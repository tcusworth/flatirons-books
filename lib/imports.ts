import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { sha1 } from "./crypto";
import { parseCents, parseDate } from "./money";
import { ImportRow } from "./csv";
export { ImportRow };

/**
 * Insert statement lines into the inbox. Re-importing the same file is safe: each line's id is a hash of
 * date, amount, description and how many identical lines came before it in the file.
 */
export async function importRows(businessId: string, bankAccountId: string, rows: ImportRow[], source: "csv" | "pdf") {
  const sql = db();
  const [acct] = await sql<{ id: string }[]>`
    select id from bank_accounts where id = ${bankAccountId} and business_id = ${businessId}`;
  if (!acct) throw new Error("Bank account not found");
  const seen = new Map<string, number>();
  let inserted = 0;
  await sql.begin(async (q) => {
    for (const r of rows) {
      const base = `${r.date}|${r.amountCents}|${r.description.trim().toLowerCase()}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const res = await q`
        insert into bank_transactions (business_id, bank_account_id, external_id, txn_date, description, amount_cents, source)
        values (${businessId}, ${bankAccountId}, ${"imp_" + sha1(`${base}|${n}`)}, ${r.date}, ${r.description.trim()},
          ${r.amountCents}, ${source})
        on conflict (bank_account_id, external_id) do nothing`;
      inserted += res.count;
    }
  });
  return { inserted, skipped: rows.length - inserted };
}

/** Read a PDF bank or card statement with Claude and return its transaction lines for review. */
export async function extractPdfStatement(pdf: Buffer, kind: "depository" | "credit"): Promise<ImportRow[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set, so PDF statements can't be read. Export a CSV instead.");
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: process.env.ANTHROPIC_PDF_MODEL || "claude-sonnet-5-5",
    max_tokens: 16000,
    tools: [
      {
        name: "record_transactions",
        description: "Record every transaction line on the statement.",
        input_schema: {
          type: "object",
          properties: {
            transactions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  date: { type: "string", description: "YYYY-MM-DD" },
                  description: { type: "string" },
                  amount: { type: "number", description: "Positive number in dollars" },
                  direction: { type: "string", enum: ["out", "in"], description: "out = money left the account / charge; in = deposit / payment / refund" },
                },
                required: ["date", "description", "amount", "direction"],
              },
            },
          },
          required: ["transactions"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_transactions" },
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
          {
            type: "text",
            text:
              `This is a ${kind === "credit" ? "credit card" : "bank"} statement. List every transaction line exactly as printed. ` +
              "Skip balances, totals, interest summaries and page headers. Use the full year for each date, taken from the statement period.",
          },
        ],
      },
    ],
  });
  const block = msg.content.find((c) => c.type === "tool_use");
  const list = (block && block.type === "tool_use" ? (block.input as { transactions?: unknown }) : {}).transactions;
  if (!Array.isArray(list)) throw new Error("Couldn't read any transactions from that PDF");
  const rows: ImportRow[] = [];
  for (const t of list as Record<string, unknown>[]) {
    const cents = parseCents(Number(t.amount));
    const parsed = ImportRow.safeParse({
      date: parseDate(String(t.date ?? "")) ?? "",
      description: String(t.description ?? "").trim() || "(no description)",
      amountCents: cents === null ? 0 : (t.direction === "in" ? -1 : 1) * Math.abs(cents),
    });
    if (parsed.success) rows.push(parsed.data);
  }
  return rows;
}
