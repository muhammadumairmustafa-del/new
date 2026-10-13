import { balances, counterpart, roleAccount, type Account, type Line, type Snapshot } from "./ledger.js";
import { fromUnits } from "../shared/money.js";
import { monthEnd, monthKey, monthsBetween, daysBetween } from "../shared/fiscal.js";

const pkr = (u: number) => Math.round(fromUnits(u) * 100) / 100;

// ---------------------------------------------------------------- Trial balance
export function trialBalance(s: Snapshot, from: string, to: string) {
  const open = balances(s, prevDay(from));
  const close = balances(s, to);
  const mov = new Map<number, { dr: number; cr: number }>();
  for (const l of s.lines) {
    if (l.date < from || l.date > to) continue;
    const m = mov.get(l.account.id) ?? { dr: 0, cr: 0 };
    m.dr += l.dr; m.cr += l.cr; mov.set(l.account.id, m);
  }
  const rows = s.accounts.map((a) => ({
    code: a.code, name: a.name, type: a.type, fsLine: a.fs_line,
    opening: pkr(open.get(a.id) ?? 0), debit: pkr(mov.get(a.id)?.dr ?? 0), credit: pkr(mov.get(a.id)?.cr ?? 0),
    closing: pkr(close.get(a.id) ?? 0),
  })).filter((r) => r.opening || r.debit || r.credit || r.closing);
  const sum = (k: "opening" | "debit" | "credit" | "closing") => Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100;
  return { from, to, rows, totals: { opening: sum("opening"), debit: sum("debit"), credit: sum("credit"), closing: sum("closing") } };
}

