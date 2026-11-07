# airspool

Reliable Airtable writes from a backend.

- **A rate-limited client.** Built on `fetch` with no runtime dependencies. Requests from every caller in the process
  share one pacer, so together they stay under Airtable's per-base and per-token limits. Writes are split into the
  largest batches Airtable accepts. A 429 waits the documented 30 seconds, temporary failures are retried with jittered
  backoff, and a request that was wrong fails at once with Airtable's error type and message.
- **A durable outbox.** Enqueueing a change only writes a row to your database. A processor, run on a schedule or on
  demand, merges all waiting changes for each record (newest value wins), batches records of the same table, and retries
  failures with growing gaps. Failed changes stay visible until you retry or discard them. Only one processor runs per
  queue at a time, even with many workers.

Runs on Deno, Node 18+, Bun, Supabase Edge Functions and Cloudflare Workers.

```sh
deno add jsr:@munimh/airspool   # Deno / JSR
npm install airspool            # Node, Bun, Workers
```

## Quick start

```ts
import { AirtableClient, Outbox, postgresStore } from "@munimh/airspool"; // npm: "airspool"
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
const client = new AirtableClient({ token: process.env.AIRTABLE_TOKEN! });

// Direct calls, rate limited and retried:
const tasks = client.table("appExampleBase0001", "Tasks");
const open = await tasks.listAll({ filterByFormula: "{Status} = 'Open'", fields: ["Name", "Due date"] });

// Or queue writes and let the outbox deliver them:
const outbox = new Outbox({
  client,
  store: postgresStore({ run: (text, params) => sql.unsafe(text, params as never[]) }),
});

await outbox.enqueue({
  baseId: "appExampleBase0001",
  table: "Tasks",
  recordId: "recExampleTask0001",
  fields: { Status: "Done" },
});

await outbox.process(); // from a cron job, a scheduled function, or right after enqueueing
```

Create the tables once with [`sql/postgres.sql`](sql/postgres.sql) (or `await store.migrate()`).

## Why an outbox

Say your backend sends a customer an email and then marks the task in Airtable:

```ts
await sendEmail(customer, "Your order has shipped");
await tasks.update([{ id: taskId, fields: { Status: "Customer notified" } }]); // Airtable is down
```

The email went out but the Airtable write failed. Retrying the whole handler sends the email twice. Not retrying it
leaves Airtable wrong, and the next person to look at the base emails the customer again. Wrapping the call in a retry
loop only helps until the process restarts, times out, or the outage lasts longer than your loop.

With an outbox, the handler records the change in your own database, which is up whenever your app is, and moves on:

```ts
await sendEmail(customer, "Your order has shipped");
await outbox.enqueue({ baseId, table: "Tasks", recordId: taskId, fields: { Status: "Customer notified" } });
```

The processor delivers it when Airtable answers, however long that takes, and it stays queued across restarts and
deploys. If Airtable refuses it (say someone renamed the field), it stays in the outbox as `failed` with Airtable's
message, and `outbox.status()` tells you so, instead of being lost in a log.

If your main action is itself a database write, enqueue in the same transaction so both happen or neither does:

```ts
await sql.begin(async (tx) => {
  await tx`UPDATE orders SET shipped_at = now() WHERE id = ${orderId}`;
  const txStore = postgresStore({ run: (text, params) => tx.unsafe(text, params as never[]) });
  await outbox.withStore(txStore).enqueue({ baseId, table: "Orders", recordId, fields: { Status: "Shipped" } });
});
```

## The client

```ts
const client = new AirtableClient({ token });
const tasks = client.table("appExampleBase0001", "Tasks"); // table name or ID (IDs survive renames)

await tasks.create([{ fields: { Name: "Write report", Status: "Open" } }], { typecast: true });
await tasks.update([{ id: "recExampleTask0001", fields: { Status: "Done" } }]); // PATCH
await tasks.update([{ id: "recExampleTask0001", fields: { Name: "Only this" } }], { replace: true }); // PUT
const { createdRecords, updatedRecords } = await tasks.upsert(
  [{ fields: { Email: "sam@example.com", Status: "Open" } }],
  { fieldsToMergeOn: ["Email"] },
);
await tasks.delete(["recExampleTask0001", "recExampleTask0002"]);
const one = await tasks.get("recExampleTask0001");

for await (const task of tasks.list({ view: "Open tasks", sort: [{ field: "Due date" }] })) {
  console.log(task.id, task.fields["Due date"]);
}
```

