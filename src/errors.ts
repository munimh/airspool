/**
 * Errors thrown by the Airtable client.
 *
 * Every error the client throws is an {@link AirtableApiError}. Look at
 * {@link AirtableApiError.retryable} to decide what to do: `false` means the
 * request itself was wrong (a bad field, a bad value, an unknown record, a
 * missing permission) and sending it again will not help.
 *
 * @module
 */

/** What went wrong, in broad terms. */
export type AirtableErrorKind =
  /** Airtable refused the request as invalid (4xx other than 429). Not retryable. */
  | "request"
  /** Airtable answered 429: too many requests. Retryable after a wait. */
  | "rate_limit"
  /** Airtable answered with a 5xx status. Retryable. */
  | "server"
  /** The request never got an answer (DNS, connection reset, timeout). Retryable. */
  | "network";

/** Base class of every error the client throws. */
export class AirtableApiError extends Error {
  /** Broad category of the failure. */
  readonly kind: AirtableErrorKind;
  /** HTTP status, or `0` when no response arrived. */
  readonly status: number;
  /**
   * Airtable's error type, such as `INVALID_REQUEST_UNKNOWN`,
   * `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` or `NOT_FOUND`, when the response
   * carried one.
   */
  readonly type: string | undefined;
  /** Airtable's own error message, when the response carried one. */
  readonly airtableMessage: string | undefined;

  /**
   * Create an error.
   *
   * @param kind Broad category of the failure.
   * @param status HTTP status, or 0 when there was no response.
   * @param message Human-readable message. Never contains the token.
   * @param details Airtable's error type and message, and the underlying cause.
   */
  constructor(
    kind: AirtableErrorKind,
    status: number,
    message: string,
    details: { type?: string; airtableMessage?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "AirtableApiError";
    this.kind = kind;
    this.status = status;
    this.type = details.type;
    this.airtableMessage = details.airtableMessage;
  }

  /** `true` when sending the same request again later may succeed. */
  get retryable(): boolean {
    return this.kind !== "request";
  }
}

/** Airtable refused the request because the request itself was wrong. */
export class AirtableRequestError extends AirtableApiError {
  /**
   * Create an error.
   *
   * @param status HTTP status (400, 401, 403, 404, 413, 422, ...).
   * @param message Human-readable message.
   * @param details Airtable's error type and message.
   */
  constructor(status: number, message: string, details: { type?: string; airtableMessage?: string } = {}) {
    super("request", status, message, details);
    this.name = "AirtableRequestError";
  }
}

/** Airtable answered 429 more times than the client was allowed to wait for. */
export class AirtableRateLimitError extends AirtableApiError {
  /**
   * Create an error.
   *
   * @param message Human-readable message.
   * @param details Airtable's error type and message.
   */
  constructor(message: string, details: { type?: string; airtableMessage?: string } = {}) {
    super("rate_limit", 429, message, details);
    this.name = "AirtableRateLimitError";
  }
}

/** Airtable answered with a server error (5xx) on every try. */
export class AirtableServerError extends AirtableApiError {
  /**
   * Create an error.
   *
   * @param status HTTP status (500, 502, 503, ...).
   * @param message Human-readable message.
   * @param details Airtable's error type and message.
   */
  constructor(status: number, message: string, details: { type?: string; airtableMessage?: string } = {}) {
    super("server", status, message, details);
    this.name = "AirtableServerError";
  }
}

/** No response arrived: the connection failed or timed out. */
export class AirtableNetworkError extends AirtableApiError {
  /**
   * Create an error.
   *
   * @param message Human-readable message.
   * @param cause The error thrown by `fetch`.
   */
  constructor(message: string, cause?: unknown) {
    super("network", 0, message, { cause });
    this.name = "AirtableNetworkError";
  }
}

/**
 * `true` when `error` means the request itself was wrong, so retrying it
 * cannot help. Errors that are not from this library count as temporary.
 */
export function isPermanentError(error: unknown): boolean {
  return error instanceof AirtableApiError && !error.retryable;
}
