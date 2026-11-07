# airspool on Supabase

A scheduled Edge Function that delivers queued Airtable writes, and a function that queues one after sending an email.
The base, table and fields ("Tasks", "Status", "Reminder sent on") are examples; use your own.

1. Copy `migrations/` into your project's `supabase/migrations/` and run `supabase db push` (or run
   `20300101000000_airspool.sql` in the SQL editor). Rename the files to your own timestamps if you like.
2. Copy `functions/` into `supabase/functions/` and add the sections in `config.toml` to yours.
3. Set secrets:
   ```sh
   supabase secrets set AIRTABLE_TOKEN=pat... AIRSPOOL_CRON_SECRET=<long random string>
   ```
4. Store `project_url` and `airspool_cron_secret` in Vault as described at the top of
   `20300101000001_airspool_schedule.sql`, then run that migration.
5. Deploy: `supabase functions deploy airspool-process send-reminder`.

Check the queue at any time:

```sql
select status, attempts > 0 as retried, count(*) from airspool_changes group by 1, 2;
select id, table_name, record_id, fields, attempts, last_error from airspool_changes where status = 'failed';
```

Use `outbox.retry(ids)` or `outbox.discard(ids)` from a function (or an admin page) to act on failed changes.
