import { assert, assertEquals, assertInstanceOf, assertRejects, assertStringIncludes } from "@std/assert";
import {
  AirtableApiError,
  AirtableClient,
  AirtableNetworkError,
  AirtableRateLimitError,
  AirtableRequestError,
  AirtableServerError,
  isPermanentError,
  RateLimiter,
} from "../mod.ts";
import { FakeClock } from "./fake_clock.ts";
import { busiestSecond, errorResponse, json, MockAirtable, TEST_TOKEN } from "./mock_airtable.ts";

const BASE = "appTESTBASE000001";
const OTHER_BASE = "appTESTBASE000002";

function setup(options: { random?: () => number; maxRetries?: number; schema?: Record<string, string[]> } = {}) {
  const clock = new FakeClock();
  const fake = new MockAirtable({ clock, schema: options.schema });
  const limiter = new RateLimiter({ clock });
  const make = () =>
    new AirtableClient({
      token: TEST_TOKEN,
      fetch: fake.fetch,
      clock,
      rateLimiter: limiter,
      random: options.random ?? (() => 0.5),
      maxRetries: options.maxRetries,
    });
  return { clock, fake, limiter, client: make(), make };
}

Deno.test("many callers on several clients stay under 5 requests a second per base", async () => {
  const { clock, fake, make } = setup();
  fake.seed(BASE, "Tasks", "recTASK000000001", { Name: "Write report" });
  const clients = [make(), make(), make()];
  const calls = Array.from({ length: 40 }, (_, i) => clients[i % 3]!.table(BASE, "Tasks").get("recTASK000000001"));
  await clock.run(Promise.all(calls));

  assertEquals(fake.requests.length, 40);
  assertEquals(fake.violations.length, 0);
  assert(busiestSecond(fake.requests, BASE) <= 5);
  // 40 requests at one every 210 ms take about 8.2 seconds, not much more.
  const span = fake.requests.at(-1)!.at - fake.requests[0]!.at;
  assert(span >= 39 * 200 && span <= 39 * 220, `span was ${span}`);
});

Deno.test("different bases do not wait for each other, but the token limit still applies", async () => {
  const { clock, fake, client } = setup();
  const bases = Array.from({ length: 12 }, (_, i) => `appTESTBASE${String(i).padStart(6, "0")}`);
  for (const b of bases) fake.seed(b, "Tasks", "recTASK000000001", {});
  const calls = Array.from({ length: 60 }, (_, i) => client.table(bases[i % 12]!, "Tasks").get("recTASK000000001"));
  await clock.run(Promise.all(calls));

  assertEquals(fake.violations.length, 0);
  for (const b of bases) assert(busiestSecond(fake.requests, b) <= 5);
  assert(busiestSecond(fake.requests) <= 50, `token saw ${busiestSecond(fake.requests)} in one second`);
  // Base two's first request did not queue behind base one's.
  const firstOfSecondBase = fake.requests.find((r) => r.baseId === bases[1])!;
  assert(firstOfSecondBase.at - fake.requests[0]!.at < 100);
});

Deno.test("after a 429 the client waits 30 seconds and holds back other callers on that base", async () => {
  const { clock, fake, client } = setup();
  fake.seed(BASE, "Tasks", "recTASK000000001", { Name: "A" });
  fake.script.push(errorResponse(429, "RATE_LIMIT_REACHED", "Rate limit exceeded. Please try again later"));
  const table = client.table(BASE, "Tasks");

  const first = table.get("recTASK000000001");
  await clock.advance(1);
  const second = table.get("recTASK000000001");
  const [a, b] = await clock.run(Promise.all([first, second]));

  assertEquals(a.fields.Name, "A");
  assertEquals(b.fields.Name, "A");
  const [limited, ...rest] = fake.requests;
  assertEquals(fake.requests.length, 3);
  for (const r of rest) assert(r.at - limited!.at >= 30_000, "a request went out during the 30 second wait");
});

