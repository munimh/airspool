import { type Clock, systemClock } from "./clock.ts";

/** Options for {@link RateLimiter}. */
export interface RateLimiterOptions {
  /** Clock used for timing. Defaults to the system clock. */
  clock?: Clock;
  /**
   * Requests allowed per second for one base. Airtable documents 5.
   * @default 5
   */
  perBase?: number;
  /**
   * Requests allowed per second for one token, across all bases. Airtable
   * documents 50 for personal access tokens and service accounts.
   * @default 50
   */
  perToken?: number;
  /**
   * Fraction added to every gap between requests, so small timing
   * differences on the network never push a burst over the limit. With the
   * defaults, requests to one base start 210 ms apart.
   * @default 0.05
   */
  safetyMargin?: number;
}

interface Lane {
  /** Earliest time the next request in this lane may start. */
  nextFree: number;
  /** Requests in this lane must not start before this time (set after a 429). */
  blockedUntil: number;
}

/**
 * Spaces requests out so they stay under Airtable's limits.
 *
 * Every request reserves a start time in two lanes: one for its base and one
 * for its token. Reservations are made synchronously, so many callers in the
 * same process queue up in order instead of all firing at once. One limiter
 * is shared by every {@link AirtableClient} in the process unless you pass
 * your own.
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #baseGap: number;
  readonly #tokenGap: number;
  readonly #lanes = new Map<string, Lane>();

  /**
   * Create a limiter.
   *
   * @param options Rates and clock.
   */
  constructor(options: RateLimiterOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    const margin = options.safetyMargin ?? 0.05;
    const perBase = options.perBase ?? 5;
    const perToken = options.perToken ?? 50;
    if (!(perBase > 0) || !(perToken > 0)) throw new RangeError("rates must be positive");
    if (!(margin >= 0)) throw new RangeError("safetyMargin must not be negative");
    this.#baseGap = Math.ceil((1000 / perBase) * (1 + margin));
    this.#tokenGap = Math.ceil((1000 / perToken) * (1 + margin));
  }

  #lane(key: string): Lane {
    let lane = this.#lanes.get(key);
    if (!lane) {
      lane = { nextFree: 0, blockedUntil: 0 };
      this.#lanes.set(key, lane);
    }
    return lane;
  }

  /**
   * Wait until a request for `baseId` sent with the token identified by
   * `tokenKey` may start, and claim that slot.
   *
   * @param baseId The Airtable base the request is for.
   * @param tokenKey An opaque key for the token (never the token itself).
   */
  async take(baseId: string, tokenKey: string): Promise<void> {
    const base = this.#lane(`base:${baseId}`);
    const token = this.#lane(`token:${tokenKey}`);
    const now = this.#clock.now();
    const start = Math.max(now, base.nextFree, base.blockedUntil, token.nextFree, token.blockedUntil);
    base.nextFree = start + this.#baseGap;
    token.nextFree = start + this.#tokenGap;
    if (start > now) await this.#clock.sleep(start - now);
  }

  /**
   * Hold back every request for `baseId` for `ms` milliseconds. The client
   * calls this after a 429, because Airtable rejects all further requests to
   * the base for a while.
   *
   * @param baseId The base that was rate limited.
   * @param ms How long to hold requests back.
   */
  pauseBase(baseId: string, ms: number): void {
    const lane = this.#lane(`base:${baseId}`);
    lane.blockedUntil = Math.max(lane.blockedUntil, this.#clock.now() + ms);
  }

  /**
   * Hold back every request sent with this token for `ms` milliseconds.
   *
   * @param tokenKey The opaque token key.
   * @param ms How long to hold requests back.
   */
  pauseToken(tokenKey: string, ms: number): void {
    const lane = this.#lane(`token:${tokenKey}`);
    lane.blockedUntil = Math.max(lane.blockedUntil, this.#clock.now() + ms);
  }
}

/** The limiter shared by every client in this process that does not get its own. */
export const sharedRateLimiter: RateLimiter = new RateLimiter();
