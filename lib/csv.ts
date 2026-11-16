import { z } from "zod";
import { isIsoDate, parseCents, parseDate } from "./money";

/** One normalized statement line. amountCents uses Plaid's sign: positive = money out. */
export const ImportRow = z.object({
  date: z.string().refine(isIsoDate, "date must be YYYY-MM-DD"),
  description: z.string().min(1).max(500),
  amountCents: z.number().int().refine((n) => n !== 0, "amount can't be zero"),
});
export type ImportRow = z.infer<typeof ImportRow>;

export type CsvMapping = {
  date: string;
  description: string;
  amount?: string; // single signed column
  debit?: string; // money out column
  credit?: string; // money in column
  /** For a single amount column: true when the bank shows money out as a negative number (most do). */
  negativeIsOut: boolean;
};

/** Turn parsed CSV records into ImportRows. Shared by the browser preview and the server. */
export function mapCsv(records: Record<string, string>[], m: CsvMapping): { rows: ImportRow[]; errors: string[] } {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  records.forEach((rec, i) => {
    const date = parseDate(rec[m.date] ?? "");
    const description = (rec[m.description] ?? "").trim();
    let cents: number | null = null;
    if (m.amount) {
      const v = parseCents(rec[m.amount] ?? "");
      if (v !== null) cents = m.negativeIsOut ? -v : v;
    } else {
      const out = parseCents(rec[m.debit ?? ""] ?? "");
      const inn = parseCents(rec[m.credit ?? ""] ?? "");
      if (out) cents = Math.abs(out);
      else if (inn) cents = -Math.abs(inn);
    }
    if (!date && !description && cents === null) return; // blank line
    if (!date) return void errors.push(`Row ${i + 2}: unreadable date "${rec[m.date] ?? ""}"`);
    if (cents === null || cents === 0) return void errors.push(`Row ${i + 2}: no amount`);
    rows.push({ date, description: description || "(no description)", amountCents: cents });
  });
  return { rows, errors };
}

/** Guess which CSV columns hold the date, description and amounts. */
export function guessMapping(headers: string[]): CsvMapping {
  const find = (...words: string[]) => headers.find((h) => words.some((w) => h.toLowerCase().includes(w)));
  const debit = find("debit", "withdrawal", "money out", "charge");
  const credit = find("credit", "deposit", "money in", "payment");
  const amount = find("amount");
  return {
    date: find("posted", "date") ?? headers[0] ?? "",
    description: find("description", "payee", "memo", "details", "name", "merchant") ?? headers[1] ?? "",
    amount: amount && !(debit && credit) ? amount : undefined,
    debit: amount && !(debit && credit) ? undefined : debit,
    credit: amount && !(debit && credit) ? undefined : credit,
    negativeIsOut: true,
  };
}

