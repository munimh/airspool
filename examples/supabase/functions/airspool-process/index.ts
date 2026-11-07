// Sends due outbox changes to Airtable. Called every minute by pg_cron (see
// migrations/20300101000001_airspool_schedule.sql). Only one run at a time
// does any work; overlapping calls return { ran: false } at once.
import { outbox } from "../_shared/outbox.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("AIRSPOOL_CRON_SECRET");
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  // Stay well inside the function's wall-clock limit.
  const result = await outbox.process({ timeLimitMs: 50_000 });
  return Response.json({ ...result, queue: await outbox.status() });
});
