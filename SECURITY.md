# Security

## Reporting a problem

Please report security problems privately, through
[GitHub's private vulnerability reporting](https://github.com/munimh/airspool/security/advisories/new), rather than in a
public issue. You should get an answer within a week. Fixes are released as a patch version and noted in the changelog.

## What the library does with secrets

- The Airtable token is sent only in the `Authorization` header to the API URL you configure
  (`https://api.airtable.com/v0` by default).
- It is not stored on the client object's own properties, so `console.log`, `JSON.stringify` and error messages do not
  contain it. The library writes no logs.
- The outbox stores the base ID, table, record ID and field values you enqueue, in your own database. It never stores
  the token. Treat the outbox tables like any other table holding the same data.

## Your side

- Use a personal access token or service account with only the scopes and bases it needs (`data.records:read` and
  `data.records:write` on the bases you write to).
- Keep the token in your platform's secret store, not in code or in the outbox.
- If you expose a processor endpoint (as in the Supabase example), protect it with a secret so others cannot trigger
  runs.
