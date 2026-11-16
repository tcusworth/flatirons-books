"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveJournalEntry } from "../../actions";
import { fmt, parseCents } from "@/lib/money";

type Opt = { id: string; label: string; type: string };
type Line = { accountId: string; debit: string; credit: string; description: string };
const blank = (): Line => ({ accountId: "", debit: "", credit: "", description: "" });

export function JournalForm({ accounts, today }: { accounts: Opt[]; today: string }) {
  const router = useRouter();
  const [date, setDate] = useState(today);
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dr = lines.reduce((s, l) => s + (parseCents(l.debit) ?? 0), 0);
  const cr = lines.reduce((s, l) => s + (parseCents(l.credit) ?? 0), 0);
  const balanced = dr > 0 && dr === cr && lines.every((l) => !(l.debit || l.credit) || l.accountId);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = () =>
    start(async () => {
      const r = await saveJournalEntry({ date, memo, lines: lines.filter((l) => l.accountId && (l.debit || l.credit)) });
      if (r.ok) router.push("/journal");
      else setErr(r.error);
    });

  return (
    <div className="card p-4">
      <div className="mb-4 flex flex-wrap gap-3">
        <div>
          <label className="label">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" />
        </div>
        <div className="min-w-64 flex-1">
          <label className="label">Memo</label>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="e.g. Owner contribution to open the account" className="input" />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr>
              <th className="th pl-0">Account</th>
              <th className="th">Line note</th>
              <th className="th w-32 text-right">Debit</th>
              <th className="th w-32 text-right">Credit</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">
                  <select className="input" value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}>
                    <option value="">Choose…</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                  </select>
                </td>
                <td className="py-1 pr-2"><input className="input" value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                <td className="py-1 pr-2"><input className="input text-right" inputMode="decimal" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} /></td>
                <td className="py-1 pr-2"><input className="input text-right" inputMode="decimal" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} /></td>
                <td>{lines.length > 2 && <button className="btn-ghost px-2" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="pt-2"><button className="btn-ghost px-0" onClick={() => setLines([...lines, blank()])}>+ Add line</button></td>
              <td className="pt-2 text-right text-muted">Totals</td>
              <td className="pt-2 pr-4 text-right tabular">{fmt(dr)}</td>
              <td className="pt-2 pr-4 text-right tabular">{fmt(cr)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      {dr !== cr && <p className="mt-2 text-sm text-amber-700">Out of balance by {fmt(Math.abs(dr - cr))}.</p>}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn-primary" disabled={!balanced || pending} onClick={save}>Save entry</button>
        <button className="btn-ghost" onClick={() => router.push("/journal")}>Cancel</button>
      </div>
    </div>
  );
}
