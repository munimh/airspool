import type { Clock } from "../src/clock.ts";

/** Let pending promise chains run. Uses a real macrotask, so it is thorough. */
export const flush = async (turns = 2): Promise<void> => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A clock that only moves when the test says so. */
export class FakeClock implements Clock {
  #now: number;
  #timers: { at: number; seq: number; resolve: () => void }[] = [];
  #seq = 0;

  constructor(start = Date.UTC(2030, 0, 1)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#timers.push({ at: this.#now + Math.max(0, ms), seq: this.#seq++, resolve });
    });
  }

  /** Timers waiting to fire. */
  get pending(): number {
    return this.#timers.length;
  }

  /** Move time forward by `ms`, firing timers in order and letting code run between them. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    await flush();
    while (true) {
      this.#timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.#timers[0];
      if (!next || next.at > target) break;
      this.#timers.shift();
      this.#now = Math.max(this.#now, next.at);
      next.resolve();
      await flush();
    }
    this.#now = target;
    await flush();
  }

  /**
   * Keep jumping to the next timer until `promise` settles. Fails if that
   * takes more than `limitMs` of fake time.
   */
  async run<T>(promise: Promise<T>, limitMs = 3_600_000): Promise<T> {
    let done = false;
    const watched = promise.finally(() => {
      done = true;
    });
    watched.catch(() => {});
    const start = this.#now;
    await flush();
    while (!done) {
      if (this.#now - start > limitMs) throw new Error(`still running after ${limitMs} ms of fake time`);
      this.#timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.#timers[0];
      await this.advance(next ? Math.max(0, next.at - this.#now) : 10);
    }
    return await watched;
  }
}
