import { DatabaseSync } from "node:sqlite";
import { sqliteStore } from "../mod.ts";
import { storeSuite } from "./store_suite.ts";

storeSuite("sqlite", async () => {
  const db = new DatabaseSync(":memory:");
  const store = sqliteStore({
    run: (sql, params) => Promise.resolve(db.prepare(sql).all(...params as never[]) as Record<string, unknown>[]),
  });
  await store.migrate();
  return store;
});
