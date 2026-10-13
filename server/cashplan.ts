import type { Db } from "./db.js";
import { balances, roleAccount, isoDate, type Snapshot } from "./ledger.js";
import { liabilitySchedule } from "./reports.js";
import { addDays, daysBetween, fiscalYearOf, monthEnd } from "../shared/fiscal.js";
import { fromUnits } from "../shared/money.js";
import { advanceTaxSchedule, partnerSalaries, taxPosition } from "./tax-position.js";
import { loadSfpLines, reconcile } from "./sfp.js";
import type { CashPlanSettings, TaxSettings } from "./settings.js";

const pkr = (u: number) => Math.round(fromUnits(u));
export interface PlanItem {
  key: string; title: string; category: "statutory" | "payroll" | "jazz" | "vendor" | "partner" | "other" | "collection";
  amount: number; dueDate: string; priority: number; overdueDays: number; basis: string; status: string; penaltyNote?: string;
}

/** 15th of the month after the given date (salary tax / sales tax payment convention). */
const fifteenthNext = (d: string) => { const [y, m] = d.split("-").map(Number); const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1; return `${ny}-${String(nm).padStart(2, "0")}-15`; };

export async function buildCashPlan(db: Db, s: Snapshot, cp: CashPlanSettings, tax: TaxSettings, opts: { asOf: string; today: string; weeks: number }) {
  const { asOf, today } = opts;
  const b = balances(s, asOf);
  const bank = roleAccount(s, "bank");
  const ledgerCash = bank ? pkr(b.get(bank.id) ?? 0) : 0;
  const openingCash = cp.bankBalanceOverride?.amount ?? ledgerCash;
  const startDate = cp.bankBalanceOverride?.date ?? asOf;
  const items: PlanItem[] = [];
  const od = (due: string) => Math.max(0, daysBetween(due, today));

  // --- Income tax: previous (completed) tax year
  const curTY = fiscalYearOf(asOf);
  const prevTY = curTY - 1;
  const prev = taxPosition(s, tax, prevTY, asOf);
  const liabBooked = Math.max(0, Math.round(prev.bookedTaxExpense - prev.taxPaidSinceYearStart)); // prior-year tax only
  const whtAvail = (() => { const a = roleAccount(s, "wht_receivable"); return a ? pkr(b.get(a.id) ?? 0) : 0; })();
  if (liabBooked > 0 || prev.computation.totalTax > 0) {
    const gross = cp.incomeTaxBasis === "recomputed" ? Math.max(liabBooked, Math.round(prev.computation.totalTax)) : liabBooked;
    const whtPrevYear = prev.computation.withholdingCredit;
    const due = prev.rules.returnDueDate;
    items.push({ key: `income_tax_ty${prevTY}`, title: `Income tax TY${prevTY} (net of WHT deducted in that year)`, category: "statutory",
      amount: Math.max(0, gross - whtPrevYear), dueDate: due, priority: 1, overdueDays: od(due), status: "open",
      basis: `${cp.incomeTaxBasis === "recomputed" ? "Recomputed" : "Booked"} tax ${gross.toLocaleString()} less WHT ${whtPrevYear.toLocaleString()} deducted by customers in TY${prevTY}`,
      penaltyNote: od(due) ? `Default surcharge ~${cp.defaultSurchargeRatePa}% p.a. accrues ≈ PKR ${Math.round(Math.max(0, gross - whtPrevYear) * cp.defaultSurchargeRatePa / 100 / 365).toLocaleString()} per day` : undefined });
  }
  // --- Advance tax current year (s.147)
  const latestTax = cp.incomeTaxBasis === "recomputed" ? Math.max(prev.bookedTaxExpense, Math.round(prev.computation.totalTax)) : prev.bookedTaxExpense;
  const adv = advanceTaxSchedule(s, tax, curTY, latestTax, asOf);
  for (const q of adv.quarters) {
    if (!q.complete && q.dueDate > addDays(today, 7 * opts.weeks)) continue;
    const amount = q.complete ? q.instalment : Math.round((latestTax * (q.turnover || adv.quarters.find((x) => x.complete)?.turnover || 0)) / (adv.latestYearTurnover || 1));
    if (amount <= 0) continue;
    items.push({ key: `advance_tax_ty${curTY}_q${q.quarter}`, title: `Advance tax TY${curTY} Q${q.quarter} (s.147)${q.complete ? "" : " — estimate"}`, category: "statutory",
      amount, dueDate: q.dueDate, priority: 1, overdueDays: od(q.dueDate), status: "open",
      basis: `A×B/C − D: ${latestTax.toLocaleString()} × ${q.turnover.toLocaleString()} / ${adv.latestYearTurnover.toLocaleString()} − WHT ${q.withheld.toLocaleString()}` });
  }
  // --- Liabilities from the ledger
  for (const L of liabilitySchedule(s, asOf) as any[]) {
    if (L.balance <= 0) continue;
    if (L.role === "income_tax_payable") continue; // handled above
    if (L.partyType === "partner") continue;       // partners shown separately
    if (L.role === "sales_tax_payable" || L.role === "salary_tax_payable") {
      const byMonth = new Map<string, number>();
      for (const layer of L.layers) byMonth.set(layer.date.slice(0, 7), (byMonth.get(layer.date.slice(0, 7)) ?? 0) + layer.amount);
      for (const [month, amount] of byMonth) {
        if (Math.round(amount) < 10) continue; // ignore rounding residue
        const due = fifteenthNext(`${month}-01`);
        items.push({ key: `${L.role}_${month}`, title: `${L.role === "sales_tax_payable" ? "Sales tax" : "Salary tax (s.149)"} for ${month}`,
          category: "statutory", amount: Math.round(amount), dueDate: due, priority: 1, overdueDays: od(due), status: "open", basis: "Ledger balance, deposit due 15th of following month" });
      }
      continue;
    }
    if (L.role === "jazz_payable") continue; // split below using invoice register
    if (L.role === "advance_from_customer") continue; // not a cash outflow unless refunded
    const cat = L.partyType === "employee" ? "payroll" : "vendor";
    items.push({ key: `acct_${L.accountId}`, title: L.name, category: cat as any, amount: Math.round(L.balance), dueDate: today, priority: cat === "payroll" ? 2 : 4,
      overdueDays: L.oldestDays ?? 0, status: "open", basis: `Ledger balance; oldest unpaid since ${L.oldestUnpaidSince}` });
  }
  // --- Jazz share: due after we collect from the customer
  const invoices = await db.query<any>("SELECT * FROM invoices WHERE coalesce(status,'') <> 'cancelled'");
  const jazzAcct = roleAccount(s, "jazz_payable");
  const jazzBal = jazzAcct ? -pkr(b.get(jazzAcct.id) ?? 0) : 0;
  let jazzCollected = 0; const jazzFuture: { date: string; amount: number; client: string }[] = [];
  const collections: { date: string; amount: number; client: string; invoice: string | null; probability: number }[] = [];
  for (const inv of invoices) {
    const gross = Number(inv.gross_amount) - Number(inv.sales_tax_withheld || 0) - Number(inv.income_tax_withheld || 0);
    const outstanding = Math.max(0, Number(inv.outstanding));
    const net = Number(inv.gross_amount) - Number(inv.income_tax_withheld || 0) - Number(inv.sales_tax_withheld || 0);
    const collectedShare = gross > 0 ? Math.min(1, Number(inv.received) / Math.max(1, net)) : 0;
    const js = Number(inv.jazz_share);
    jazzCollected += js * collectedShare;
    if (outstanding > 1) {
      const invDate = isoDate(inv.invoice_date);
      let exp = inv.expected_date ? isoDate(inv.expected_date) : addDays(invDate, cp.defaultCollectionDays);
      if (exp < today) exp = addDays(today, 14); // overdue: assume chased and collected in 2 weeks unless user sets a date
      const p = Number(inv.collection_probability ?? 100) / 100;
      const cash = outstanding * (1 - cp.withholdingOnCollectionPct / 100) * p;
      collections.push({ date: exp, amount: Math.round(cash), client: inv.client, invoice: inv.number, probability: p });
      if (js > 0) jazzFuture.push({ date: addDays(exp, cp.jazzPaysAfterCollectionDays), amount: Math.round(js * (1 - collectedShare) * p), client: inv.client });
    }
  }
  // Delivered campaigns in Sales Flow Pro that are not invoiced yet: invoice, then collect.
  // Skipped when proposed SFP accruals are already in the ledger snapshot (they would then be in receivables).
  const sfpAccrualsInLedger = s.lines.some((l) => l.source === "sfp-accrual");
  if (cp.includeUninvoicedSfp && !sfpAccrualsInLedger) {
    const { lines: sfpLines, settings: sfpSet } = await loadSfpLines(db);
    if (sfpLines.length) {
      const sales = new Map<string, number>();
      for (const fy of [fiscalYearOf(asOf), fiscalYearOf(today)].filter((v, i, a) => a.indexOf(v) === i)) {
        const rec = await reconcile(db, sfpLines, fy, sales, sfpSet.clientAliases ?? {}, today);
        for (const l of rec.notInvoiced) {
          const invoiceDate = addDays(today, cp.invoiceLagDays);
          const exp = addDays(invoiceDate, cp.defaultCollectionDays);
          const gross = l.revenue * (1 + sfpSet.gstRate);
          collections.push({ date: exp, amount: Math.round(gross * (1 - cp.withholdingOnCollectionPct / 100)), client: `${l.client} (to invoice ${l.month})`, invoice: null, probability: 1 });
          if (l.platformFee > 0) jazzFuture.push({ date: addDays(exp, cp.jazzPaysAfterCollectionDays), amount: Math.round(l.platformFee), client: `${l.client} (${l.month})` });
          // the sales tax on these invoices is payable by the 15th of the month after invoicing
          const stDue = fifteenthNext(invoiceDate);
          items.push({ key: `sfp_st_${l.id}`, title: `Sales tax on new invoice: ${l.client} ${l.month}`, category: "statutory", amount: Math.round(l.revenue * sfpSet.gstRate), dueDate: stDue, priority: 1, overdueDays: 0, status: "open", basis: "Output tax on delivered campaign to be invoiced" });
        }
      }
    }
  }
  const jazzOnCollected = Math.max(0, Math.min(jazzBal, Math.round(jazzCollected)));
  if (jazzOnCollected > 0) items.push({ key: "jazz_collected", title: "Jazz platform share on invoices already collected", category: "jazz", amount: jazzOnCollected,
    dueDate: today, priority: 2, overdueDays: 0, status: "open", basis: `Share of Jazz payable (${jazzBal.toLocaleString()}) relating to cash already received from customers` });
  // Jazz payable in the ledger that the invoice register does not explain (e.g. adjusting entries for
  // invoices booked without a Jazz share) relates to past, collected sales: treat as due now.
  const explained = Math.round(jazzCollected + jazzFuture.reduce((a, j) => a + j.amount, 0));
  const unexplained = jazzBal - explained;
  if (unexplained > 1000) items.push({ key: "jazz_unregistered", title: "Jazz share booked in the ledger but not in the invoice register", category: "jazz", amount: unexplained,
    dueDate: today, priority: 2, overdueDays: 0, status: "open", basis: `Ledger Jazz payable ${jazzBal.toLocaleString()} less ${explained.toLocaleString()} traceable to registered invoices` });
  for (const j of jazzFuture) if (j.amount > 0) items.push({ key: `jazz_${j.client}_${j.date}`, title: `Jazz share — ${j.client} (after collection)`, category: "jazz", amount: j.amount,
    dueDate: j.date, priority: 3, overdueDays: 0, status: "open", basis: `${cp.jazzPaysAfterCollectionDays} days after expected customer receipt` });
  // --- Payroll run-rate
  const lastMonth = asOf.slice(0, 7);
  const lmFrom = `${lastMonth}-01`;
  const payroll = roleAccount(s, "payroll_expense");
  let payrollLast = 0; if (payroll) for (const l of s.lines) if (l.account.id === payroll.id && l.date >= lmFrom && l.date <= asOf) payrollLast += l.dr - l.cr;
  const pSalLast = partnerSalaries(s, lmFrom, asOf);
  const staff = cp.staffPayrollMonthly ?? Math.max(0, pkr(payrollLast) - pSalLast);
  const partnersSal = cp.partnerSalariesMonthly ?? pSalLast;
  const horizonEnd = addDays(startDate, 7 * opts.weeks);
  for (let m = monthEnd(addDays(asOf, 5).slice(0, 7)); m <= horizonEnd; m = monthEnd(addDays(m, 5).slice(0, 7))) {
    if (m <= asOf) continue;
    items.push({ key: `payroll_${m.slice(0, 7)}`, title: `Staff payroll ${m.slice(0, 7)}`, category: "payroll", amount: staff, dueDate: m, priority: 2, overdueDays: 0, status: "open", basis: "Last month's staff payroll" });
    if (cp.includePartnerSalaries && partnersSal) items.push({ key: `partner_salary_${m.slice(0, 7)}`, title: `Partners' salaries ${m.slice(0, 7)}`, category: "partner", amount: partnersSal, dueDate: m, priority: 5, overdueDays: 0, status: "open", basis: "Last month's partner salaries — discretionary" });
  }
  // --- Manual obligations
  for (const o of await db.query<any>("SELECT * FROM obligations WHERE status IN ('open','scheduled')")) {
    const due = isoDate(o.due_date);
    items.push({ key: `manual_${o.id}`, title: o.title, category: o.category, amount: Number(o.amount), dueDate: due, priority: o.priority, overdueDays: od(due), status: o.status, basis: o.notes ?? "Manual entry" });
  }
  // --- Overrides (user-set due dates / amounts / deferrals)
  for (const it of items) {
    const ov = cp.overrides[it.key];
    if (!ov) continue;
    if (ov.dueDate) { it.dueDate = ov.dueDate; it.overdueDays = od(ov.dueDate); }
    if (ov.amount !== undefined) it.amount = ov.amount;
    if (ov.status) it.status = ov.status;
    if (ov.note) it.basis += ` · ${ov.note}`;
  }
  const active = items.filter((i) => i.status !== "paid" && i.status !== "deferred");
  // --- Weekly forecast
  const weeks = Array.from({ length: opts.weeks }, (_, w) => {
    const from = addDays(startDate, w * 7 + (w === 0 ? 0 : 1)); const to = addDays(startDate, (w + 1) * 7);
    return { week: w + 1, from, to, inflow: 0, outflow: 0, statutory: 0, closing: 0 };
  });
  const bucket = (d: string) => { const eff = d < startDate ? startDate : d; return weeks.find((w) => eff <= w.to); };
  for (const c of collections) { const w = bucket(c.date); if (w) w.inflow += c.amount; }
  for (const i of active) { const w = bucket(i.dueDate); if (w) { w.outflow += i.amount; if (i.category === "statutory") w.statutory += i.amount; } }
  let run = openingCash, minCash = openingCash, minWeek = 0;
  for (const w of weeks) { run += w.inflow - w.outflow; w.closing = Math.round(run); if (run < minCash) { minCash = run; minWeek = w.week; } }
  const dueNow = active.filter((i) => i.dueDate <= today);
  const sum = (xs: { amount: number }[]) => Math.round(xs.reduce((a, x) => a + x.amount, 0));
  const partnerBal = (liabilitySchedule(s, asOf) as any[]).filter((l) => l.partyType === "partner").map((l) => ({ name: l.name, balance: l.balance }));
  return {
    asOf, today, startDate, ledgerCash, openingCash, bankBalanceOverride: cp.bankBalanceOverride,
    whtAvailable: whtAvail,
    items: active.sort((a, b) => a.priority - b.priority || (a.dueDate < b.dueDate ? -1 : 1)),
    excluded: items.filter((i) => i.status === "paid" || i.status === "deferred"),
    collections: collections.sort((a, b) => (a.date < b.date ? -1 : 1)),
    weeks, minCash: Math.round(minCash), minWeek,
    summary: {
      dueNow: sum(dueNow), statutoryDueNow: sum(dueNow.filter((i) => i.category === "statutory")),
      shortfallNow: Math.max(0, sum(dueNow) - openingCash),
      statutoryShortfallNow: Math.max(0, sum(dueNow.filter((i) => i.category === "statutory")) - openingCash),
      totalObligations: sum(active), expectedCollections: sum(collections),
      fundingGap: Math.max(0, -Math.round(minCash)),
    },
    partnersCurrentAccounts: partnerBal,
    assumptions: cp,
  };
}
