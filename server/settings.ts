import type { Db } from "./db.js";
import { DEFAULT_TAX_RULES, type TaxYearRules } from "../shared/tax.js";

export interface CashPlanSettings {
  bankBalanceOverride: { amount: number; date: string } | null; // actual bank balance today if ledger is behind
  incomeTaxBasis: "booked" | "recomputed";
  defaultCollectionDays: number;       // fallback days from invoice date to collection
  withholdingOnCollectionPct: number;  // income tax customers deduct when paying (share of gross)
  jazzPaysAfterCollectionDays: number; // Jazz share settled N days after we collect from the customer
  staffPayrollMonthly: number | null;  // null = derive from last month
  partnerSalariesMonthly: number | null;
  includePartnerSalaries: boolean;
  defaultSurchargeRatePa: number;      // default surcharge on late tax (s.205) — verify
  /** Count delivered-but-uninvoiced Sales Flow Pro campaigns as future collections (after invoicing). */
  includeUninvoicedSfp: boolean;
  invoiceLagDays: number;
  overrides: Record<string, { dueDate?: string; amount?: number; status?: string; note?: string }>;
}
export const DEFAULT_CASHPLAN: CashPlanSettings = {
  bankBalanceOverride: null, incomeTaxBasis: "recomputed", defaultCollectionDays: 90, withholdingOnCollectionPct: 7,
  jazzPaysAfterCollectionDays: 30, staffPayrollMonthly: null, partnerSalariesMonthly: null, includePartnerSalaries: true,
  defaultSurchargeRatePa: 12, includeUninvoicedSfp: true, invoiceLagDays: 7, overrides: {},
};
export interface TaxSettings {
  rules: TaxYearRules[];
  treatPartnerSalaryAsInadmissible: boolean;
  carryForwardLossTY2026: number; // loss of TY2025 claimed by the accountant
}
export const DEFAULT_TAX: TaxSettings = { rules: DEFAULT_TAX_RULES, treatPartnerSalaryAsInadmissible: true, carryForwardLossTY2026: 0 };

export async function getSetting<T>(db: Db, key: string, def: T): Promise<T> {
  const r = await db.query<{ value: any }>("SELECT value FROM settings WHERE key = $1", [key]);
  if (!r.length) return def;
  const v = typeof r[0].value === "string" ? JSON.parse(r[0].value) : r[0].value;
  return { ...def, ...v };
}
export async function putSetting(db: Db, key: string, value: unknown) {
  await db.query(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}
