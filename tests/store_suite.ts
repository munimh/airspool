/**
 * The behaviour every OutboxStore must have. Each adapter's test file runs
 * this suite against a fresh store.
 */
import { assert, assertEquals } from "@std/assert";
import { AirtableClient, type NewChange, Outbox, type OutboxStore, RateLimiter } from "../mod.ts";
import { FakeClock } from "./fake_clock.ts";
import { MockAirtable, TEST_TOKEN } from "./mock_airtable.ts";

const BASE = "appTESTBASE000001";
const T0 = Date.UTC(2030, 0, 1);

const change = (over: Partial<NewChange> = {}): NewChange => ({
  queue: "q",
  groupKey: "g1",
  baseId: BASE,
  table: "Tasks",
  recordId: "recTASK000000001",
  match: null,
  fields: { Status: "Done" },
  typecast: false,
  createdAt: T0,
  ...over,
});

export function storeSuite(name: string, make: () => Promise<OutboxStore>, options: { ignore?: boolean } = {}) {
  const test = (title: string, fn: (store: OutboxStore) => Promise<void>) =>
    Deno.test({
      name: `${name}: ${title}`,
      ignore: options.ignore,
      sanitizeResources: false,
      sanitizeOps: false,
      fn: async () => await fn(await make()),
    });

  test("insert returns the stored change with defaults", async (s) => {
    const c = await s.insert(change({ fields: { Status: "Done", "Due date": "2030-02-01", Count: 3, Done: true } }));
    assert(c.id > 0);
    assertEquals(c.status, "pending");
    assertEquals(c.attempts, 0);
    assertEquals(c.nextAttemptAt, T0);
    assertEquals(c.createdAt, T0);
    assertEquals(c.fields, { Status: "Done", "Due date": "2030-02-01", Count: 3, Done: true });
    assertEquals(c.lastError, null);
    assertEquals(c.sentAt, null);
    const m = await s.insert(change({ groupKey: "g2", recordId: null, match: ["Name"], typecast: true }));
    assertEquals(m.match, ["Name"]);
    assertEquals(m.typecast, true);
    assert(m.id > c.id);
  });

  test("loadDue returns whole groups, oldest group first, and respects the limit", async (s) => {
    const a1 = await s.insert(change({ groupKey: "a" }));
    const b1 = await s.insert(change({ groupKey: "b" }));
    const a2 = await s.insert(change({ groupKey: "a", fields: { Status: "Open" } }));
    await s.insert(change({ groupKey: "c" }));
    await s.insert(change({ groupKey: "a", queue: "other" }));
    const due = await s.loadDue("q", T0, 2);
    assertEquals(due.map((c) => c.id), [a1.id, b1.id, a2.id]);
  });

  test("a group is due only when all its changes are due", async (s) => {
    const a = await s.insert(change({ groupKey: "a" }));
    await s.recordFailure([a.id], { attempts: 1, status: "pending", nextAttemptAt: T0 + 60_000, error: "x" });
    await s.insert(change({ groupKey: "a", createdAt: T0 + 1000 }));
    assertEquals((await s.loadDue("q", T0 + 59_999, 10)).length, 0);
    assertEquals((await s.loadDue("q", T0 + 60_000, 10)).length, 2);
  });

  test("markSent, recordFailure and counts", async (s) => {
    const a = await s.insert(change({ groupKey: "a" }));
    const b = await s.insert(change({ groupKey: "b" }));
    const c = await s.insert(change({ groupKey: "c" }));
    await s.insert(change({ groupKey: "d" }));
    await s.markSent([a.id], T0 + 5);
    await s.recordFailure([b.id], { attempts: 1, status: "pending", nextAttemptAt: T0 + 60_000, error: "later" });
    await s.recordFailure([c.id], { attempts: 3, status: "failed", nextAttemptAt: T0, error: "no" });
    assertEquals(await s.counts("q"), { pending: 1, retrying: 1, failed: 1 });
    assertEquals(await s.counts("empty"), { pending: 0, retrying: 0, failed: 0 });
    const [failed] = await s.listFailed("q", 10);
    assertEquals(failed!.id, c.id);
    assertEquals(failed!.attempts, 3);
    assertEquals(failed!.lastError, "no");
    const [sent] = await s.loadSentAfter("q", ["a"], 0);
    assertEquals(sent!.sentAt, T0 + 5);
    assertEquals(sent!.attempts, 1);
  });

  test("retry and discard by id and all", async (s) => {
    const ids: number[] = [];
    for (const g of ["a", "b", "c", "d"]) {
      const c = await s.insert(change({ groupKey: g }));
      await s.recordFailure([c.id], { attempts: 5, status: "failed", nextAttemptAt: T0, error: "e" });
      ids.push(c.id);
    }
    const pending = await s.insert(change({ groupKey: "e" }));
    assertEquals(await s.retry("q", [ids[0]!, pending.id], T0 + 10), 1);
    const [retried] = await s.loadDue("q", T0 + 10, 10);
    assertEquals(retried!.id, ids[0]);
    assertEquals(retried!.attempts, 0);
    assertEquals(retried!.lastError, null);
    assertEquals(await s.discard("q", [ids[1]!]), 1);
    assertEquals(await s.discard("q", []), 0);
    assertEquals(await s.retry("q", [], T0), 0);
    assertEquals(await s.retry("q", "all", T0), 2);
    await s.recordFailure([ids[2]!, ids[3]!], { attempts: 5, status: "failed", nextAttemptAt: T0, error: "e" });
    assertEquals(await s.discard("q", "all"), 2);
    assertEquals(await s.counts("q"), { pending: 2, retrying: 0, failed: 0 });
  });

  test("loadSentAfter filters by group and id", async (s) => {
    const a1 = await s.insert(change({ groupKey: "a" }));
    const a2 = await s.insert(change({ groupKey: "a" }));
    const b1 = await s.insert(change({ groupKey: "b" }));
    await s.markSent([a1.id, a2.id, b1.id], T0);
    assertEquals((await s.loadSentAfter("q", ["a"], a1.id)).map((c) => c.id), [a2.id]);
    assertEquals((await s.loadSentAfter("q", ["a", "b"], 0)).length, 3);
    assertEquals(await s.loadSentAfter("q", [], 0), []);
  });

  test("purgeSent keeps groups that still have failed changes", async (s) => {
    const a = await s.insert(change({ groupKey: "a" }));
    const b = await s.insert(change({ groupKey: "b" }));
    const bOld = await s.insert(change({ groupKey: "b" }));
    await s.markSent([a.id, b.id], T0);
    await s.recordFailure([bOld.id], { attempts: 1, status: "failed", nextAttemptAt: T0, error: "e" });
    assertEquals(await s.purgeSent("q", T0), 0);
    assertEquals(await s.purgeSent("q", T0 + 1), 1);
    assertEquals((await s.loadSentAfter("q", ["a", "b"], 0)).map((c) => c.id), [b.id]);
  });

  test("lease: one holder at a time, renewable, expires, releasable", async (s) => {
    assert(await s.acquireLease("q", "w1", T0 + 100, T0));
    assert(!await s.acquireLease("q", "w2", T0 + 100, T0 + 50));
    assert(await s.acquireLease("other", "w2", T0 + 100, T0), "queues have separate leases");
    assert(await s.renewLease("q", "w1", T0 + 200));
    assert(!await s.acquireLease("q", "w2", T0 + 300, T0 + 150));
    assert(await s.acquireLease("q", "w2", T0 + 400, T0 + 200), "an expired lease can be taken");
    assert(!await s.renewLease("q", "w1", T0 + 500), "the old holder cannot renew");
    await s.releaseLease("q", "w1");
    assert(!await s.acquireLease("q", "w3", T0 + 500, T0 + 300), "release by a non-holder does nothing");
    await s.releaseLease("q", "w2");
    assert(!await s.renewLease("q", "w2", T0 + 500), "a released lease cannot be renewed");
    assert(await s.acquireLease("q", "w3", T0 + 500, T0 + 300));
  });

  test("lease: many acquirers at once, exactly one wins", async (s) => {
    for (let round = 0; round < 5; round++) {
      const queue = `race${round}`;
      const wins = await Promise.all(
        Array.from({ length: 8 }, (_, i) => s.acquireLease(queue, `w${i}`, T0 + 1000, T0)),
      );
      assertEquals(wins.filter(Boolean).length, 1);
    }
  });

  test("end to end: merge, batch and upsert through an outbox", async (s) => {
    const clock = new FakeClock(T0);
    const fake = new MockAirtable({ clock });
    const client = new AirtableClient({
      token: TEST_TOKEN,
      fetch: fake.fetch,
      clock,
      rateLimiter: new RateLimiter({ clock }),
    });
    const outbox = new Outbox({ store: s, client, clock, queue: "e2e" });
    for (let i = 1; i <= 11; i++) fake.seed(BASE, "Tasks", `recTASK${String(i).padStart(9, "0")}`, {});
    for (let i = 1; i <= 11; i++) {
      const recordId = `recTASK${String(i).padStart(9, "0")}`;
      await outbox.enqueue({ baseId: BASE, table: "Tasks", recordId, fields: { Status: "Open" } });
      await outbox.enqueue({
        baseId: BASE,
        table: "Tasks",
        recordId,
        fields: { Status: "Done", "Due date": "2030-03-01" },
      });
    }
    await outbox.enqueue({ baseId: BASE, table: "Tasks", match: ["Name"], fields: { Name: "Plan", Status: "Open" } });
    const result = await clock.run(outbox.process());
    assertEquals(result.written, 12);
    assertEquals(result.sent, 23);
    assertEquals(fake.writes().length, 3);
    assertEquals(fake.record(BASE, "Tasks", "recTASK000000011")!.fields, { Status: "Done", "Due date": "2030-03-01" });
    assertEquals(await outbox.status(), { pending: 0, retrying: 0, failed: 0 });
  });
}
