/**
 * Runs the store suite against a real Postgres when DATABASE_URL is set
 * (CI starts one in a service container). Skipped otherwise.
 */
import postgres from "postgres";
import { POSTGRES_SCHEMA, postgresStore } from "../mod.ts";
import { storeSuite } from "./store_suite.ts";

const url = Deno.env.get("DATABASE_URL");
let sql: ReturnType<typeof postgres> | undefined;
let n = 0;

storeSuite("postgres", async () => {
  sql ??= postgres(url!, { max: 10, onnotice: () => {} });
  // A fresh schema per test keeps tests independent.
  const schema = `airspool_test_${Date.now()}_${n++}`;
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  const run = (text: string, params: readonly unknown[]) => sql!.unsafe(text, params as never[]);
  const store = postgresStore({ run, schema });
  await store.migrate();
  return store;
}, { ignore: !url });

Deno.test({
  name: "postgres: the shipped schema file runs as is",
  ignore: !url,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    sql ??= postgres(url!, { max: 10, onnotice: () => {} });
    const schema = `airspool_schema_${Date.now()}`;
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
      await tx.unsafe(POSTGRES_SCHEMA);
      await tx.unsafe(POSTGRES_SCHEMA); // twice: it must be safe to rerun
    });
  },
});

Deno.test({
  name: "postgres: close the pool",
  ignore: !url,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await sql?.end();
  },
});
