import { syncAll } from "@/lib/plaid";
import { categorizeInbox } from "@/lib/categorize";

// Backup to the Plaid webhook: call on a schedule with  Authorization: Bearer <CRON_SECRET>
// (sent by netlify/functions/daily-bank-sync.ts) or ?key=<CRON_SECRET> from any scheduler.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const key = new URL(req.url).searchParams.get("key");
  if (!secret || (auth !== `Bearer ${secret}` && key !== secret)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const results = await syncAll();
  const cat = await categorizeInbox().catch((e) => ({ error: (e as Error).message }));
  return Response.json({ results, categorized: cat });
}