Deno.test("429 on every try ends in a rate limit error, which is retryable", async () => {
  const { clock, fake, client } = setup();
  for (let i = 0; i < 3; i++) fake.script.push(errorResponse(429, "RATE_LIMIT_REACHED", "Rate limit exceeded"));
  const error = await clock.run(client.table(BASE, "Tasks").get("recTASK000000001").catch((e) => e));
  assertInstanceOf(error, AirtableRateLimitError);
  assertEquals(error.status, 429);
  assertEquals(error.type, "RATE_LIMIT_REACHED");
  assert(error.retryable);
  assertEquals(fake.requests.length, 3);
});

Deno.test("writes are split into requests of 10 records", async () => {
  const { clock, fake, client } = setup();
  const table = client.table(BASE, "Tasks");
  const created = await clock.run(
    table.create(Array.from({ length: 25 }, (_, i) => ({ fields: { Name: `Task ${i}` } }))),
  );
  assertEquals(created.length, 25);
  assertEquals(fake.writes().map((r) => (r.body!.records as unknown[]).length), [10, 10, 5]);

  fake.requests.length = 0;
  await clock.run(table.update(created.slice(0, 10).map((r) => ({ id: r.id, fields: { Status: "Done" } }))));
  assertEquals(fake.requests.length, 1);
  assertEquals(fake.requests[0]!.method, "PATCH");

  fake.requests.length = 0;
  const deleted = await clock.run(table.delete(created.slice(0, 21).map((r) => r.id)));
  assertEquals(deleted.length, 21);
  assertEquals(fake.requests.map((r) => r.url.searchParams.getAll("records[]").length), [10, 10, 1]);
  assertEquals(fake.all(BASE, "Tasks").length, 4);
});

Deno.test("update with replace sends PUT; typecast is sent in the body", async () => {
  const { clock, fake, client } = setup();
  fake.seed(BASE, "Tasks", "recTASK000000001", { Name: "A", Status: "Open" });
  await clock.run(
    client.table(BASE, "Tasks").update([{ id: "recTASK000000001", fields: { Name: "B" } }], {
      replace: true,
      typecast: true,
    }),
  );
  assertEquals(fake.requests[0]!.method, "PUT");
  assertEquals(fake.requests[0]!.body!.typecast, true);
  assertEquals(fake.record(BASE, "Tasks", "recTASK000000001")!.fields, { Name: "B" });
});

Deno.test("upsert sends performUpsert and reports created and updated records", async () => {
  const { clock, fake, client } = setup();
  fake.seed(BASE, "Tasks", "recTASK000000001", { Name: "Existing", Status: "Open" });
  const result = await clock.run(
    client.table(BASE, "Tasks").upsert(
      [{ fields: { Name: "Existing", Status: "Done" } }, { fields: { Name: "New", Status: "Open" } }],
      { fieldsToMergeOn: ["Name"] },
    ),
  );
  assertEquals(fake.requests[0]!.body!.performUpsert, { fieldsToMergeOn: ["Name"] });
  assertEquals(result.updatedRecords, ["recTASK000000001"]);
  assertEquals(result.createdRecords.length, 1);
  assertEquals(result.records.length, 2);
  assertEquals(fake.record(BASE, "Tasks", "recTASK000000001")!.fields.Status, "Done");
  await assertRejects(
    () => client.table(BASE, "Tasks").upsert([], { fieldsToMergeOn: ["A", "B", "C", "D"] }),
    TypeError,
  );
});

Deno.test("a request error is not retried and carries Airtable's type and message", async () => {
  const { clock, fake, client } = setup({ schema: { [`${BASE}/Tasks`]: ["Name", "Status"] } });
  fake.seed(BASE, "Tasks", "recTASK000000001", {});
  const error = await clock.run(
    client.table(BASE, "Tasks").update([{ id: "recTASK000000001", fields: { Colour: "Red" } }]).catch((e) => e),
  );
  assertInstanceOf(error, AirtableRequestError);
  assertEquals(error.status, 422);
  assertEquals(error.type, "UNKNOWN_FIELD_NAME");
  assertStringIncludes(error.airtableMessage!, "Colour");
  assertEquals(error.retryable, false);
  assert(isPermanentError(error));
  assertEquals(fake.requests.length, 1);
});

