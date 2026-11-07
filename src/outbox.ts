import type { AirtableClient, FieldValues } from "./client.ts";
import { type Clock, systemClock } from "./clock.ts";
import { isPermanentError } from "./errors.ts";
import type { OutboxCounts, OutboxStore, StoredChange } from "./store.ts";

/** A change to send to Airtable. Give either `recordId` or `match`. */
export interface ChangeInput {
  /** Base ID, starting with `app`. */
  baseId: string;
  /**
   * Table ID or name. Changes are merged per table string, so use the same
   * form (preferably the ID) everywhere.
   */
  table: string;
  /** The record to update, when you know its ID. */
  recordId?: string;
  /**
   * Upsert instead: one to three fields whose values in `fields` identify
   * the record. Airtable updates the matching record or creates one.
   */
  match?: string[];
  /** Cell values to set, keyed by field name or ID. */
  fields: FieldValues;
  /** Send with `typecast: true`. @default false */
  typecast?: boolean;
}

/** One change that was part of a write, as passed to hooks. */
export interface ChangeRef {
  /** Change ID from the store. */
  id: number;
  /** When it was enqueued, ms since the epoch. */
  createdAt: number;
}

/** Passed to {@link OutboxOptions.onSent}. */
export interface SentEvent {
  /** Queue name. */
  queue: string;
  /** Base ID. */
  baseId: string;
  /** Table ID or name. */
  table: string;
  /** The record written. For an upsert, the ID Airtable reported. */
  recordId: string | null;
  /** Merge fields, for an upsert. */
  match: string[] | null;
  /** The merged values that were sent. */
  fields: FieldValues;
  /** The changes that this write covered, oldest first. */
  changes: ChangeRef[];
  /** For an upsert: whether Airtable created the record. */
  created?: boolean;
}

/** Passed to {@link OutboxOptions.onFailed}. */
export interface FailedEvent {
  /** Queue name. */
  queue: string;
  /** Base ID. */
  baseId: string;
  /** Table ID or name. */
  table: string;
  /** Target record ID, if the changes had one. */
  recordId: string | null;
  /** Merge fields, for an upsert. */
  match: string[] | null;
  /** The merged values that could not be sent. */
  fields: FieldValues;
  /** The changes affected, oldest first. */
  changes: ChangeRef[];
  /** The error from the send. */
  error: unknown;
  /** Sends tried so far, including this one. */
  attempts: number;
  /** `true` when the changes will be sent again at `nextAttemptAt`. */
  willRetry: boolean;
  /** When the next try is due, ms since the epoch; `null` when giving up. */
  nextAttemptAt: number | null;
}

/** Options for {@link Outbox}. */
export interface OutboxOptions {
  /** Where changes are kept. */
  store: OutboxStore;
  /** The client used to send. Only {@link Outbox.process} uses it. */
  client: AirtableClient;
  /** Queue name, so one store can hold several queues. @default "default" */
  queue?: string;
  /**
   * Sends to try before a change is marked failed. Errors that mean the
   * request was wrong fail at once, whatever this says.
   * @default 5
   */
  maxAttempts?: number;
  /**
   * Wait before try number `attempt + 1`, given the number of tries so far.
   * The default waits 1, 2, 4, 8 ... minutes, at most one hour.
   */
  backoff?: (attempt: number) => number;
  /**
   * How long a processor's lease lasts without renewal. It is renewed before
   * every request, so it only needs to cover one request with its retries.
   * If a worker dies, another can take over after this long.
   * @default 120000
   */
  leaseMs?: number;
  /** Groups (target records) loaded from the store at a time. @default 100 */
  loadSize?: number;
  /**
   * How long to keep sent changes. They guard against an older change that
   * is retried later overwriting a newer value. @default 7 days
   */
  keepSentMs?: number;
  /** Clock used for scheduling. Defaults to the system clock. */
  clock?: Clock;
  /** Called after each successful write. */
  onSent?: (event: SentEvent) => void | Promise<void>;
  /** Called after each failed write, whether or not it will be retried. */
  onFailed?: (event: FailedEvent) => void | Promise<void>;
  /** Called when `onSent` or `onFailed` throws. Hook errors never stop a run. */
  onHookError?: (error: unknown) => void;
}

/** Options for one {@link Outbox.process} run. */
export interface ProcessOptions {
  /** Stop starting new requests after this many milliseconds. */
  timeLimitMs?: number;
}

/** What one {@link Outbox.process} run did. */
export interface ProcessResult {
  /** `false` when another processor holds the lease, so nothing was done. */
  ran: boolean;
  /** Writes (target records) that reached Airtable. */
  written: number;
  /** Changes marked sent. */
  sent: number;
  /** Changes scheduled to be sent again. */
  retrying: number;
  /** Changes that were given up on in this run. */
  failed: number;
  /** HTTP requests made to Airtable. */
  requests: number;
  /** Why the run stopped before running out of due changes, if it did. */
  stopped?: "time_limit" | "lease_lost";
}

