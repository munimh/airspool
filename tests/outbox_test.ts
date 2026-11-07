import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  AirtableClient,
  type FailedEvent,
  memoryStore,
  Outbox,
  type OutboxOptions,
  type OutboxStore,
  RateLimiter,
  type SentEvent,
} from "../mod.ts";
import { FakeClock, flush } from "./fake_clock.ts";
import { errorResponse, json, MockAirtable, TEST_TOKEN } from "./mock_airtable.ts";

const BASE = "appTESTBASE000001";
const MINUTE = 60_000;

function setup(
  options: Partial<OutboxOptions> & { maxRetries?: number; timeoutMs?: number; store?: OutboxStore } = {},
) {
  const clock = new FakeClock();
  const fake = new MockAirtable({
    clock,
    schema: { [`${BASE}/Tasks`]: ["Name", "Status", "Due date", "Notes", "Email"] },
  });
  const limiter = new RateLimiter({ clock });
  const client = new AirtableClient({
    token: TEST_TOKEN,
    fetch: fake.fetch,
    clock,
    rateLimiter: limiter,
    random: () => 0,
    maxRetries: options.maxRetries ?? 0,
    timeoutMs: options.timeoutMs,
  });
  const store = options.store ?? memoryStore();
  const sent: SentEvent[] = [];
  const failed: FailedEvent[] = [];
  const outbox = new Outbox({
    store,
    client,
    clock,
    onSent: (e) => void sent.push(e),
    onFailed: (e) => void failed.push(e),
    ...options,
  });
  return { clock, fake, client, store, outbox, sent, failed };
}

const task = (n: number) => `recTASK${String(n).padStart(9, "0")}`;

Deno.test("enqueue only writes to the store", async () => {
  const { fake, outbox } = setup();
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  assertEquals(fake.requests.length, 0);
  assertEquals(await outbox.status(), { pending: 1, retrying: 0, failed: 0 });
});

Deno.test("enqueue checks its input", async () => {
  const { outbox } = setup();
  const base = { baseId: BASE, table: "Tasks" };
  await assertRejects(() => outbox.enqueue({ ...base, fields: { Status: "Done" } }), TypeError);
  await assertRejects(() => outbox.enqueue({ ...base, recordId: task(1), match: ["Name"], fields: {} }), TypeError);
  await assertRejects(() => outbox.enqueue({ ...base, recordId: task(1), fields: {} }), TypeError);
  await assertRejects(() => outbox.enqueue({ ...base, match: ["Email"], fields: { Name: "x" } }), TypeError);
  await assertRejects(
    () => outbox.enqueue({ ...base, match: ["A", "B", "C", "D"], fields: { A: 1, B: 2, C: 3, D: 4 } }),
    TypeError,
  );
});

Deno.test("several changes to one record go out as one write, newest value wins", async () => {
  const { clock, fake, outbox, sent } = setup();
  fake.seed(BASE, "Tasks", task(1), { Name: "Write report", Status: "Open" });
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "In progress" } });
  await clock.advance(1000);
  await outbox.enqueue({
    baseId: BASE,
    table: "Tasks",
    recordId: task(1),
    fields: { Status: "Blocked", "Due date": "2030-02-01" },
  });
  await clock.advance(1000);
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });

  const result = await clock.run(outbox.process());
  assertEquals(fake.writes().length, 1);
  assertEquals(fake.writes()[0]!.body!.records, [{
    id: task(1),
    fields: { Status: "Done", "Due date": "2030-02-01" },
  }]);
  assertEquals(fake.record(BASE, "Tasks", task(1))!.fields, {
    Name: "Write report",
    Status: "Done",
    "Due date": "2030-02-01",
  });
  assertEquals(result, { ran: true, written: 1, sent: 3, retrying: 0, failed: 0, requests: 1 });
  assertEquals(sent.length, 1);
  assertEquals(sent[0]!.changes.map((c) => c.id), [1, 2, 3]);
  assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 0 });
});

Deno.test("changes to different records in one table are batched, ten per request", async () => {
  const { clock, fake, outbox } = setup();
  for (let i = 1; i <= 12; i++) {
    fake.seed(BASE, "Tasks", task(i), {});
    await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(i), fields: { Status: "Done" } });
  }
  fake.seed(BASE, "Projects", "recPROJ000000001", {});
  await outbox.enqueue({ baseId: BASE, table: "Projects", recordId: "recPROJ000000001", fields: { Name: "Q3" } });

  const result = await clock.run(outbox.process());
  const sizes = fake.writes().map((r) => `${r.table}:${(r.body!.records as unknown[]).length}`);
  assertEquals(sizes.sort(), ["Projects:1", "Tasks:10", "Tasks:2"]);
  assertEquals(result.written, 13);
  assertEquals(fake.violations.length, 0);
});

