import type { Browser } from 'puppeteer'
import type { GitHubStats } from './common'
import { TaskQueue } from './task_queue'

export interface Task {
  stats: GitHubStats
}

export interface Payload {
  png: Uint8Array
}

export function makeGenerator<M>(
  browser: Browser,
  htmlGenFn: (stats: GitHubStats) => string,
) {
  return new TaskQueue<Task, Payload, M>(
    async ({ stats }, meta) => {
      const page = await browser.newPage()
      await page.setViewport({ width: 768, height: 512, deviceScaleFactor: 2 })
      const pageContent = htmlGenFn(stats)
      await page.setContent(pageContent)
      const el = await page.waitForSelector('#stats')
      if (!el) {
        throw new Error('stats element not found')
      }
      const png = await el.screenshot({
        type: 'png',
        path: undefined,
        encoding: 'binary',
        omitBackground: false,
      })
      await page.close({ runBeforeUnload: false })
      return { png, meta }
    },
  )
}
