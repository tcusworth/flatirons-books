"use client";
import { useMemo, useState } from "react";
import Papa from "papaparse";
import { useRouter } from "next/navigation";
import { guessMapping, mapCsv, type CsvMapping, type ImportRow } from "@/lib/csv";
import { fmt, fmtDate } from "@/lib/money";

type BankOpt = { id: string; name: string; kind: "depository" | "credit"; live: boolean };

export function ImportPanel({ banks, pdfOn }: { banks: BankOpt[]; pdfOn: boolean }) {
  const router = useRouter();
  const [bankId, setBankId] = useState(banks.find((b) => !b.live)?.id ?? banks[0].id);
  const [records, setRecords] = useState<Record<string, string>[] | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [pdfRows, setPdfRows] = useState<ImportRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const bank = banks.find((b) => b.id === bankId)!;

  const mapped = useMemo(() => (records && mapping ? mapCsv(records, mapping) : null), [records, mapping]);
  const rows = pdfRows ?? mapped?.rows ?? null;

  const reset = () => {
    setRecords(null);
    setMapping(null);
    setPdfRows(null);
  };

  const onFile = async (file: File) => {
    reset();
    setMsg(null);
    if (file.name.toLowerCase().endsWith(".pdf")) {
      if (!pdfOn) return setMsg({ ok: false, text: "PDF reading needs ANTHROPIC_API_KEY. Export a CSV from your bank instead." });
      setBusy(true);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("bank_account_id", bankId);
      const res = await fetch("/api/import/pdf", { method: "POST", body: fd });
      const data = await res.json();
      setBusy(false);
      if (!res.ok) return setMsg({ ok: false, text: data.error ?? "Couldn't read that PDF" });
      setPdfRows(data.rows);
      return;
    }
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const hs = res.meta.fields ?? [];
        if (hs.length < 2) return setMsg({ ok: false, text: "That file doesn't look like a CSV with a header row." });
        setHeaders(hs);
        setRecords(res.data);
        setMapping(guessMapping(hs));
      },
      error: (e) => setMsg({ ok: false, text: e.message }),
    });
  };

  const submit = async () => {
    if (!rows?.length) return;
    setBusy(true);
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bank_account_id: bankId, source: pdfRows ? "pdf" : "csv", rows }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: data.error ?? "Import failed" });
    setMsg({ ok: true, text: `Imported ${data.inserted} lines${data.skipped ? `, skipped ${data.skipped} already imported` : ""}. They're in your inbox.` });
    reset();
    router.refresh();
  };

  const sel = (key: keyof CsvMapping, label: string, optional = false) => (
    <div>
      <label className="label">{label}</label>
      <select
        className="input"
        value={(mapping?.[key] as string) ?? ""}
        onChange={(e) => setMapping({ ...mapping!, [key]: e.target.value || undefined })}
      >
        {optional && <option value="">—</option>}
        {headers.map((h) => (
          <option key={h} value={h}>{h}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Into account</label>
          <select className="input" value={bankId} onChange={(e) => { setBankId(e.target.value); reset(); }}>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Statement file (CSV{pdfOn ? " or PDF" : ""})</label>
          <input
            type="file"
            accept={pdfOn ? ".csv,.pdf,text/csv,application/pdf" : ".csv,text/csv"}
            className="block text-sm file:mr-3 file:rounded-md file:border file:border-black/10 file:bg-white file:px-3 file:py-1.5 file:text-sm"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </div>
        {busy && <span className="text-sm text-muted">Working…</span>}
      </div>
      {bank.live && (
        <p className="mt-2 text-xs text-amber-700">
          This account has a live feed. Only import dates the feed doesn&apos;t cover, or you&apos;ll get duplicates (exclude them in the inbox if so).
        </p>
      )}
      {msg && <p className={`mt-3 text-sm ${msg.ok ? "text-brand-700" : "text-red-600"}`}>{msg.text}</p>}

      {mapping && (
        <div className="mt-4 rounded-lg bg-black/[0.02] p-3">
          <p className="mb-2 text-xs font-medium text-muted">Check the columns</p>
          <div className="flex flex-wrap gap-3">
            {sel("date", "Date")}
            {sel("description", "Description")}
            {sel("amount", "Amount (one column)", true)}
            {!mapping.amount && sel("debit", "Money out column", true)}
            {!mapping.amount && sel("credit", "Money in column", true)}
            {mapping.amount && (
              <div>
                <label className="label">In this file, money out is</label>
                <select
                  className="input"
                  value={mapping.negativeIsOut ? "neg" : "pos"}
                  onChange={(e) => setMapping({ ...mapping, negativeIsOut: e.target.value === "neg" })}
                >
                  <option value="neg">Negative (−50.00)</option>
                  <option value="pos">Positive (50.00)</option>
                </select>
              </div>
            )}
          </div>
          {mapped && mapped.errors.length > 0 && (
            <p className="mt-2 text-xs text-red-600">{mapped.errors.length} rows can&apos;t be read: {mapped.errors.slice(0, 3).join("; ")}</p>
          )}
        </div>
      )}

      {rows && (
        <div className="mt-4">
          <p className="mb-2 text-sm">
            {rows.length} lines ready. Money in shows green. If the signs look backwards, flip the setting above.
          </p>
          <div className="max-h-72 overflow-auto rounded-lg border border-black/[0.06]">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-black/[0.05]">
                {rows.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td className="td whitespace-nowrap text-muted">{fmtDate(r.date)}</td>
                    <td className="td">{r.description}</td>
                    <td className={`td text-right tabular ${r.amountCents < 0 ? "text-brand-700" : ""}`}>{fmt(-r.amountCents, { sign: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 50 && <p className="mt-1 text-xs text-muted">Showing the first 50.</p>}
          <div className="mt-3 flex gap-2">
            <button className="btn-primary" disabled={busy || rows.length === 0} onClick={submit}>
              Import {rows.length} lines
            </button>
            <button className="btn-ghost" onClick={reset}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
