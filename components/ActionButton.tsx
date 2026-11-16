"use client";
import { useState, useTransition } from "react";

type Result = { ok: true; message?: string } | { ok: false; error: string } | void;

/** A button that calls a (bound) server action, with an optional confirm prompt and inline error. */
export function ActionButton({
  action,
  children,
  className = "btn-ghost",
  confirm,
}: {
  action: () => Promise<Result>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const go = () =>
    start(async () => {
      setAsking(false);
      const r = await action();
      setErr(r && !r.ok ? r.error : null);
    });
  if (asking) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="text-muted">{confirm}</span>
        <button className="btn-secondary px-2 py-1 text-xs" onClick={go}>Yes</button>
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setAsking(false)}>No</button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button className={className} disabled={pending} onClick={() => (confirm ? setAsking(true) : go())}>
        {pending ? "…" : children}
      </button>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </span>
  );
}
