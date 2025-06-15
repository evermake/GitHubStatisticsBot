import { Bot, Context } from "grammy"
import process from "node:process"

function readEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`)
  }
  return value
}

function assertNever(value: never): never {
  throw new Error(`${value} was not expected`)
}

type Action =
  | { type: 'Start' }
  | { type: 'Stats', username: string }

async function processAction(ctx: Context, action: Action) {
  switch (action.type) {
    case "Start":
      await ctx.reply([
        'I can show GitHub statistics for a user:',
        '/stats evermake'
      ].join('\n'))
      break
    case "Stats":
      const stats = await getUserStats(action.username)
      await ctx.reply(
        formatUserStatsMessage(stats),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }
      )
      break
    default: assertNever(action)
  }
}

function parseStatsCommand(args: string): Extract<Action, { type: 'Stats' }> {
  const usernameRegex = /^[a-z0-9-]{1,39}$/i

  const parts = args.trim().split(/\s+/)
  switch (parts.length) {
    case 1:
      if (usernameRegex.test(parts[0])) {
        return { type: 'Stats', username: parts[0] }
      }
      throw new Error(`invalid username: ${parts[0]}`)
    default:
      throw new Error(`expected 1 part, got ${parts.length}`)
  }
}

async function getUserStats(username: string): Promise<UserStats> {
  const response = await fetch(`https://api.github.com/users/${username}`)
  const data = await response.json()
  return {
    username,
    stats: {
      followersCount: data.followers,
      publicReposCount: data.public_repos,
    }
  }
}

function formatUserStatsMessage(stats: UserStats): string {
  return [
    `<b>Statistics for <a href="https://github.com/${stats.username}">${stats.username}</a></b>`,
    `Followers: ${stats.stats.followersCount}`,
    `Public repositories: ${stats.stats.publicReposCount}`,
  ].join('\n')
}

type UserStats = {
  username: string
  stats: {
    followersCount: number
    publicReposCount: number
  }
}

async function main() {
  const bot = new Bot(readEnv("BOT_TOKEN"))

  bot.command("start", async (ctx) => {
    await processAction(ctx, { type: 'Start' })
  })

  bot.command("stats", async (ctx) => {
    try {
      await processAction(ctx, parseStatsCommand(ctx.match))
    } catch (error) {
      console.warn('Failed to process stats command', error)
      await ctx.reply([
        'Wrong command format. Use it like this:',
        '/stats <username>',
        '/stats <username> <year>',
      ].join('\n'))
    }
  })

  bot.catch((error) => {
    console.error(error)
  })

  await bot.start({
    onStart: (botInfo) => {
      console.log(`@${botInfo.username} is alive.`)
    }
  })
}

main().catch(console.error)
