/**
 * A source of time. The client and the outbox read time and wait only
 * through this interface, so tests can swap in a fake clock.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Resolve after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

/** The real clock: `Date.now()` and `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, ms));
    }),
};
