// Sends a reminder email for a task, then records that in Airtable through
// the outbox. If Airtable is down, the email is not sent twice and the
// Airtable change is delivered later by the airspool-process function.
import { BASE_ID, outbox } from "../_shared/outbox.ts";

interface ReminderRequest {
  taskRecordId: string; // e.g. "recExampleTask0001"
  to: string;
  taskName: string;
}

async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  // Stand-in for your email provider's API.
  const response = await fetch("https://email-provider.example/send", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("EMAIL_API_KEY")}` },
    body: JSON.stringify({ to, subject, text }),
  });
  if (!response.ok) throw new Error(`email provider answered ${response.status}`);
}

Deno.serve(async (req) => {
  const { taskRecordId, to, taskName } = await req.json() as ReminderRequest;

  // 1. The main action.
  await sendEmail(to, `Reminder: ${taskName}`, `"${taskName}" is due soon.`);

  // 2. Record it. This only writes a row to Postgres; it cannot fail because of Airtable.
  await outbox.enqueue({
    baseId: BASE_ID,
    table: "Tasks",
    recordId: taskRecordId,
    fields: { Status: "Reminder sent", "Reminder sent on": new Date().toISOString().slice(0, 10) },
  });

  // 3. Optional: try to deliver right away. If another run is busy or Airtable is down,
  //    the scheduled processor picks it up.
  const result = await outbox.process({ timeLimitMs: 5_000 }).catch(() => undefined);

  return Response.json({ emailed: true, airtable: result?.written ? "written" : "queued" });
});
