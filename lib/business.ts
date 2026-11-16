import { db, type Q } from "./db";

export type Business = { id: string; name: string; description: string };

/** v1 holds one set of books; the schema already supports more. */
export async function getBusiness(q: Q = db()): Promise<Business> {
  const [b] = await q<Business[]>`select id, name, description from businesses order by created_at limit 1`;
  if (!b) throw new Error("No business found. Run `npm run db:migrate` first.");
  return b;
}

export type Account = {
  id: string;
  code: string | null;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  subtype: string | null;
  is_archived: boolean;
};

export async function listAccounts(businessId: string, opts: { includeArchived?: boolean } = {}, q: Q = db()) {
  return q<Account[]>`
    select id, code, name, type, subtype, is_archived from accounts
    where business_id = ${businessId} ${opts.includeArchived ? q`` : q`and not is_archived`}
    order by case type when 'asset' then 1 when 'liability' then 2 when 'equity' then 3
                       when 'income' then 4 else 5 end, code nulls last, name`;
}

export async function accountBySubtype(businessId: string, subtype: string, q: Q = db()) {
  const [a] = await q<Account[]>`
    select id, code, name, type, subtype, is_archived from accounts
    where business_id = ${businessId} and subtype = ${subtype} and not is_archived
    order by code limit 1`;
  return a ?? null;
}

/** Next free code in a type's range, e.g. 1000-1099 for bank accounts. */
export async function nextCode(businessId: string, start: number, end: number, q: Q = db()): Promise<string | null> {
  const rows = await q<{ code: string }[]>`
    select code from accounts where business_id = ${businessId} and code ~ '^[0-9]+$'
      and code::int between ${start} and ${end}`;
  const used = new Set(rows.map((r) => Number(r.code)));
  for (let c = start; c <= end; c++) if (!used.has(c)) return String(c);
  return null;
}
