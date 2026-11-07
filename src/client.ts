import { type Clock, systemClock } from "./clock.ts";
import {
  AirtableApiError,
  AirtableNetworkError,
  AirtableRateLimitError,
  AirtableRequestError,
  AirtableServerError,
} from "./errors.ts";
import { type RateLimiter, sharedRateLimiter } from "./rate_limiter.ts";

/** Cell values of a record, keyed by field name or field ID. */
export type FieldValues = Record<string, unknown>;

/** A record as Airtable returns it. */
export interface AirtableRecord<F extends FieldValues = FieldValues> {
  /** Record ID, such as `recAbc123...`. */
  id: string;
  /** When the record was created (ISO 8601). */
  createdTime: string;
  /** Cell values. Airtable leaves out empty cells. */
  fields: F;
}

/** Options for {@link AirtableClient}. */
export interface AirtableClientOptions {
  /** A personal access token or service account token. Never logged. */
  token: string;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock used for waits. Defaults to the system clock. */
  clock?: Clock;
  /**
   * Rate limiter. Defaults to one limiter shared by every client in the
   * process, which is what keeps several callers under the per-base limit.
   */
  rateLimiter?: RateLimiter;
  /** API root. @default "https://api.airtable.com/v0" */
  apiUrl?: string;
  /**
   * Records per create, update, upsert or delete request. Airtable allows 10.
   * @default 10
   */
  batchSize?: number;
  /**
   * How many times to retry a network error or a 5xx answer.
   * @default 3
   */
  maxRetries?: number;
  /**
   * How many times to wait and retry after a 429 before giving up.
   * @default 2
   */
  maxRateLimitRetries?: number;
  /**
   * How long to wait after a 429. Airtable says to wait 30 seconds.
   * @default 30000
   */
  rateLimitPauseMs?: number;
  /** First backoff delay for network and 5xx retries. @default 500 */
  retryBaseDelayMs?: number;
  /** Largest backoff delay for network and 5xx retries. @default 8000 */
  retryMaxDelayMs?: number;
  /** Abort a request that takes longer than this. `0` disables. @default 30000 */
  timeoutMs?: number;
  /** Random source for backoff jitter, in [0, 1). @default Math.random */
  random?: () => number;
}

/** Options shared by create, update and upsert. */
export interface WriteOptions {
  /**
   * Ask Airtable to convert string values to the right cell type (for example
   * create a missing select option). Off by default, so a typo is refused
   * rather than silently creating a new option.
   */
  typecast?: boolean;
}

/** Options for {@link AirtableTable.update}. */
export interface UpdateOptions extends WriteOptions {
  /**
   * `true` sends a PUT, which clears every field not included. The default
   * PATCH only changes the fields you send.
   */
  replace?: boolean;
}

/** Options for {@link AirtableTable.upsert}. */
export interface UpsertOptions extends UpdateOptions {
  /**
   * One to three fields (names or IDs) whose values together identify a
   * record. A record with matching values is updated; otherwise one is
   * created. Computed fields such as formulas cannot be used.
   */
  fieldsToMergeOn: string[];
}

/** Result of {@link AirtableTable.upsert}. */
export interface UpsertResult<F extends FieldValues = FieldValues> {
  /** Every record written, in request order. */
  records: AirtableRecord<F>[];
  /** IDs of records that were created. */
  createdRecords: string[];
  /** IDs of records that were updated. */
  updatedRecords: string[];
}

/** Options for {@link AirtableTable.get}. */
export interface GetOptions {
  /** Key returned fields by field ID instead of name. */
  returnFieldsByFieldId?: boolean;
  /** `"json"` (default) or `"string"`. `"string"` needs `timeZone` and `userLocale`. */
  cellFormat?: "json" | "string";
  /** Time zone for `cellFormat: "string"`. */
  timeZone?: string;
  /** Locale for `cellFormat: "string"`. */
  userLocale?: string;
}

/** One sort rule for {@link AirtableTable.list}. */
export interface SortRule {
  /** Field name or ID. */
  field: string;
  /** Sort order. @default "asc" */
  direction?: "asc" | "desc";
}

