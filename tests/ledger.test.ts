import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { openDb, type Db } from "../server/db";
import { importWorkbook } from "../server/importer";
import { loadSnapshot, validateEntry } from "../server/ledger";
import { balanceSheet, profitAndLoss, partnerStatement, cashFlow, fifoAging, trialBalance } from "../server/reports";
import { computeTax, slabTax, DEFAULT_TAX_RULES } from "../shared/tax";
import { fiscalYearOf } from "../shared/fiscal";

/** Builds a synthetic workbook in the accountant's journal format (no real data). */
async function syntheticWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data_Journal");
  ws.addRow(["Demo Co"]); ws.addRow(["General Journal"]); ws.addRow([]);
  ws.addRow(["JV #", "Period", "Date", "Nature", "Account head", "Ledger", "Description", "Offset account", "Payee", "Payee Name", "Debit", "Credit"]);
  const d = (s: string) => new Date(s + "T00:00:00Z");
  const jv = (ref: string, date: string, lines: [string, string, string, number, number][]) =>
    lines.forEach(([nature, head, ledger, dr, cr]) => ws.addRow([ref, "", d(date), nature, head, ledger, `${ref} demo`, "", "", "", dr, cr]));
  jv("JV1", "2025-07-01", [["Assets", "Current Assets", "Bank Alfalah", 1000000, 0], ["Equity", "Share Capital", "Share Capital", 0, 1000000]]);
  jv("JV2", "2025-08-10", [["Assets", "Current Assets", "Receivable", 1150000, 0], ["Income", "Revenue", "Sales", 0, 1000000], ["Liabilities", "Current Liabilities", "Sales Tax Payable", 0, 150000]]);
  jv("JV3", "2025-08-31", [["Expense", "Cost of Goods Sold", "Platform Fee", 400000, 0], ["Liabilities", "Current Liabilities", "Payable to Jazz", 0, 400000]]);
  jv("JV4", "2025-08-31", [["Expense", "Admin Expense", "Payroll Expense", 200000, 0], ["Liabilities", "Current Liabilities", "Payable to Staff One", 0, 200000]]);
  jv("JV5", "2025-09-05", [["Liabilities", "Current Liabilities", "Payable to Staff One", 200000, 0], ["Assets", "Current Assets", "Bank Alfalah", 0, 200000]]);
  jv("JV6", "2025-09-20", [["Assets", "Current Assets", "Bank Alfalah", 1081000, 0], ["Assets", "Current Assets", "WHT Receivable", 69000, 0], ["Assets", "Current Assets", "Receivable", 0, 1150000]]);
  // profit allocation 60/40 to two partners (profit = 1,000,000 - 400,000 - 200,000 = 400,000)
  jv("JV7", "2025-09-30", [["Equity", "Drawings", "Drawings - Partner's Current Acount", 400000, 0], ["Liabilities", "Current Liabilities", "Payable to Partner A", 0, 240000], ["Liabilities", "Current Liabilities", "Payable to Partner B", 0, 160000]]);
  jv("JV8", "2025-09-30", [["Liabilities", "Current Liabilities", "Payable to Partner A", 100000, 0], ["Assets", "Current Assets", "Bank Alfalah", 0, 100000]]);
  const inv = wb.addWorksheet("Data_Invoices");
  inv.addRow(["Register"]); inv.addRow([]); inv.addRow([]);
  inv.addRow(["Invoice #", "STR invoice #", "Invoice date", "Invoice month", "Period", "Client", "Billed to", "Campaign period", "Sales amount (excl. GST)", "TonePerks share", "Jazz share", "GST rate", "GST", "Sales incl. GST", "Income tax withheld", "Sales tax withheld", "Net receivable", "Received", "Difference", "Receiving Date", "Status / notes"]);
  inv.addRow(["01", "1", d("2025-08-10"), d("2025-08-01"), "Aug-25", "Client X", "Client X", "Aug", 1000000, 600000, 400000, 0.15, 150000, 1150000, 69000, 0, 1081000, 1081000, 0, d("2025-09-20"), ""]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let db: Db;
beforeAll(async () => {
  db = await openDb({ memory: true });
  const r: any = await importWorkbook(db, await syntheticWorkbook(), "demo.xlsx", { dryRun: false, userId: null });
  expect(r.summary.entries).toBe(8);
}, 60000);

describe("ledger", () => {
  it("rejects unbalanced entries", () => {
    expect(validateEntry([{ debit: 10, credit: 0 }, { debit: 0, credit: 9.99 }])).toMatch(/balance/);
    expect(validateEntry([{ debit: 10, credit: 0 }, { debit: 0, credit: 10 }])).toBeNull();
  });
  it("trial balance nets to zero and P&L is correct", async () => {
    const s = await loadSnapshot(db);
    expect(trialBalance(s, "2025-07-01", "2026-06-30").totals.closing).toBe(0);
    const pl = profitAndLoss(s, "2025-07-01", "2026-06-30");
    expect(pl.sections[0].total.at(-1)).toBe(1000000);
    expect(pl.grossProfit.at(-1)).toBe(600000);
    expect(pl.profitBeforeTax.at(-1)).toBe(400000);
  });
  it("balance sheet balances, both presentations", async () => {
    const s = await loadSnapshot(db);
    for (const pie of [false, true]) {
      const bs = balanceSheet(s, ["2025-08-31", "2025-09-30"], { partnersInEquity: pie });
      expect(bs.check).toEqual([0, 0]);
    }
    const bs = balanceSheet(s, ["2025-09-30"]);
    expect(bs.totalAssets[0]).toBe(1000000 - 200000 + 1081000 + 69000 - 100000);
  });
  it("classifies partner movements and detects parties", async () => {
    const s = await loadSnapshot(db);
    const accts = s.accounts.filter((a) => a.party_type === "partner").map((a) => a.party).sort();
    expect(accts).toEqual(["Partner A", "Partner B"]);
    expect(s.accounts.find((a) => a.name === "Payable to Staff One")?.party_type).toBe("employee");
    const ps = partnerStatement(s, "2025-07-01", "2026-06-30", new Map());
    const a: any = ps.rows.find((r: any) => r.partner === "Partner A");
    expect(a.profit).toBe(240000); expect(a.cashWithdrawn).toBe(100000); expect(a.closing).toBe(140000);
    const [p] = await db.query<any>("SELECT ratio FROM partners WHERE name='Partner A'");
    expect(Number(p.ratio)).toBeCloseTo(0.6, 4);
  });
  it("cash flow ties to bank and FIFO ages liabilities", async () => {
    const s = await loadSnapshot(db);
    const cf = cashFlow(s, "2025-07-01", "2025-09-30");
    expect(cf.closing.at(-1)).toBe(1781000);
    expect(cf.inflows.find((r) => r.label === "Receipts from customers")?.values.at(-1)).toBe(1081000);
    const jazz = s.accounts.find((a) => a.system_role === "jazz_payable")!;
    const ag = fifoAging(s, jazz.id, "2025-12-31");
    expect(ag.balance).toBe(400000); expect(ag.layers[0].date).toBe("2025-08-31");
  });
  it("re-importing the same period replaces, not duplicates", async () => {
    await importWorkbook(db, await syntheticWorkbook(), "demo.xlsx", { dryRun: false, userId: null });
    const s = await loadSnapshot(db);
    expect(profitAndLoss(s, "2025-07-01", "2026-06-30").profitBeforeTax.at(-1)).toBe(400000);
    const [{ n }] = await db.query<any>("SELECT count(*)::int AS n FROM invoices");
    expect(n).toBe(1);
  });
});

describe("tax engine", () => {
  const rules = DEFAULT_TAX_RULES[0];
  it("applies slabs and surcharge", () => {
    expect(slabTax(600000, rules.slabs)).toBe(0);
    expect(slabTax(1200000, rules.slabs)).toBeCloseTo(90000);
    expect(slabTax(5600000, rules.slabs)).toBeCloseTo(1610000);
    const c = computeTax({ accountingProfit: 20_000_000, withholdingCredit: 1_000_000, rules });
    expect(c.normalTax).toBeCloseTo(1_610_000 + 0.45 * 14_400_000);
    expect(c.surcharge).toBeCloseTo(c.normalTax * 0.1);
    expect(c.netPayable).toBeCloseTo(c.totalTax - 1_000_000);
  });
  it("fiscal year helper follows Jul–Jun", () => {
    expect(fiscalYearOf("2025-07-01")).toBe(2026);
    expect(fiscalYearOf("2026-06-30")).toBe(2026);
  });
});
