import { db } from "@/lib/db";
import { syncItem } from "@/lib/plaid";
import { categorizeInbox } from "@/lib/categorize";

// Plaid calls this when new transactions are ready (SYNC_UPDATES_AVAILABLE) or a sign-in expires.
// The body is not trusted for data: it only tells us which stored connection to re-sync from Plaid.
// The URL carries a secret (?key=PLAID_WEBHOOK_SECRET) so strangers can't trigger syncs.
export async function POST(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!process.env.PLAID_WEBHOOK_SECRET || key !== process.env.PLAID_WEBHOOK_SECRET) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { webhook_type?: string; webhook_code?: string; item_id?: string };
  if (!body.item_id) return Response.json({ ok: true });
  const [item] = await db()<{ id: string }[]>`select id from plaid_items where item_id = ${body.item_id}`;
  if (!item) return Response.json({ ok: true });

  if (body.webhook_type === "ITEM" && (body.webhook_code === "ERROR" || body.webhook_code === "PENDING_DISCONNECT" || body.webhook_code === "PENDING_EXPIRATION")) {
    await db()`update plaid_items set status = 'login_required', last_error = ${body.webhook_code} where id = ${item.id}`;
    return Response.json({ ok: true });
  }
  if (body.webhook_type === "TRANSACTIONS") {
    try {
      await syncItem(item.id);
      await categorizeInbox();
    } catch (e) {
      console.error("webhook sync failed", e);
    }
  }
  return Response.json({ ok: true });
}
