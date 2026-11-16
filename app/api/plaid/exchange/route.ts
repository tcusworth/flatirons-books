import { z } from "zod";
import { apiAuth } from "@/lib/auth";
import { exchangePublicToken, syncItem } from "@/lib/plaid";
import { categorizeInbox } from "@/lib/categorize";

const Body = z.object({ public_token: z.string().min(1), institution_name: z.string().max(200).default("") });

export async function POST(req: Request) {
  const denied = await apiAuth();
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  try {
    const r = await exchangePublicToken(parsed.data.public_token, parsed.data.institution_name);
    // First sync may return nothing until Plaid finishes pulling history; the webhook/cron picks up the rest.
    const s = await syncItem(r.itemId).catch(() => ({ added: 0 }));
    if (s.added) await categorizeInbox().catch(() => undefined);
    return Response.json({ ...r, added: s.added });
  } catch (e) {
    console.error(e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
