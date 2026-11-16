import { z } from "zod";
import { apiAuth } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { ImportRow, importRows } from "@/lib/imports";
import { categorizeInbox } from "@/lib/categorize";

const Body = z.object({
  bank_account_id: z.string().uuid(),
  source: z.enum(["csv", "pdf"]),
  rows: z.array(ImportRow).min(1).max(20000),
});

export async function POST(req: Request) {
  const denied = await apiAuth();
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Bad request" }, { status: 400 });
  try {
    const biz = await getBusiness();
    const r = await importRows(biz.id, parsed.data.bank_account_id, parsed.data.rows, parsed.data.source);
    const c = await categorizeInbox().catch((e) => ({ error: (e as Error).message }));
    return Response.json({ ...r, categorized: c });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
