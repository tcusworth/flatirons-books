"use client";
import { useMemo, useState, useTransition } from "react";
import { approveAllConfident, approveTransfer, approveTxn, excludeTxn, rejectTransfer, runCategorizer, type ActionResult } from "../actions";
import { fmt, fmtDate } from "@/lib/money";

export type InboxTxn = {
  id: string;
  txn_date: string;
  description: string;
  merchant: string | null;
  amount_cents: number;
  source: string;
  bank_category: string | null;
  suggested_account_id: string | null;
  suggestion_confidence: number | null;
  suggestion_reason: string | null;
  suggestion_source: string | null;
  transfer_match_id: string | null;
  bank_name: string;
  match_description: string | null;
  match_bank_name: string | null;
  match_date: string | null;
};
type Opt = { id: string; label: string; type: string };

const GROUPS: [string, string][] = [
  ["expense", "Expenses"],
  ["income", "Income"],
  ["equity", "Equity (owner)"],
  ["liability", "Liabilities"],
  ["asset", "Assets"],
];
const AUTO = 0.9;

export function InboxList({ txns, accounts, aiOn }: { txns: InboxTxn[]; accounts: Opt[]; aiOn: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [q, setQ] = useState("");
  const [onlyUnsure, setOnlyUnsure] = useState(false);

  const ids = useMemo(() => new Set(txns.map((t) => t.id)), [txns]);
  // Show a transfer pair once, on its money-out side.
  const visible = txns.filter((t) => {
    if (t.transfer_match_id && t.amount_cents < 0 && ids.has(t.transfer_match_id)) return false;
    if (onlyUnsure && (t.suggestion_confidence ?? 0) >= AUTO) return false;
    if (q && !`${t.description} ${t.merchant ?? ""} ${t.bank_name}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const confident = txns.filter((t) => (t.suggestion_confidence ?? 0) >= AUTO && (t.suggested_account_id || (t.transfer_match_id && t.amount_cents > 0))).length;

  const run = (fn: () => Promise<ActionResult>) => start(async () => setMsg(await fn()));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={pending || confident === 0} onClick={() => run(() => approveAllConfident(AUTO))}>
          Approve all sure ones ({confident})
        </button>
        <button className="btn-secondary" disabled={pending} onClick={() => run(() => runCategorizer(false))}>
          Suggest categories
        </button>
        {aiOn && (
          <button className="btn-ghost" disabled={pending} onClick={() => run(() => runCategorizer(true))}>
            Re-ask AI
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={onlyUnsure} onChange={(e) => setOnlyUnsure(e.target.checked)} />
            Unsure only
          </label>
          <input className="input w-48" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {!aiOn && (
        <p className="mb-3 text-xs text-muted">AI suggestions are off (no ANTHROPIC_API_KEY). Rules, transfers and your history still work.</p>
      )}
      {msg && (
        <p className={`mb-3 text-sm ${msg.ok ? "text-brand-700" : "text-red-600"}`}>{msg.ok ? msg.message ?? "Done" : msg.error}</p>
      )}
      <div className={`card divide-y divide-black/[0.05] ${pending ? "opacity-60" : ""}`}>
        {visible.map((t) => (t.transfer_match_id ? <TransferRow key={t.id} t={t} run={run} /> : <Row key={t.id} t={t} accounts={accounts} run={run} />))}
        {visible.length === 0 && <p className="px-4 py-6 text-sm text-muted">No lines match.</p>}
      </div>
    </div>
  );
}

function Confidence({ t }: { t: InboxTxn }) {
  if (t.suggestion_confidence == null) return <span className="pill bg-black/[0.05] text-muted">No suggestion</span>;
  const c = t.suggestion_confidence;
  const label = t.suggestion_source === "rule" ? "Rule" : t.suggestion_source === "history" ? "History" : t.suggestion_source === "transfer" ? "Transfer" : "AI";
  const cls = c >= AUTO ? "bg-brand-50 text-brand-800" : c >= 0.6 ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700";
  return (
    <span className={`pill ${cls}`} title={t.suggestion_reason ?? ""}>
      {label} · {Math.round(c * 100)}%
    </span>
  );
}

function Head({ t }: { t: InboxTxn }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="truncate font-medium">{t.merchant || t.description}</p>
      <p className="truncate text-xs text-muted">
        {fmtDate(t.txn_date)} · {t.bank_name}
        {t.merchant ? ` · ${t.description}` : ""}
        {t.source !== "plaid" ? ` · ${t.source.toUpperCase()} import` : ""}
      </p>
      {t.suggestion_reason && <p className="mt-0.5 truncate text-xs text-muted">{t.suggestion_reason}</p>}
    </div>
  );
}

function Amount({ cents }: { cents: number }) {
  // Stored as money out = positive; show it the way a person reads a statement.
  const display = -cents;
  return <span className={`tabular w-28 shrink-0 text-right font-medium ${display > 0 ? "text-brand-700" : ""}`}>{fmt(display, { sign: true })}</span>;
}

function Row({ t, accounts, run }: { t: InboxTxn; accounts: Opt[]; run: (fn: () => Promise<ActionResult>) => void }) {
  const [account, setAccount] = useState(t.suggested_account_id ?? "");
  const [remember, setRemember] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
      <Head t={t} />
      <Amount cents={t.amount_cents} />
      <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
        <Confidence t={t} />
        <select
          className="input w-full sm:w-64"
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            if (e.target.value !== t.suggested_account_id) setRemember(true);
          }}
        >
          <option value="">Choose a category…</option>
          {GROUPS.map(([type, label]) => (
            <optgroup key={type} label={label}>
              {accounts.filter((a) => a.type === type).map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-muted" title="Future lines from this merchant get this category">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember
        </label>
        <button className="btn-primary" disabled={!account} onClick={() => run(() => approveTxn(t.id, account, remember))}>
          Approve
        </button>
        <button className="btn-ghost" onClick={() => run(() => excludeTxn(t.id))} title="Not a business transaction, or a duplicate">
          Exclude
        </button>
      </div>
    </div>
  );
}

function TransferRow({ t, run }: { t: InboxTxn; run: (fn: () => Promise<ActionResult>) => void }) {
  const outSide = t.amount_cents > 0;
  return (
    <div className="flex flex-wrap items-center gap-3 bg-brand-50/40 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          Transfer: {outSide ? t.bank_name : t.match_bank_name} → {outSide ? t.match_bank_name : t.bank_name}
        </p>
        <p className="truncate text-xs text-muted">
          {fmtDate(t.txn_date)} “{t.description}” and {t.match_date ? fmtDate(t.match_date) : ""} “{t.match_description}”
        </p>
      </div>
      <span className="tabular w-28 text-right font-medium">{fmt(Math.abs(t.amount_cents))}</span>
      <div className="flex items-center gap-2">
        <Confidence t={t} />
        <button
          className="btn-primary"
          onClick={() => run(() => (outSide ? approveTransfer(t.id, t.transfer_match_id!) : approveTransfer(t.transfer_match_id!, t.id)))}
        >
          Approve transfer
        </button>
        <button className="btn-ghost" onClick={() => run(() => rejectTransfer(t.id))}>
          Not a transfer
        </button>
      </div>
    </div>
  );
}