Deno.test("upsert by match field: merged per match value, created then updated", async () => {
  const { clock, fake, outbox, sent } = setup();
  const target = { baseId: BASE, table: "Tasks", match: ["Email"] };
  await outbox.enqueue({ ...target, fields: { Email: "sam@example.com", Name: "Sam's task" } });
  await outbox.enqueue({ ...target, fields: { Email: "sam@example.com", Status: "Open" } });
  await outbox.enqueue({ ...target, fields: { Email: "lee@example.com", Status: "Open" } });

  await clock.run(outbox.process());
  const write = fake.writes()[0]!;
  assertEquals(fake.writes().length, 1);
  assertEquals(write.body!.performUpsert, { fieldsToMergeOn: ["Email"] });
  assertEquals((write.body!.records as unknown[]).length, 2);
  assertEquals(fake.all(BASE, "Tasks").length, 2);
  assert(sent.every((e) => e.created === true && e.recordId?.startsWith("rec")));

  await outbox.enqueue({ ...target, fields: { Email: "sam@example.com", Status: "Done" } });
  await clock.run(outbox.process());
  assertEquals(fake.all(BASE, "Tasks").length, 2);
  const sam = fake.all(BASE, "Tasks").find((r) => r.fields.Email === "sam@example.com")!;
  assertEquals(sam.fields, { Email: "sam@example.com", Name: "Sam's task", Status: "Done" });
  assertEquals(sent.at(-1)!.created, false);
  assertEquals(sent.at(-1)!.recordId, sam.id);
});

Deno.test("an error that means the request was wrong fails at once, with the error kept", async () => {
  const { clock, fake, outbox, failed } = setup();
  fake.seed(BASE, "Tasks", task(1), {});
  const change = await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Colour: "Red" } });

  const result = await clock.run(outbox.process());
  assertEquals(result.failed, 1);
  assertEquals(fake.writes().length, 1);
  assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 1 });
  const [kept] = await outbox.failed();
  assertEquals(kept!.id, change.id);
  assertEquals(kept!.attempts, 1);
  assertStringIncludes(kept!.lastError!, "UNKNOWN_FIELD_NAME");
  assertEquals(failed[0]!.willRetry, false);
  assertEquals(failed[0]!.nextAttemptAt, null);

  // Nothing more happens on later runs until someone acts.
  await clock.advance(60 * MINUTE);
  await clock.run(outbox.process());
  assertEquals(fake.writes().length, 1);
});

Deno.test("one bad record in a batch fails alone; the others are sent", async () => {
  const { clock, fake, outbox } = setup();
  for (let i = 1; i <= 3; i++) fake.seed(BASE, "Tasks", task(i), {});
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(2), fields: { Colour: "Red" } });
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(3), fields: { Status: "Open" } });

  const result = await clock.run(outbox.process());
  assertEquals(result.sent, 2);
  assertEquals(result.failed, 1);
  assertEquals(fake.record(BASE, "Tasks", task(1))!.fields.Status, "Done");
  assertEquals(fake.record(BASE, "Tasks", task(3))!.fields.Status, "Open");
  assertEquals((await outbox.failed())[0]!.recordId, task(2));
});

Deno.test("an unknown record is a permanent failure", async () => {
  const { clock, outbox } = setup();
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: "recDOESNOTEXIST01", fields: { Status: "Done" } });
  await clock.run(outbox.process());
  assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 1 });
});

Deno.test("temporary errors retry after 1, 2, 4, 8 minutes, then fail after max tries", async () => {
  const { clock, fake, outbox, failed } = setup();
  fake.intercept = () => errorResponse(503, "RETRIABLE_ERROR", "try again");
  fake.seed(BASE, "Tasks", task(1), {});
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });

  const tries: number[] = [];
  const start = clock.now();
  for (let minute = 0; minute <= 20; minute++) {
    const before = fake.writes().length;
    await clock.run(outbox.process());
    if (fake.writes().length > before) tries.push((clock.now() - start) / MINUTE);
    if (minute === 0) assertEquals(await outbox.status(), { pending: 0, retrying: 1, failed: 0 });
    await clock.advance(MINUTE);
  }
  // Tries at 0, then 1, 2, 4 and 8 minutes after each previous one.
  assertEquals(tries.map(Math.round), [0, 1, 3, 7, 15]);
  assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 1 });
  assertEquals(failed.map((e) => e.willRetry), [true, true, true, true, false]);
  assertEquals(
    failed.slice(0, 4).map((e, i) => (e.nextAttemptAt! - (start + tries[i]! * MINUTE)) / MINUTE),
    [1, 2, 4, 8],
  );
});

