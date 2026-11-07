/**
 * A small stand-in for the Airtable Web API, served through a fake `fetch`.
 * It keeps records in memory, checks the request shapes the client sends,
 * and records every request with the fake time it arrived.
 */
import type { Clock } from "../src/clock.ts";

export const TEST_TOKEN = "patTESTONLY.notarealtoken0000000000000000";

export interface LoggedRequest {
  at: number;
  method: string;
  url: URL;
  baseId: string;
  table: string;
  body: Record<string, unknown> | undefined;
}

interface MockRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/** What a scripted answer can be: a response, or a thrown network error. */
export type Scripted = Response | Error | (() => Response | Promise<Response> | Error);

export interface MockAirtableOptions {
  clock: Clock;
  /** Field names each table accepts, keyed by `${baseId}/${table}`. Unknown fields get a 422. */
  schema?: Record<string, string[]>;
  /** Answer 429 to more than this many requests per base in any 1000 ms window. */
  perBaseLimit?: number;
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const errorResponse = (status: number, type: string, message?: string): Response =>
  json(status, { error: message === undefined ? type : { type, message } });

export class MockAirtable {
  readonly requests: LoggedRequest[] = [];
  /** Requests that broke the per-base rate limit. */
  readonly violations: LoggedRequest[] = [];
  readonly tables = new Map<string, Map<string, MockRecord>>();
  /** Answers to give instead of the normal ones, in order. */
  readonly script: Scripted[] = [];
  /** Called for every request; return a response to override the normal handling. */
  intercept?: (req: LoggedRequest) => Scripted | undefined | Promise<Scripted | undefined>;

  #clock: Clock;
  #schema: Record<string, string[]>;
  #perBaseLimit: number;
  #next = 0;

  constructor(options: MockAirtableOptions) {
    this.#clock = options.clock;
    this.#schema = options.schema ?? {};
    this.#perBaseLimit = options.perBaseLimit ?? 5;
  }

  /** Put a record in a table directly. */
  seed(baseId: string, table: string, id: string, fields: Record<string, unknown>): void {
    this.#table(baseId, table).set(id, { id, createdTime: new Date(this.#clock.now()).toISOString(), fields });
  }

  record(baseId: string, table: string, id: string): MockRecord | undefined {
    return this.tables.get(`${baseId}/${table}`)?.get(id);
  }

  all(baseId: string, table: string): MockRecord[] {
    return [...(this.tables.get(`${baseId}/${table}`)?.values() ?? [])];
  }

  writes(): LoggedRequest[] {
    return this.requests.filter((r) => r.method !== "GET" && !r.url.pathname.endsWith("/listRecords"));
  }

  #table(baseId: string, table: string): Map<string, MockRecord> {
    const key = `${baseId}/${table}`;
    let t = this.tables.get(key);
    if (!t) {
      t = new Map();
      this.tables.set(key, t);
    }
    return t;
  }

