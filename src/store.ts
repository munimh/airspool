import type { FieldValues } from "./client.ts";

/**
 * Where a change is in its life.
 *
 * - `pending`: waiting to be sent (for the first time, or again after a
 *   temporary error; see {@link StoredChange.attempts}).
 * - `sent`: written to Airtable. Kept for a while so an older change that is
 *   retried later cannot overwrite a newer value.
 * - `failed`: gave up. Stays until {@link Outbox.retry} or {@link Outbox.discard}.
 */
export type ChangeStatus = "pending" | "sent" | "failed";

/** A change as it is written to the store. */
export interface NewChange {
  /** Queue name. One store can hold several queues. */
  queue: string;
  /** Identifies the target record. Changes with the same key are merged. */
  groupKey: string;
  /** Base ID. */
  baseId: string;
  /** Table ID or name. */
  table: string;
  /** Target record ID, when the record is known. */
  recordId: string | null;
  /** Merge fields for an upsert, when the record is found by value. */
  match: string[] | null;
  /** Cell values to set. */
  fields: FieldValues;
  /** Send with `typecast: true`. */
  typecast: boolean;
  /** Enqueue time, ms since the epoch. */
  createdAt: number;
}

/** A change as the store returns it. */
export interface StoredChange extends NewChange {
  /** Assigned by the store. Larger means enqueued later. */
  id: number;
  /** Current status. */
  status: ChangeStatus;
  /** Sends tried so far. */
  attempts: number;
  /** Not sent before this time, ms since the epoch. */
  nextAttemptAt: number;
  /** Message of the last failed send. */
  lastError: string | null;
  /** When it was sent, ms since the epoch. */
  sentAt: number | null;
}

/** Counts returned by {@link Outbox.status}. */
export interface OutboxCounts {
  /** Waiting for their first send. */
  pending: number;
  /** Waiting to be sent again after a temporary error. */
  retrying: number;
  /** Given up; waiting for `retry()` or `discard()`. */
  failed: number;
}

/** The outcome of a failed send, as recorded by {@link OutboxStore.recordFailure}. */
export interface FailureUpdate {
  /** New attempt count for every change in the group. */
  attempts: number;
  /** `pending` to try again at `nextAttemptAt`, or `failed` to give up. */
  status: "pending" | "failed";
  /** When to try again, ms since the epoch. */
  nextAttemptAt: number;
  /** Error message to keep. */
  error: string;
}

/**
 * Storage behind an {@link Outbox}. Implement this to keep changes anywhere;
 * {@link memoryStore}, {@link postgresStore} and {@link sqliteStore} are
 * ready-made.
 *
 * Every method must be safe to call from several processes at once. Only
 * {@link OutboxStore.acquireLease} needs to be atomic: the outbox calls the
 * other write methods only while it holds the lease.
 */
export interface OutboxStore {
  /** Save a new change with status `pending`, attempts 0, `nextAttemptAt` = `createdAt`. */
  insert(change: NewChange): Promise<StoredChange>;

  /**
   * Take or extend the queue's lease. Succeeds when nobody holds it, the
   * holder's lease ended at or before `now`, or `owner` already holds it.
   *
   * @returns `true` when `owner` now holds the lease until `expiresAt`.
   */
  acquireLease(queue: string, owner: string, expiresAt: number, now: number): Promise<boolean>;

  /**
   * Extend a lease that `owner` still holds, even if it has run out, as long
   * as nobody else has taken or released it since.
   *
   * @returns `false` when `owner` no longer holds the lease.
   */
  renewLease(queue: string, owner: string, expiresAt: number): Promise<boolean>;

  /** Give up the lease if `owner` holds it. */
  releaseLease(queue: string, owner: string): Promise<void>;

  /**
   * Pending changes of up to `maxGroups` due groups, ordered by `id`.
   * A group (all pending changes with one `groupKey`) is due when every one
   * of its changes has `nextAttemptAt <= now`. Groups whose oldest change is
   * oldest come first.
   */
  loadDue(queue: string, now: number, maxGroups: number): Promise<StoredChange[]>;

  /** Sent changes in these groups with `id > afterId`, ordered by `id`. */
  loadSentAfter(queue: string, groupKeys: string[], afterId: number): Promise<StoredChange[]>;

  /** Mark changes sent: status `sent`, `sentAt` = `now`, attempts + 1, no error. */
  markSent(ids: number[], now: number): Promise<void>;

  /** Record a failed send for these changes. */
  recordFailure(ids: number[], update: FailureUpdate): Promise<void>;

  /**
   * Put failed changes back to `pending` with attempts 0 and
   * `nextAttemptAt` = `now`. `"all"` means every failed change in the queue.
   *
   * @returns How many changes were reset.
   */
  retry(queue: string, ids: number[] | "all", now: number): Promise<number>;

  /**
   * Delete failed changes. `"all"` means every failed change in the queue.
   *
   * @returns How many changes were deleted.
   */
  discard(queue: string, ids: number[] | "all"): Promise<number>;

  /** Counts of pending, retrying and failed changes. */
  counts(queue: string): Promise<OutboxCounts>;

  /** Failed changes, oldest first. */
  listFailed(queue: string, limit: number): Promise<StoredChange[]>;

  /**
   * Delete sent changes with `sentAt < before`, except in groups that still
   * have failed changes (those are needed to protect newer values).
   *
   * @returns How many changes were deleted.
   */
  purgeSent(queue: string, before: number): Promise<number>;
}
