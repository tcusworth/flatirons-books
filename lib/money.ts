/** Format integer cents as US dollars, e.g. -123456 -> "-$1,234.56". */
export function fmt(cents: number, opts: { sign?: boolean } = {}): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const c = String(abs % 100).padStart(2, "0");
  const prefix = neg ? "-" : opts.sign && cents > 0 ? "+" : "";
  return `${prefix}$${dollars}.${c}`;
}

/**
 * Parse a money string into integer cents. Accepts "$1,234.56", "(12.00)", "-5", "1.2".
 * Returns null when the text is not a number.
 */
export function parseCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * 100) : null;
  let s = input.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "").replace(/(USD|CR|DR)$/i, "");
  if (s.startsWith("-")) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.endsWith("-")) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole || "0") * 100 + Number((frac + "00").slice(0, 2));
  // Round half-up on a third decimal place.
  const third = frac.length > 2 ? Number(frac[2]) : 0;
  const total = cents + (third >= 5 ? 1 : 0);
  return neg ? -total : total;
}

/** Today's date as YYYY-MM-DD in the app's time zone (defaults to America/Denver). */
export function today(): string {
  const tz = process.env.APP_TIME_ZONE || "America/Denver";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date()
  );
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Parse common bank date formats into YYYY-MM-DD:
 * 2026-03-07, 03/07/2026, 3/7/26, 03-07-2026, 2026/03/07.
 */
export function parseDate(input: string): string | null {
  const s = input.trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return isIsoDate(iso) ? iso : null;
  }
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    let year = m[3];
    if (year.length === 2) year = (Number(year) > 70 ? "19" : "20") + year;
    const iso = `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return isIsoDate(iso) ? iso : null;
  }
  return null;
}

export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
