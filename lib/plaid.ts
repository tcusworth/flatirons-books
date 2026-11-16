import { PlaidClient, PlaidEnvironment, Plaid } from "plaid";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { getBusiness } from "./business";
import { createLedgerAccountForBank } from "./ledger";

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

function client(): PlaidClient {
  if (!plaidConfigured()) throw new Error("PLAID_CLIENT_ID and PLAID_SECRET are not set");
  return new PlaidClient({
    environment: process.env.PLAID_ENV === "production" ? PlaidEnvironment.Production : PlaidEnvironment.Sandbox,
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    maxRetries: 2,
  });
}

/** Where Plaid should send "new transactions ready" notices. Needs APP_URL and PLAID_WEBHOOK_SECRET. */
function webhookUrl(): string | undefined {
  const base = (process.env.APP_URL || process.env.URL)?.replace(/\/$/, "");
  const key = process.env.PLAID_WEBHOOK_SECRET;
  return base && key ? `${base}/api/plaid/webhook?key=${encodeURIComponent(key)}` : undefined;
}

/** Link token for connecting a new bank, or (with itemId) for re-authenticating an existing one. */
export async function createLinkToken(itemId?: string): Promise<string> {
  const req: Plaid.LinkTokenCreateRequest = {
    client_name: process.env.APP_NAME || "Flatirons Books",
    language: "en",
    country_codes: [Plaid.CountryCode.Us],
    user: { client_user_id: "owner" },
    webhook: webhookUrl(),
  };
  if (itemId) {
    const [item] = await db()<{ access_token_enc: string }[]>`select access_token_enc from plaid_items where id = ${itemId}`;
    if (!item) throw new Error("Bank connection not found");
    req.access_token = decrypt(item.access_token_enc);
  } else {
    req.products = [Plaid.Products.Transactions];
    req.transactions = { days_requested: Number(process.env.PLAID_DAYS_REQUESTED || 730) };
  }
  const res = await client().link.createToken(req);
  return res.link_token;
}

/** After Plaid Link succeeds: store the item (token encrypted) and create a ledger account per bank account. */
export async function exchangePublicToken(publicToken: string, institutionName: string) {
  const c = client();
  const biz = await getBusiness();
  const ex = await c.item.exchangePublicToken({ public_token: publicToken });
  const accts = await c.accounts.get({ access_token: ex.access_token });

  return db().begin(async (q) => {
    const [item] = await q<{ id: string }[]>`
      insert into plaid_items (business_id, item_id, access_token_enc, institution_name)
      values (${biz.id}, ${ex.item_id}, ${encrypt(ex.access_token)}, ${institutionName})
      on conflict (item_id) do update set access_token_enc = excluded.access_token_enc, status = 'active', last_error = null
      returning id`;
    let created = 0;
    for (const a of accts.accounts) {
      const kind = a.type === "credit" ? "credit" : a.type === "depository" ? "depository" : null;
      if (!kind) continue; // loans/investments are out of scope for v1
      const [existing] = await q<{ id: string }[]>`select id from bank_accounts where plaid_account_id = ${a.account_id}`;
      if (existing) continue;
      const label = `${institutionName ? institutionName + " " : ""}${a.name}${a.mask ? ` ••${a.mask}` : ""}`;
      const ledgerId = await createLedgerAccountForBank(q, biz.id, label, kind);
      await q`
        insert into bank_accounts (business_id, plaid_item_id, plaid_account_id, ledger_account_id, name, mask, kind,
          current_balance_cents, balance_updated_at)
        values (${biz.id}, ${item.id}, ${a.account_id}, ${ledgerId}, ${label}, ${a.mask ?? null}, ${kind},
          ${a.balances.current == null ? null : Math.round(a.balances.current * 100)}, now())`;
      created++;
    }
    return { itemId: item.id, accountsCreated: created };
  });
}