/** Waits 1, 2, 4, 8 ... minutes, at most one hour. */
export function defaultBackoff(attempt: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

/** A random ID for one processor run. Node 18 has no global `crypto`. */
function newOwnerId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

interface Group {
  key: string;
  baseId: string;
  table: string;
  recordId: string | null;
  match: string[] | null;
  typecast: boolean;
  rows: StoredChange[];
  fields: FieldValues;
}

/**
 * A durable queue of Airtable writes.
 *
 * {@link Outbox.enqueue} only writes to the store. {@link Outbox.process}
 * (run it on a schedule, or right after enqueueing) sends what is due: all
 * waiting changes for one record become one write, applied oldest first so
 * the newest value of each field wins, and writes to the same table are
 * batched. Only one processor runs per queue at a time.
 *
 * Delivery is at least once: if a worker dies after Airtable saved a write
 * but before the store recorded it, the write is sent again. Updates and
 * upserts set the same values again, so that is harmless.
 *
 * @example
 * ```ts
 * import { AirtableClient, Outbox, memoryStore } from "@munimh/airspool";
 *
 * const outbox = new Outbox({
 *   store: memoryStore(),
 *   client: new AirtableClient({ token: Deno.env.get("AIRTABLE_TOKEN")! }),
 * });
 * await outbox.enqueue({
 *   baseId: "appExampleBase0001",
 *   table: "Tasks",
 *   recordId: "recExampleTask0001",
 *   fields: { Status: "Done" },
 * });
 * await outbox.process();
 * ```
 */
export class Outbox {
  /** Queue name. */
  readonly queue: string;
  readonly #options: OutboxOptions;
  readonly #store: OutboxStore;
  readonly #client: AirtableClient;
  readonly #clock: Clock;
  readonly #maxAttempts: number;
  readonly #backoff: (attempt: number) => number;
  readonly #leaseMs: number;
  readonly #loadSize: number;
  readonly #keepSentMs: number;

  /**
   * Create an outbox.
   *
   * @param options Store, client, and tuning.
   */
  constructor(options: OutboxOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#client = options.client;
    this.queue = options.queue ?? "default";
    this.#clock = options.clock ?? systemClock;
    this.#maxAttempts = options.maxAttempts ?? 5;
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
    this.#backoff = options.backoff ?? defaultBackoff;
    this.#leaseMs = options.leaseMs ?? 120_000;
    this.#loadSize = options.loadSize ?? 100;
    this.#keepSentMs = options.keepSentMs ?? 7 * 24 * 3_600_000;
  }

  /**
   * The same outbox on another store. Use it to enqueue inside your own
   * database transaction: give it a store whose runner uses the transaction.
   *
   * @param store The store to use instead.
   */
  withStore(store: OutboxStore): Outbox {
    return new Outbox({ ...this.#options, store });
  }

  /**
   * Queue a change. Only writes to the store; never calls Airtable.
   *
   * @param change Target and values.
   * @returns The stored change.
   */
  async enqueue(change: ChangeInput): Promise<StoredChange> {
    const { baseId, table, recordId, match, fields } = change;
    if (!baseId || !table) throw new TypeError("enqueue() needs baseId and table");
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      throw new TypeError("fields must be an object");
    }
    if ((recordId === undefined) === (match === undefined)) {
      throw new TypeError("give either recordId or match");
    }
    let groupKey: string;
    let mergeOn: string[] | null = null;
    if (recordId !== undefined) {
      if (!recordId) throw new TypeError("recordId must not be empty");
      if (Object.keys(fields).length === 0) throw new TypeError("fields must not be empty");
      groupKey = JSON.stringify([baseId, table, "id", recordId]);
    } else {
      mergeOn = [...new Set(match)].sort();
      if (mergeOn.length < 1 || mergeOn.length > 3) throw new TypeError("match needs one to three fields");
      for (const field of mergeOn) {
        if (fields[field] === undefined) throw new TypeError(`fields must include the match field "${field}"`);
      }
      groupKey = JSON.stringify([baseId, table, "match", mergeOn, mergeOn.map((f) => fields[f])]);
    }
    return await this.#store.insert({
      queue: this.queue,
      groupKey,
      baseId,
      table,
      recordId: recordId ?? null,
      match: mergeOn,
      fields: JSON.parse(JSON.stringify(fields)),
      typecast: change.typecast ?? false,
      createdAt: this.#clock.now(),
    });
  }

  /** Counts of pending, retrying and failed changes in this queue. */
  async status(): Promise<OutboxCounts> {
    return await this.#store.counts(this.queue);
  }

  /**
   * Failed changes with their last error, oldest first.
   *
   * @param limit At most this many. @default 100
   */
  async failed(limit = 100): Promise<StoredChange[]> {
    return await this.#store.listFailed(this.queue, limit);
  }

  /**
   * Send failed changes again on the next run, with a fresh set of tries.
   * They keep their place in line, so a retried old value never replaces a
   * newer one.
   *
   * @param ids Change IDs, or `"all"` for every failed change in the queue.
   * @returns How many changes will be retried.
   */
  async retry(ids: number[] | "all"): Promise<number> {
    return await this.#store.retry(this.queue, ids, this.#clock.now());
  }

  /**
   * Delete failed changes without sending them.
   *
   * @param ids Change IDs, or `"all"` for every failed change in the queue.
   * @returns How many changes were deleted.
   */
  async discard(ids: number[] | "all"): Promise<number> {
    return await this.#store.discard(this.queue, ids);
  }

  /**
   * Send everything that is due. Returns at once with `ran: false` if
   * another processor is running for this queue.
   *
   * @param options Optional time limit, useful in functions with a deadline.
   */
  async process(options: ProcessOptions = {}): Promise<ProcessResult> {
    const result: ProcessResult = { ran: false, written: 0, sent: 0, retrying: 0, failed: 0, requests: 0 };
    const owner = newOwnerId();
    const started = this.#clock.now();
    const now = this.#clock.now();
    if (!await this.#store.acquireLease(this.queue, owner, now + this.#leaseMs, now)) return result;
    const renew = () => this.#store.renewLease(this.queue, owner, this.#clock.now() + this.#leaseMs);
    result.ran = true;
    const seen = new Set<string>();

    try {
      run: while (true) {
        const rows = await this.#store.loadDue(this.queue, this.#clock.now(), this.#loadSize);
        const groups = this.#group(rows).filter((g) => !seen.has(g.key));
        if (groups.length === 0) break;
        for (const g of groups) seen.add(g.key);
        await this.#dropSuperseded(groups);

        for (const batch of this.#batches(groups)) {
          if (options.timeLimitMs !== undefined && this.#clock.now() - started >= options.timeLimitMs) {
            result.stopped = "time_limit";
            break run;
          }
          const lost = await this.#send(batch, renew, result);
          if (lost) {
            result.stopped = "lease_lost";
            break run;
          }
        }
      }
      if (!result.stopped) await this.#store.purgeSent(this.queue, this.#clock.now() - this.#keepSentMs);
    } finally {
      await this.#store.releaseLease(this.queue, owner);
    }
    return result;
  }

  #group(rows: StoredChange[]): Group[] {
    const groups = new Map<string, Group>();
    for (const row of [...rows].sort((a, b) => a.id - b.id)) {
      let g = groups.get(row.groupKey);
      if (!g) {
        g = {
          key: row.groupKey,
          baseId: row.baseId,
          table: row.table,
          recordId: row.recordId,
          match: row.match,
          typecast: false,
          rows: [],
          fields: {},
        };
        groups.set(row.groupKey, g);
      }
      g.rows.push(row);
      g.typecast ||= row.typecast;
      Object.assign(g.fields, row.fields);
    }
    return [...groups.values()];
  }

  /**
   * Leave out fields that a newer, already-sent change has set. That only
   * happens when an old failed change is retried after newer ones went out.
   */
  async #dropSuperseded(groups: Group[]): Promise<void> {
    const oldest = Math.min(...groups.map((g) => g.rows[0]!.id));
    const sent = await this.#store.loadSentAfter(this.queue, groups.map((g) => g.key), oldest);
    if (sent.length === 0) return;
    // For every group and field: the ID of the latest change that already delivered it.
    const delivered = new Map<string, Map<string, number>>();
    for (const s of sent) {
      const perField = delivered.get(s.groupKey) ?? new Map<string, number>();
      for (const name of Object.keys(s.fields)) perField.set(name, Math.max(perField.get(name) ?? 0, s.id));
      delivered.set(s.groupKey, perField);
    }
    for (const g of groups) {
      const perField = delivered.get(g.key);
      if (!perField) continue;
      // Replay the pending changes oldest first, skipping values that a later
      // delivered change has already replaced in Airtable.
      const merged: FieldValues = {};
      for (const row of g.rows) {
        for (const [name, value] of Object.entries(row.fields)) {
          if (g.match?.includes(name) || row.id > (perField.get(name) ?? 0)) merged[name] = value;
        }
      }
      g.fields = merged;
    }
  }

  /** Split groups into requests: same base, table, kind and options, at most batchSize each. */
  #batches(groups: Group[]): Group[][] {
    const buckets = new Map<string, Group[]>();
    for (const g of groups) {
      const key = JSON.stringify([g.baseId, g.table, g.match, g.typecast]);
      const list = buckets.get(key) ?? [];
      list.push(g);
      buckets.set(key, list);
    }
    const out: Group[][] = [];
    for (const list of buckets.values()) {
      for (let i = 0; i < list.length; i += this.#client.batchSize) {
        out.push(list.slice(i, i + this.#client.batchSize));
      }
    }
    return out;
  }

  /** @returns `true` if the lease was lost and the run must stop. */
  async #send(batch: Group[], renew: () => Promise<boolean>, result: ProcessResult): Promise<boolean> {
    // A group whose fields were all superseded has nothing left to write.
    const empty = batch.filter((g) => this.#nothingToSend(g));
    for (const g of empty) {
      await this.#store.markSent(g.rows.map((r) => r.id), this.#clock.now());
      result.sent += g.rows.length;
    }
    const todo = batch.filter((g) => !empty.includes(g));
    if (todo.length === 0) return false;

    if (!await renew()) return true;
    const first = todo[0]!;
    const table = this.#client.table(first.baseId, first.table);
    result.requests++;
    try {
      if (first.match) {
        const res = await table.upsert(todo.map((g) => ({ fields: g.fields })), {
          fieldsToMergeOn: first.match,
          typecast: first.typecast,
        });
        const created = new Set(res.createdRecords);
        for (const [i, g] of todo.entries()) {
          const id = res.records[i]?.id ?? null;
          await this.#succeeded(g, result, id, id ? created.has(id) : undefined);
        }
      } else {
        await table.update(todo.map((g) => ({ id: g.recordId!, fields: g.fields })), { typecast: first.typecast });
        for (const g of todo) await this.#succeeded(g, result, g.recordId);
      }
    } catch (error) {
      if (isPermanentError(error) && todo.length > 1) {
        // One bad record fails the whole request. Send each alone to find it.
        for (const g of todo) {
          if (await this.#send([g], renew, result)) return true;
        }
        return false;
      }
      for (const g of todo) await this.#failedAttempt(g, error, result);
    }
    return false;
  }

  #nothingToSend(g: Group): boolean {
    const own = Object.keys(g.fields).filter((k) => !g.match?.includes(k));
    if (own.length > 0) return false;
    // A match-only upsert (create if missing) still has to be sent once.
    const original = new Set(g.rows.flatMap((r) => Object.keys(r.fields)).filter((k) => !g.match?.includes(k)));
    return original.size > 0;
  }

  async #succeeded(g: Group, result: ProcessResult, recordId: string | null, created?: boolean): Promise<void> {
    await this.#store.markSent(g.rows.map((r) => r.id), this.#clock.now());
    result.written++;
    result.sent += g.rows.length;
    await this.#hook(this.#options.onSent, {
      queue: this.queue,
      baseId: g.baseId,
      table: g.table,
      recordId,
      match: g.match,
      fields: g.fields,
      changes: g.rows.map((r) => ({ id: r.id, createdAt: r.createdAt })),
      ...(created === undefined ? {} : { created }),
    });
  }

  async #failedAttempt(g: Group, error: unknown, result: ProcessResult): Promise<void> {
    const attempts = Math.max(...g.rows.map((r) => r.attempts)) + 1;
    const giveUp = isPermanentError(error) || attempts >= this.#maxAttempts;
    const now = this.#clock.now();
    const nextAttemptAt = giveUp ? now : now + Math.max(0, this.#backoff(attempts));
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await this.#store.recordFailure(g.rows.map((r) => r.id), {
      attempts,
      status: giveUp ? "failed" : "pending",
      nextAttemptAt,
      error: message,
    });
    if (giveUp) result.failed += g.rows.length;
    else result.retrying += g.rows.length;
    await this.#hook(this.#options.onFailed, {
      queue: this.queue,
      baseId: g.baseId,
      table: g.table,
      recordId: g.recordId,
      match: g.match,
      fields: g.fields,
      changes: g.rows.map((r) => ({ id: r.id, createdAt: r.createdAt })),
      error,
      attempts,
      willRetry: !giveUp,
      nextAttemptAt: giveUp ? null : nextAttemptAt,
    });
  }

  async #hook<E>(hook: ((event: E) => void | Promise<void>) | undefined, event: E): Promise<void> {
    if (!hook) return;
    try {
      await hook(event);
    } catch (error) {
      try {
        this.#options.onHookError?.(error);
      } catch {
        // Nothing more to do: a broken error handler must not stop the run.
      }
    }
  }
}
