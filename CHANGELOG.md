# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

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

[Unreleased]: https://github.com/munimh/airspool/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/munimh/airspool/releases/tag/v0.1.0
