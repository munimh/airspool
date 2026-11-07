# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The publish workflow skips a registry that already has the version, so a failed run can be re-run, and retries npm
  staging up to three times when Sigstore answers 409 to npm's own retried provenance upload.

## [0.1.2] - 2026-11-07

No code changes. This release is about packaging and docs.

### Added

- A publish workflow that runs on a GitHub release, runs the checks and tests, publishes to JSR and stages the npm
  version for approval, both with provenance through GitHub OIDC, so no publish tokens are stored.

### Changed

- README: badges, a one-line summary of what the library is for, both import paths in the quick start, and a "Why not
  airtable.js?" section.
- npm keywords, and an explicit `publish.exclude` list in `deno.json`.

## [0.1.1] - 2026-11-07

### Fixed

- Requests that were already queued in the rate limiter when a 429 arrived went out during the 30-second pause. They now
  wait it out too.
- A long `Retry-After` on a 5xx answer was waited for in full. Anything longer than `retryMaxDelayMs` now fails at once
  with a retryable `AirtableServerError`.
- The outbox renewed its lease only before each request, so a client retry could go out after another worker had taken
  over and overwrite a newer value. The lease is now renewed before every HTTP attempt.
- `timeLimitMs` was only checked between requests. It is now checked before every attempt, and the outbox no longer lets
  the client sit out 429 pauses itself.
- A 2xx answer whose body could not be read is retried for idempotent requests, and a write answer without `records` is
  an `AirtableServerError` instead of a `TypeError`.

### Added

- `beforeAttempt` client option, and `client.withOptions()`.
- `clientRetries` outbox option (default `{ maxRetries: 1, maxRateLimitRetries: 0 }`).
- `client.timeoutMs` getter.

### Changed

- `new Outbox()` throws a `RangeError` if `leaseMs` is not longer than the client's `timeoutMs`.
- `ProcessResult.requests` counts HTTP attempts, retries included.

## [0.1.0] - 2026-11-07

First release.

### Added

- `AirtableClient`: `fetch`-based client with create, update (PATCH or PUT), upsert (`performUpsert`), delete, get and
  paginated list (switching to `listRecords` POST for long formulas). Writes are batched 10 records per request.
- `RateLimiter`: per-base (5/s) and per-token (50/s) pacing shared by every client in the process; pauses a base for 30
  seconds after a 429.
- Typed errors: `AirtableRequestError`, `AirtableRateLimitError`, `AirtableServerError`, `AirtableNetworkError`, with
  Airtable's error type and message. Request errors are never retried; creates are not retried after a lost answer.
- `Outbox`: durable queue with per-record merging (newest value wins), batching per table, backoff retries,
  `maxAttempts`, a renewable lease so only one processor runs per queue, `retry()`, `discard()`, `failed()`, `status()`,
  and `onSent` / `onFailed` hooks.
- Stores: `memoryStore`, `postgresStore` and `sqliteStore`, driver-agnostic through a `SqlRunner` function, with
  migrations in `sql/`.
- Supabase example with a scheduled Edge Function.

[Unreleased]: https://github.com/munimh/airspool/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/munimh/airspool/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/munimh/airspool/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/munimh/airspool/releases/tag/v0.1.0