Every write method takes any number of records and sends them in requests of 10. The requests go out in order; if one
fails, the earlier ones are already saved. Use the outbox when every write must land.

`list()` pages through results one request at a time. A formula too long for a URL (Airtable rejects URLs of 16,000
characters or more) is sent with the `listRecords` POST form instead.

Type your fields if you like: `client.table<{ Name: string; Status: "Open" | "Done" }>(base, "Tasks")`.

### Rate limits

Airtable allows
[5 requests per second per base, and 50 per second for all traffic using one personal access token
or service account](https://airtable.com/developers/web/api/rate-limits). Every request takes a slot in its base's lane
and its token's lane of a `RateLimiter` before it is sent. Slots are claimed synchronously and spaced 210 ms apart per
base and 21 ms apart per token (the documented rate plus a 5% margin), so any number of concurrent callers queue up
instead of bursting.

All clients in a process share one limiter by default. Pass your own `rateLimiter` to isolate a client, or give the same
one to clients you create separately. The limiter is per process: if you run several processes against one base, lower
`perBase` on each (for example `new RateLimiter({ perBase: 2 })` for two processes), or rely on the outbox, where only
one processor sends at a time.

After a 429 Airtable rejects further requests for a while; the
[docs](https://airtable.com/developers/web/api/rate-limits) say to wait 30 seconds. The client pauses that base's lane
for `rateLimitPauseMs` (30 s). Every caller on that base waits out the pause, including requests that were already
queued when the 429 arrived, then the client tries again, up to `maxRateLimitRetries` (2) times.

Airtable also has monthly API call allowances that depend on your plan; see
[Managing API call limits](https://support.airtable.com/articles/7735693959-managing-api-call-limits-in-airtable).
Batching and the outbox's merging both reduce how many calls you use.

### Errors and retries

Every error the client throws is an `AirtableApiError` with `kind`, `status`, `type` (Airtable's error type, such as
`INVALID_REQUEST_UNKNOWN` or `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND`), `airtableMessage` and `retryable`.

| Answer                                  | Class                    | Retried by the client                                                          | Outbox               |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ | -------------------- |
| 400, 401, 403, 404, 413, 422, other 4xx | `AirtableRequestError`   | No: the request was wrong                                                      | Fails at once        |
| 429                                     | `AirtableRateLimitError` | After 30 s, up to 2 times                                                      | Retries with backoff |
| 500, 502, 503, 504                      | `AirtableServerError`    | Up to 3 times, jittered backoff; honours `Retry-After` up to `retryMaxDelayMs` | Retries with backoff |
| No answer (network error, timeout)      | `AirtableNetworkError`   | Up to 3 times, jittered backoff                                                | Retries with backoff |

Errors are classified by HTTP status, following Airtable's
[error reference](https://airtable.com/developers/web/api/errors), so an error type Airtable adds later is handled too.
`isPermanentError(e)` tells you whether retrying can help.

A create is not idempotent: if the answer is lost, the record may exist already. So `create()` is only retried after a
429, 502 or 503 (which Airtable says are safe to retry), not after a network error, timeout or 500. Updates, upserts,
deletes and reads are retried in all those cases.

Backoff is "full jitter": a random wait between 0 and `retryBaseDelayMs * 2^n` (500 ms, 1 s, 2 s, ... at most
`retryMaxDelayMs`, 8 s). A `Retry-After` header longer than `retryMaxDelayMs` is not waited for: the request fails at
once with a retryable `AirtableServerError`, so a long server hint cannot block your process. An answer whose body
cannot be read is retried like a network error.

Two options help when you build on the client:

- `beforeAttempt` is called before every HTTP attempt, after the rate-limit wait. Throwing from it stops the request
  without sending anything.
- `client.withOptions({ ... })` returns a client with some options changed that keeps the same token and shares the same
  rate-limit lanes.

### The token

The token is held outside the object's own properties, so `console.log(client)`, `JSON.stringify(client)` and error
messages never contain it. The library logs nothing.

## The outbox

```ts
const outbox = new Outbox({
  client,
  store,
  queue: "default", // several queues can share one store
  maxAttempts: 5, // then the change is marked failed
  backoff: (attempt) => Math.min(60_000 * 2 ** (attempt - 1), 3_600_000), // 1, 2, 4, 8 ... min (the default)
  leaseMs: 120_000, // must be longer than the client's timeoutMs
  clientRetries: { maxRetries: 1, maxRateLimitRetries: 0 }, // the default; see below
  onSent: (e) => console.log("sent", e.table, e.recordId, e.changes.length),
  onFailed: (e) => e.willRetry || alertSomeone(e),
});
```

### Enqueueing

```ts
// By record ID:
await outbox.enqueue({ baseId, table: "Tasks", recordId: "recExampleTask0001", fields: { Status: "Done" } });

// By match field (upsert): updates the record whose Email matches, or creates it.
await outbox.enqueue({
  baseId,
  table: "Contacts",
  match: ["Email"], // one to three fields; their values must be in `fields`
  fields: { Email: "sam@example.com", Status: "Subscribed" },
});
```

`enqueue()` never calls Airtable. Use the same table string (name or ID) for a record everywhere, because changes are
merged by base, table and record.

### Processing

`process()` takes the queue's lease, then repeatedly:

1. loads due changes from the store, grouped by target record;
2. merges each group oldest first, so the newest value of each field wins;
3. sends groups for the same table together, 10 records per request (upserts with the same match fields together);
4. marks the changes sent, or records the failure.

```ts
const result = await outbox.process({ timeLimitMs: 50_000 });
// { ran: true, written: 12, sent: 30, retrying: 1, failed: 0, requests: 2 }
```

If another worker holds the lease, `process()` returns `{ ran: false }` at once. The lease is renewed right before every
HTTP attempt, retries included, so a worker that lost its lease can never send an old value after another worker sent a
newer one. A worker that dies stops renewing, and after `leaseMs` another worker takes over. `leaseMs` must be longer
than the client's `timeoutMs`, which bounds one attempt; the constructor checks this.

While sending, the outbox runs the client with `clientRetries` (by default one quick retry for network errors and 5xx,
and no waiting out 429s). The outbox's own backoff handles longer outages, and runs stay short. `timeLimitMs` is checked
before every attempt; a run can still overrun it by one attempt (`timeoutMs`) plus one rate-limit pause, so leave that
much room below a hard deadline.

If Airtable refuses a batch as invalid, the outbox sends its records one at a time to find the bad one, so one bad
record does not hold back the other nine.

### Retries and failures

A temporary error (429, 5xx, network) schedules the whole group again after `backoff(attempts)`. A new change for a
record that is waiting out a backoff waits with it, so values are never sent out of order. After `maxAttempts` tries, or
at once for an error that means the request was wrong, the changes are marked `failed` with the last error and stay
there.

```ts
await outbox.status(); // { pending: 3, retrying: 1, failed: 2 }
const failed = await outbox.failed(); // with .lastError, .attempts, .fields
await outbox.retry([failed[0].id]); // or retry("all")
await outbox.discard([failed[1].id]); // or discard("all")
```

A retried change keeps its place in line: it is merged with any newer waiting changes for that record, and a field that
a newer change already sent is left out, so a retry never puts an old value back. Sent changes are kept for `keepSentMs`
(7 days) for that purpose, and longer while their record still has failed changes.

### Delivery guarantee

At least once. If a worker dies after Airtable saved a write but before the store marked it sent, the next run sends it
again. Updates and upserts set the same values again, so that is harmless. This is also why the outbox does not offer
plain creates: use an upsert on a field you control (an order number, an email) instead.

## Stores

The outbox keeps its data behind a small `OutboxStore` interface. Three ship with the library.

### Postgres

`postgresStore({ run })` needs only a function that runs SQL with `$1`-style parameters and returns rows:

```ts
// postgres.js (also Supabase Edge Functions)
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL!, { prepare: false }); // prepare: false for transaction poolers
const store = postgresStore({ run: (text, params) => sql.unsafe(text, params as never[]) });

// node-postgres
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = postgresStore({ run: async (text, params) => (await pool.query(text, params as unknown[])).rows });
```

The migration is a plain file: [`sql/postgres.sql`](sql/postgres.sql) (also exported as `POSTGRES_SCHEMA`, and run by
`store.migrate()`). Options: `schema`, and `tablePrefix` (default `airspool_`). The lease is an ordinary row, not a
session-level advisory lock, so it works through PgBouncer and Supabase's pooler in transaction mode.

### SQLite

For a single machine, on SQLite 3.35 or newer. Schema: [`sql/sqlite.sql`](sql/sqlite.sql).

```ts
import { DatabaseSync } from "node:sqlite"; // Node 22+, Deno, Bun
const db = new DatabaseSync("outbox.db");
const store = sqliteStore({ run: (sql, params) => Promise.resolve(db.prepare(sql).all(...params as never[])) });
await store.migrate();
```

With better-sqlite3, which refuses `.all()` on statements without rows:
`run: (sql, p) => { const s = db.prepare(sql); return Promise.resolve(s.reader ? s.all(...p) : (s.run(...p), [])); }`.

### Memory

`memoryStore()` keeps everything in memory, for tests.

### Your own

Implement `OutboxStore` (see its JSDoc). Only `acquireLease` has to be atomic across processes.

## Supabase

A complete example is in [`examples/supabase`](examples/supabase):

- [`migrations/…_airspool.sql`](examples/supabase/migrations/20300101000000_airspool.sql) creates the tables;
- [`functions/send-reminder`](examples/supabase/functions/send-reminder/index.ts) sends an email and enqueues the
  Airtable update;
- [`functions/airspool-process`](examples/supabase/functions/airspool-process/index.ts) runs the processor;
- [`migrations/…_airspool_schedule.sql`](examples/supabase/migrations/20300101000001_airspool_schedule.sql) calls it
  every minute with `pg_cron` and `pg_net`.

The processor function in short:

```ts
import { AirtableClient, Outbox, postgresStore } from "jsr:@munimh/airspool";
import postgres from "npm:postgres";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false });
const outbox = new Outbox({
  client: new AirtableClient({ token: Deno.env.get("AIRTABLE_TOKEN")! }),
  store: postgresStore({ run: (text, params) => sql.unsafe(text, params as never[]) }),
});

Deno.serve(async (req) => {
  if (req.headers.get("authorization") !== `Bearer ${Deno.env.get("AIRSPOOL_CRON_SECRET")}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const result = await outbox.process({ timeLimitMs: 50_000 });
  return Response.json({ ...result, ...(await outbox.status()) });
});
```

## Runtimes

The library uses only `fetch`, `AbortController`, `setTimeout`, `structuredClone` and standard JavaScript. It is tested
on Deno and on Node 18, 20, 22 and 24, and the built package is checked under Bun. On Cloudflare Workers, create the
client inside the request handler or a module-level lazy getter, since secrets arrive with the request's `env`; keep
`process()` runs short with `timeLimitMs`.

## Airtable API reference

Behaviour in this library follows Airtable's documentation:

- [Rate limits](https://airtable.com/developers/web/api/rate-limits): 5 requests/s per base, 50 requests/s per token,
  wait 30 s after a 429.
- [Errors](https://airtable.com/developers/web/api/errors): status codes and the error body shape.
- [Create records](https://airtable.com/developers/web/api/create-records),
  [update multiple records](https://airtable.com/developers/web/api/update-multiple-records) (including `performUpsert`
  / `fieldsToMergeOn` and `typecast`),
  [delete multiple records](https://airtable.com/developers/web/api/delete-multiple-records),
  [get record](https://airtable.com/developers/web/api/get-record),
  [list records](https://airtable.com/developers/web/api/list-records).
- [Managing API call limits](https://support.airtable.com/articles/7735693959-managing-api-call-limits-in-airtable): 10
  records per create or update request, and monthly call allowances. The per-request record count is not repeated on the
  API reference pages themselves, so it is configurable: `new AirtableClient({ batchSize })`.

## Development

```sh
deno task check   # fmt, lint, type check, doc lint
deno task test    # unit tests; Postgres tests run when DATABASE_URL is set
npm run build && npm run test:node
```

## Licence

[MIT](LICENSE)
