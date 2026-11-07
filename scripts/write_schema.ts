// Writes sql/postgres.sql and sql/sqlite.sql from the schema in src/stores/sql.ts.
// tests/schema_test.ts fails if the files and the code ever drift apart.
import { POSTGRES_SCHEMA, SQLITE_SCHEMA } from "../src/stores/sql.ts";
import { header } from "../tests/schema_header.ts";

await Deno.writeTextFile("sql/postgres.sql", header("Postgres") + POSTGRES_SCHEMA);
await Deno.writeTextFile("sql/sqlite.sql", header("SQLite 3.35+") + SQLITE_SCHEMA);
