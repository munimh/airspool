// One outbox for every function in this project. Supabase gives each
// function SUPABASE_DB_URL; set AIRTABLE_TOKEN with `supabase secrets set`.
import { AirtableClient, Outbox, postgresStore } from "jsr:@munimh/airspool@^0.1";
import postgres from "npm:postgres@^3.4";

// prepare: false because Supabase's pooler runs in transaction mode.
export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

export const outbox = new Outbox({
  client: new AirtableClient({ token: Deno.env.get("AIRTABLE_TOKEN")! }),
  store: postgresStore({ run: (text, params) => sql.unsafe(text, params as never[]) }),
  onFailed: (event) => {
    if (!event.willRetry) {
      // Replace with your alerting. Never log the token; the error message does not contain it.
      console.error(`Airtable write failed for ${event.table} ${event.recordId ?? ""}:`, String(event.error));
    }
  },
});

/** The example base. Replace with your own base ID. */
export const BASE_ID = "appExampleBase0001";
