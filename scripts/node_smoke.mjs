// Checks the built npm package in Node: imports it by name through the
// "exports" map, sends writes through a fake fetch, and runs an outbox on
// the memory store (and on node:sqlite where Node has it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AirtableClient,
  AirtableRequestError,
  memoryStore,
  Outbox,
  POSTGRES_SCHEMA,
  RateLimiter,
  sqliteStore,
} from "airspool";

const TOKEN = "patTESTONLY.notarealtoken0000000000000000";
const records = new Map([["recTASK000000001", { Status: "Open" }]]);
const seen = [];

/** Just enough of the API for this check. */
function fakeFetch(url, init) {
  seen.push({ method: init.method, url: String(url), body: init.body && JSON.parse(init.body) });
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  const body = init.body ? JSON.parse(init.body) : {};
  if (init.method === "PATCH") {
    const out = [];
    for (const r of body.records) {
      if (r.fields.Colour) {
        return new Response(JSON.stringify({ error: { type: "UNKNOWN_FIELD_NAME", message: "Unknown field name" } }), {
          status: 422,
        });
      }
      const fields = { ...(records.get(r.id) ?? {}), ...r.fields };
      records.set(r.id, fields);
      out.push({ id: r.id, createdTime: "2030-01-01T00:00:00.000Z", fields });
    }
    return Promise.resolve(new Response(JSON.stringify({ records: out }), { status: 200 }));
  }
  return Promise.resolve(new Response(JSON.stringify({ records: [] }), { status: 200 }));
}

const client = new AirtableClient({ token: TOKEN, fetch: fakeFetch, rateLimiter: new RateLimiter() });
const outbox = new Outbox({ store: memoryStore(), client });
await outbox.enqueue({
  baseId: "appTESTBASE000001",
  table: "Tasks",
  recordId: "recTASK000000001",
  fields: { Status: "Started" },
});
await outbox.enqueue({
  baseId: "appTESTBASE000001",
  table: "Tasks",
  recordId: "recTASK000000001",
  fields: { Status: "Done", "Due date": "2030-02-01" },
});
const result = await outbox.process();
assert.equal(result.written, 1);
assert.deepEqual(records.get("recTASK000000001"), { Status: "Done", "Due date": "2030-02-01" });

const err = await client.table("appTESTBASE000001", "Tasks").update([{
  id: "recTASK000000001",
  fields: { Colour: "Red" },
}]).catch((e) => e);
assert.ok(err instanceof AirtableRequestError);
assert.equal(err.type, "UNKNOWN_FIELD_NAME");
assert.ok(!JSON.stringify(client).includes(TOKEN));

// The shipped .sql file is reachable through the exports map and matches the code.
const sqlPath = new URL(import.meta.resolve("airspool/sql/postgres.sql"));
assert.ok(readFileSync(sqlPath, "utf8").endsWith(POSTGRES_SCHEMA));

let sqlite = "skipped (no node:sqlite)";
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  const store = sqliteStore({ run: (sql, params) => Promise.resolve(db.prepare(sql).all(...params)) });
  await store.migrate();
  const box = new Outbox({ store, client });
  await box.enqueue({
    baseId: "appTESTBASE000001",
    table: "Tasks",
    recordId: "recTASK000000002",
    fields: { Status: "Open" },
  });
  assert.equal((await box.process()).written, 1);
  sqlite = "ok";
} catch (e) {
  if (!String(e).includes("node:sqlite")) throw e;
}

console.log(
  `${
    typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`
  }: client ok, outbox ok, sqlite ${sqlite}`,
);
