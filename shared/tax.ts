/**
 * Income tax engine for an AOP / LLP taxed as an association of persons.
 * Rates are configuration, not code: defaults below reflect the First Schedule
 * (Division I) rates for non-salaried individuals and AOPs as understood for
 * tax years 2025-2027, PLUS the s.4AB surcharge. They MUST be confirmed by the
 * firm's tax adviser and can be edited in Settings.
 */
export interface Slab { upTo: number | null; fixed: number; rate: number; over: number }
export interface TaxYearRules {
  taxYear: number;
  slabs: Slab[];
  surchargeRate: number;       // s.4AB surcharge on tax, AOP
  surchargeThreshold: number;  // taxable income above which surcharge applies
  superTaxThreshold: number;   // s.4C — income at/above which super tax applies
  superTaxRate: number;
  returnDueDate: string;       // for AOP
  advanceTaxDueDates: string[]; // s.147 quarterly instalments
  verified: boolean;
  source: string;
}

const NON_SALARIED_TY2025_ON: Slab[] = [
  { upTo: 600_000, fixed: 0, rate: 0, over: 0 },
  { upTo: 1_200_000, fixed: 0, rate: 0.15, over: 600_000 },
  { upTo: 1_600_000, fixed: 90_000, rate: 0.20, over: 1_200_000 },
  { upTo: 3_200_000, fixed: 170_000, rate: 0.30, over: 1_600_000 },
  { upTo: 5_600_000, fixed: 650_000, rate: 0.40, over: 3_200_000 },
  { upTo: null, fixed: 1_610_000, rate: 0.45, over: 5_600_000 },
];

export const DEFAULT_TAX_RULES: TaxYearRules[] = [2026, 2027].map((ty) => ({
  taxYear: ty,
  slabs: NON_SALARIED_TY2025_ON,
  surchargeRate: 0.10,
  surchargeThreshold: 10_000_000,
  superTaxThreshold: 150_000_000,
  superTaxRate: 0.01,
  returnDueDate: `${ty}-09-30`,
  advanceTaxDueDates: [`${ty - 1}-09-25`, `${ty - 1}-12-25`, `${ty}-03-25`, `${ty}-06-15`],
  verified: false,
  source: "Finance Act 2024/2025 non-salaried & AOP slabs + s.4AB surcharge — CONFIRM WITH TAX ADVISER",
}));

/** The slabs the external accountant used for TY2026 (top rate 35%). Kept for comparison only. */
export const ACCOUNTANT_TY2026_SLABS: Slab[] = [
  { upTo: 400_000, fixed: 0, rate: 0, over: 0 },
  { upTo: 600_000, fixed: 0, rate: 0.05, over: 400_000 },
  { upTo: 1_200_000, fixed: 10_000, rate: 0.15, over: 600_000 },
  { upTo: 2_400_000, fixed: 100_000, rate: 0.20, over: 1_200_000 },
  { upTo: 3_600_000, fixed: 340_000, rate: 0.25, over: 2_400_000 },
  { upTo: 6_000_000, fixed: 640_000, rate: 0.30, over: 3_600_000 },
  { upTo: null, fixed: 1_360_000, rate: 0.35, over: 6_000_000 },
];

export function slabTax(income: number, slabs: Slab[]): number {
  if (income <= 0) return 0;
  for (const s of slabs) {
    if (s.upTo === null || income <= s.upTo) return s.fixed + (income - s.over) * s.rate;
  }
  return 0;
}

export interface TaxComputation {
  accountingProfit: number;
  addBacks: { label: string; amount: number }[];
  deductions: { label: string; amount: number }[];
  taxableIncome: number;
  normalTax: number;
  surcharge: number;
  superTax: number;
  totalTax: number;
  withholdingCredit: number;
  advanceTaxPaid: number;
  netPayable: number;
  effectiveRate: number;
}

export function computeTax(input: {
  accountingProfit: number;
  addBacks?: { label: string; amount: number }[];
  deductions?: { label: string; amount: number }[];
  withholdingCredit?: number;
  advanceTaxPaid?: number;
  rules: TaxYearRules;
}): TaxComputation {
  const addBacks = input.addBacks ?? [];
  const deductions = input.deductions ?? [];
  const taxable = Math.max(0, input.accountingProfit + addBacks.reduce((a, b) => a + b.amount, 0) - deductions.reduce((a, b) => a + b.amount, 0));
  const normalTax = slabTax(taxable, input.rules.slabs);
  const surcharge = taxable > input.rules.surchargeThreshold ? normalTax * input.rules.surchargeRate : 0;
  const superTax = taxable >= input.rules.superTaxThreshold ? taxable * input.rules.superTaxRate : 0;
  const totalTax = normalTax + surcharge + superTax;
  const wht = input.withholdingCredit ?? 0;
  const adv = input.advanceTaxPaid ?? 0;
  return {
    accountingProfit: input.accountingProfit, addBacks, deductions, taxableIncome: taxable,
    normalTax, surcharge, superTax, totalTax, withholdingCredit: wht, advanceTaxPaid: adv,
    netPayable: totalTax - wht - adv,
    effectiveRate: taxable > 0 ? totalTax / taxable : 0,
  };
}
