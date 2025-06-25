import type { GitHubStats } from './common'
import type { GeneratorJobResult } from './generator'
import fs from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '@grammyjs/runner'
import { Bot, InputFile } from 'grammy'
import { Octokit } from 'octokit'
import puppeteer from 'puppeteer'
import { StatsFetcher } from './fetcher'
import { Generator } from './generator'
import { formatDate, formatStat, parseGithubUsername, readEnv } from './utils'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pathTo = (...parts: string[]) => resolve(__dirname, ...parts)

export async function main() {
  const octokit = new Octokit()
  const fetcher = new StatsFetcher(octokit)
  const blueprint = await fs.readFile(pathTo('../card.html'), 'utf-8')
  const browser = await puppeteer.launch({ browser: 'chrome' })
  let pdfGenerator: Generator<{ username: string, tgUserId: number, messageId: number }>

  //////////////////////////////////////////////////////////////////////////////
  const bot = new Bot(readEnv('BOT_TOKEN'))

  bot.command('start', async (ctx) => {
    await ctx.reply('Send me a GitHub username, and I\'ll generate stats.')
  })

  bot
    .filter((ctx): ctx is import('grammy').Context & { match: string } => {
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
      const message = await ctx.reply(
        `Fetching stats for <a href="https://github.com/${username}">${username}</a>...`,
        { parse_mode: 'HTML' },
      )
      const stats = await fetcher.getUserStats(username)
      pdfGenerator.addJob(stats, { username, tgUserId: ctx.from!.id, messageId: message.message_id })
    })

  bot.catch((error) => {
    console.error(error)
  })
  //////////////////////////////////////////////////////////////////////////////

  pdfGenerator = new Generator<{ username: string, tgUserId: number, messageId: number }>(
    browser,
    async (result: GeneratorJobResult, meta) => {
      bot.api.deleteMessage(meta.tgUserId, meta.messageId)
      if (result.ok) {
        await bot.api.sendPhoto(meta.tgUserId, new InputFile(result.png))
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
    (stats: GitHubStats) => {
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
