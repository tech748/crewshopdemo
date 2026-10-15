import type { Db } from "../../db/pool.js";

export interface PriceRule { id: string; kind: "base" | "promo" | "package"; params: Record<string, unknown>; priority: number }
export interface QuoteLine { description: string; amountCents: number; ruleId?: string }
export interface Quote { parcelCount: number; lines: QuoteLine[]; totalCents: number; promoApplied?: string }

/** Pure: given active rules, price an order. Base rule = per parcel. Promo = code + percentOff | amountOffCents. */
export function computeQuote(rules: PriceRule[], parcelCount: number, promoCode?: string): Quote {
  if (parcelCount < 1) throw new Error("parcelCount must be >= 1");
  const base = rules.filter((r) => r.kind === "base").sort((a, b) => b.priority - a.priority)[0];
  if (!base) throw new Error("No base price rule configured");
  const per = Number(base.params.perParcelCents);
  const lines: QuoteLine[] = [{ description: `Delivery x ${parcelCount} parcel(s)`, amountCents: per * parcelCount, ruleId: base.id }];
  let promoApplied: string | undefined;
  if (promoCode) {
    const promo = rules.find((r) => r.kind === "promo" && String(r.params.code).toUpperCase() === promoCode.trim().toUpperCase());
    if (promo) {
      const gross = per * parcelCount;
      const off = promo.params.percentOff != null
        ? Math.round((gross * Number(promo.params.percentOff)) / 100)
        : Math.min(gross, Number(promo.params.amountOffCents ?? 0));
      if (off > 0) { lines.push({ description: `Promo ${promoCode.toUpperCase()}`, amountCents: -off, ruleId: promo.id }); promoApplied = promoCode.toUpperCase(); }
    }
  }
  return { parcelCount, lines, totalCents: lines.reduce((s, l) => s + l.amountCents, 0), promoApplied };
}

export async function loadActiveRules(db: Db, now = new Date()): Promise<PriceRule[]> {
  const r = await db.query(
    `SELECT id, kind, params, priority FROM price_rule
      WHERE (active_from IS NULL OR active_from <= $1) AND (active_to IS NULL OR active_to > $1)`, [now]);
  return r.rows;
}