Deno.test("maxAttempts and backoff are configurable", async () => {
  const { clock, fake, outbox } = setup({ maxAttempts: 2, backoff: () => 5_000, clientRetries: { maxRetries: 0 } });
  fake.intercept = () => errorResponse(502, "BAD_GATEWAY");
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  await clock.run(outbox.process());
  await clock.advance(4_999);
  await clock.run(outbox.process());
  assertEquals(fake.writes().length, 1);
  await clock.advance(1);
  await clock.run(outbox.process());
  assertEquals(fake.writes().length, 2);
  assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 1 });
});

Deno.test("a new change for a record that is backing off waits with it", async () => {
  const { clock, fake, outbox } = setup({ clientRetries: { maxRetries: 0 } });
  fake.seed(BASE, "Tasks", task(1), {});
  fake.script.push(errorResponse(503, "RETRIABLE_ERROR"));
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Open" } });
  await clock.run(outbox.process());
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  await clock.run(outbox.process());
  assertEquals(fake.writes().length, 1, "sent before its backoff ended");
  await clock.advance(MINUTE);
  await clock.run(outbox.process());
  assertEquals(fake.writes().length, 2);
  assertEquals(fake.record(BASE, "Tasks", task(1))!.fields.Status, "Done");
});

Deno.test("retry() sends failed changes again; discard() removes them", async () => {
  const { clock, fake, outbox } = setup();
  for (let i = 1; i <= 3; i++) fake.seed(BASE, "Tasks", task(i), {});
  fake.intercept = () => errorResponse(422, "INVALID_REQUEST_UNKNOWN", "refused");
  const a = await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  const b = await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(2), fields: { Status: "Done" } });
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(3), fields: { Status: "Done" } });
  await clock.run(outbox.process());
  assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 3 });

  fake.intercept = undefined;
  assertEquals(await outbox.retry([a.id]), 1);
  assertEquals(await outbox.status(), { pending: 1, retrying: 0, failed: 2 });
  await clock.run(outbox.process());
  assertEquals(fake.record(BASE, "Tasks", task(1))!.fields.Status, "Done");

  assertEquals(await outbox.discard([b.id]), 1);
  assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 1 });
  assertEquals(await outbox.retry("all"), 1);
  await clock.run(outbox.process());
  assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 0 });
  assertEquals(fake.record(BASE, "Tasks", task(2))!.fields, {});
  assertEquals(await outbox.discard("all"), 0);
});

Deno.test("a retried old change never overwrites a newer value that already went out", async () => {
  const { clock, fake, outbox } = setup();
  fake.seed(BASE, "Tasks", task(1), {});
  fake.script.push(errorResponse(422, "INVALID_REQUEST_UNKNOWN", "refused once"));
  const old = await outbox.enqueue({
    baseId: BASE,
    table: "Tasks",
    recordId: task(1),
    fields: { Status: "Open", Notes: "first" },
  });
  await clock.run(outbox.process());
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  await clock.run(outbox.process());
  assertEquals(fake.record(BASE, "Tasks", task(1))!.fields, { Status: "Done" });

  await outbox.retry([old.id]);
  await clock.run(outbox.process());
  assertEquals(fake.writes().at(-1)!.body!.records, [{ id: task(1), fields: { Notes: "first" } }]);
  assertEquals(fake.record(BASE, "Tasks", task(1))!.fields, { Status: "Done", Notes: "first" });
});

Deno.test("a retried change whose every field was superseded is marked sent without a request", async () => {
  const { clock, fake, outbox } = setup();
  fake.seed(BASE, "Tasks", task(1), {});
  fake.script.push(errorResponse(422, "INVALID_REQUEST_UNKNOWN", "refused once"));
  const old = await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Open" } });
  await clock.run(outbox.process());
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  await clock.run(outbox.process());
  const writes = fake.writes().length;
  await outbox.retry([old.id]);
  const result = await clock.run(outbox.process());
  assertEquals(fake.writes().length, writes);
  assertEquals(result.sent, 1);
  assertEquals(fake.record(BASE, "Tasks", task(1))!.fields.Status, "Done");
});

