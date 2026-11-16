import { db } from "@/lib/db";
import { getBusiness } from "@/lib/business";
import { listProposals, type Proposal } from "@/lib/proposals";
import { fmt, fmtDate } from "@/lib/money";
import { Empty, Money, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/ActionButton";
import { approveProposal, rejectProposalAction } from "../actions";
import Link from "next/link";

type Payload = Record<string, unknown>;

async function Details({ p, businessId }: { p: Proposal; businessId: string }) {
  const sql = db();
  const pl = p.payload as Payload;
  const acctIds: string[] = [];
  if (p.kind === "categorize") for (const i of pl.items as { account_id: string }[]) acctIds.push(i.account_id);
  if (p.kind === "journal_entry") for (const l of pl.lines as { account_id: string }[]) acctIds.push(l.account_id);
  if (p.kind === "create_rule") acctIds.push(pl.account_id as string);
  const names = acctIds.length
    ? new Map((await sql<{ id: string; name: string }[]>`select id, name from accounts where business_id = ${businessId} and id in ${sql(acctIds)}`).map((a) => [a.id, a.name]))
    : new Map<string, string>();

  if (p.kind === "categorize" || p.kind === "exclude") {
    const items = p.kind === "categorize" ? (pl.items as { transaction_id: string; account_id: string }[]) : (pl.transaction_ids as string[]).map((id) => ({ transaction_id: id, account_id: "" }));
    const txns = await sql<{ id: string; txn_date: string; description: string; merchant: string | null; amount_cents: number; status: string; current: string | null }[]>`
      select t.id, t.txn_date, t.description, t.merchant, t.amount_cents, t.status,
        (select a.name from journal_lines l join accounts a on a.id = l.account_id join bank_accounts b on b.id = t.bank_account_id
          where l.entry_id = t.journal_entry_id and l.account_id <> b.ledger_account_id limit 1) as current
      from bank_transactions t where t.business_id = ${businessId} and t.id in ${sql(items.map((i) => i.transaction_id))}`;
    const byId = new Map(txns.map((t) => [t.id, t]));
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <tbody className="divide-y divide-black/[0.05]">
            {items.slice(0, 100).map((i) => {
              const t = byId.get(i.transaction_id);
              return (
                <tr key={i.transaction_id}>
                  <td className="py-1.5 pr-3 text-muted whitespace-nowrap">{t ? fmtDate(t.txn_date) : ""}</td>
                  <td className="py-1.5 pr-3">{t ? t.merchant || t.description : <span className="text-red-600">Transaction no longer exists</span>}</td>
                  <td className="py-1.5 pr-3 text-right">{t && <Money cents={-t.amount_cents} flow />}</td>
                  <td className="py-1.5 text-muted">
                    {p.kind === "exclude" ? "→ Exclude" : (
                      <>
                        {t?.current && t.current !== names.get(i.account_id) ? <span className="line-through">{t.current}</span> : null}
                        {" → "}<span className="font-medium text-ink">{names.get(i.account_id) ?? "Unknown account"}</span>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {items.length > 100 && <p className="mt-1 text-xs text-muted">and {items.length - 100} more</p>}
      </div>
    );
  }
  if (p.kind === "journal_entry") {
    const lines = pl.lines as { account_id: string; debit_cents: number; credit_cents: number; description: string }[];
    return (
      <table className="w-full text-sm">
        <thead><tr><th className="py-1 text-left text-xs text-muted">{fmtDate(pl.date as string)} · {String(pl.memo)}</th><th className="w-28 text-right text-xs text-muted">Debit</th><th className="w-28 text-right text-xs text-muted">Credit</th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className={`py-0.5 ${l.credit_cents ? "pl-6" : ""}`}>{names.get(l.account_id) ?? "Unknown account"}{l.description ? <span className="text-muted"> · {l.description}</span> : null}</td>
              <td className="py-0.5 text-right tabular">{l.debit_cents ? fmt(l.debit_cents) : ""}</td>
              <td className="py-0.5 text-right tabular">{l.credit_cents ? fmt(l.credit_cents) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return null;
}

export default async function ApprovalsPage() {
  const biz = await getBusiness();
  const [pending, decided] = await Promise.all([listProposals(biz.id, "pending", 100), listProposals(biz.id, "decided", 20)]);
  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Changes prepared by Claude or another connected AI app. Nothing touches your books until you approve it here."
      />
      {pending.length === 0 ? (
        <Empty title="Nothing waiting">
          Ask Claude about your books through the connector. Any change it suggests shows up here. <Link className="text-brand-700 underline" href="/settings">Connection details</Link>
        </Empty>
      ) : (
        <div className="space-y-3">
          {pending.map((p) => (
            <div key={p.id} className="card p-4">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{p.summary}</p>
                  <p className="text-xs text-muted">
                    From {p.client_name || "a connected app"} · {new Date(p.created_at).toLocaleString("en-US")}
                  </p>
                  {p.note && <p className="mt-1 text-sm text-muted">“{p.note}”</p>}
                </div>
                <div className="flex gap-2">
                  <ActionButton action={approveProposal.bind(null, p.id)} className="btn-primary">Approve</ActionButton>
                  <ActionButton action={rejectProposalAction.bind(null, p.id)} className="btn-secondary">Reject</ActionButton>
                </div>
              </div>
              <Details p={p} businessId={biz.id} />
            </div>
          ))}
        </div>
      )}
      {decided.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-muted">Recently decided</h2>
          <div className="card divide-y divide-black/[0.05]">
            {decided.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <span className={`pill ${p.status === "applied" ? "bg-brand-50 text-brand-800" : p.status === "failed" ? "bg-red-50 text-red-700" : "bg-black/[0.05] text-muted"}`}>
                  {p.status === "applied" ? "Approved" : p.status === "failed" ? "Failed" : "Rejected"}
                </span>
                <span className="min-w-0 flex-1 truncate">{p.summary}</span>
                {p.result && <span className="text-xs text-muted">{p.result}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