/** Options for {@link AirtableTable.list}. */
export interface ListOptions extends GetOptions {
  /** Only records for which this formula is truthy, such as `{Status} = 'Done'`. */
  filterByFormula?: string;
  /** Only return these fields (names or IDs). */
  fields?: string[];
  /** Sort rules, applied in order. */
  sort?: SortRule[];
  /** Only records in this view (name or ID), in the view's order. */
  view?: string;
  /** Records per page, at most 100. @default 100 */
  pageSize?: number;
  /** Stop after this many records in total. */
  maxRecords?: number;
}

/** Airtable rejects URLs of 16,000 characters or more; past this we POST instead. */
const MAX_URL_LENGTH = 15_000;

const tokens = new WeakMap<AirtableClient, { token: string; key: string }>();

/** A short, non-reversible key for a token, used to share a rate limit lane. */
function tokenFingerprint(token: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** A raw request for {@link AirtableClient.request}. */
export interface RequestSpec {
  /** HTTP method. */
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path below the API root, such as `appXXX/Tasks`. Already URL-encoded. */
  path: string;
  /** Query string parameters. */
  query?: URLSearchParams;
  /** JSON body. */
  body?: unknown;
  /** Safe to send twice. Creates are not: a lost answer could mean a duplicate. */
  idempotent: boolean;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readError(response: Response): Promise<{ type?: string; airtableMessage?: string }> {
  try {
    const body = await response.json() as { error?: unknown };
    const error = body?.error;
    if (typeof error === "string") return { type: error };
    if (error && typeof error === "object") {
      const { type, message } = error as { type?: unknown; message?: unknown };
      return {
        type: typeof type === "string" ? type : undefined,
        airtableMessage: typeof message === "string" ? message.slice(0, 1000) : undefined,
      };
    }
  } catch {
    // The body was not JSON; the status alone has to do.
  }
  return {};
}

function describe(status: number, details: { type?: string; airtableMessage?: string }): string {
  const parts = [`Airtable answered ${status}`];
  if (details.type) parts.push(details.type);
  return details.airtableMessage ? `${parts.join(" ")}: ${details.airtableMessage}` : parts.join(" ");
}

/**
 * A rate-limited Airtable Web API client built on `fetch`.
 *
 * @example
 * ```ts
 * import { AirtableClient } from "@munimh/airspool";
 *
 * const airtable = new AirtableClient({ token: Deno.env.get("AIRTABLE_TOKEN")! });
 * const tasks = airtable.table("appExampleBase0001", "Tasks");
 * await tasks.update([{ id: "recExampleTask0001", fields: { Status: "Done" } }]);
 * ```
 */
export class AirtableClient {
  /** Records per write request. */
  readonly batchSize: number;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #limiter: RateLimiter;
  readonly #apiUrl: string;
  readonly #maxRetries: number;
  readonly #maxRateLimitRetries: number;
  readonly #rateLimitPauseMs: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #timeoutMs: number;
  readonly #random: () => number;

  /**
   * Create a client.
   *
   * @param options Token and tuning. Only `token` is required.
   */
  constructor(options: AirtableClientOptions) {
    if (typeof options.token !== "string" || options.token.trim() === "") {
      throw new TypeError("AirtableClient needs a token");
    }
    tokens.set(this, { token: options.token, key: tokenFingerprint(options.token) });
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = options.clock ?? systemClock;
    this.#limiter = options.rateLimiter ?? sharedRateLimiter;
    this.#apiUrl = (options.apiUrl ?? "https://api.airtable.com/v0").replace(/\/+$/, "");
    this.batchSize = options.batchSize ?? 10;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new RangeError("batchSize must be a positive integer");
    }
    this.#maxRetries = options.maxRetries ?? 3;
    this.#maxRateLimitRetries = options.maxRateLimitRetries ?? 2;
    this.#rateLimitPauseMs = options.rateLimitPauseMs ?? 30_000;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.#retryMaxDelayMs = options.retryMaxDelayMs ?? 8_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#random = options.random ?? Math.random;
  }

  /**
   * A handle on one table.
   *
   * @param baseId Base ID, starting with `app`.
   * @param table Table ID (starting with `tbl`) or table name. IDs survive renames.
   */
  table<F extends FieldValues = FieldValues>(baseId: string, table: string): AirtableTable<F> {
    if (!baseId || !table) throw new TypeError("table() needs a base ID and a table");
    return new AirtableTable<F>(this, baseId, table);
  }

  /** Keeps the token out of `console.log` and `JSON.stringify`. */
  toJSON(): Record<string, unknown> {
    return { batchSize: this.batchSize, apiUrl: this.#apiUrl };
  }

  #backoff(attempt: number): number {
    const ceiling = Math.min(this.#retryMaxDelayMs, this.#retryBaseDelayMs * 2 ** attempt);
    return Math.floor(this.#random() * ceiling);
  }

  /**
   * Send one request, waiting for a rate-limit slot first and retrying where
   * that is safe. Used by {@link AirtableTable}; call it directly only for
   * endpoints the table methods do not cover.
   *
   * @param baseId Base the request is for (selects the rate limit lane).
   * @param spec Method, path below the API root, query, body, and whether
   *   the request is safe to send twice.
   * @returns The parsed JSON body.
   */
  async request(baseId: string, spec: RequestSpec): Promise<unknown> {
    const secret = tokens.get(this);
    if (!secret) throw new TypeError("client is not initialised");
    const query = spec.query?.toString();
    const url = `${this.#apiUrl}/${spec.path}${query ? `?${query}` : ""}`;
    let failures = 0;
    let rateLimited = 0;

    while (true) {
      await this.#limiter.take(baseId, secret.key);

      let response: Response;
      const controller = new AbortController();
      const timer = this.#timeoutMs > 0 ? setTimeout(() => controller.abort(), this.#timeoutMs) : undefined;
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${secret.token}` };
        if (spec.body !== undefined) headers["Content-Type"] = "application/json";
        response = await this.#fetch(url, {
          method: spec.method,
          headers,
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: controller.signal,
        });
      } catch (cause) {
        clearTimeout(timer);
        const reason = controller.signal.aborted
          ? `no answer within ${this.#timeoutMs} ms`
          : cause instanceof Error
          ? cause.message
          : String(cause);
        if (spec.idempotent && failures < this.#maxRetries) {
          await this.#clock.sleep(this.#backoff(failures++));
          continue;
        }
        throw new AirtableNetworkError(`Could not reach Airtable: ${reason}`, cause);
      }

      try {
        if (response.ok) {
          const text = await response.text();
          return text ? JSON.parse(text) : {};
        }

        if (response.status === 429) {
          const details = await readError(response);
          this.#limiter.pauseBase(baseId, this.#rateLimitPauseMs);
          if (rateLimited++ < this.#maxRateLimitRetries) continue;
          throw new AirtableRateLimitError(describe(429, details), details);
        }

        if (response.status >= 500) {
          const wait = retryAfterMs(response);
          const details = await readError(response);
          // Airtable says 502 and 503 are safe to retry even for a create.
          const safe = spec.idempotent || response.status === 502 || response.status === 503;
          if (safe && failures < this.#maxRetries) {
            await this.#clock.sleep(wait ?? this.#backoff(failures));
            failures++;
            continue;
          }
          throw new AirtableServerError(response.status, describe(response.status, details), details);
        }

        const details = await readError(response);
        throw new AirtableRequestError(response.status, describe(response.status, details), details);
      } catch (error) {
        if (error instanceof AirtableApiError) throw error;
        throw new AirtableNetworkError(
          `Could not read Airtable's answer: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/**
 * One table of one base. Get it from {@link AirtableClient.table}.
 *
 * Writes are split into requests of {@link AirtableClient.batchSize} records
 * and sent in order. If one request fails, the earlier ones are already
 * saved; use the outbox when every write must land.
 */
export class AirtableTable<F extends FieldValues = FieldValues> {
  readonly #client: AirtableClient;
  /** Base ID. */
  readonly baseId: string;
  /** Table ID or name. */
  readonly table: string;
  readonly #path: string;

  /**
   * Create a table handle. Prefer {@link AirtableClient.table}.
   *
   * @param client The client that sends requests.
   * @param baseId Base ID.
   * @param table Table ID or name.
   */
  constructor(client: AirtableClient, baseId: string, table: string) {
    this.#client = client;
    this.baseId = baseId;
    this.table = table;
    this.#path = `${encodeURIComponent(baseId)}/${encodeURIComponent(table)}`;
  }

  /**
   * Create records.
   *
   * A create is not retried after a lost answer, because the record may
   * already exist; 429, 502 and 503 answers are still retried.
   *
   * @param records The cell values of each new record.
   * @param options `typecast`.
   * @returns The created records, in the same order.
   */
  async create(records: { fields: Partial<F> }[], options: WriteOptions = {}): Promise<AirtableRecord<F>[]> {
    const out: AirtableRecord<F>[] = [];
    for (const part of chunk(records, this.#client.batchSize)) {
      const body = await this.#client.request(this.baseId, {
        method: "POST",
        path: this.#path,
        body: { records: part.map((r) => ({ fields: r.fields })), ...(options.typecast ? { typecast: true } : {}) },
        idempotent: false,
      }) as { records: AirtableRecord<F>[] };
      out.push(...body.records);
    }
    return out;
  }

  /**
   * Change existing records.
   *
   * @param records Record ID and the cell values to set.
   * @param options `typecast`, and `replace` to clear fields that are not sent.
   * @returns The updated records, in the same order.
   */
  async update(
    records: { id: string; fields: Partial<F> }[],
    options: UpdateOptions = {},
  ): Promise<AirtableRecord<F>[]> {
    const out: AirtableRecord<F>[] = [];
    for (const part of chunk(records, this.#client.batchSize)) {
      const body = await this.#client.request(this.baseId, {
        method: options.replace ? "PUT" : "PATCH",
        path: this.#path,
        body: {
          records: part.map((r) => ({ id: r.id, fields: r.fields })),
          ...(options.typecast ? { typecast: true } : {}),
        },
        idempotent: true,
      }) as { records: AirtableRecord<F>[] };
      out.push(...body.records);
    }
    return out;
  }

  /**
   * Update the record whose `fieldsToMergeOn` values match, or create it.
   *
   * Airtable fails the request if more than one record matches.
   *
   * @param records Cell values, including the merge fields.
   * @param options `fieldsToMergeOn` (one to three fields), `typecast`, `replace`.
   * @returns The written records and which IDs were created or updated.
   */
  async upsert(records: { fields: Partial<F> }[], options: UpsertOptions): Promise<UpsertResult<F>> {
    const merge = options.fieldsToMergeOn;
    if (!Array.isArray(merge) || merge.length < 1 || merge.length > 3) {
      throw new TypeError("fieldsToMergeOn needs one to three fields");
    }
    const result: UpsertResult<F> = { records: [], createdRecords: [], updatedRecords: [] };
    for (const part of chunk(records, this.#client.batchSize)) {
      const body = await this.#client.request(this.baseId, {
        method: options.replace ? "PUT" : "PATCH",
        path: this.#path,
        body: {
          performUpsert: { fieldsToMergeOn: merge },
          records: part.map((r) => ({ fields: r.fields })),
          ...(options.typecast ? { typecast: true } : {}),
        },
        idempotent: true,
      }) as Partial<UpsertResult<F>>;
      result.records.push(...(body.records ?? []));
      result.createdRecords.push(...(body.createdRecords ?? []));
      result.updatedRecords.push(...(body.updatedRecords ?? []));
    }
    return result;
  }

  /**
   * Delete records.
   *
   * @param ids Record IDs.
   * @returns The IDs Airtable reports as deleted.
   */
  async delete(ids: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const part of chunk(ids, this.#client.batchSize)) {
      const query = new URLSearchParams();
      for (const id of part) query.append("records[]", id);
      const body = await this.#client.request(this.baseId, {
        method: "DELETE",
        path: this.#path,
        query,
        idempotent: true,
      }) as { records: { id: string; deleted: boolean }[] };
      out.push(...body.records.filter((r) => r.deleted).map((r) => r.id));
    }
    return out;
  }

  /**
   * Fetch a single record by its ID.
   *
   * @param id Record ID.
   * @param options Output format.
   */
  async get(id: string, options: GetOptions = {}): Promise<AirtableRecord<F>> {
    const query = new URLSearchParams();
    if (options.returnFieldsByFieldId) query.set("returnFieldsByFieldId", "true");
    if (options.cellFormat) query.set("cellFormat", options.cellFormat);
    if (options.timeZone) query.set("timeZone", options.timeZone);
    if (options.userLocale) query.set("userLocale", options.userLocale);
    return await this.#client.request(this.baseId, {
      method: "GET",
      path: `${this.#path}/${encodeURIComponent(id)}`,
      query,
      idempotent: true,
    }) as AirtableRecord<F>;
  }

  /**
   * Read records page by page. Each page is one request, so the rate limit
   * applies between pages.
   *
   * Very long formulas would make the URL too long for Airtable, so the
   * client switches to the `listRecords` POST form when needed.
   *
   * @param options Filter, fields, sort, view and paging.
   * @example
   * ```ts
   * for await (const task of tasks.list({ filterByFormula: "{Status} = 'Open'" })) {
   *   console.log(task.id, task.fields["Due date"]);
   * }
   * ```
   */
  async *list(options: ListOptions = {}): AsyncGenerator<AirtableRecord<F>, void, undefined> {
    let offset: string | undefined;
    do {
      const page = await this.#page(options, offset);
      yield* page.records;
      offset = page.offset;
    } while (offset);
  }

  /**
   * Read every matching record into an array.
   *
   * @param options Filter, fields, sort, view and paging.
   */
  async listAll(options: ListOptions = {}): Promise<AirtableRecord<F>[]> {
    const out: AirtableRecord<F>[] = [];
    for await (const record of this.list(options)) out.push(record);
    return out;
  }

  async #page(
    options: ListOptions,
    offset: string | undefined,
  ): Promise<{ records: AirtableRecord<F>[]; offset?: string }> {
    const query = new URLSearchParams();
    const set = (key: string, value: string | number | boolean | undefined) => {
      if (value !== undefined) query.set(key, String(value));
    };
    set("pageSize", options.pageSize);
    set("maxRecords", options.maxRecords);
    set("view", options.view);
    set("filterByFormula", options.filterByFormula);
    set("cellFormat", options.cellFormat);
    set("timeZone", options.timeZone);
    set("userLocale", options.userLocale);
    if (options.returnFieldsByFieldId) query.set("returnFieldsByFieldId", "true");
    for (const field of options.fields ?? []) query.append("fields[]", field);
    (options.sort ?? []).forEach((rule, i) => {
      query.set(`sort[${i}][field]`, rule.field);
      if (rule.direction) query.set(`sort[${i}][direction]`, rule.direction);
    });
    set("offset", offset);

    // A rough length check is enough: the API root is short.
    if (this.#path.length + query.toString().length + 100 <= MAX_URL_LENGTH) {
      return await this.#client.request(this.baseId, {
        method: "GET",
        path: this.#path,
        query,
        idempotent: true,
      }) as { records: AirtableRecord<F>[]; offset?: string };
    }

    const body: Record<string, unknown> = {};
    for (
      const key of [
        "pageSize",
        "maxRecords",
        "view",
        "filterByFormula",
        "cellFormat",
        "timeZone",
        "userLocale",
      ] as const
    ) {
      if (options[key] !== undefined) body[key] = options[key];
    }
    if (options.returnFieldsByFieldId) body.returnFieldsByFieldId = true;
    if (options.fields) body.fields = options.fields;
    if (options.sort) body.sort = options.sort;
    if (offset) body.offset = offset;
    return await this.#client.request(this.baseId, {
      method: "POST",
      path: `${this.#path}/listRecords`,
      body,
      idempotent: true,
    }) as { records: AirtableRecord<F>[]; offset?: string };
  }
}