export function prevDay(d: string) {
  const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- Profit & loss
const PL_SECTIONS: { key: string; title: string; sign: 1 | -1 }[] = [
  { key: "Revenue", title: "Revenue", sign: -1 },
  { key: "Cost of sales", title: "Cost of sales", sign: 1 },
  { key: "Administrative expenses", title: "Administrative expenses", sign: 1 },
  { key: "Other operating expenses", title: "Other operating expenses", sign: 1 },
  { key: "Other income", title: "Other income", sign: -1 },
  { key: "Finance cost", title: "Finance cost", sign: 1 },
  { key: "Taxation", title: "Taxation", sign: 1 },
];

export function profitAndLoss(s: Snapshot, from: string, to: string) {
  const months = monthsBetween(from, to);
  const idx = new Map(months.map((m, i) => [m, i]));
  const cols = months.length + 1;
  const sectionLines = new Map<string, Map<string, number[]>>();
  for (const l of s.lines) {
    if (l.date < from || l.date > to) continue;
    const a = l.account;
    if (a.type !== "income" && a.type !== "expense") continue;
    const sec = PL_SECTIONS.find((x) => x.key === a.grp) ?? (a.type === "income" ? PL_SECTIONS[4] : PL_SECTIONS[3]);
    const lm = sectionLines.get(sec.key) ?? new Map<string, number[]>();
    const arr = lm.get(a.fs_line) ?? new Array(cols).fill(0);
    const v = (l.dr - l.cr) * sec.sign;
    arr[idx.get(monthKey(l.date))!] += v; arr[cols - 1] += v;
    lm.set(a.fs_line, arr); sectionLines.set(sec.key, lm);
  }
  const total = (key: string) => {
    const t = new Array(cols).fill(0);
    for (const arr of sectionLines.get(key)?.values() ?? []) arr.forEach((v, i) => (t[i] += v));
    return t;
  };
  const sections = PL_SECTIONS.map((sec) => ({
    key: sec.key, title: sec.title,
    lines: [...(sectionLines.get(sec.key) ?? new Map()).entries()].map(([label, arr]) => ({ label, values: arr.map(pkr) })),
    total: total(sec.key).map(pkr),
  }));
  const T = Object.fromEntries(PL_SECTIONS.map((x) => [x.key, total(x.key)]));
  const comb = (f: (i: number) => number) => Array.from({ length: cols }, (_, i) => pkr(f(i)));
  const grossProfit = comb((i) => T["Revenue"][i] - T["Cost of sales"][i]);
  const operatingProfit = comb((i) => T["Revenue"][i] - T["Cost of sales"][i] - T["Administrative expenses"][i] - T["Other operating expenses"][i] + T["Other income"][i]);
  const profitBeforeTax = comb((i) => T["Revenue"][i] - T["Cost of sales"][i] - T["Administrative expenses"][i] - T["Other operating expenses"][i] + T["Other income"][i] - T["Finance cost"][i]);
  const profitAfterTax = comb((i) => profitBeforeTax[i] * 10000 - T["Taxation"][i]);
  return { from, to, months, sections, grossProfit, operatingProfit, profitBeforeTax, profitAfterTax };
}

// ---------------------------------------------------------------- Balance sheet
export function balanceSheet(s: Snapshot, dates: string[], opts: { partnersInEquity?: boolean } = {}) {
  const bals = dates.map((d) => balances(s, d));
  const sumBy = (pred: (a: Account) => boolean, sign: 1 | -1) => {
    const lines = new Map<string, number[]>();
    for (const a of s.accounts) {
      if (!pred(a)) continue;
      const arr = lines.get(a.fs_line) ?? new Array(dates.length).fill(0);
      bals.forEach((b, i) => (arr[i] += (b.get(a.id) ?? 0) * sign));
      lines.set(a.fs_line, arr);
    }
    const out = [...lines.entries()].map(([label, v]) => ({ label, values: v.map(pkr) })).filter((r) => r.values.some((x) => x !== 0));
    const total = dates.map((_, i) => pkr([...lines.values()].reduce((acc, v) => acc + v[i], 0)));
    return { lines: out, total };
  };
  const isPartner = (a: Account) => a.type === "liability" && a.party_type === "partner";
  const nonCurrent = sumBy((a) => a.type === "asset" && a.grp === "Non-current assets", 1);
  const current = sumBy((a) => a.type === "asset" && a.grp !== "Non-current assets", 1);
  const liabilities = sumBy((a) => a.type === "liability" && !isPartner(a), -1);
  const partnerAccts = sumBy(isPartner, -1);
  const shareCapital = sumBy((a) => a.type === "equity" && a.system_role === "share_capital", -1);
  const transferred = sumBy((a) => a.type === "equity" && a.system_role !== "share_capital", -1);
  const accumulated = dates.map((_, i) => {
    let u = 0;
    for (const a of s.accounts) if (a.type === "income" || a.type === "expense") u -= bals[i].get(a.id) ?? 0;
    return pkr(u);
  });
  const totalAssets = dates.map((_, i) => pkr((nonCurrent.total[i] + current.total[i]) * 10000));
  const equity = dates.map((_, i) => pkr((shareCapital.total[i] + accumulated[i] + transferred.total[i] + (opts.partnersInEquity ? partnerAccts.total[i] : 0)) * 10000));
  const totalLiabilities = dates.map((_, i) => pkr((liabilities.total[i] + (opts.partnersInEquity ? 0 : partnerAccts.total[i])) * 10000));
  const check = dates.map((_, i) => pkr((totalAssets[i] - equity[i] - totalLiabilities[i]) * 10000));
  return {
    dates, partnersInEquity: !!opts.partnersInEquity,
    nonCurrentAssets: nonCurrent, currentAssets: current, totalAssets,
    currentLiabilities: liabilities, partnersCurrentAccounts: partnerAccts, totalLiabilities,
    equity: { shareCapital: shareCapital.total, accumulatedProfit: accumulated, profitTransferred: transferred.total, total: equity },
    check,
  };
}

// ---------------------------------------------------------------- Cash flow (direct, from bank lines)
export function cashCategory(a: Account | undefined): string {
  if (!a) return "Unclassified";
  const r = a.system_role;
  if (r === "receivable") return "Receipts from customers";
  if (r === "advance_from_customer") return "Advances from customers";
  if (r === "sales_tax_payable" || r === "input_tax") return "Sales tax paid";
  if (r === "income_tax_payable" || r === "wht_receivable" || r === "income_tax_expense") return "Income tax paid";
  if (r === "salary_tax_payable") return "Salary tax deposited";
  if (r === "jazz_payable" || r === "platform_fee") return "Paid to Jazz";
  if (r === "share_capital") return "Capital introduced";
  if (r === "employee_advance") return "Advances to employees";
  if (a.party_type === "partner") return "Partner withdrawals / contributions";
  if (a.party_type === "employee" || r === "payroll_expense") return "Salaries and staff reimbursements";
  if (a.grp === "Non-current assets") return "Fixed assets";
  if (a.grp === "Finance cost") return "Bank charges";
  if (a.party_type === "vendor") return "Vendors and subscriptions";
  if (a.type === "expense") return "Expenses paid directly";
  if (a.type === "income") return "Other receipts";
  return a.fs_line;
}

export function cashFlow(s: Snapshot, from: string, to: string) {
  const bankIds = new Set(s.accounts.filter((a) => a.system_role === "bank").map((a) => a.id));
  const months = monthsBetween(from, to);
  const idx = new Map(months.map((m, i) => [m, i]));
  const cols = months.length + 1;
  const cats = new Map<string, number[]>();
  for (const l of s.lines) {
    if (!bankIds.has(l.account.id) || l.date < from || l.date > to) continue;
    const cat = cashCategory(counterpart(s, l));
    const arr = cats.get(cat) ?? new Array(cols).fill(0);
    const v = l.dr - l.cr;
    arr[idx.get(monthKey(l.date))!] += v; arr[cols - 1] += v;
    cats.set(cat, arr);
  }
  const opening: number[] = []; const closing: number[] = [];
  months.forEach((m, i) => {
    const ob = balances(s, prevDay(i === 0 ? from : `${m}-01`));
    const cb = balances(s, monthEnd(m) < to ? monthEnd(m) : to);
    opening.push(pkr([...bankIds].reduce((a, id) => a + (ob.get(id) ?? 0), 0)));
    closing.push(pkr([...bankIds].reduce((a, id) => a + (cb.get(id) ?? 0), 0)));
  });
  opening.push(opening[0] ?? 0); closing.push(closing[closing.length - 1] ?? 0);
  const rows = [...cats.entries()].map(([label, v]) => ({ label, values: v.map(pkr) }))
    .sort((a, b) => b.values[cols - 1] - a.values[cols - 1]);
  const net = Array.from({ length: cols }, (_, i) => pkr(rows.reduce((a, r) => a + r.values[i] * 10000, 0)));
  return { from, to, months, opening, inflows: rows.filter((r) => r.values[cols - 1] >= 0), outflows: rows.filter((r) => r.values[cols - 1] < 0), net, closing };
}

// ---------------------------------------------------------------- Partners
export function partnerStatement(s: Snapshot, from: string, to: string, ratios: Map<string, number>) {
  const accts = s.accounts.filter((a) => a.party_type === "partner");
  const open = balances(s, prevDay(from)); const close = balances(s, to);
  const rows = accts.map((a) => {
    const r = { partner: a.party ?? a.name, accountId: a.id, ratio: ratios.get(a.party ?? "") ?? null,
      opening: -(open.get(a.id) ?? 0), profit: 0, salary: 0, expensesOnBehalf: 0, cashWithdrawn: 0, cashIntroduced: 0, other: 0, closing: -(close.get(a.id) ?? 0) };
    for (const l of s.lines) {
      if (l.account.id !== a.id || l.date < from || l.date > to) continue;
      const cp = counterpart(s, l); const v = l.cr - l.dr; // credit = owed to partner
      if (cp?.system_role === "profit_transfer") r.profit += v;
      else if (cp?.system_role === "payroll_expense") r.salary += v;
      else if (cp?.system_role === "bank") { if (v < 0) r.cashWithdrawn += -v; else r.cashIntroduced += v; }
      else if (cp?.type === "expense") r.expensesOnBehalf += v;
      else r.other += v;
    }
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" && !["accountId", "ratio"].includes(k) ? pkr(v) : v]));
  });
  const totalProfit = rows.reduce((a, r: any) => a + r.profit, 0);
  return { from, to, rows: rows.map((r: any) => ({ ...r, impliedRatio: totalProfit ? r.profit / totalProfit : null })) };
}

// ---------------------------------------------------------------- FIFO aging of a balance
/** Ages the open balance of an account first-in-first-out. Works for liabilities (credits) and assets (debits). */
export function fifoAging(s: Snapshot, accountId: number, asOf: string) {
  const ls = s.lines.filter((l) => l.account.id === accountId && l.date <= asOf);
  const a = ls[0]?.account; if (!a) return { balance: 0, layers: [] as { date: string; amount: number; memo: string }[] };
  const increaseSide = a.type === "asset" || a.type === "expense" ? "dr" : "cr";
  const layers: { date: string; amount: number; memo: string }[] = [];
  let pending = 0; // decreases not yet matched (e.g. opening advance)
  for (const l of ls) {
    const inc = increaseSide === "dr" ? l.dr : l.cr; const dec = increaseSide === "dr" ? l.cr : l.dr;
    if (inc) {
      let amt = inc;
      if (pending) { const m = Math.min(pending, amt); pending -= m; amt -= m; }
      if (amt) layers.push({ date: l.date, amount: amt, memo: l.description ?? l.memo });
    }
    let d = dec;
    while (d > 0 && layers.length) {
      const m = Math.min(d, layers[0].amount); layers[0].amount -= m; d -= m;
      if (layers[0].amount === 0) layers.shift();
    }
    pending += d;
  }
  const bal = layers.reduce((x, y) => x + y.amount, 0) - pending;
  return { balance: pkr(bal), layers: layers.map((x) => ({ ...x, amount: pkr(x.amount), days: daysBetween(x.date, asOf) })) };
}

export function liabilitySchedule(s: Snapshot, asOf: string) {
  const b = balances(s, asOf);
  return s.accounts.filter((a) => a.type === "liability").map((a) => {
    const bal = -(b.get(a.id) ?? 0);
    if (Math.abs(bal) < 5000) return null; // < 0.5 PKR
    const ag = fifoAging(s, a.id, asOf);
    const oldest = ag.layers[0];
    return { accountId: a.id, code: a.code, name: a.name, fsLine: a.fs_line, partyType: a.party_type, role: a.system_role,
      balance: pkr(bal), oldestUnpaidSince: oldest?.date ?? null, oldestDays: oldest ? daysBetween(oldest.date, asOf) : null, layers: ag.layers };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- Monthly KPIs
export function monthlySeries(s: Snapshot, from: string, to: string) {
  const pl = profitAndLoss(s, from, to);
  const sec = (k: string) => pl.sections.find((x) => x.key === k)!.total;
  const bank = roleAccount(s, "bank"); const rec = roleAccount(s, "receivable");
  return pl.months.map((m, i) => {
    const b = balances(s, monthEnd(m) < to ? monthEnd(m) : to);
    return { month: m, revenue: sec("Revenue")[i], grossProfit: pl.grossProfit[i], profitBeforeTax: pl.profitBeforeTax[i],
      cash: bank ? pkr(b.get(bank.id) ?? 0) : 0, receivables: rec ? pkr(b.get(rec.id) ?? 0) : 0 };
  });
}

export function lastActivityDate(s: Snapshot): string | null {
  return s.lines.length ? s.lines[s.lines.length - 1].date : null;
}
export type { Line };
