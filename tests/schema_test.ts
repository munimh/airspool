import { assertEquals } from "@std/assert";
import { POSTGRES_SCHEMA, SQLITE_SCHEMA } from "../mod.ts";
import { header } from "./schema_header.ts";

Deno.test("the shipped .sql files match the schema in code (run `deno task schema` to update)", async () => {
  const dir = new URL("../sql/", import.meta.url);
  assertEquals(await Deno.readTextFile(new URL("postgres.sql", dir)), header("Postgres") + POSTGRES_SCHEMA);
  assertEquals(await Deno.readTextFile(new URL("sqlite.sql", dir)), header("SQLite 3.35+") + SQLITE_SCHEMA);
});

Deno.test("the Supabase example migration is the shipped Postgres schema", async () => {
  const shipped = await Deno.readTextFile(new URL("../sql/postgres.sql", import.meta.url));
  const example = new URL("../examples/supabase/migrations/20300101000000_airspool.sql", import.meta.url);
  assertEquals(await Deno.readTextFile(example), shipped);
});
