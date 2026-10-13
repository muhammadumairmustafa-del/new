import type { Db } from "./db.js";
import { balances, roleAccount, isoDate, type Snapshot } from "./ledger.js";
import { cashFlow, liabilitySchedule, partnerStatement, profitAndLoss } from "./reports.js";
import { taxPosition, advanceTaxSchedule } from "./tax-position.js";
import { daysBetween, fiscalYearOf, fyRange } from "../shared/fiscal.js";
import { fromUnits, formatPkr } from "../shared/money.js";
import type { TaxSettings } from "./settings.js";

export interface Check {
  code: string; title: string; severity: "critical" | "high" | "medium" | "low"; area: string;
  status: "fail" | "warn" | "pass"; amount: number | null; detail: string; recommendation: string;
}
const pkr = (u: number) => Math.round(fromUnits(u));
const f = (n: number) => `PKR ${formatPkr(n)}`;

/** Automated audit checks run against the live ledger. Each is explainable and evidence-based. */
export async function runChecks(db: Db, s: Snapshot, tax: TaxSettings, asOf: string, today: string): Promise<Check[]> {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);
  const b = balances(s, asOf);
  const bal = (role: Parameters<typeof roleAccount>[1], sign = 1) => { const a = roleAccount(s, role); return a ? sign * pkr(b.get(a.id) ?? 0) : 0; };
  const cash = bal("bank");
  const curTY = fiscalYearOf(asOf), prevTY = curTY - 1;

  // C01/C02 prior-year income tax
  const prev = taxPosition(s, tax, prevTY, asOf);
  const itLiab = bal("income_tax_payable", -1);
  if (itLiab > 0) {
    const late = daysBetween(prev.rules.returnDueDate, today);
    add({ code: "TAX-01", area: "Income tax", severity: late > 0 ? "critical" : "high", status: "fail", amount: itLiab,
      title: `Income tax for TY${prevTY} unpaid${late > 0 ? ` — ${late} days past the ${prev.rules.returnDueDate} due date` : ""}`,
      detail: `The ledger carries an income tax liability of ${f(itLiab)} with no payment recorded. Withholding tax receivable of ${f(bal("wht_receivable"))} has not been adjusted against it.`,
      recommendation: "Confirm whether the TY return was filed or extended; adjust WHT certificates against the liability; agree a payment plan (instalments can be requested from the Commissioner) to stop default surcharge accruing." });
  }
  if (prev.period.complete && prev.understatement && Math.abs(prev.understatement) > 100000) {
    add({ code: "TAX-02", area: "Income tax", severity: "critical", status: "fail", amount: prev.understatement,
      title: `TY${prevTY} income tax appears under-provided by ${f(prev.understatement)}`,
      detail: `Booked tax expense ${f(prev.bookedTaxExpense)} vs ${f(Math.round(prev.computation.totalTax))} using the configured rates (${prev.rules.source}). The accountant's working uses a 7-slab table topping out at 35% and no s.4AB surcharge.`,
      recommendation: "Have the tax adviser confirm the applicable AOP rates and surcharge for this tax year and correct the provision before the return is finalised." });
  }
  // TAX-03 advance tax
  const adv = advanceTaxSchedule(s, tax, curTY, Math.max(itLiab, Math.round(prev.computation.totalTax)), asOf);
  const missed = adv.quarters.filter((q) => q.complete && q.dueDate < today && q.instalment > 0);
  if (missed.length) {
    const amt = missed.reduce((a, q) => a + q.instalment, 0);
    add({ code: "TAX-03", area: "Income tax", severity: "high", status: "fail", amount: amt,
      title: `Advance tax (s.147) for TY${curTY} not paid: ${missed.map((q) => `Q${q.quarter} due ${q.dueDate}`).join(", ")}`,
      detail: `Estimated instalments ${f(amt)} (turnover-based formula, net of WHT deducted by customers). No advance-tax payment is recorded in the ledger.`,
      recommendation: "Pay or formally estimate lower advance tax (an estimate can be filed if profit will be lower). Unpaid instalments attract default surcharge." });
  }
  // TAX-04 current-year provision missing
  const cur = taxPosition(s, tax, curTY, asOf);
  if (cur.accountingProfit > 0 && cur.bookedTaxExpense === 0) {
    add({ code: "TAX-04", area: "Income tax", severity: "high", status: "fail", amount: Math.round(cur.computation.totalTax),
      title: `No income tax provision for TY${curTY} year-to-date — profit was allocated to partners before tax`,
      detail: `Year-to-date profit before tax ${f(cur.accountingProfit)}; estimated tax on it ${f(Math.round(cur.computation.totalTax))}. Partners' current accounts were credited with pre-tax profit, overstating what is owed to them.`,
      recommendation: "Book a monthly tax provision and allocate only after-tax profit to partners." });
  }
  // TAX-05 salary tax
  const salTax = (liabilitySchedule(s, asOf) as any[]).find((l) => l.role === "salary_tax_payable");
  if (salTax && salTax.balance > 0) {
    add({ code: "TAX-05", area: "Withholding taxes", severity: "high", status: "fail", amount: salTax.balance,
      title: `Salary tax withheld but not deposited (${f(salTax.balance)}), oldest from ${salTax.oldestUnpaidSince}`,
      detail: "Tax deducted from employees under s.149 must be deposited by the 15th of the following month and reported in monthly/annual statements. Withholding and not depositing is a serious default.",
      recommendation: "Deposit immediately via a CPR, file the s.165 statements, and issue salary certificates." });
  }
  // TAX-06 input tax not claimed
  const input = bal("input_tax");
  if (input > 50000) add({ code: "TAX-06", area: "Sales tax", severity: "medium", status: "warn", amount: input,
    title: `Input sales tax of ${f(input)} accumulating, never claimed`, detail: "Input tax on purchases sits in the balance sheet while full output tax is paid monthly.",
    recommendation: "Verify the input invoices are from registered suppliers and claim them in the next return (subject to time limits)." });
  // TAX-07 WHT not adjusted
  const wht = bal("wht_receivable");
  if (wht > 0 && itLiab > 0) add({ code: "TAX-07", area: "Income tax", severity: "medium", status: "warn", amount: wht,
    title: `WHT receivable ${f(wht)} not adjusted against income tax liability`, detail: "Customers' withholding certificates are tax already paid on your behalf and reduce the cash needed for the liability.",
    recommendation: "Collect all CPRs / certificates from customers (some are missing) and claim them in the return." });

  // JAZZ-01
  const jazz = (liabilitySchedule(s, asOf) as any[]).find((l) => l.role === "jazz_payable");
  if (jazz && jazz.balance > 0) {
    const paid = s.lines.some((l) => l.account.system_role === "jazz_payable" && l.dr > 0);
    add({ code: "JAZZ-01", area: "Payables", severity: "high", status: "fail", amount: jazz.balance,
      title: `Jazz platform share ${f(jazz.balance)} outstanding${paid ? "" : " — never paid"}; oldest from ${jazz.oldestUnpaidSince}`,
      detail: "The 40% Jazz share is accrued on every non-Jazz-Cash invoice but no settlement, statement or reconciliation with Jazz is recorded. Terms (pay-on-collection vs pay-on-invoice) and whether Jazz will charge sales tax on its share are undocumented.",
      recommendation: "Obtain the Jazz revenue-share agreement and a statement from Jazz; reconcile invoice-by-invoice; agree that the share is payable only on collection." });
  }
  // AR checks from the register
  const inv = await db.query<any>("SELECT * FROM invoices WHERE coalesce(status,'') <> 'cancelled'");
  const old = inv.filter((i) => Number(i.outstanding) > 1000 && daysBetween(isoDate(i.invoice_date), asOf) > 90);
  if (old.length) {
    const amt = Math.round(old.reduce((a, i) => a + Number(i.outstanding), 0));
    const byClient = new Map<string, number>(); for (const i of old) byClient.set(i.client, (byClient.get(i.client) ?? 0) + Number(i.outstanding));
    add({ code: "AR-01", area: "Receivables", severity: "high", status: "fail", amount: amt,
      title: `${f(amt)} of receivables older than 90 days`, detail: [...byClient.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c}: ${f(Math.round(v))}`).join("; "),
      recommendation: "Get written balance confirmations from each customer, set expected payment dates in the Cash Plan, and consider a provision for doubtful debts for anything disputed." });
  }
  const residual = inv.filter((i) => Number(i.outstanding) > 1000 && Number(i.received) > 0 && Math.abs(Number(i.outstanding) - Number(i.gst)) < 0.02 * Number(i.gst) + 1);
  if (residual.length) {
    const amt = Math.round(residual.reduce((a, i) => a + Number(i.outstanding), 0));
    add({ code: "AR-02", area: "Receivables / Sales tax", severity: "medium", status: "warn", amount: amt,
      title: `${residual.length} part-paid invoices whose open balance equals the GST (${f(amt)}) — likely sales tax withheld by the customer`,
      detail: residual.map((i) => `${i.client} #${i.number ?? "-"}: ${f(Math.round(Number(i.outstanding)))}`).join("; "),
      recommendation: "Obtain the customers' sales-tax withholding evidence and reclassify from receivables against sales tax payable; otherwise these balances will never be collected." });
  }
  const rec = bal("receivable");
  const regTotal = Math.round(inv.reduce((a, i) => a + Number(i.outstanding), 0));
  if (inv.length && Math.abs(rec - regTotal) > 1000) add({ code: "AR-03", area: "Receivables", severity: "low", status: "warn", amount: rec - regTotal,
    title: `Ledger receivables differ from invoice register by ${f(rec - regTotal)}`, detail: `Ledger ${f(rec)} vs register ${f(regTotal)}.`, recommendation: "Reconcile customer-by-customer each month." });

  // PART-01..03
  const fy = fyRange(curTY);
  const ps = partnerStatement(s, fy.from, asOf, new Map());
  const debit = ps.rows.filter((r: any) => r.closing < -1000);
  for (const r of debit as any[]) add({ code: `PART-01-${r.partner}`, area: "Partners", severity: "medium", status: "fail", amount: -r.closing,
    title: `${r.partner}'s current account is overdrawn by ${f(-r.closing)}`, detail: "The partner has received more than the profit and salary credited to them. This is a receivable from the partner.",
    recommendation: "Recover, set off against future profit by written agreement, or document as an advance." });
  const cf = cashFlow(s, fy.from, asOf);
  const toPartners = -(cf.outflows.find((x) => x.label.startsWith("Partner"))?.values.at(-1) ?? 0);
  const statutory = (itLiab > 0 ? itLiab : 0) + (salTax?.balance ?? 0);
  if (toPartners > 0 && statutory > 0) add({ code: "PART-02", area: "Partners / Liquidity", severity: "critical", status: "fail", amount: toPartners,
    title: `${f(toPartners)} paid to partners this year while ${f(statutory)} of tax is unpaid`,
    detail: `Cash paid to partners (salaries, drawings, reimbursements) since ${fy.from}: ${f(toPartners)}. Profit before tax for the same period: ${f(cur.accountingProfit)}. Cash at bank ${f(cash)}.`,
    recommendation: "Freeze partner drawings (and consider deferring partner salaries) until statutory liabilities are cleared or on an agreed payment plan." });
  const partnersTotal = (liabilitySchedule(s, asOf) as any[]).filter((l) => l.partyType === "partner").reduce((a, l) => a + l.balance, 0);
  if (partnersTotal > 0) add({ code: "PART-03", area: "Presentation", severity: "medium", status: "warn", amount: Math.round(partnersTotal),
    title: `Partners' current accounts (${f(Math.round(partnersTotal))}) presented as current liabilities`,
    detail: "All accumulated profit has been moved to partners' current accounts and shown as payables, which makes the firm look like it owes partners cash it does not have and hides the true equity.",
    recommendation: "Present partners' current accounts within partners' funds (toggle on the Balance Sheet) and only treat formally approved distributions as liabilities." });
  // LIQ-01
  if (statutory > cash) add({ code: "LIQ-01", area: "Liquidity", severity: "critical", status: "fail", amount: statutory - cash,
    title: `Cash ${f(cash)} does not cover statutory tax liabilities ${f(statutory)}`, detail: "See the Cash Plan for the week-by-week funding gap including payroll, Jazz and vendors.",
    recommendation: "Prioritise collections from the largest overdue customers, file for instalments, stop discretionary outflows." });
  // DATA-01 ledger is behind
  const lag = daysBetween(asOf, today);
  if (lag > 10) add({ code: "DATA-01", area: "Bookkeeping", severity: lag > 40 ? "high" : "medium", status: "warn", amount: null,
    title: `Books are ${lag} days behind (last entry ${asOf})`, detail: "Decisions are being made on stale numbers.", recommendation: "Import the accountant's next monthly workbook, or enter the bank balance override in the Cash Plan." });
  // PL-01 margin swing
  const pl = profitAndLoss(s, fy.from, asOf);
  const loss = pl.months.map((m, i) => ({ m, v: pl.profitBeforeTax[i] })).filter((x) => x.v < 0);
  if (loss.length) add({ code: "PL-01", area: "Profitability", severity: "medium", status: "warn", amount: Math.round(loss.reduce((a, x) => a + x.v, 0)),
    title: `Loss-making months this year: ${loss.map((x) => x.m).join(", ")}`,
    detail: `Fixed monthly costs (mainly payroll incl. partner salaries) are ~${f(Math.round(-(pl.sections.find((x) => x.key === "Administrative expenses")!.total.at(-1)! / Math.max(1, pl.months.length))))} per month; revenue is lumpy and concentrated in few clients.`,
    recommendation: "Track break-even revenue monthly; partner salaries make the firm loss-making in low months." });
  return out.sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a.severity) - ["critical", "high", "medium", "low"].indexOf(b.severity));
}
