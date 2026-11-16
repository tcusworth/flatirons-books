import { apiAuth } from "@/lib/auth";
import { syncItem } from "@/lib/plaid";
import { categorizeInbox } from "@/lib/categorize";

export async function POST(req: Request) {
  const denied = await apiAuth();
  if (denied) return denied;
  const { itemId } = (await req.json().catch(() => ({}))) as { itemId?: string };
  if (!itemId) return Response.json({ error: "itemId required" }, { status: 400 });
  try {
    const r = await syncItem(itemId);
    await categorizeInbox().catch(() => undefined);
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
