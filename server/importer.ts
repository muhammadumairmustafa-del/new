import ExcelJS from "exceljs";
import type { Db } from "./db.js";
import { postEntry, isoDate } from "./ledger.js";
import { toUnits } from "../shared/money.js";

/**
 * Imports the external accountant's workbook format:
 *  - a General Journal sheet (columns JV #, Date, Nature, Account head, Ledger, Description, Payee, Debit, Credit)
 *  - optionally an Invoice Register sheet (Invoice #, Invoice date, Client, Sales amount, GST, ...)
 * Works for both the year-end workbook ("Journal Entries") and monthly/quarterly ones ("Data_Journal").
 */

type Cell = string | number | Date | null;
function val(c: ExcelJS.Cell): Cell {
  const v: any = c.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return v.result instanceof Date ? v.result : (v.result ?? null);
    if ("richText" in v) return v.richText.map((t: any) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("error" in v) return null;
  }
  return v;
}
const norm = (v: Cell) => (v === null ? "" : String(v instanceof Date ? v.toISOString() : v).replace(/\s+/g, " ").trim());
const iso = (v: Cell): string | null => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0]; }
  return null;
};
const num = (v: Cell) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v.replace(/,/g, ""))) ? Number(v.replace(/,/g, "")) : 0);

const ALIASES: Record<string, string> = {
  "advance from customer": "Advance From Customer",
};
export const canonName = (n: string) => ALIASES[n.toLowerCase()] ?? n;

interface ParsedLine { ref: string; date: string; nature: string; head: string; account: string; description: string; payee: string | null; debit: number; credit: number }
export interface ParsedEntry { ref: string; date: string; memo: string; lines: ParsedLine[] }
export interface ParsedInvoice {
  number: string | null; date: string; client: string; billedTo: string; campaignPeriod: string;
  netAmount: number; jazzShare: number; gstRate: number; gst: number; grossAmount: number;
  incomeTaxWithheld: number; salesTaxWithheld: number; received: number; outstanding: number; receivedDates: string | null; notes: string | null;
}

function findHeader(ws: ExcelJS.Worksheet, must: RegExp[], maxRow = 12) {
  for (let r = 1; r <= Math.min(maxRow, ws.rowCount); r++) {
    const row = ws.getRow(r); const cols = new Map<number, string>();
    row.eachCell({ includeEmpty: false }, (c, col) => cols.set(col, norm(val(c))));
    const texts = [...cols.values()];
    if (must.every((re) => texts.some((t) => re.test(t)))) return { row: r, cols };
  }
  return null;
}
const col = (cols: Map<number, string>, re: RegExp) => { for (const [k, v] of cols) if (re.test(v)) return k; return 0; };