  #newId(): string {
    return `recMOCK${String(++this.#next).padStart(10, "0")}`;
  }

  /** The `fetch` to hand to the client. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const [, , baseId = "", table = ""] = url.pathname.split("/").map(decodeURIComponent);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const req: LoggedRequest = { at: this.#clock.now(), method, url, baseId, table, body };
    this.requests.push(req);

    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TEST_TOKEN}`) return errorResponse(401, "AUTHENTICATION_REQUIRED", "bad token");

    const cutoff = req.at - 1000;
    const recent = this.requests.filter((r) => r.baseId === baseId && r.at > cutoff && r.at <= req.at);
    if (recent.length > this.#perBaseLimit) {
      this.violations.push(req);
      return errorResponse(429, "RATE_LIMIT_REACHED", "Rate limit exceeded. Please try again later");
    }

    const scripted = this.script.shift() ?? await this.intercept?.(req);
    if (scripted !== undefined) {
      const answer = typeof scripted === "function" ? await scripted() : scripted;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return this.#handle(req, url);
  };

  #checkFields(baseId: string, table: string, fields: Record<string, unknown>): Response | undefined {
    const allowed = this.#schema[`${baseId}/${table}`];
    if (!allowed) return undefined;
    for (const name of Object.keys(fields)) {
      if (!allowed.includes(name)) {
        return errorResponse(422, "UNKNOWN_FIELD_NAME", `Unknown field name: "${name}"`);
      }
    }
    return undefined;
  }

  #handle(req: LoggedRequest, url: URL): Response {
    const { method, baseId, table, body } = req;
    const t = this.#table(baseId, table);
    const parts = url.pathname.split("/").map(decodeURIComponent);
    const recordId = parts[4];

    if (method === "GET" && recordId) {
      const rec = t.get(recordId);
      return rec ? json(200, rec) : errorResponse(404, "NOT_FOUND");
    }

    if ((method === "GET" && !recordId) || (method === "POST" && recordId === "listRecords")) {
      const q = method === "GET" ? url.searchParams : null;
      const pageSize = Number(q?.get("pageSize") ?? body?.pageSize ?? 100);
      const offset = Number(q?.get("offset") ?? body?.offset ?? 0);
      const formula = q?.get("filterByFormula") ?? (body?.filterByFormula as string | undefined);
      let rows = [...t.values()];
      // Understands `{Field} = 'value'` and nothing else; enough for tests.
      const m = formula?.match(/^\{([^}]+)\}\s*=\s*'([^']*)'$/);
      if (m) rows = rows.filter((r) => String(r.fields[m[1]!]) === m[2]);
      const page = rows.slice(offset, offset + pageSize);
      const more = offset + pageSize < rows.length;
      return json(200, { records: page, ...(more ? { offset: String(offset + pageSize) } : {}) });
    }

    if (method === "DELETE") {
      const ids = url.searchParams.getAll("records[]");
      if (ids.length > 10) return errorResponse(422, "INVALID_REQUEST_UNKNOWN", "too many records");
      return json(200, { records: ids.map((id) => ({ id, deleted: t.delete(id) })) });
    }

    const records = (body?.records ?? []) as { id?: string; fields: Record<string, unknown> }[];
    if (records.length > 10) return errorResponse(422, "INVALID_REQUEST_UNKNOWN", "too many records");
    for (const r of records) {
      const bad = this.#checkFields(baseId, table, r.fields);
      if (bad) return bad;
    }

    if (method === "POST") {
      const created = records.map((r) => {
        const rec = { id: this.#newId(), createdTime: new Date(req.at).toISOString(), fields: { ...r.fields } };
        t.set(rec.id, rec);
        return rec;
      });
      return json(200, { records: created });
    }

    if (method === "PATCH" || method === "PUT") {
      const upsert = body?.performUpsert as { fieldsToMergeOn: string[] } | undefined;
      const createdRecords: string[] = [];
      const updatedRecords: string[] = [];
      const out: MockRecord[] = [];
      for (const r of records) {
        let rec: MockRecord | undefined;
        if (r.id) {
          rec = t.get(r.id);
          if (!rec) return errorResponse(404, "NOT_FOUND", `Record ${r.id} not found`);
        } else if (upsert) {
          const hits = [...t.values()].filter((x) => upsert.fieldsToMergeOn.every((f) => x.fields[f] === r.fields[f]));
          if (hits.length > 1) return errorResponse(422, "INVALID_REQUEST_UNKNOWN", "more than one match");
          rec = hits[0];
          if (!rec) {
            rec = { id: this.#newId(), createdTime: new Date(req.at).toISOString(), fields: {} };
            t.set(rec.id, rec);
            createdRecords.push(rec.id);
          } else updatedRecords.push(rec.id);
        } else return errorResponse(422, "INVALID_REQUEST_UNKNOWN", "record id missing");
        rec.fields = method === "PUT" ? { ...r.fields } : { ...rec.fields, ...r.fields };
        out.push(rec);
      }
      return json(200, upsert ? { records: out, createdRecords, updatedRecords } : { records: out });
    }

    return errorResponse(404, "NOT_FOUND");
  }
}

/** The largest number of requests to one base that arrived in any 1000 ms window. */
export function busiestSecond(requests: LoggedRequest[], baseId?: string): number {
  const times = requests.filter((r) => baseId === undefined || r.baseId === baseId).map((r) => r.at).sort((a, b) =>
    a - b
  );
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i]! - times[j]! >= 1000) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}
