import type { Db } from "./db.js";
import { toUnits } from "../shared/money.js";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export interface Account {
  id: number; code: string; name: string; type: AccountType; grp: string; fs_line: string;
  party_type: string | null; party: string | null; system_role: string | null; active: boolean;
}
export interface Line {
  entryId: number; date: string; ref: string | null; memo: string; kind: string; source: string;
  account: Account; dr: number; cr: number; description: string | null; payee: string | null;
}
export interface Snapshot { accounts: Account[]; lines: Line[]; byEntry: Map<number, Line[]>; }

/** System roles let reports find key accounts without hard-coding names. */
export const ROLES = [
  "bank", "receivable", "wht_receivable", "input_tax", "employee_advance",
  "jazz_payable", "income_tax_payable", "sales_tax_payable", "salary_tax_payable",
  "advance_from_customer", "share_capital", "profit_transfer",
  "revenue", "platform_fee", "payroll_expense", "income_tax_expense", "depreciation",
] as const;
export type Role = (typeof ROLES)[number];

export function isoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export async function loadSnapshot(db: Db, opts: { includeProposed?: boolean } = {}): Promise<Snapshot> {
  const accounts = await db.query<Account>("SELECT * FROM accounts ORDER BY code");
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows = await db.query<any>(
    `SELECT l.entry_id, e.entry_date, e.ref, e.memo, e.kind, e.source, l.account_id, l.debit, l.credit, l.description, l.payee
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.status = 'posted' ${opts.includeProposed ? "" : "AND e.kind <> 'proposed'"}
      ORDER BY e.entry_date, e.id, l.id`);
  const lines: Line[] = rows.map((r) => ({
    entryId: r.entry_id, date: isoDate(r.entry_date), ref: r.ref, memo: r.memo, kind: r.kind, source: r.source,
    account: byId.get(r.account_id)!, dr: toUnits(r.debit), cr: toUnits(r.credit), description: r.description, payee: r.payee,
  }));
  const byEntry = new Map<number, Line[]>();
  for (const l of lines) {
    const arr = byEntry.get(l.entryId); if (arr) arr.push(l); else byEntry.set(l.entryId, [l]);
  }
  return { accounts, lines, byEntry };
}

export const roleAccount = (s: Snapshot, role: Role) => s.accounts.find((a) => a.system_role === role);
export const roleAccounts = (s: Snapshot, role: Role) => s.accounts.filter((a) => a.system_role === role);

/** Net debit balance (units) per account id for lines dated <= asOf (and >= from if given). */
export function balances(s: Snapshot, asOf: string, from?: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of s.lines) {
    if (l.date > asOf) continue;
    if (from && l.date < from) continue;
    m.set(l.account.id, (m.get(l.account.id) ?? 0) + l.dr - l.cr);
  }
  return m;
}

/** The dominant counterpart account of a line inside its journal entry. */
export function counterpart(s: Snapshot, line: Line): Account | undefined {
  const others = (s.byEntry.get(line.entryId) ?? []).filter((o) => o !== line && o.account.id !== line.account.id);
  const opposite = others.filter((o) => (line.dr > 0 ? o.cr > 0 : o.dr > 0));
  const pool = opposite.length ? opposite : others;
  let best: Line | undefined;
  for (const o of pool) if (!best || Math.max(o.dr, o.cr) > Math.max(best.dr, best.cr)) best = o;
  return best?.account;
}

export function validateEntry(lines: { debit: number; credit: number }[]): string | null {
  if (lines.length < 2) return "An entry needs at least two lines";
  let d = 0, c = 0;
  for (const l of lines) {
    if (l.debit < 0 || l.credit < 0) return "Amounts cannot be negative";
    if (l.debit > 0 && l.credit > 0) return "A line cannot be both debit and credit";
    d += toUnits(l.debit); c += toUnits(l.credit);
  }
  if (d !== c) return `Entry does not balance (debits ${d / 10000} vs credits ${c / 10000})`;
  if (d === 0) return "Entry total is zero";
  return null;
}

export async function postEntry(q: Db["query"], e: {
  date: string; ref?: string | null; memo: string; source: string; kind?: string; batchId?: number | null; userId?: number | null;
  lines: { accountId: number; debit: number; credit: number; description?: string | null; payee?: string | null }[];
}): Promise<number> {
  const err = validateEntry(e.lines);
  if (err) throw new Error(err);
  const [row] = await q<{ id: number }>(
    `INSERT INTO journal_entries (entry_date, ref, memo, source, kind, batch_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [e.date, e.ref ?? null, e.memo, e.source, e.kind ?? "normal", e.batchId ?? null, e.userId ?? null]);
  for (const l of e.lines) {
    await q(`INSERT INTO journal_lines (entry_id, account_id, debit, credit, description, payee) VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, l.accountId, l.debit, l.credit, l.description ?? null, l.payee ?? null]);
  }
  return row.id;
}
