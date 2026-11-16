import { apiAuth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBusiness } from "@/lib/business";
import { extractPdfStatement } from "@/lib/imports";

export const maxDuration = 120;

// Reads the PDF and returns lines for the user to check. Nothing is saved until they confirm.
export async function POST(req: Request) {
  const denied = await apiAuth();
  if (denied) return denied;
  const form = await req.formData();
  const file = form.get("file");
  const bankId = String(form.get("bank_account_id") ?? "");
  if (!(file instanceof File)) return Response.json({ error: "No file" }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return Response.json({ error: "PDF is over 20 MB" }, { status: 400 });
  const biz = await getBusiness();
  const [bank] = await db()<{ kind: "depository" | "credit" }[]>`
    select kind from bank_accounts where id = ${bankId} and business_id = ${biz.id}`;
  if (!bank) return Response.json({ error: "Bank account not found" }, { status: 404 });
  try {
    const rows = await extractPdfStatement(Buffer.from(await file.arrayBuffer()), bank.kind);
    if (rows.length === 0) return Response.json({ error: "No transaction lines found in that PDF" }, { status: 422 });
    return Response.json({ rows });
  } catch (e) {
    console.error(e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
