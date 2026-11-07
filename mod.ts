/**
 * Reliable Airtable writes from a backend.
 *
 * - {@link AirtableClient}: a small `fetch`-based client that stays under
 *   Airtable's rate limits across every caller in the process, batches
 *   writes, waits out 429s and retries temporary failures.
 * - {@link Outbox}: a durable queue of writes. Enqueue cheaply now; a
 *   processor merges changes per record and sends them, retrying with
 *   backoff, one processor at a time.
 * - Stores: {@link memoryStore}, {@link postgresStore}, {@link sqliteStore}.
 *
 * @example
 * ```ts
 * import { AirtableClient, Outbox, postgresStore } from "@munimh/airspool";
 * import postgres from "npm:postgres";
 *
 * const sql = postgres(Deno.env.get("DATABASE_URL")!);
 * const outbox = new Outbox({
 *   store: postgresStore({ run: (text, params) => sql.unsafe(text, params as never[]) }),
 *   client: new AirtableClient({ token: Deno.env.get("AIRTABLE_TOKEN")! }),
 * });
 *
 * await outbox.enqueue({
 *   baseId: "appExampleBase0001",
 *   table: "Tasks",
 *   recordId: "recExampleTask0001",
 *   fields: { Status: "Done" },
 * });
 * await outbox.process();
 * ```
 *
 * @module
 */

export { type Clock, systemClock } from "./src/clock.ts";
export {
  AirtableApiError,
  type AirtableErrorKind,
  AirtableNetworkError,
  AirtableRateLimitError,
  AirtableRequestError,
  AirtableServerError,
  isPermanentError,
} from "./src/errors.ts";
export { RateLimiter, type RateLimiterOptions, sharedRateLimiter } from "./src/rate_limiter.ts";
export {
  AirtableClient,
  type AirtableClientOptions,
  type AirtableRecord,
  AirtableTable,
  type FieldValues,
  type GetOptions,
  type ListOptions,
  type RequestSpec,
  type SortRule,
  type UpdateOptions,
  type UpsertOptions,
  type UpsertResult,
  type WriteOptions,
} from "./src/client.ts";
export type { ChangeStatus, FailureUpdate, NewChange, OutboxCounts, OutboxStore, StoredChange } from "./src/store.ts";
export {
  type ChangeInput,
  type ChangeRef,
  defaultBackoff,
  type FailedEvent,
  Outbox,
  type OutboxOptions,
  type ProcessOptions,
  type ProcessResult,
  type SentEvent,
} from "./src/outbox.ts";
export { memoryStore } from "./src/stores/memory.ts";
export {
  POSTGRES_SCHEMA,
  postgresStore,
  type PostgresStoreOptions,
  SQLITE_SCHEMA,
  sqliteStore,
  type SqlOutboxStore,
  type SqlRunner,
  type SqlStoreOptions,
} from "./src/stores/sql.ts";
