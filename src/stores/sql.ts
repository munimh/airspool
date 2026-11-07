import type { FailureUpdate, NewChange, OutboxCounts, OutboxStore, StoredChange } from "../store.ts";

/**
 * Runs one SQL statement with positional parameters and resolves to the
 * rows it returns (an empty array for statements without rows).
 *
 * Statements use `$1`, `$2`, ... placeholders. Parameters are only strings,
 * numbers, booleans (Postgres only) and `null`.
 *
 * @example postgres.js
 * ```ts
 * import postgres from "postgres";
 * const sql = postgres(process.env.DATABASE_URL!);
 * const run: SqlRunner = (text, params) => sql.unsafe(text, params as never[]);
 * ```
 *
 * @example node-postgres
 * ```ts
 * import pg from "pg";
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const run: SqlRunner = async (text, params) => (await pool.query(text, params as unknown[])).rows;
 * ```
 */
export type SqlRunner = (
  sql: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

/** Options shared by {@link postgresStore} and {@link sqliteStore}. */
export interface SqlStoreOptions {
  /** Runs SQL. See {@link SqlRunner}. */
  run: SqlRunner;
  /**
   * Prefix of the two table names (`<prefix>changes`, `<prefix>leases`).
   * Letters, digits and underscores only.
   * @default "airspool_"
   */
  tablePrefix?: string;
}

/** Options for {@link postgresStore}. */
export interface PostgresStoreOptions extends SqlStoreOptions {
  /** Schema that holds the tables. Defaults to the connection's search path. */
  schema?: string;
}

/** An {@link OutboxStore} backed by SQL, with a method to create its tables. */
export interface SqlOutboxStore extends OutboxStore {
  /** Create the tables and indexes if they do not exist yet. Safe to call again. */
  migrate(): Promise<void>;
}

type Dialect = "postgres" | "sqlite";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkIdent(value: string, what: string): string {
  if (!IDENT.test(value) && value !== "") {
    throw new TypeError(`${what} may only contain letters, digits and underscores`);
  }
  return value;
}

/** Table and index DDL for a dialect, with the given names. */
function ddl(dialect: Dialect, changes: string, leases: string, indexPrefix: string): string[] {
  const pg = dialect === "postgres";
  return [
    `CREATE TABLE IF NOT EXISTS ${changes} (
  id ${pg ? "bigserial PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"},
  queue text NOT NULL,
  group_key text NOT NULL,
  base_id text NOT NULL,
  table_name text NOT NULL,
  record_id text,
  match_fields ${pg ? "jsonb" : "text"},
  fields ${pg ? "jsonb" : "text"} NOT NULL,
  typecast ${pg ? "boolean NOT NULL DEFAULT false" : "integer NOT NULL DEFAULT 0"},
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  send_after bigint NOT NULL,
  sent_at bigint,
  last_error text
)`,
    `CREATE INDEX IF NOT EXISTS ${indexPrefix}changes_by_group ON ${changes} (queue, status, group_key, id)`,
    `CREATE TABLE IF NOT EXISTS ${leases} (
  queue text PRIMARY KEY,
  owner text NOT NULL,
  expires_at bigint NOT NULL
)`,
  ];
}

/**
 * The Postgres schema with the default table names, as shipped in
 * `sql/postgres.sql`. Handy where reading files is awkward.
 */
export const POSTGRES_SCHEMA: string = ddl("postgres", "airspool_changes", "airspool_leases", "airspool_")
  .map((s) => `${s};\n`).join("\n");

/** The SQLite schema with the default table names, as shipped in `sql/sqlite.sql`. */
export const SQLITE_SCHEMA: string = ddl("sqlite", "airspool_changes", "airspool_leases", "airspool_")
  .map((s) => `${s};\n`).join("\n");

/** SQLite drivers differ on numbered placeholders, so give them plain `?`s. */
function toQuestionMarks(text: string, params: readonly unknown[]): [string, unknown[]] {
  const out: unknown[] = [];
  const sql = text.replace(/\$(\d+)/g, (_, n: string) => {
    out.push(params[Number(n) - 1]);
    return "?";
  });
  return [sql, out];
}

function sqlStore(dialect: Dialect, options: SqlStoreOptions & { schema?: string }): SqlOutboxStore {
  const prefix = checkIdent(options.tablePrefix ?? "airspool_", "tablePrefix");
  const schema = options.schema ? `${checkIdent(options.schema, "schema")}.` : "";
  const T = `${schema}${prefix}changes`;
  const L = `${schema}${prefix}leases`;
  const pg = dialect === "postgres";

  const run = async (text: string, params: unknown[] = []) => {
    if (pg) return await options.run(text, params);
    const [sql, args] = toQuestionMarks(text, params.map((p) => typeof p === "boolean" ? (p ? 1 : 0) : p));
    return await options.run(sql, args);
  };
  // Through text first: some drivers JSON-encode a string again when the
  // parameter itself is typed jsonb.
  const json = (n: number) => pg ? `CAST(CAST($${n} AS text) AS jsonb)` : `$${n}`;
  const asText = (col: string) => pg ? `CAST(${col} AS text)` : col;
  const num = (col: string) => `CAST(${col} AS double precision)`;
  const idList = (ids: number[], from: number) => ids.map((_, i) => `CAST($${from + i} AS bigint)`).join(", ");

  const COLUMNS = `${num("id")} AS id, queue, group_key, base_id, table_name, record_id,
    ${asText("match_fields")} AS match_fields, ${asText("fields")} AS fields, typecast, status, attempts,
    ${num("created_at")} AS created_at, ${num("send_after")} AS send_after,
    ${num("sent_at")} AS sent_at, last_error`;

  const toChange = (row: Record<string, unknown>): StoredChange => {
    const parse = (v: unknown) => typeof v === "string" ? JSON.parse(v) : v;
    return {
      id: Number(row.id),
      queue: String(row.queue),
      groupKey: String(row.group_key),
      baseId: String(row.base_id),
      table: String(row.table_name),
      recordId: row.record_id == null ? null : String(row.record_id),
      match: row.match_fields == null ? null : parse(row.match_fields) as string[],
      fields: parse(row.fields) as Record<string, unknown>,
      typecast: row.typecast === true || row.typecast === 1 || row.typecast === "t",
      status: row.status as StoredChange["status"],
      attempts: Number(row.attempts),
      createdAt: Number(row.created_at),
      nextAttemptAt: Number(row.send_after),
      sentAt: row.sent_at == null ? null : Number(row.sent_at),
      lastError: row.last_error == null ? null : String(row.last_error),
    };
  };

  const failedWhere = (ids: number[] | "all") =>
    ids === "all" ? "" : ids.length ? ` AND id IN (${idList(ids, 2)})` : " AND 1 = 0";

  return {
    async migrate() {
      for (const statement of ddl(dialect, T, L, prefix)) await run(statement);
    },

    async insert(change: NewChange) {
      const rows = await run(
        `INSERT INTO ${T} (queue, group_key, base_id, table_name, record_id, match_fields, fields, typecast,
           created_at, send_after)
         VALUES ($1, $2, $3, $4, $5, ${json(6)}, ${json(7)}, $8, CAST($9 AS bigint), CAST($9 AS bigint))
         RETURNING ${COLUMNS}`,
        [
          change.queue,
          change.groupKey,
          change.baseId,
          change.table,
          change.recordId,
          change.match ? JSON.stringify(change.match) : null,
          JSON.stringify(change.fields),
          change.typecast,
          change.createdAt,
        ],
      );
      return toChange(rows[0]!);
    },

    async acquireLease(queue, owner, expiresAt, now) {
      const rows = await run(
        `INSERT INTO ${L} AS l (queue, owner, expires_at) VALUES ($1, $2, CAST($3 AS bigint))
         ON CONFLICT (queue) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE l.expires_at <= CAST($4 AS bigint) OR l.owner = excluded.owner
         RETURNING owner`,
        [queue, owner, expiresAt, now],
      );
      return rows.length === 1 && rows[0]!.owner === owner;
    },

    async renewLease(queue, owner, expiresAt) {
      const rows = await run(
        `UPDATE ${L} SET expires_at = CAST($3 AS bigint) WHERE queue = $1 AND owner = $2 RETURNING owner`,
        [queue, owner, expiresAt],
      );
      return rows.length === 1;
    },

    async releaseLease(queue, owner) {
      await run(`DELETE FROM ${L} WHERE queue = $1 AND owner = $2`, [queue, owner]);
    },

    async loadDue(queue, now, maxGroups) {
      const rows = await run(
        `SELECT ${COLUMNS} FROM ${T}
         WHERE queue = $1 AND status = 'pending' AND group_key IN (
           SELECT group_key FROM ${T} WHERE queue = $1 AND status = 'pending'
           GROUP BY group_key HAVING MAX(send_after) <= CAST($2 AS bigint)
           ORDER BY MIN(id) LIMIT CAST($3 AS integer))
         ORDER BY id`,
        [queue, now, maxGroups],
      );
      return rows.map(toChange);
    },

    async loadSentAfter(queue, groupKeys, afterId) {
      if (groupKeys.length === 0) return [];
      const keys = groupKeys.map((_, i) => `$${i + 3}`).join(", ");
      const rows = await run(
        `SELECT ${COLUMNS} FROM ${T}
         WHERE queue = $1 AND status = 'sent' AND id > CAST($2 AS bigint) AND group_key IN (${keys})
         ORDER BY id`,
        [queue, afterId, ...groupKeys],
      );
      return rows.map(toChange);
    },

    async markSent(ids, now) {
      if (ids.length === 0) return;
      await run(
        `UPDATE ${T} SET status = 'sent', sent_at = CAST($1 AS bigint), attempts = attempts + 1, last_error = NULL
         WHERE id IN (${idList(ids, 2)})`,
        [now, ...ids],
      );
    },

    async recordFailure(ids, update: FailureUpdate) {
      if (ids.length === 0) return;
      await run(
        `UPDATE ${T} SET status = $1, attempts = CAST($2 AS integer), send_after = CAST($3 AS bigint),
           last_error = $4
         WHERE id IN (${idList(ids, 5)})`,
        [update.status, update.attempts, update.nextAttemptAt, update.error, ...ids],
      );
    },

    async retry(queue, ids, now) {
      const where = ids === "all" ? "" : ids.length ? ` AND id IN (${idList(ids, 3)})` : " AND 1 = 0";
      const rows = await run(
        `UPDATE ${T} SET status = 'pending', attempts = 0, send_after = CAST($2 AS bigint), last_error = NULL
         WHERE queue = $1 AND status = 'failed'${where} RETURNING id`,
        [queue, now, ...(ids === "all" ? [] : ids)],
      );
      return rows.length;
    },

    async discard(queue, ids) {
      const rows = await run(
        `DELETE FROM ${T} WHERE queue = $1 AND status = 'failed'${failedWhere(ids)} RETURNING id`,
        [queue, ...(ids === "all" ? [] : ids)],
      );
      return rows.length;
    },

    async counts(queue): Promise<OutboxCounts> {
      const rows = await run(
        `SELECT
           CAST(COALESCE(SUM(CASE WHEN status = 'pending' AND attempts = 0 THEN 1 ELSE 0 END), 0) AS integer) AS pending,
           CAST(COALESCE(SUM(CASE WHEN status = 'pending' AND attempts > 0 THEN 1 ELSE 0 END), 0) AS integer) AS retrying,
           CAST(COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS integer) AS failed
         FROM ${T} WHERE queue = $1 AND status <> 'sent'`,
        [queue],
      );
      const row = rows[0] ?? {};
      return {
        pending: Number(row.pending ?? 0),
        retrying: Number(row.retrying ?? 0),
        failed: Number(row.failed ?? 0),
      };
    },

    async listFailed(queue, limit) {
      const rows = await run(
        `SELECT ${COLUMNS} FROM ${T} WHERE queue = $1 AND status = 'failed' ORDER BY id LIMIT CAST($2 AS integer)`,
        [queue, limit],
      );
      return rows.map(toChange);
    },

    async purgeSent(queue, before) {
      const rows = await run(
        `DELETE FROM ${T}
         WHERE queue = $1 AND status = 'sent' AND sent_at < CAST($2 AS bigint)
           AND group_key NOT IN (SELECT group_key FROM ${T} WHERE queue = $1 AND status = 'failed')
         RETURNING id`,
        [queue, before],
      );
      return rows.length;
    },
  };
}

/**
 * An {@link OutboxStore} on Postgres. Works with any driver through a
 * {@link SqlRunner}: postgres.js, node-postgres, or Supabase's database URL.
 *
 * Create the tables with `sql/postgres.sql` (or {@link POSTGRES_SCHEMA}, or
 * `await store.migrate()`). The lease is a row in the leases table, so it
 * works through connection poolers in transaction mode.
 *
 * To enqueue inside your own transaction, build a second store whose runner
 * uses the transaction and call `outbox.withStore(thatStore).enqueue(...)`.
 *
 * @param options SQL runner, and optional schema and table prefix.
 */
export function postgresStore(options: PostgresStoreOptions): SqlOutboxStore {
  return sqlStore("postgres", options);
}

/**
 * An {@link OutboxStore} on SQLite 3.35 or newer, for a single machine.
 *
 * @example node:sqlite (Node 22+, Deno)
 * ```ts
 * import { DatabaseSync } from "node:sqlite";
 * const db = new DatabaseSync("outbox.db");
 * const store = sqliteStore({ run: (sql, params) => Promise.resolve(db.prepare(sql).all(...params as never[])) });
 * await store.migrate();
 * ```
 *
 * @param options SQL runner and optional table prefix.
 */
export function sqliteStore(options: SqlStoreOptions): SqlOutboxStore {
  return sqlStore("sqlite", options);
}