for (
  const [status, type] of [[403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"], [404, "NOT_FOUND"], [
    401,
    "AUTHENTICATION_REQUIRED",
  ]] as const
) {
  Deno.test(`a ${status} is a request error and is not retried`, async () => {
    const { clock, fake, client } = setup();
    fake.script.push(errorResponse(status, type, "refused"));
    const error = await clock.run(client.table(BASE, "Tasks").get("recTASK000000001").catch((e) => e));
    assertInstanceOf(error, AirtableRequestError);
    assertEquals(error.type, type);
    assertEquals(fake.requests.length, 1);
  });
}

Deno.test("the older error shape, a bare string, still gives a type", async () => {
  const { clock, fake, client } = setup();
  fake.script.push(json(404, { error: "NOT_FOUND" }));
  const error = await clock.run(client.table(BASE, "Tasks").get("recMISSING0000001").catch((e) => e));
  assertInstanceOf(error, AirtableRequestError);
  assertEquals(error.type, "NOT_FOUND");
});

Deno.test("5xx answers are retried with jittered, growing backoff", async () => {
  const { clock, fake, client } = setup({ random: () => 0.5 });
  fake.seed(BASE, "Tasks", "recTASK000000001", { Name: "A" });
  fake.script.push(errorResponse(500, "SERVER_ERROR"), errorResponse(502, "BAD_GATEWAY"));
  const rec = await clock.run(client.table(BASE, "Tasks").get("recTASK000000001"));
  assertEquals(rec.fields.Name, "A");
  const [a, b, c] = fake.requests.map((r) => r.at);
  // Full jitter with random() = 0.5: half of 500 ms, then half of 1000 ms.
  assertEquals(b! - a!, 250);
  assertEquals(c! - b!, 500);
});

Deno.test("Retry-After on a 503 is honoured", async () => {
  const { clock, fake, client } = setup();
  fake.seed(BASE, "Tasks", "recTASK000000001", {});
  fake.script.push(json(503, { error: { type: "RETRIABLE_ERROR" } }, { "retry-after": "7" }));
  await clock.run(client.table(BASE, "Tasks").get("recTASK000000001"));
  assertEquals(fake.requests[1]!.at - fake.requests[0]!.at, 7000);
});

Deno.test("persistent 5xx ends in a server error after maxRetries", async () => {
  const { clock, fake, client } = setup({ maxRetries: 2 });
  for (let i = 0; i < 5; i++) fake.script.push(errorResponse(503, "RETRIABLE_ERROR"));
  const error = await clock.run(client.table(BASE, "Tasks").get("recTASK000000001").catch((e) => e));
  assertInstanceOf(error, AirtableServerError);
  assert(error.retryable);
  assertEquals(fake.requests.length, 3);
});

Deno.test("network errors are retried for updates but not for creates", async () => {
  const { clock, fake, client } = setup();
  fake.seed(BASE, "Tasks", "recTASK000000001", {});
  fake.script.push(new TypeError("connection reset"));
  await clock.run(client.table(BASE, "Tasks").update([{ id: "recTASK000000001", fields: { Name: "A" } }]));
  assertEquals(fake.requests.length, 2);

  fake.requests.length = 0;
  fake.script.push(new TypeError("connection reset"));
  const error = await clock.run(client.table(BASE, "Tasks").create([{ fields: { Name: "B" } }]).catch((e) => e));
  assertInstanceOf(error, AirtableNetworkError);
  assertEquals(error.status, 0);
  assertEquals(fake.requests.length, 1, "a create must not be sent twice after a lost answer");

  fake.requests.length = 0;
  fake.script.push(errorResponse(500, "SERVER_ERROR"));
  assertInstanceOf(
    await clock.run(client.table(BASE, "Tasks").create([{ fields: {} }]).catch((e) => e)),
    AirtableServerError,
  );
  assertEquals(fake.requests.length, 1);

  fake.requests.length = 0;
  fake.script.push(errorResponse(503, "RETRIABLE_ERROR"));
  await clock.run(client.table(BASE, "Tasks").create([{ fields: { Name: "C" } }]));
  assertEquals(fake.requests.length, 2, "Airtable says 503 is safe to retry");
});

