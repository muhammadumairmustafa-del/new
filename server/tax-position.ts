import type { Snapshot } from "./ledger.js";
import { balances, counterpart, roleAccount } from "./ledger.js";
import { profitAndLoss, prevDay } from "./reports.js";
import { computeTax, slabTax, ACCOUNTANT_TY2026_SLABS, type TaxYearRules } from "../shared/tax.js";
import { fyRange } from "../shared/fiscal.js";
import { fromUnits } from "../shared/money.js";
import type { TaxSettings } from "./settings.js";

const pkr = (u: number) => Math.round(fromUnits(u));

/** Sum of a role account's movements in [from,to], signed so increases are positive. */
function movement(s: Snapshot, role: Parameters<typeof roleAccount>[1], from: string, to: string, side: "dr" | "cr") {
  const a = roleAccount(s, role); if (!a) return 0;
  let u = 0; for (const l of s.lines) if (l.account.id === a.id && l.date >= from && l.date <= to) u += side === "dr" ? l.dr : l.cr;
  return pkr(u);
}

export function partnerSalaries(s: Snapshot, from: string, to: string) {
  let u = 0;
  for (const l of s.lines) {
    if (l.date < from || l.date > to || l.account.system_role !== "payroll_expense") continue;
    if (counterpart(s, l)?.party_type === "partner") u += l.dr - l.cr;
  }
  return pkr(u);
}

export function taxPosition(s: Snapshot, settings: TaxSettings, taxYear: number, asOf: string) {
  const rules: TaxYearRules = settings.rules.find((r) => r.taxYear === taxYear) ?? settings.rules[settings.rules.length - 1];
  const { from, to: fyEnd } = fyRange(taxYear);
  const to = asOf < fyEnd ? asOf : fyEnd;
  const pl = profitAndLoss(s, from, to);
  const pbt = pl.profitBeforeTax[pl.profitBeforeTax.length - 1];
  const revenue = pl.sections.find((x) => x.key === "Revenue")!.total.at(-1)!;
  const bookedTaxExpense = pl.sections.find((x) => x.key === "Taxation")!.total.at(-1)!;
  const pSal = partnerSalaries(s, from, to);
  const addBacks = settings.treatPartnerSalaryAsInadmissible && pSal ? [{ label: "Partners' salaries (member remuneration) — confirm admissibility", amount: pSal }] : [];
  const deductions = taxYear === 2026 && settings.carryForwardLossTY2026 ? [{ label: "Brought-forward loss TY2025 (only if TY2025 return filed)", amount: settings.carryForwardLossTY2026 }] : [];
  const whtInYear = movement(s, "wht_receivable", from, to, "dr");
  const comp = computeTax({ accountingProfit: pbt, addBacks, deductions, withholdingCredit: whtInYear, rules });
  const months = pl.months.length;
  const accountantMethod = taxYear === 2026 ? slabTax(Math.max(0, pbt - settings.carryForwardLossTY2026), ACCOUNTANT_TY2026_SLABS) : null;
  const liab = roleAccount(s, "income_tax_payable");
  const bookedLiability = liab ? -pkr(balances(s, asOf).get(liab.id) ?? 0) : 0;
  const taxPaid = movement(s, "income_tax_payable", from, asOf, "dr");
  return {
    taxYear, period: { from, to, months, complete: to === fyEnd }, rules,
    revenue, accountingProfit: pbt, bookedTaxExpense, partnerSalaries: pSal,
    computation: comp,
    annualisedEstimate: !(to === fyEnd) && months > 0 ? computeTax({ accountingProfit: (pbt * 12) / months, addBacks: addBacks.map((a) => ({ ...a, amount: (a.amount * 12) / months })), rules }) : null,
    accountantMethodTax: accountantMethod,
    bookedLiabilityAsOf: bookedLiability, taxPaidSinceYearStart: taxPaid,
    understatement: to === fyEnd ? Math.round(comp.totalTax - bookedTaxExpense) : null,
  };
}

/** Advance tax u/s 147: instalment = (A × B / C) − D, A = tax of latest tax year, B = turnover of quarter, C = turnover of latest year, D = tax withheld in quarter. */
export function advanceTaxSchedule(s: Snapshot, settings: TaxSettings, taxYear: number, latestYearTax: number, asOf: string) {
  const rules = settings.rules.find((r) => r.taxYear === taxYear) ?? settings.rules[settings.rules.length - 1];
  const prev = fyRange(taxYear - 1); const cur = fyRange(taxYear);
  const prevPl = profitAndLoss(s, prev.from, prev.to);
  const C = prevPl.sections.find((x) => x.key === "Revenue")!.total.at(-1)!;
  const quarters = [0, 1, 2, 3].map((q) => {
    const startMonth = new Date(Date.UTC(taxYear - 1, 6 + q * 3, 1));
    const qFrom = startMonth.toISOString().slice(0, 10);
    const qTo = prevDay(new Date(Date.UTC(taxYear - 1, 9 + q * 3, 1)).toISOString().slice(0, 10));
    const pl = qFrom <= asOf ? profitAndLoss(s, qFrom, qTo < asOf ? qTo : asOf) : null;
    const B = pl ? pl.sections.find((x) => x.key === "Revenue")!.total.at(-1)! : 0;
    const D = qFrom <= asOf ? movement(s, "wht_receivable", qFrom, qTo < asOf ? qTo : asOf, "dr") : 0;
    const instalment = C > 0 ? Math.max(0, Math.round((latestYearTax * B) / C - D)) : 0;
    return { quarter: q + 1, from: qFrom, to: qTo, dueDate: rules.advanceTaxDueDates[q], turnover: B, withheld: D, instalment, complete: qTo <= asOf };
  });
  void cur;
  return { taxYear, latestYearTax, latestYearTurnover: C, quarters };
}