/** Pull new, changed and removed transactions with /transactions/sync, from the stored cursor. */
export async function syncItem(itemDbId: string) {
  const sql = db();
  const [item] = await sql<{ id: string; business_id: string; access_token_enc: string; sync_cursor: string | null }[]>`
    select id, business_id, access_token_enc, sync_cursor from plaid_items where id = ${itemDbId}`;
  if (!item) throw new Error("Bank connection not found");
  const accessToken = decrypt(item.access_token_enc);
  const c = client();

  const accts = await sql<{ id: string; plaid_account_id: string }[]>`
    select id, plaid_account_id from bank_accounts where plaid_item_id = ${item.id}`;
  const byPlaidId = new Map(accts.map((a) => [a.plaid_account_id, a.id]));

  let cursor = item.sync_cursor ?? undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;
  try {
    for (let page = 0; page < 50; page++) {
      const res = await c.transactions.sync({ access_token: accessToken, cursor, count: 500 });
      await sql.begin(async (q) => {
        for (const t of res.added) {
          const acct = byPlaidId.get(t.account_id);
          if (!acct || t.pending || !t.amount) continue; // pending lines come back later as posted ones
          const r = await q`
            insert into bank_transactions (business_id, bank_account_id, external_id, txn_date, description, merchant,
              amount_cents, bank_category, source)
            values (${item.business_id}, ${acct}, ${t.transaction_id}, ${t.date},
              ${t.name}, ${t.merchant_name ?? null}, ${Math.round(t.amount * 100)},
              ${t.personal_finance_category?.primary ?? null}, 'plaid')
            on conflict (bank_account_id, external_id) do nothing`;
          added += r.count;
        }
        for (const t of res.modified) {
          const acct = byPlaidId.get(t.account_id);
          if (!acct || t.pending || !t.amount) continue;
          const r = await q`
            update bank_transactions set txn_date = ${t.date}, description = ${t.name},
              merchant = ${t.merchant_name ?? null}, amount_cents = ${Math.round(t.amount * 100)}
            where bank_account_id = ${acct} and external_id = ${t.transaction_id} and status = 'review'`;
          modified += r.count;
        }
        for (const t of res.removed) {
          if (!t.transaction_id) continue;
          const r = await q`
            delete from bank_transactions where external_id = ${t.transaction_id} and source = 'plaid' and status = 'review'
              and bank_account_id in (select id from bank_accounts where plaid_item_id = ${item.id})`;
          removed += r.count;
        }
        for (const a of res.accounts) {
          const id = byPlaidId.get(a.account_id);
          if (id && a.balances.current != null) {
            await q`update bank_accounts set current_balance_cents = ${Math.round(a.balances.current * 100)},
              balance_updated_at = now() where id = ${id}`;
          }
        }
        await q`update plaid_items set sync_cursor = ${res.next_cursor} where id = ${item.id}`;
      });
      cursor = res.next_cursor;
      if (!res.has_more) break;
    }
    await sql`update plaid_items set last_synced_at = now(), status = 'active', last_error = null where id = ${item.id}`;
  } catch (err) {
    const body = (err as { body?: { error_code?: string; error_message?: string } }).body;
    const code = body?.error_code;
    await sql`
      update plaid_items set status = ${code === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error"},
        last_error = ${body?.error_message ?? (err as Error).message}
      where id = ${item.id}`;
    throw err;
  }
  return { added, modified, removed };
}

export async function syncAll() {
  const items = await db()<{ id: string; institution_name: string }[]>`select id, institution_name from plaid_items`;
  const results: { institution: string; ok: boolean; added?: number; error?: string }[] = [];
  for (const it of items) {
    try {
      const r = await syncItem(it.id);
      results.push({ institution: it.institution_name, ok: true, added: r.added });
    } catch (e) {
      results.push({ institution: it.institution_name, ok: false, error: (e as Error).message });
    }
  }
  return results;
}

export async function removeItem(itemDbId: string) {
  const [item] = await db()<{ access_token_enc: string }[]>`select access_token_enc from plaid_items where id = ${itemDbId}`;
  if (!item) return;
  try {
    await client().item.remove({ access_token: decrypt(item.access_token_enc) });
  } catch {
    // Already revoked at Plaid; still disconnect locally.
  }
  // Keep the bank accounts and their history; they become manual (statement-import) accounts.
  await db()`update bank_accounts set plaid_item_id = null, plaid_account_id = null where plaid_item_id = ${itemDbId}`;
  await db()`delete from plaid_items where id = ${itemDbId}`;
}
