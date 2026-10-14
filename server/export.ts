import ExcelJS from "exceljs";
import { monthLabel, monthEnd } from "../shared/fiscal.js";

const NUM = '#,##0;(#,##0);"-"';
type Grid = (string | number | null)[][];

function sheet(wb: ExcelJS.Workbook, name: string, title: string, subtitle: string, header: string[], rows: Grid, opts: { boldRows?: Set<number>; widths?: number[] } = {}) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 4 }] });
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([subtitle]).font = { italic: true, color: { argb: "FF666666" } };
  ws.addRow([]);
  const h = ws.addRow(header); h.font = { bold: true, color: { argb: "FFFFFFFF" } };
  h.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } }));
  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    row.eachCell((c) => { if (typeof c.value === "number") c.numFmt = NUM; });
    if (opts.boldRows?.has(i)) row.font = { bold: true };
  });
  ws.columns.forEach((c, i) => (c.width = opts.widths?.[i] ?? (i === 0 ? 44 : 16)));
  return ws;
}

export async function statementsWorkbook(data: { company: string; fyLabel: string; generated: string; pl: any; bs: any; cf: any; tb: any; partners: any; liabilities: any[]; tax: any; checks: any[]; plan: any; adjusted: boolean }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TonePerks Finance Platform";
  const sub = `${data.fyLabel} · PKR · generated ${data.generated}${data.adjusted ? " · INCLUDES PROPOSED ADJUSTMENTS" : " · as recorded"}`;
  // P&L
  const months = data.pl.months.map(monthLabel);
  const plRows: Grid = []; const bold = new Set<number>();
  const push = (label: string, vals: number[], b = false) => { if (b) bold.add(plRows.length); plRows.push([label, ...vals]); };
  for (const sec of data.pl.sections) {
    if (!sec.lines.length) continue;
    plRows.push([sec.title]); bold.add(plRows.length - 1);
    for (const l of sec.lines) push(`   ${l.label}`, l.values);
    push(`Total ${sec.title.toLowerCase()}`, sec.total, true);
    if (sec.key === "Cost of sales") push("Gross profit", data.pl.grossProfit, true);
    if (sec.key === "Other income") push("Operating profit", data.pl.operatingProfit, true);
    if (sec.key === "Finance cost") push("Profit before tax", data.pl.profitBeforeTax, true);
  }
  push("Profit after tax", data.pl.profitAfterTax, true);
  sheet(wb, "P&L", `${data.company} — Statement of Profit or Loss`, sub, ["Line item", ...months, "Total"], plRows, { boldRows: bold });
  // Balance sheet
  const bs = data.bs; const bsRows: Grid = []; const bb = new Set<number>();
  const add = (l: string, v: number[] | null, b = false) => { if (b) bb.add(bsRows.length); bsRows.push([l, ...(v ?? [])]); };
  add("Non-current assets", null, true); bs.nonCurrentAssets.lines.forEach((l: any) => add(`   ${l.label}`, l.values));
  add("Current assets", null, true); bs.currentAssets.lines.forEach((l: any) => add(`   ${l.label}`, l.values));
  add("TOTAL ASSETS", bs.totalAssets, true);
  add("Current liabilities", null, true); bs.currentLiabilities.lines.forEach((l: any) => add(`   ${l.label}`, l.values));
  if (!bs.partnersInEquity) bs.partnersCurrentAccounts.lines.forEach((l: any) => add(`   ${l.label}`, l.values));
  add("Total liabilities", bs.totalLiabilities, true);
  add("Partners' funds", null, true);
  add("   Share capital", bs.equity.shareCapital); add("   Accumulated profit", bs.equity.accumulatedProfit); add("   Profit transferred to current accounts", bs.equity.profitTransferred);
  if (bs.partnersInEquity) add("   Partners' current accounts", bs.partnersCurrentAccounts.total);
  add("Total partners' funds", bs.equity.total, true);
  add("Check (should be zero)", bs.check);
  sheet(wb, "Balance Sheet", `${data.company} — Statement of Financial Position`, sub, ["Line item", ...bs.dates], bsRows, { boldRows: bb });
  // Cash flow
  const cfRows: Grid = [["Opening bank balance", ...data.cf.opening]];
  cfRows.push(["Inflows"]); data.cf.inflows.forEach((r: any) => cfRows.push([`   ${r.label}`, ...r.values]));
  cfRows.push(["Outflows"]); data.cf.outflows.forEach((r: any) => cfRows.push([`   ${r.label}`, ...r.values]));
  cfRows.push(["Net cash flow", ...data.cf.net]); cfRows.push(["Closing bank balance", ...data.cf.closing]);
  sheet(wb, "Cash Flow", `${data.company} — Cash flow (direct, from bank ledger)`, sub, ["", ...data.cf.months.map(monthLabel), "Total"], cfRows, { boldRows: new Set([0, cfRows.length - 1, cfRows.length - 2]) });
  // TB
  sheet(wb, "Trial Balance", `${data.company} — Trial balance ${data.tb.from} to ${data.tb.to}`, "Positive = debit", ["Code", "Account", "Opening", "Debit", "Credit", "Closing"],
    [...data.tb.rows.map((r: any) => [r.code, r.name, r.opening, r.debit, r.credit, r.closing]), ["", "Total", data.tb.totals.opening, data.tb.totals.debit, data.tb.totals.credit, data.tb.totals.closing]], { widths: [8, 44, 16, 16, 16, 16] });
  // Partners
  sheet(wb, "Partners", `${data.company} — Partners' current accounts`, `${data.partners.from} to ${data.partners.to} · credit balance = owed to partner`,
    ["Partner", "Ratio", "Opening", "Profit allocated", "Salary", "Expenses paid", "Cash withdrawn", "Cash introduced", "Other", "Closing"],
    data.partners.rows.map((r: any) => [r.partner, r.ratio ?? r.impliedRatio, r.opening, r.profit, r.salary, r.expensesOnBehalf, -r.cashWithdrawn, r.cashIntroduced, r.other, r.closing]));
  // Liabilities
  sheet(wb, "Liabilities", `${data.company} — Liabilities and age`, sub, ["Account", "Category", "Balance", "Oldest unpaid since", "Days"],
    data.liabilities.map((l: any) => [l.name, l.fsLine, l.balance, l.oldestUnpaidSince, l.oldestDays]));
  // Tax
  const t = data.tax; const c = t.computation;
  sheet(wb, "Tax", `${data.company} — Income tax computation TY${t.taxYear}`, `${t.rules.source}${t.rules.verified ? "" : " — NOT YET VERIFIED"}`, ["Item", "PKR"], [
    ["Accounting profit before tax", c.accountingProfit], ...c.addBacks.map((a: any) => [`Add: ${a.label}`, a.amount]), ...c.deductions.map((a: any) => [`Less: ${a.label}`, -a.amount]),
    ["Taxable income", c.taxableIncome], ["Tax on slabs", Math.round(c.normalTax)], ["Surcharge (s.4AB)", Math.round(c.surcharge)], ["Super tax (s.4C)", Math.round(c.superTax)],
    ["Total tax", Math.round(c.totalTax)], ["Less: WHT deducted by customers in year", -c.withholdingCredit], ["Net payable", Math.round(c.netPayable)],
    ["Tax booked in accounts", t.bookedTaxExpense], ["Accountant's method (35% slabs)", t.accountantMethodTax], ["Under/(over) provision", t.understatement]], { widths: [60, 18] });
  // Checks
  sheet(wb, "Audit Checks", `${data.company} — Automated audit checks`, sub, ["Code", "Severity", "Area", "Finding", "Amount", "Detail", "Recommendation"],
    data.checks.map((x) => [x.code, x.severity, x.area, x.title, x.amount, x.detail, x.recommendation]), { widths: [12, 10, 16, 60, 16, 80, 80] });
  // Cash plan
  const p = data.plan;
  sheet(wb, "Cash Plan", `${data.company} — Obligations & payment priority`, `Opening cash ${p.openingCash} on ${p.startDate}`, ["Priority", "Obligation", "Category", "Due", "Days overdue", "Amount", "Basis"],
    p.items.map((i: any) => [i.priority, i.title, i.category, i.dueDate, i.overdueDays, i.amount, i.basis]), { widths: [8, 50, 12, 12, 10, 16, 70] });
  sheet(wb, "Cash Forecast", `${data.company} — Weekly cash forecast`, "Expected collections are probability-weighted and net of customer withholding", ["Week", "From", "To", "Inflow", "Outflow", "of which statutory", "Closing"],
    p.weeks.map((w: any) => [w.week, w.from, w.to, w.inflow, -w.outflow, -w.statutory, w.closing]), { widths: [8, 12, 12, 16, 16, 16, 16] });
  void monthEnd;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const SOURCE: Record<string, string> = { callperks_sourced: "TonePerks (CallPerks)", jazz_sourced: "Jazz sourced", jazz_internal: "Jazz internal (Jazz Cash)" };

/** Month-by-month revenue, who brought it, what is owed to Jazz and what is still to collect. */
export async function monthlyWorkbook(company: string, generated: string, d: any, adjusted: boolean) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "TonePerks Finance Platform";
  const sub = `${monthLabel(d.months[0])} – ${monthLabel(d.months[d.months.length - 1])} · PKR · generated ${generated}${adjusted ? " · books include proposed adjustments" : ""}`;
  const r0 = (n: number) => Math.round(n);
  const tot = (k: string) => r0(d.byMonth.reduce((a: number, m: any) => a + m[k], 0));
  sheet(wb, "Monthly summary", `${company} — Monthly breakdown (campaigns run in the month)`, sub,
    ["Month", "Campaigns", "Revenue", "…brought by TonePerks", "…Jazz sourced", "…Jazz Cash (internal)", "Jazz 40% fee", "TonePerks keeps", "Invoiced", "Not invoiced yet", "Invoice total incl. tax", "Received (cash + tax withheld)", "Still to collect", "…of which from Jazz", "Jazz fee still to pay", "…due now (customer has paid)"],
    [...d.byMonth.map((m: any) => [monthLabel(m.month), m.campaigns, r0(m.revenue), r0(m.bySource.callperks_sourced), r0(m.bySource.jazz_sourced), r0(m.bySource.jazz_internal), r0(m.jazzFee), r0(m.toneperksKeeps), r0(m.invoiced), r0(m.notInvoiced), r0(m.invoiceTotal), r0(m.received), r0(m.toCollect), r0(m.toCollectFromJazz), r0(m.jazzToPay), r0(m.jazzDueNow)]),
     ["Total", tot("campaigns"), tot("revenue"), r0(d.byMonth.reduce((a: number, m: any) => a + m.bySource.callperks_sourced, 0)), r0(d.byMonth.reduce((a: number, m: any) => a + m.bySource.jazz_sourced, 0)), r0(d.byMonth.reduce((a: number, m: any) => a + m.bySource.jazz_internal, 0)), tot("jazzFee"), tot("toneperksKeeps"), tot("invoiced"), tot("notInvoiced"), tot("invoiceTotal"), tot("received"), tot("toCollect"), tot("toCollectFromJazz"), tot("jazzToPay"), tot("jazzDueNow")]],
    { boldRows: new Set([d.byMonth.length]), widths: [12, 10, 15, 15, 14, 14, 14, 15, 14, 14, 15, 16, 15, 14, 15, 15] });
  const bt = (k: string) => r0(d.byMonth.reduce((a: number, m: any) => a + m.books[k], 0));
  sheet(wb, "Books by month", `${company} — The books, month by month`, `${sub} · revenue is booked in the month of the invoice`,
    ["Month", "Revenue booked", "Jazz fee booked", "Paid to Jazz", "Owed to Jazz (month end)", "Cash collected from customers", "Receivables (month end)", "Bank (month end)"],
    [...d.byMonth.map((m: any) => [monthLabel(m.month), r0(m.books.revenue), r0(m.books.jazzFee), r0(m.books.jazzPaid), r0(m.books.jazzPayableEnd), r0(m.books.collected), r0(m.books.receivableEnd), r0(m.books.bankEnd)]),
     ["Total", bt("revenue"), bt("jazzFee"), bt("jazzPaid"), null, bt("collected"), null, null]],
    { boldRows: new Set([d.byMonth.length]), widths: [12, 16, 16, 14, 18, 18, 18, 16] });
  sheet(wb, "By client", `${company} — By client and who brought it`, sub,
    ["Client", "Brought by", "Collect from", "Campaign-months", "Months", "Revenue", "Jazz fee", "TonePerks keeps", "Not invoiced yet", "Invoice total incl. tax", "Received", "Still to collect", "Jazz fee to pay", "…due now"],
    d.byClient.map((c: any) => [c.client, SOURCE[c.source], c.collectFrom, c.campaigns, c.months.map(monthLabel).join(", "), r0(c.revenue), r0(c.jazzFee), r0(c.toneperksKeeps), r0(c.notInvoiced), r0(c.invoiceTotal), r0(c.received), r0(c.toCollect), r0(c.jazzToPay), r0(c.jazzDueNow)]),
    { widths: [26, 22, 12, 10, 30, 14, 13, 14, 14, 15, 14, 14, 14, 13] });
  sheet(wb, "Campaigns", `${company} — Every campaign-month`, sub,
    ["Month", "Code", "Client", "Brought by", "Manager", "Collect from", "Campaign value", "Revenue", "Jazz fee", "TonePerks keeps", "Invoice #", "Invoice total incl. tax", "Received", "Still to collect", "Jazz fee paid", "Jazz fee to pay", "…due now"],
    d.campaigns.map((r: any) => [monthLabel(r.month), r.code, r.client, SOURCE[r.source] + (r.billedByJazz ? " · billed by Jazz" : ""), r.manager, r.collectFrom, r0(r.campaignValue), r0(r.revenue), r0(r.jazzFee), r0(r.toneperksKeeps), r.invoiced ? (r.invoiceNo ?? "yes") : "NOT INVOICED", r0(r.invoiceTotal), r0(r.received), r0(r.toCollect), r0(r.jazzPaid), r0(r.jazzToPay), r0(r.jazzDueNow)]),
    { widths: [10, 9, 26, 26, 16, 12, 14, 13, 12, 14, 12, 15, 13, 14, 12, 13, 12] });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