export async function parseWorkbook(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const warnings: string[] = [];
  let journal: { sheet: string; entries: ParsedEntry[] } | null = null;
  let invoices: { sheet: string; rows: ParsedInvoice[] } | null = null;

  for (const ws of wb.worksheets) {
    const jh = findHeader(ws, [/^JV ?#?$/i, /^Debit$/i, /^Credit$/i]);
    if (jh && !journal) {
      const c = jh.cols;
      const cJv = col(c, /^JV/i), cDate = col(c, /^Date$/i), cNat = col(c, /^Nature$/i), cHead = col(c, /^Account head$/i),
        cLed = col(c, /Ledger/i), cDesc = col(c, /^Description$/i), cPay = col(c, /^Payee/i), cDr = col(c, /^Debit$/i), cCr = col(c, /^Credit$/i);
      if (!cLed || !cDate) { warnings.push(`Sheet "${ws.name}" looks like a journal but has no Ledger/Date column`); continue; }
      const lines: ParsedLine[] = [];
      for (let r = jh.row + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const account = canonName(norm(val(row.getCell(cLed))));
        if (!account) continue;
        const debit = num(val(row.getCell(cDr))), credit = num(val(row.getCell(cCr)));
        if (!debit && !credit) continue;
        const date = iso(val(row.getCell(cDate)));
        if (!date) { warnings.push(`${ws.name} row ${r}: missing/invalid date — skipped`); continue; }
        lines.push({ ref: norm(val(row.getCell(cJv))), date, nature: cNat ? norm(val(row.getCell(cNat))) : "", head: cHead ? norm(val(row.getCell(cHead))) : "",
          account, description: cDesc ? norm(val(row.getCell(cDesc))) : "", payee: cPay ? norm(val(row.getCell(cPay))) || null : null, debit, credit });
      }
      journal = { sheet: ws.name, entries: groupEntries(lines, warnings) };
      continue;
    }
    const ih = findHeader(ws, [/^Invoice ?#$/i, /^Client/i, /^Sales amount/i]);
    if (ih && !invoices) {
      const c = ih.cols;
      const g = (re: RegExp) => col(c, re);
      const k = { no: g(/^Invoice ?#$/i), date: g(/^Invoice date$/i), client: g(/^Client/i), billed: g(/^Billed to/i), camp: g(/^Campaign period/i),
        net: g(/^Sales amount/i), jazz: g(/^Jazz share/i), rate: g(/^GST rate/i), gst: g(/^GST$/i), gross: g(/^Sales incl/i),
        itw: g(/^Income tax withheld/i), stw: g(/^Sales tax withheld/i), rec: g(/^Received$/i), diff: g(/^Difference|^Outstanding/i),
        rdate: g(/^Receiving Date/i), notes: g(/^Status/i) };
      const rows: ParsedInvoice[] = [];
      for (let r = ih.row + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r); const v = (i: number) => (i ? val(row.getCell(i)) : null);
        const client = norm(v(k.client)); const date = iso(v(k.date));
        if (!client || !date || /^total$/i.test(client)) continue;
        const rd = v(k.rdate);
        rows.push({ number: norm(v(k.no)) || null, date, client, billedTo: norm(v(k.billed)), campaignPeriod: norm(v(k.camp)),
          netAmount: num(v(k.net)), jazzShare: num(v(k.jazz)), gstRate: num(v(k.rate)), gst: num(v(k.gst)), grossAmount: num(v(k.gross)),
          incomeTaxWithheld: num(v(k.itw)), salesTaxWithheld: num(v(k.stw)), received: num(v(k.rec)), outstanding: num(v(k.diff)),
          receivedDates: rd instanceof Date ? iso(rd) : norm(rd) || null, notes: norm(v(k.notes)) || null });
      }
      invoices = { sheet: ws.name, rows };
    }
  }
  return { journal, invoices, warnings };
}

function groupEntries(lines: ParsedLine[], warnings: string[]): ParsedEntry[] {
  const groups = new Map<string, ParsedLine[]>();
  for (const l of lines) { const k = `${l.ref}|${l.date}`; const a = groups.get(k); if (a) a.push(l); else groups.set(k, [l]); }
  const bal = (ls: ParsedLine[]) => ls.reduce((a, l) => a + toUnits(l.debit) - toUnits(l.credit), 0);
  const out: ParsedEntry[] = []; const badRefs = new Set<string>();
  for (const ls of groups.values()) if (bal(ls) !== 0) badRefs.add(ls[0].ref);
  const merged = new Map<string, ParsedLine[]>();
  for (const ls of groups.values()) {
    if (badRefs.has(ls[0].ref) && ls[0].ref) { const m = merged.get(ls[0].ref) ?? []; m.push(...ls); merged.set(ls[0].ref, m); }
    else out.push({ ref: ls[0].ref, date: ls[0].date, memo: ls[0].description, lines: ls });
  }
  for (const [ref, ls] of merged) {
    if (bal(ls) !== 0) { warnings.push(`Journal ${ref} does not balance (difference ${bal(ls) / 10000}) — NOT imported`); continue; }
    const date = ls.map((l) => l.date).sort()[0];
    out.push({ ref, date, memo: ls[0].description, lines: ls });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ------------------------------------------------------------- account classification
const PL: Record<string, [string, string, string, string, string?]> = {
  // name: [code, type, group, fsLine, role]
  "Sales": ["4000", "income", "Revenue", "Revenue", "revenue"],
  "Unidentified Income": ["4900", "income", "Other income", "Other income"],
  "Platform Fee": ["5000", "expense", "Cost of sales", "Cost of sales - Jazz platform fee", "platform_fee"],
  "Payroll Expense": ["6000", "expense", "Administrative expenses", "Payroll", "payroll_expense"],
  "Dues and Subscription": ["6010", "expense", "Administrative expenses", "Dues and subscriptions"],
  "Travelling Expense": ["6020", "expense", "Administrative expenses", "Travelling"],
  "Fuel Expense": ["6030", "expense", "Administrative expenses", "Fuel"],
  "Meal and Entertainment": ["6040", "expense", "Administrative expenses", "Meals and entertainment"],
  "Deprecition - IT Equipment": ["6050", "expense", "Administrative expenses", "Depreciation", "depreciation"],
  "Deprecition - Furniture and Fittings": ["6051", "expense", "Administrative expenses", "Depreciation", "depreciation"],
  "Printing & Stationery Expense": ["6060", "expense", "Administrative expenses", "Printing and stationery"],
  "Research & Development": ["6070", "expense", "Administrative expenses", "Research and development"],
  "Utilities": ["6080", "expense", "Administrative expenses", "Utilities"],
  "Commission Expense": ["6090", "expense", "Administrative expenses", "Commission"],
  "Legal and Professional Services": ["6500", "expense", "Other operating expenses", "Legal and professional"],
  "IT Related Expense": ["6510", "expense", "Other operating expenses", "IT related"],
  "Unidentified Expense": ["6590", "expense", "Other operating expenses", "Other expenses"],
  "Bank Charges": ["7000", "expense", "Finance cost", "Finance cost"],
  "Income Tax Expense": ["8000", "expense", "Taxation", "Income tax", "income_tax_expense"],
  "IT Equipment & Hardware": ["1500", "asset", "Non-current assets", "Property and equipment"],
  "Acc . Depreciation - IT Equipment & Hardware": ["1501", "asset", "Non-current assets", "Property and equipment"],
  "Furniture and Fittings": ["1510", "asset", "Non-current assets", "Property and equipment"],
  "Acc . Depreciation - Furniture and Fittings": ["1511", "asset", "Non-current assets", "Property and equipment"],
  "Bank Alfalah": ["1000", "asset", "Current assets", "Cash and bank balances", "bank"],
  "Receivable": ["1100", "asset", "Current assets", "Trade receivables", "receivable"],
  "WHT Receivable": ["1200", "asset", "Current assets", "Withholding tax receivable", "wht_receivable"],
  "Sales Tax Receivable / Input": ["1210", "asset", "Current assets", "Sales tax input receivable", "input_tax"],
  "Advance to Employee": ["1300", "asset", "Current assets", "Advances to employees", "employee_advance"],
  "Payable to Jazz": ["2000", "liability", "Current liabilities", "Payable to Jazz (platform share)", "jazz_payable"],
  "Tax Liability": ["2100", "liability", "Current liabilities", "Income tax liability", "income_tax_payable"],
  "Sales Tax Payable": ["2110", "liability", "Current liabilities", "Sales tax payable", "sales_tax_payable"],
  "Salary Tax Payable": ["2120", "liability", "Current liabilities", "Salary tax payable (s.149)", "salary_tax_payable"],
  "Payable to PRA": ["2130", "liability", "Current liabilities", "Trade and other payables"],
  "Advance From Customer": ["2300", "liability", "Current liabilities", "Advances from customers", "advance_from_customer"],
  "Share Capital": ["3000", "equity", "Partners' equity", "Share capital", "share_capital"],
  "Drawings - Partner's Current Acount": ["3100", "equity", "Partners' equity", "Profit transferred to partners' current accounts", "profit_transfer"],
};

function guessByHead(nature: string, head: string): [string, string, string] {
  const n = nature.toLowerCase(), h = head.toLowerCase();
  if (n.startsWith("asset")) return h.includes("non") ? ["asset", "Non-current assets", "Property and equipment"] : ["asset", "Current assets", "Other current assets"];
  if (n.startsWith("liabil")) return ["liability", "Current liabilities", "Trade and other payables"];
  if (n.startsWith("equity")) return ["equity", "Partners' equity", "Other equity"];
  if (n.startsWith("income")) return ["income", "Other income", "Other income"];
  if (h.includes("cost of good")) return ["expense", "Cost of sales", "Cost of sales - other"];
  if (h.includes("finance")) return ["expense", "Finance cost", "Finance cost"];
  if (h.includes("tax")) return ["expense", "Taxation", "Income tax"];
  if (h.includes("operating")) return ["expense", "Other operating expenses", "Other expenses"];
  return ["expense", "Administrative expenses", "Other administrative expenses"];
}

export async function importWorkbook(db: Db, buf: Buffer, fileName: string, opts: { dryRun: boolean; userId: number | null }) {
  const parsed = await parseWorkbook(buf);
  const { journal, invoices, warnings } = parsed;
  if (!journal && !invoices) throw new Error("No journal or invoice register sheet found in this workbook.");
  const entries = journal?.entries ?? [];
  const from = entries[0]?.date ?? null, to = entries[entries.length - 1]?.date ?? null;

  // Party detection for "Payable to X" accounts via counterpart accounts.
  const counterpartsOf = new Map<string, Set<string>>();
  for (const e of entries) for (const l of e.lines) {
    const set = counterpartsOf.get(l.account) ?? new Set(); for (const o of e.lines) if (o.account !== l.account) set.add(o.account); counterpartsOf.set(l.account, set);
  }
  const existing = await db.query<{ id: number; name: string; code: string }>("SELECT id, name, code FROM accounts");
  const existingNames = new Map(existing.map((a) => [a.name, a]));
  const usedCodes = new Set(existing.map((a) => a.code));
  const newAccounts: any[] = [];
  const allNames = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.account)))];
  const meta = (name: string) => entries.flatMap((e) => e.lines).find((l) => l.account === name)!;
  const nextCode = (base: number) => { let c = base; while (usedCodes.has(String(c))) c++; usedCodes.add(String(c)); return String(c); };
  for (const name of allNames) {
    if (existingNames.has(name)) continue;
    const known = PL[name];
    if (known) {
      const code = usedCodes.has(known[0]) ? nextCode(9000) : (usedCodes.add(known[0]), known[0]);
      newAccounts.push({ code, name, type: known[1], grp: known[2], fs_line: known[3], role: known[4] ?? null, party_type: null, party: null });
      continue;
    }
    const m = name.match(/^Payable to (.+)$/i);
    if (m) {
      const cps = counterpartsOf.get(name) ?? new Set();
      const isPartner = [...cps].some((c) => /Drawings|Partner's Current/i.test(c));
      const isEmployee = !isPartner && [...cps].some((c) => /Payroll/i.test(c));
      newAccounts.push(isPartner
        ? { code: nextCode(2400), name, type: "liability", grp: "Partners' current accounts", fs_line: "Partners' current accounts", role: null, party_type: "partner", party: m[1] }
        : isEmployee
          ? { code: nextCode(2200), name, type: "liability", grp: "Current liabilities", fs_line: "Salaries payable", role: null, party_type: "employee", party: m[1] }
          : { code: nextCode(2500), name, type: "liability", grp: "Current liabilities", fs_line: "Trade and other payables", role: null, party_type: "vendor", party: m[1] });
      continue;
    }
    const l = meta(name); const [type, grp, fs] = guessByHead(l.nature, l.head);
    const base = { asset: 1900, liability: 2900, equity: 3900, income: 4900, expense: 6900 }[type as "asset"]!;
    newAccounts.push({ code: nextCode(base), name, type, grp, fs_line: fs, role: null, party_type: null, party: null });
    warnings.push(`New account "${name}" classified by heading as ${type} / ${fs} — please review in Accounts.`);
  }

  // Implied profit-sharing ratios from the latest profit allocation.
  const allocations = entries.filter((e) => e.lines.some((l) => /Drawings|Partner's Current/i.test(l.account)) && e.lines.some((l) => /^Payable to /i.test(l.account)));
  const lastAlloc = allocations[allocations.length - 1];
  const impliedRatios: Record<string, number> = {};
  const ls = lastAlloc?.lines.filter((l) => /^Payable to /i.test(l.account)) ?? [];
  if (ls.length >= 2) {
    const tot = ls.reduce((a, l) => a + (l.credit - l.debit), 0);
    if (tot) for (const l of ls) impliedRatios[l.account.replace(/^Payable to /i, "")] = Math.round(((l.credit - l.debit) / tot) * 10000) / 10000;
  }

  const overlap = from && to ? (await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE status='posted' AND entry_date BETWEEN $1 AND $2", [from, to]))[0].n : "0";
  const totals = entries.reduce((a, e) => { for (const l of e.lines) { a.dr += toUnits(l.debit); a.cr += toUnits(l.credit); } return a; }, { dr: 0, cr: 0 });
  const summary = {
    fileName, journalSheet: journal?.sheet ?? null, invoiceSheet: invoices?.sheet ?? null,
    entries: entries.length, lines: entries.reduce((a, e) => a + e.lines.length, 0),
    periodFrom: from, periodTo: to, debits: totals.dr / 10000, credits: totals.cr / 10000,
    newAccounts, impliedRatios, invoices: invoices?.rows.length ?? 0,
    existingEntriesInPeriod: Number(overlap), warnings,
  };
  if (opts.dryRun) return { dryRun: true, summary };

  return db.tx(async (q) => {
    const [batch] = await q<{ id: number }>(
      "INSERT INTO import_batches (file_name, kind, period_from, period_to, entries, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [fileName, journal ? "journal" : "invoices", from, to, entries.length, JSON.stringify(summary), opts.userId]);
    if (from && to) {
      // Replace earlier IMPORTED entries for the same period; manual/adjusting entries are kept.
      await q("DELETE FROM journal_entries WHERE batch_id IS NOT NULL AND entry_date BETWEEN $1 AND $2", [from, to]);
    }
    for (const a of newAccounts) {
      await q("INSERT INTO accounts (code, name, type, grp, fs_line, party_type, party, system_role) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [a.code, a.name, a.type, a.grp, a.fs_line, a.party_type, a.party, a.role]);
    }
    const accts = new Map((await q<{ id: number; name: string }>("SELECT id, name FROM accounts")).map((a) => [a.name, a.id]));
    for (const e of entries) {
      await postEntry(q, { date: e.date, ref: e.ref || null, memo: e.memo, source: `import:${fileName}`, batchId: batch.id, userId: opts.userId,
        lines: e.lines.map((l) => ({ accountId: accts.get(l.account)!, debit: l.debit, credit: l.credit, description: l.description, payee: l.payee })) });
    }
    // Partners
    for (const a of newAccounts.filter((x) => x.party_type === "partner")) {
      await q(`INSERT INTO partners (name, ratio, account_id) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET account_id = EXCLUDED.account_id`,
        [a.party, impliedRatios[a.party] ?? 0, accts.get(a.name)]);
    }
    for (const [p, r] of Object.entries(impliedRatios)) {
      await q("UPDATE partners SET ratio = $2 WHERE name = $1", [p, r]);
    }
    // Invoice register is cumulative: replace, but keep user-entered collection expectations.
    if (invoices) {
      const prev = await q<any>("SELECT number, client, invoice_date, expected_date, collection_probability, status FROM invoices");
      const key = (n: string | null, c: string, d: string) => `${n ?? ""}|${c}|${isoDate(d)}`;
      const keep = new Map(prev.map((p) => [key(p.number, p.client, p.invoice_date), p]));
      await q("DELETE FROM invoices");
      for (const r of invoices.rows) {
        const k = keep.get(key(r.number, r.client, r.date));
        await q(`INSERT INTO invoices (number, invoice_date, client, billed_to, campaign_period, net_amount, jazz_share, gst_rate, gst, gross_amount,
                 income_tax_withheld, sales_tax_withheld, received, outstanding, received_dates, notes, status, expected_date, collection_probability, batch_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [r.number, r.date, r.client, r.billedTo, r.campaignPeriod, r.netAmount, r.jazzShare, r.gstRate, r.gst, r.grossAmount,
           r.incomeTaxWithheld, r.salesTaxWithheld, r.received, r.outstanding, r.receivedDates, r.notes,
           /cancel/i.test(r.notes ?? "") ? "cancelled" : k?.status ?? null, k?.expected_date ?? null, k?.collection_probability ?? 100, batch.id]);
      }
    }
    await q("INSERT INTO audit_log (user_id, action, detail) VALUES ($1,'import',$2)", [opts.userId, JSON.stringify({ fileName, from, to, entries: entries.length })]);
    return { dryRun: false, batchId: batch.id, summary };
  });
}