Deno.test("list pages through results with filter, fields and sort", async () => {
  const { clock, fake, client } = setup();
  for (let i = 0; i < 230; i++) {
    fake.seed(BASE, "Tasks", `recTASK${String(i).padStart(9, "0")}`, { Status: i % 2 ? "Open" : "Done" });
  }
  const open = await clock.run(
    client.table(BASE, "Tasks").listAll({
      filterByFormula: "{Status} = 'Open'",
      fields: ["Status", "Due date"],
      sort: [{ field: "Due date", direction: "desc" }],
    }),
  );
  assertEquals(open.length, 115);
  assertEquals(fake.requests.length, 2);
  const q = fake.requests[0]!.url.searchParams;
  assertEquals(q.get("filterByFormula"), "{Status} = 'Open'");
  assertEquals(q.getAll("fields[]"), ["Status", "Due date"]);
  assertEquals(q.get("sort[0][field]"), "Due date");
  assertEquals(q.get("sort[0][direction]"), "desc");
  assertEquals(fake.requests[1]!.url.searchParams.get("offset"), "100");
});

Deno.test("a formula too long for a URL is sent with POST listRecords", async () => {
  const { clock, fake, client } = setup();
  fake.seed(BASE, "Tasks", "recTASK000000001", { Name: "x" });
  const formula = `OR(${Array.from({ length: 2000 }, (_, i) => `{Name}='n${i}'`).join(",")})`;
  await clock.run(client.table(BASE, "Tasks").listAll({ filterByFormula: formula }));
  assertEquals(fake.requests[0]!.method, "POST");
  assert(fake.requests[0]!.url.pathname.endsWith("/listRecords"));
  assertEquals(fake.requests[0]!.body!.filterByFormula, formula);
});

Deno.test("the token never shows up in logs, JSON or error messages", async () => {
  const { clock, fake, client } = setup();
  assert(!Deno.inspect(client, { depth: 10, showHidden: true }).includes(TEST_TOKEN));
  assert(!JSON.stringify(client).includes(TEST_TOKEN));
  assert(!String(client).includes(TEST_TOKEN));

  fake.script.push(new TypeError("boom"));
  const net = await clock.run(client.table(BASE, "Tasks").create([{ fields: {} }]).catch((e) => e));
  fake.script.push(errorResponse(422, "INVALID_REQUEST_UNKNOWN", "bad"));
  const req = await clock.run(client.table(BASE, "Tasks").get("recUNKNOWN0000001").catch((e) => e));
  for (const e of [net, req]) {
    assertInstanceOf(e, AirtableApiError);
    assert(!Deno.inspect(e, { depth: 10 }).includes(TEST_TOKEN));
  }
});

Deno.test("a request that never answers times out as a network error", async () => {
  const fake = new MockAirtable({ clock: new FakeClock() });
  const client = new AirtableClient({
    token: TEST_TOKEN,
    rateLimiter: new RateLimiter(),
    maxRetries: 0,
    timeoutMs: 20,
    fetch: (input, init) =>
      new Promise((_, fail) => {
        init?.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
        void fake;
        void input;
      }),
  });
  const error = await client.table(OTHER_BASE, "Tasks").get("recTASK000000001").catch((e) => e);
  assertInstanceOf(error, AirtableNetworkError);
  assertStringIncludes(error.message, "no answer within 20 ms");
});

Deno.test("constructor checks its options", () => {
  let threw = false;
  try {
    new AirtableClient({ token: "" });
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assert(threw);
});
