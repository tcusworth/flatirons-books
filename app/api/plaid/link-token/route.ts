import { apiAuth } from "@/lib/auth";
import { createLinkToken } from "@/lib/plaid";

export async function POST(req: Request) {
  const denied = await apiAuth();
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { itemId?: string };
    const link_token = await createLinkToken(body.itemId || undefined);
    return Response.json({ link_token });
  } catch (e) {
    console.error(e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