Deno.test("two processors racing: only one runs", async () => {
  const shared = memoryStore();
  const a = setup({ store: shared });
  const b = setup({ store: shared });
  a.fake.seed(BASE, "Tasks", task(1), {});
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  a.fake.intercept = async () => {
    await gate;
    return undefined;
  };
  await a.outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });

  const first = a.outbox.process();
  await flush();
  const second = await b.outbox.process();
  assertEquals(second.ran, false);
  release();
  const done = await a.clock.run(first);
  assertEquals(done.ran, true);
  assertEquals(a.fake.writes().length + b.fake.writes().length, 1);
});

Deno.test("a worker that dies mid-run loses its lease, and another takes over", async () => {
  const shared = memoryStore();
  const crashed = setup({ store: shared, leaseMs: 30_000, timeoutMs: 5_000 });
  crashed.fake.intercept = () => () => new Promise<Response>(() => {}); // never answers
  const live = setup({ store: shared, leaseMs: 30_000, timeoutMs: 5_000 });
  live.fake.seed(BASE, "Tasks", task(1), {});
  await crashed.outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });

  void crashed.outbox.process(); // hangs forever, like a killed worker
  await flush();
  assertEquals((await live.outbox.process()).ran, false);

  // The live worker's clock is the one the store compares against.
  await live.clock.advance(30_001);
  const result = await live.clock.run(live.outbox.process());
  assertEquals(result.ran, true);
  assertEquals(result.sent, 1);
  assertEquals(live.fake.record(BASE, "Tasks", task(1))!.fields.Status, "Done");
});

Deno.test("a worker whose lease was taken stops before its next request", async () => {
  const shared = memoryStore();
  const clock = new FakeClock();
  const fake = new MockAirtable({ clock });
  for (let i = 1; i <= 11; i++) fake.seed(BASE, "Tasks", task(i), {});
  const client = new AirtableClient({
    token: TEST_TOKEN,
    fetch: fake.fetch,
    clock,
    rateLimiter: new RateLimiter({ clock }),
    timeoutMs: 5_000,
  });
  const slow = new Outbox({ store: shared, client, clock, leaseMs: 10_000 });
  const quick = new Outbox({ store: shared, client, clock, leaseMs: 10_000 });
  for (let i = 1; i <= 11; i++) {
    await slow.enqueue({ baseId: BASE, table: "Tasks", recordId: task(i), fields: { Status: "Done" } });
  }
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fake.intercept = async () => {
    fake.intercept = undefined;
    await gate;
    return undefined;
  };
  const slowRun = slow.process();
  await flush();
  await clock.advance(10_001);
  const quickRun = await clock.run(quick.process());
  assertEquals(quickRun.ran, true);
  release();
  const slowResult = await clock.run(slowRun);
  assertEquals(slowResult.stopped, "lease_lost");
  assertEquals(slowResult.requests, 1);
  assertEquals(await quick.status(), { pending: 0, retrying: 0, failed: 0 });
});

Deno.test("timeLimitMs stops a long run between requests", async () => {
  const { clock, fake, outbox } = setup();
  for (let i = 1; i <= 50; i++) {
    fake.seed(BASE, "Tasks", task(i), {});
    await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(i), fields: { Status: "Done" } });
  }
  const result = await clock.run(outbox.process({ timeLimitMs: 500 }));
  assertEquals(result.stopped, "time_limit");
  assert(result.requests < 5);
  assertEquals((await outbox.status()).pending, 50 - result.sent);
  await clock.run(outbox.process());
  assertEquals((await outbox.status()).pending, 0);
});

Deno.test("a hook that throws does not stop the run", async () => {
  const hookErrors: unknown[] = [];
  const { clock, fake, outbox } = setup({
    onSent: () => {
      throw new Error("hook broke");
    },
    onHookError: (e) => hookErrors.push(e),
  });
  for (let i = 1; i <= 2; i++) {
    fake.seed(BASE, "Tasks", task(i), {});
    await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(i), fields: { Status: "Done" } });
  }
  const result = await clock.run(outbox.process());
  assertEquals(result.written, 2);
  assertEquals(hookErrors.length, 2);
});

Deno.test("typecast is sent when any merged change asks for it", async () => {
  const { clock, fake, outbox } = setup();
  fake.seed(BASE, "Tasks", task(1), {});
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Open" } });
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Notes: "x" }, typecast: true });
  await clock.run(outbox.process());
  assertEquals(fake.writes()[0]!.body!.typecast, true);
});

Deno.test("queues in one store are separate", async () => {
  const shared = memoryStore();
  const a = setup({ store: shared, queue: "a" });
  const b = setup({ store: shared, queue: "b" });
  await a.outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  assertEquals((await b.outbox.status()).pending, 0);
  assertEquals((await a.outbox.status()).pending, 1);
});

