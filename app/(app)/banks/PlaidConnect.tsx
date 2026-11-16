"use client";
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink, type PlaidLinkOnSuccess } from "react-plaid-link";
import { useRouter } from "next/navigation";

/** Opens Plaid Link. With itemId it runs Link in update mode to fix an expired sign-in. */
export function PlaidConnect({ itemId, label = "Connect a bank" }: { itemId?: string; label?: string }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const getToken = async () => {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/plaid/link-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setErr(data.error ?? "Couldn't start Plaid");
      setBusy(false);
      return;
    }
    setToken(data.link_token);
  };

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, metadata) => {
      if (itemId) {
        await fetch("/api/plaid/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId }) });
      } else {
        const res = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ public_token: publicToken ?? "", institution_name: metadata.institution?.name ?? "" }),
        });
        if (!res.ok) setErr((await res.json()).error ?? "Couldn't save the connection");
      }
      setBusy(false);
      setToken(null);
      router.refresh();
    },
    [itemId, router]
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
    onExit: () => {
      setBusy(false);
      setToken(null);
    },
  });

  useEffect(() => {
    if (token && ready) open();
  }, [token, ready, open]);

  return (
    <span className="inline-flex items-center gap-2">
      <button className={itemId ? "btn-secondary" : "btn-primary"} disabled={busy} onClick={getToken}>
        {busy ? "Opening…" : label}
      </button>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </span>
  );
}
