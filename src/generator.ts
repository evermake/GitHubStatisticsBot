import type { GitHubStats } from './common'

export type GeneratorJobResult
  = | { ok: true, png: Uint8Array }
    | { ok: false, error: unknown }

export interface GeneratorJob<M> {
  stats: GitHubStats
  meta: M
}

export class Generator<JobMeta = null> {
  #queue: Array<GeneratorJob<JobMeta>> = []
  #resolversQueue: Array<(result: GeneratorJob<JobMeta>) => void> = []
  #isRunning = false

  constructor(
    private browser: import('puppeteer').Browser,
    private jobResultHandler: (result: GeneratorJobResult, meta: JobMeta) => Promise<void>,
    private getPageHtmlContent: (stats: GitHubStats) => string,
  ) {}

  public addJob(stats: GitHubStats, meta: JobMeta) {
    const resolver = this.#resolversQueue.shift()
    if (resolver) {
      resolver({ stats, meta })
    }
    else {
      this.#queue.push({ stats, meta })
    }
  }

  private async generatePng(stats: GitHubStats): Promise<Uint8Array> {
    const page = await this.browser.newPage()
    await page.setViewport({ width: 768, height: 512, deviceScaleFactor: 2 })
    const pageContent = this.getPageHtmlContent(stats)
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
    return png
  }

  private job(): Promise<GeneratorJob<JobMeta>> {
    const head = this.#queue.shift()
    if (head) {
      return Promise.resolve(head)
    }
    return new Promise<GeneratorJob<JobMeta>>((resolve) => {
      this.#resolversQueue.push(resolve)
    })
  }

  private jobResultHandlerSafe(result: GeneratorJobResult, meta: JobMeta) {
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
        const png = await this.generatePng(stats)
        await this.jobResultHandlerSafe({ ok: true, png }, meta)
      }
      catch (error) {
        await this.jobResultHandlerSafe({ ok: false, error }, meta)
      }
    }
  }
}
