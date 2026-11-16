/** Lowercase, drop digits/punctuation noise so "SQ *BLUE BOTTLE #1234 BOULDER" ~ "sq blue bottle boulder". */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[0-9#*]+/g, " ")
    .replace(/[^a-z&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOISE = new Set(["sq", "tst", "pos", "debit", "credit", "card", "purchase", "ach", "payment", "online", "www", "com", "inc", "llc", "the"]);

/** The text a "Remember this choice" rule will look for in future transactions. */
export function rulePatternFor(merchant: string | null | undefined, description: string): string {
  if (merchant && normalizeText(merchant).length >= 3) return normalizeText(merchant);
  const words = normalizeText(description)
    .split(" ")
    .filter((w) => w.length > 1 && !NOISE.has(w));
  return words.slice(0, 3).join(" ");
}

export type Rule = { pattern: string; account_id: string };

/** The longest matching pattern wins, so "amazon web services" beats "amazon". */
export function matchRule(rules: Rule[], merchant: string | null, description: string): Rule | null {
  const hay = ` ${normalizeText(`${merchant ?? ""} ${description}`)} `;
  let best: Rule | null = null;
  for (const r of rules) {
    const p = normalizeText(r.pattern);
    if (!p) continue;
    if (hay.includes(` ${p} `) && (!best || p.length > normalizeText(best.pattern).length)) best = r;
  }
  return best;
}
