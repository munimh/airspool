-- Calls the airspool-process function every minute.
--
-- Before running this, store two secrets in Vault (SQL editor):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<a long random string>', 'airspool_cron_secret');
-- and give the function the same secret:
--   supabase secrets set AIRSPOOL_CRON_SECRET=<the same string> AIRTABLE_TOKEN=<your token>

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'airspool-process',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/airspool-process',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'airspool_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
