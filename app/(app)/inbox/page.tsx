import { db } from "@/lib/db";
import { getBusiness, listAccounts } from "@/lib/business";
import { PageHeader, Empty } from "@/components/ui";
import { InboxList, type InboxTxn } from "./InboxList";
import Link from "next/link";

export default async function InboxPage() {
  const biz = await getBusiness();
  const accounts = (await listAccounts(biz.id)).filter((a) => a.subtype !== "bank" && a.subtype !== "credit_card" && a.subtype !== "opening_balance");
  const txns = await db()<InboxTxn[]>`
    select t.id, t.txn_date, t.description, t.merchant, t.amount_cents, t.source, t.bank_category,
      t.suggested_account_id, t.suggestion_confidence, t.suggestion_reason, t.suggestion_source, t.transfer_match_id,
      b.name as bank_name, m.description as match_description, mb.name as match_bank_name, m.txn_date as match_date
    from bank_transactions t
    join bank_accounts b on b.id = t.bank_account_id
    left join bank_transactions m on m.id = t.transfer_match_id
    left join bank_accounts mb on mb.id = m.bank_account_id
    where t.business_id = ${biz.id} and t.status = 'review'
    order by t.txn_date desc, t.created_at desc
    limit 500`;
  const aiOn = Boolean(process.env.ANTHROPIC_API_KEY);
  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Each line has a suggested category. Approve it, change it, or exclude it. Nothing reaches your books until you approve."
      />
      {txns.length === 0 ? (
        <Empty title="Nothing to review">
          New lines arrive from your <Link className="text-brand-700 underline" href="/banks">bank feeds and statement imports</Link>.
        </Empty>
      ) : (
        <InboxList txns={txns} accounts={accounts.map((a) => ({ id: a.id, label: `${a.code ? a.code + " · " : ""}${a.name}`, type: a.type }))} aiOn={aiOn} />
      )}
    </>
  );
}
