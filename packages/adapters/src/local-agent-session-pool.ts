interface Resource {
  close(): Promise<unknown>;
}
type Idle<T> = {
  binding: string;
  generation: number;
  value: T;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
};

/** A bounded idle-resource cache; generations fence a release racing with a finishing turn. */
export class LocalAgentSessionPool<T extends Resource> {
  private readonly idle = new Map<string, Idle<T>>();
  private readonly generations = new Map<string, number>();
  private readonly closing = new Set<Promise<unknown>>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(
    private readonly ttlMs = 300_000,
    private readonly maxIdle = 2,
  ) {
    if (ttlMs <= 0 || maxIdle < 1 || maxIdle > 2)
      throw new Error("Invalid local session cache policy");
  }
  generation(binding: string) {
    return this.generations.get(binding) ?? 0;
  }
  private dispose(value: T) {
    const task = Promise.resolve().then(() => value.close());
    this.closing.add(task);
    void task.finally(() => this.closing.delete(task)).catch(() => undefined);
    return task;
  }
  async take(key: string) {
    await this.queue;
    if (this.closed) throw new Error("Local session cache is closed");
    const entry = this.idle.get(key);
    if (!entry) return;
    this.idle.delete(key);
    clearTimeout(entry.timer);
    if (entry.expires <= performance.now() || entry.generation !== this.generation(entry.binding)) {
      await this.dispose(entry.value);
      return;
    }
    return entry.value;
  }
  put(key: string, binding: string, generation: number, value: T) {
    const task = this.queue.then(() => this.store(key, binding, generation, value));
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async store(key: string, binding: string, generation: number, value: T) {
    if (this.closed || generation !== this.generation(binding)) {
      await this.dispose(value);
      return;
    }
    const old = this.idle.get(key);
    if (old) {
      this.idle.delete(key);
      clearTimeout(old.timer);
      await this.dispose(old.value);
    }
    while (this.idle.size >= this.maxIdle) {
      const [first, entry] = this.idle.entries().next().value!;
      this.idle.delete(first);
      clearTimeout(entry.timer);
      await this.dispose(entry.value);
    }
    // Recheck after asynchronous disposal: release/close may have won in the meantime.
    if (this.closed || generation !== this.generation(binding)) {
      await this.dispose(value);
      return;
    }
    const timer = setTimeout(() => {
      const entry = this.idle.get(key);
      if (entry?.value === value) {
        this.idle.delete(key);
        void this.dispose(value).catch(() => {
          this.closed = true;
        });
      }
    }, this.ttlMs);
    timer.unref();
    this.idle.set(key, {
      binding,
      generation,
      value,
      expires: performance.now() + this.ttlMs,
      timer,
    });
  }
  async release(binding: string) {
    this.generations.set(binding, this.generation(binding) + 1);
    await this.queue;
    const pending = [];
    for (const [key, entry] of this.idle)
      if (entry.binding === binding) {
        this.idle.delete(key);
        clearTimeout(entry.timer);
        pending.push(this.dispose(entry.value));
      }
    await Promise.all(pending);
  }
  async close() {
    this.closed = true;
    await this.queue;
    for (const entry of this.idle.values()) {
      clearTimeout(entry.timer);
      void this.dispose(entry.value);
    }
    this.idle.clear();
    await Promise.all([...this.closing]);
  }
}
