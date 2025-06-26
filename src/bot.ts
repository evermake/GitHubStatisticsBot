import fs from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { autoRetry } from '@grammyjs/auto-retry'
import { run } from '@grammyjs/runner'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'
import { Bot, InputFile } from 'grammy'
import { Octokit } from 'octokit'
import puppeteer from 'puppeteer'
import { makeFetcher } from './fetcher'
import { makeGenerator } from './generator'
import { formatDate, formatStat, parseGithubUsername, readEnv } from './utils'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pathTo = (...parts: string[]) => resolve(__dirname, ...parts)

interface TaskMeta {
  pendingMessageId: number
  userTgId: number
  targetGhUsername: string
}

export async function main() {
  //////////////////////////////////////////////////////////////////////////////
  // Initialize fetcher.
  const OctokitPlugged = Octokit
    .plugin(retry)
    .plugin(throttling)

  const octokit = new OctokitPlugged({
    request: { retries: 2 },
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(`rate limit (1) for request ${options.method} ${options.url}`)
        if (retryCount < 2) {
          octokit.log.info(`retrying after ${retryAfter} seconds`)
          return true
        }
      },
      onSecondaryRateLimit: (_retryAfter, options, octokit) => {
        octokit.log.warn(`rate limit (2) for request ${options.method} ${options.url}`)
      },
    },
  })
  const fetcher = makeFetcher<TaskMeta>(octokit)
  //////////////////////////////////////////////////////////////////////////////

  //////////////////////////////////////////////////////////////////////////////
  // Initialize generator.
  const blueprint = await fs.readFile(pathTo('./blueprint.html'), 'utf-8')
  const browser = await puppeteer.launch({ browser: 'chrome' })
  const generator = makeGenerator<TaskMeta>(browser, (stats) => {
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
  })
  //////////////////////////////////////////////////////////////////////////////

  //////////////////////////////////////////////////////////////////////////////
  // Pipe fetcher and generator.
  const taskQueue = fetcher.pipe(generator)
  //////////////////////////////////////////////////////////////////////////////

  //////////////////////////////////////////////////////////////////////////////
  // Initialize bot.
  const bot = new Bot(readEnv('BOT_TOKEN'))

  bot.api.config.use(autoRetry())

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
        `Fetching stats for <code}">${username}</code>...`,
        { parse_mode: 'HTML' },
      )
      taskQueue.addTask(
        { username },
        {
          pendingMessageId: message.message_id,
          targetGhUsername: username,
          userTgId: ctx.from!.id,
        },
      )
    })

  bot.catch((error) => {
    console.error(error)
  })
  //////////////////////////////////////////////////////////////////////////////

  //////////////////////////////////////////////////////////////////////////////
  // Set consumer.
  taskQueue.setConsumer(async (result) => {
    bot.api.deleteMessage(result.meta.userTgId, result.meta.pendingMessageId)
    if (result.ok) {
      await bot.api.sendPhoto(result.meta.userTgId, new InputFile(result.payload.png))
    }
    else {
      console.error(result.error)
      await bot.api.sendMessage(
        result.meta.userTgId,
        `Failed to generate stats for <code>${result.meta.targetGhUsername}</code>, sorry.`,
        { parse_mode: 'HTML' },
      )
    }
  })
  //////////////////////////////////////////////////////////////////////////////

  //////////////////////////////////////////////////////////////////////////////
  // Launch.
  generator.start()
  fetcher.start()
  taskQueue.start()

  const runner = run(bot)

  // Graceful shutdown.
  const stopRunner = () => runner.isRunning() && runner.stop()
  process.once('SIGINT', stopRunner)
  process.once('SIGTERM', stopRunner)

  await runner.task()
  await taskQueue.stop()
  await fetcher.stop()
  await generator.stop()
  //////////////////////////////////////////////////////////////////////////////
}
