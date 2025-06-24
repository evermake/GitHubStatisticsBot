import type { Context } from 'grammy'
import fs from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { run } from '@grammyjs/runner'
import { Bot, InputFile } from 'grammy'
import { Octokit } from 'octokit'
import puppeteer from 'puppeteer'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pathTo = (...parts: string[]) => resolve(__dirname, ...parts)

function readEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`)
  }
  return value
}

function parseGithubUsername(input: string): string | null {
  const username = input.trim()
  const usernameRegex = /^[a-z0-9-]{1,39}$/i
  if (usernameRegex.test(username)) {
    return username
  }
  return null
}

// function formatUserStatsMessage(stats: UserStats): string {
//   return [
//     `<b>Statistics for <a href="https://github.com/${stats.username}">${stats.username}</a></b>`,
//     `Followers: ${stats.stats.followersCount}`,
//     `Public repositories: ${stats.stats.publicReposCount}`,
//   ].join('\n')
// }

// const commits = await octokit.rest.search.commits({
//   q: `author:<username>`,
//   sort: 'author-date',
//   order: 'asc',
//   page: 1,
//   per_page: 1
// })

/**
 * Formats a number statistic value to a string, with a maximum precision
 * to fit into 5 characters.
 *
 * @example
 * ```js
 * formatStat(10) // '10'
 * formatStat(999) // '999'
 * formatStat(1599) // '1.59k'
 * formatStat(2109) // '2.1k'
 * formatStat(1_234_567) // '1.23m'
 * formatStat(12_345_678) // '12.3m'
 * ```
 */
function formatStat(number: number): string {
  if (number < 1000) {
    return number.toString()
  }
  else {
    const units = [
      { value: 1_000_000, suffix: 'm' },
      { value: 1_000, suffix: 'k' },
    ]
    for (const { value, suffix } of units) {
      if (number >= value) {
        const n = number / value
        if (n < 10) {
          return n.toFixed(2).replace(/\.00$/, '').replace(/(\.[1-9])0$/, '$1') + suffix
        }
        else if (n < 100) {
          return n.toFixed(1).replace(/\.0$/, '') + suffix
        }
        else {
          return Math.round(n).toString() + suffix
        }
      }
    }
    return number.toString()
  }
}

/**
 * @example
 * ```js
 * formatDate(new Date('2019-07-25')) // 'July 25, 2019'
 * ```
 */
function formatDate(date: Date): string {
  const month = date.toLocaleString('en-US', { month: 'long' })
  const day = date.getDate()
  const year = date.getFullYear()
  return `${month} ${day}, ${year}`
}

async function main() {
  const octokit = new Octokit()
  const blueprint = await fs.readFile(pathTo('card.html'), 'utf-8')
  const browser = await puppeteer.launch({ browser: 'chrome' })
  let pdfGenerator: PdfGenerator<{ username: string, tgUserId: number }>

  //////////////////////////////////////////////////////////////////////////////
  const bot = new Bot(readEnv('BOT_TOKEN'))

  bot.command('start', async (ctx) => {
    await ctx.reply('I can show GitHub statistics for a user. Just send me a username.')
  })

  bot
    .filter((ctx): ctx is Context & { match: string } => {
      if (ctx.update.message?.text) {
        const username = parseGithubUsername(ctx.update.message.text)
        if (username) {
          ctx.match = username
          return true
        }
      }
      return false
    })
    .use(async (ctx) => {
      const username = ctx.match
      const stats = await octokit.rest.users.getByUsername({ username })
      pdfGenerator.addJob(
        {
          avatarUrl: stats.data.avatar_url,
          fullname: stats.data.name ?? '',
          username,
          joinDate: new Date(stats.data.created_at),
          commits: 0,
          stars: 0,
          followers: stats.data.followers,
          pullRequests: 0,
          issues: 0,
          repos: 0,
        },
        { username, tgUserId: ctx.from!.id },
      )
    })

  bot.catch((error) => {
    console.error(error)
  })
  //////////////////////////////////////////////////////////////////////////////

  pdfGenerator = new PdfGenerator<{ username: string, tgUserId: number }>(
    browser,
    async (result, meta) => {
      if (result.ok) {
        await bot.api.sendDocument(meta.tgUserId, new InputFile(
          result.pdf,
          `${meta.username}_stats.pdf`,
        ))
      }
      else {
        console.error(result.error)
        await bot.api.sendMessage(
          meta.tgUserId,
          `Failed to generate stats for <code>${meta.username}</code>, sorry.`,
          { parse_mode: 'HTML' },
        )
      }
    },
    (stats) => {
      return blueprint
        .replace('$AVATAR$', stats.avatarUrl)
        .replace('$FULLNAME$', stats.fullname)
        .replace('$USERNAME$', stats.username)
        .replace('$DATE_JOINED$', `Joined on ${formatDate(stats.joinDate)}`)
        .replace('$COMMITS$', formatStat(stats.commits))
        .replace('$STARS$', formatStat(stats.stars))
        .replace('$FOLLOWERS$', formatStat(stats.followers))
        .replace('$PULL_REQUESTS$', formatStat(stats.pullRequests))
        .replace('$ISSUES$', formatStat(stats.issues))
        .replace('$REPOS$', formatStat(stats.repos))
    },
  )

  pdfGenerator.start()
  const runner = run(bot)
  await runner.task()
}

interface StatsInfo {
  avatarUrl: string
  fullname: string
  username: string
  joinDate: Date
  commits: number
  stars: number
  followers: number
  pullRequests: number
  issues: number
  repos: number
}

type PdfGeneratorJobResult
  = | { ok: true, pdf: Uint8Array }
    | { ok: false, error: unknown }

interface PdfGeneratorJob<M> {
  stats: StatsInfo
  meta: M
}

class PdfGenerator<JobMeta = null> {
  #queue: Array<PdfGeneratorJob<JobMeta>> = []
  #resolversQueue: Array<(result: PdfGeneratorJob<JobMeta>) => void> = []
  #isRunning = false

  constructor(
    private browser: puppeteer.Browser,
    private jobResultHandler: (result: PdfGeneratorJobResult, meta: JobMeta) => Promise<void>,
    private getPageHtmlContent: (stats: StatsInfo) => string,
  ) {}

  public addJob(stats: StatsInfo, meta: JobMeta) {
    const resolver = this.#resolversQueue.shift()
    if (resolver) {
      resolver({ stats, meta })
    }
    else {
      this.#queue.push({ stats, meta })
    }
  }

  private async generatePdf(stats: StatsInfo): Promise<Uint8Array> {
    const page = await this.browser.newPage()
    const pageContent = this.getPageHtmlContent(stats)
    await page.setContent(pageContent)
    const pdf = await page.pdf({
      path: undefined,
      preferCSSPageSize: true,
      omitBackground: false,
      printBackground: true,
    })
    await page.close({ runBeforeUnload: false })
    return pdf
  }

  private job(): Promise<PdfGeneratorJob<JobMeta>> {
    const head = this.#queue.shift()
    if (head) {
      return Promise.resolve(head)
    }
    return new Promise<PdfGeneratorJob<JobMeta>>((resolve) => {
      this.#resolversQueue.push(resolve)
    })
  }

  private jobResultHandlerSafe(result: PdfGeneratorJobResult, meta: JobMeta) {
    try {
      return this.jobResultHandler(result, meta)
    }
    catch (error) {
      console.error('job result handler failed', error)
    }
  }

  public async start(): Promise<never> {
    if (this.#isRunning) {
      throw new Error('already running')
    }
    this.#isRunning = true
    while (true) {
      const job = await this.job()
      const { stats, meta } = job
      try {
        const pdf = await this.generatePdf(stats)
        await this.jobResultHandlerSafe({ ok: true, pdf }, meta)
      }
      catch (error) {
        await this.jobResultHandlerSafe({ ok: false, error }, meta)
      }
    }
  }
}

main().catch(console.error)
