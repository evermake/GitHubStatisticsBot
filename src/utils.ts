import process from 'node:process'

export function readEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`)
  }
  return value
}

export function parseGithubUsername(input: string): string | null {
  const username = input.trim()
  const usernameRegex = /^[a-z0-9-]{1,39}$/i
  if (usernameRegex.test(username)) {
    return username
  }
  return null
}

export function formatStat(number: number): string {
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

export function formatDate(date: Date): string {
  const month = date.toLocaleString('en-US', { month: 'long' })
  const day = date.getDate()
  const year = date.getFullYear()
  return `${month} ${day}, ${year}`
}
