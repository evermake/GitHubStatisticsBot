export type ConsumeResultFn<P, M> = (result: Result<P, M>) => void
export type ExecuteTaskFn<T, P, M> = (task: T, meta: M) => Promise<P>

export type Result<P, M>
  = | { meta: M, ok: true, payload: P }
    | { meta: M, ok: false, error: unknown }

interface TaskInternal<T, P, M> {
  task: T
  meta: M
  resolver: (result: Result<P, M>) => void
  promise: Promise<Result<P, M>>
}
const aborted = Symbol('aborted')

export class TaskQueue<T, P, M> {
  #state: 'idle' | 'stopping' | 'running' = 'idle'

  #stopPromise: Promise<void> | null = null
  #stopResolver: (() => void) | null = null
  #abortPromise: Promise<typeof aborted> = new Promise<typeof aborted>(() => {})
  #abortResolver: ((_: typeof aborted) => void) | null = null

  #queue: TaskInternal<T, P, M>[] = []
  #taskResolver: ((task: TaskInternal<T, P, M>) => void) | null = null

  #consumeFn: ConsumeResultFn<P, M> = () => {}
  #executeFn: ExecuteTaskFn<T, P, M>

  constructor(executeFn: ExecuteTaskFn<T, P, M>) {
    this.#executeFn = executeFn
  }

  public setConsumer(consumeFn: ConsumeResultFn<P, M>) {
    this.#consumeFn = consumeFn
  }

  public addTask(task: T, meta: M): Promise<Result<P, M>> {
    const { promise, resolve } = Promise.withResolvers<Result<P, M>>()
    const wrapped: TaskInternal<T, P, M> = {
      task,
      meta,
      resolver: resolve,
      promise,
    }

    if (this.#state === 'running' && this.#taskResolver) {
      this.#taskResolver(wrapped)
    }
    else {
      this.#queue.push(wrapped)
    }

    return promise
  }

  public start() {
    if (this.#state === 'idle') {
      const p1 = Promise.withResolvers<void>()
      this.#stopPromise = p1.promise
      this.#stopResolver = p1.resolve

      const p2 = Promise.withResolvers<typeof aborted>()
      this.#abortPromise = p2.promise
      this.#abortResolver = p2.resolve

      this.#state = 'running'
      this.loop()
    }
  }

  public stop(): Promise<void> {
    switch (this.#state) {
      case 'idle':
        return Promise.resolve()
      case 'stopping':
        return this.#stopPromise!
      case 'running':
        this.#state = 'stopping'
        this.#abortResolver!(aborted)
        return this.#stopPromise!
    }
  }

  public pipe<O>(another: TaskQueue<P, O, M>): TaskQueue<T, O, M> {
    const connection = new TaskQueue<T, O, M>(async (task, meta) => {
      const result1 = await this.addTask(task, meta)
      if (!result1.ok) {
        throw result1.error
      }
      const result2 = await another.addTask(result1.payload, result1.meta)
      if (!result2.ok) {
        throw result2.error
      }
      return result2.payload
    })
    return connection
  }

  private consumeSafe(result: Result<P, M>): void {
    try {
      this.#consumeFn(result)
    }
    catch (error) {
      console.error('consumer failed', error)
    }
  }

  private async loop() {
    while (true) {
      const task = await this.task()
      if (task === aborted) {
        break
      }
      try {
        const payload = await this.#executeFn(task.task, task.meta)
        task.resolver({ meta: task.meta, ok: true, payload })
        this.consumeSafe({ meta: task.meta, ok: true, payload })
      }
      catch (error) {
        task.resolver({ meta: task.meta, ok: false, error })
        this.consumeSafe({ meta: task.meta, ok: false, error })
      }
    }
    this.#state = 'idle'
    this.#stopResolver!()
  }

  private async task(): Promise<TaskInternal<T, P, M> | typeof aborted> {
    if (this.#state !== 'running') {
      return aborted
    }

    const head = this.#queue.shift()
    if (head)
      return head

    const { promise: taskPromise, resolve: taskResolver } = Promise.withResolvers<TaskInternal<T, P, M>>()
    this.#taskResolver = taskResolver
    return Promise.race([this.#abortPromise, taskPromise])
  }
}
