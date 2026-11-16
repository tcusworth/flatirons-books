"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "Overview" },
  { href: "/inbox", label: "Inbox", badge: "inbox" },
  { href: "/approvals", label: "Approvals", badge: "approvals" },
  { href: "/transactions", label: "Transactions" },
  { href: "/banks", label: "Banks & imports" },
  { href: "/reports/profit-and-loss", label: "Profit & loss" },
  { href: "/reports/balance-sheet", label: "Balance sheet" },
  { href: "/accounts", label: "Chart of accounts" },
  { href: "/journal", label: "Journal entries" },
  { href: "/rules", label: "Rules" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ inboxCount, approvalsCount = 0 }: { inboxCount: number; approvalsCount?: number }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`flex shrink-0 items-center justify-between gap-3 rounded-md px-3 py-1.5 text-sm ${
              active ? "bg-white font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]" : "text-muted hover:bg-black/[0.04] hover:text-ink"
            }`}
          >
            {it.label}
            {it.badge && (it.badge === "inbox" ? inboxCount : approvalsCount) > 0 && (
              <span className={`pill tabular text-white ${it.badge === "approvals" ? "bg-amber-500" : "bg-brand-600"}`}>
                {Math.min(it.badge === "inbox" ? inboxCount : approvalsCount, 999)}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