Deno.test("sent changes are purged after keepSentMs", async () => {
  const store = memoryStore();
  const { clock, fake, outbox } = setup({ store, keepSentMs: MINUTE });
  fake.seed(BASE, "Tasks", task(1), {});
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  await clock.run(outbox.process());
  assertEquals((await store.loadSentAfter("default", [JSON.stringify([BASE, "Tasks", "id", task(1)])], 0)).length, 1);
  await clock.advance(MINUTE + 1);
  await clock.run(outbox.process());
  assertEquals((await store.loadSentAfter("default", [JSON.stringify([BASE, "Tasks", "id", task(1)])], 0)).length, 0);
});

Deno.test("withStore shares settings but writes elsewhere", async () => {
  const { outbox } = setup();
  const other = memoryStore();
  await outbox.withStore(other).enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { A: 1 } });
  assertEquals((await outbox.status()).pending, 0);
  assertEquals((await other.counts("default")).pending, 1);
});

Deno.test("upsert answers carry the record id into onSent even when Airtable sends extra keys", async () => {
  const { clock, fake, outbox, sent } = setup();
  fake.script.push(
    json(200, {
      records: [{ id: task(9), createdTime: "", fields: {} }],
      createdRecords: [],
      updatedRecords: [task(9)],
      extra: 1,
    }),
  );
  await outbox.enqueue({ baseId: BASE, table: "Tasks", match: ["Name"], fields: { Name: "Plan", Status: "Open" } });
  await clock.run(outbox.process());
  assertEquals(sent[0]!.recordId, task(9));
  assertEquals(sent[0]!.created, false);
});

Deno.test("leaseMs must be longer than the client's timeoutMs", () => {
  const client = new AirtableClient({ token: TEST_TOKEN, timeoutMs: 30_000 });
  let error: unknown;
  try {
    new Outbox({ store: memoryStore(), client, leaseMs: 30_000 });
  } catch (e) {
    error = e;
  }
  assert(error instanceof RangeError);
  new Outbox({ store: memoryStore(), client, leaseMs: 30_001 });
});

Deno.test("a worker that lost its lease does not retry a request afterwards", async () => {
  const shared = memoryStore();
  const clock = new FakeClock();
  const fake = new MockAirtable({ clock });
  fake.seed(BASE, "Tasks", task(1), {});
  const client = new AirtableClient({
    token: TEST_TOKEN,
    fetch: fake.fetch,
    clock,
    rateLimiter: new RateLimiter({ clock }),
    timeoutMs: 5_000,
    random: () => 0,
  });
  const slow = new Outbox({ store: shared, client, clock, leaseMs: 10_000 });
  const quick = new Outbox({ store: shared, client, clock, leaseMs: 10_000 });
  await slow.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Open" } });

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fake.intercept = async () => {
    fake.intercept = undefined;
    await gate;
    return errorResponse(503, "RETRIABLE_ERROR"); // the slow worker's first try fails late
  };
  const slowRun = slow.process();
  await flush();
  await clock.advance(10_001);
  await quick.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  const quickRun = await clock.run(quick.process());
  assertEquals(quickRun.written, 1);
  release();
  const slowResult = await clock.run(slowRun);

  assertEquals(slowResult.stopped, "lease_lost");
  assertEquals(slowResult.requests, 1, "the slow worker must not retry after losing its lease");
  assertEquals(fake.writes().length, 2);
  assertEquals(fake.record(BASE, "Tasks", task(1))!.fields.Status, "Done");
});

Deno.test("a 429 is left to the outbox's backoff, and the time limit stops the next attempt", async () => {
  const { clock, fake, outbox } = setup({ timeoutMs: 5_000 });
  fake.seed(BASE, "Tasks", task(1), {});
  fake.seed(BASE, "Projects", "recPROJ000000001", {});
  fake.script.push(errorResponse(429, "RATE_LIMIT_REACHED", "Rate limit exceeded"));
  await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId: task(1), fields: { Status: "Done" } });
  await outbox.enqueue({ baseId: BASE, table: "Projects", recordId: "recPROJ000000001", fields: { Name: "Q3" } });

  const result = await clock.run(outbox.process({ timeLimitMs: 10_000 }));
  assertEquals(result.requests, 1, "the client must not sit out the 429 itself");
  assertEquals(result.retrying, 1);
  assertEquals(result.stopped, "time_limit");
  assertEquals(await outbox.status(), { pending: 1, retrying: 1, failed: 0 });
  assertEquals(fake.writes().length, 1);
});
