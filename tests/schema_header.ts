/** The comment at the top of the shipped .sql files. */
export function header(dialect: string): string {
  return `-- airspool outbox tables for ${dialect}.
-- Times are milliseconds since the Unix epoch. Safe to run more than once.
-- To use other names, pass tablePrefix (and schema, on Postgres) to the store
-- and edit the names below to match.

`;
}
