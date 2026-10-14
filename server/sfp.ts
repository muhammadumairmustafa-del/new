import type { Db } from "./db.js";
import { postEntry, isoDate } from "./ledger.js";
import { monthEnd, fiscalYearOf, monthsBetween, fyRange } from "../shared/fiscal.js";

/**
 * Sales Flow Pro (SFP) integration. SFP is the operational system where campaigns are
 * booked with their gross value and the Jazz / TonePerks revenue split. We read it
 * READ-ONLY, keep a local snapshot, and use it to (1) report revenue by month, source,
 * client and manager, (2) reconcile against the accountant's invoice register and ledger,
 * and (3) propose revenue accruals for months the books do not cover yet.
 */
export type Q = (sql: string, params?: unknown[]) => Promise<any[]>;

export interface SfpSettings {
  gstRate: number;
  /** TonePerks share by source when SFP has no explicit split. */
  defaultShare: Record<"jazz_internal" | "jazz_sourced" | "callperks_sourced", number>;
  /** Map a client name (as written in SFP or the register) to a common name for reconciliation. */
  clientAliases: Record<string, string>;
}
export const DEFAULT_SFP: SfpSettings = { gstRate: 0.15, defaultShare: { jazz_internal: 0.10, jazz_sourced: 0.30, callperks_sourced: 0.60 }, clientAliases: {} };

const WANT_CAMPAIGN = ["id", "campaign_code", "client_name", "type", "source", "status", "start_date", "end_date", "revenue_pkr", "jazz_share_pkr",
  "callperks_share_pkr", "billing_type", "is_monthly_retainer", "campaign_month", "campaign_year", "manager_id", "created_at", "notes",
  "payment_received_date", "target_impressions", "actual_impressions"];
const WANT_PAYMENT = ["id", "campaign_id", "month", "year", "payment_received_date", "amount_pkr"];
const WANT_TARGET = ["id", "year", "month", "revenue_type", "target_pkr", "actual_pkr", "campaigns_run", "deals_closed"];

async function columns(q: Q, table: string): Promise<Set<string>> {
  const r = await q("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [table]);
  return new Set(r.map((x) => x.column_name));
}
const pick = (want: string[], have: Set<string>, alias: string) => want.filter((c) => have.has(c)).map((c) => `${alias}.${c}`).join(", ");

/** Read the SFP tables through an injected query function (read-only). */
export async function readSfp(q: Q) {
  const cc = await columns(q, "campaigns");
  if (!cc.size) throw new Error("No 'campaigns' table found in the Sales Flow Pro database");
  const missing = ["id", "client_name", "revenue_pkr"].filter((c) => !cc.has(c));
  if (missing.length) throw new Error(`Sales Flow Pro 'campaigns' is missing columns: ${missing.join(", ")}`);
  const uc = await columns(q, "users");
  const joinManager = cc.has("manager_id") && uc.has("id") && uc.has("name");
  const campaigns = await q(`SELECT ${pick(WANT_CAMPAIGN, cc, "c")}${joinManager ? ", u.name AS manager_name" : ""}
                               FROM campaigns c ${joinManager ? "LEFT JOIN users u ON u.id = c.manager_id" : ""}`);
  const pc = await columns(q, "campaign_payments");
  const payments = pc.has("id") && pc.has("campaign_id") ? await q(`SELECT ${pick(WANT_PAYMENT, pc, "p")} FROM campaign_payments p`) : [];
  const tc = await columns(q, "revenue_targets");
  const targets = tc.has("id") ? await q(`SELECT ${pick(WANT_TARGET, tc, "t")} FROM revenue_targets t`) : [];
  return { campaigns, payments, targets, columns: { campaigns: [...cc], payments: [...pc], targets: [...tc] } };
}

/** Connect to the SFP database from SFP_DATABASE_URL with a read-only session. */
export async function readSfpFromEnv() {
  const url = process.env.SFP_DATABASE_URL;
  if (!url) throw new Error("SFP_DATABASE_URL is not set on the server. Add it as a secret (never commit it).");
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: url, ssl: /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: true }, statement_timeout: 30000, connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    return await readSfp(async (s, p = []) => (await client.query(s, p as any[])).rows);
  } finally { await client.end(); }
}

export async function storeSnapshot(db: Db, snap: Awaited<ReturnType<typeof readSfp>>) {
  await db.tx(async (q) => {
    await q("DELETE FROM sfp_campaigns"); await q("DELETE FROM sfp_payments"); await q("DELETE FROM sfp_targets");
    for (const c of snap.campaigns) await q("INSERT INTO sfp_campaigns (id, data) VALUES ($1,$2)", [String(c.id), JSON.stringify(c)]);
    for (const p of snap.payments) await q("INSERT INTO sfp_payments (id, campaign_id, data) VALUES ($1,$2,$3)", [String(p.id), String(p.campaign_id), JSON.stringify(p)]);
    for (const t of snap.targets) await q("INSERT INTO sfp_targets (id, data) VALUES ($1,$2)", [String(t.id), JSON.stringify(t)]);
    await q(`INSERT INTO settings (key, value, updated_at) VALUES ('sfp.lastSync', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ at: new Date().toISOString(), campaigns: snap.campaigns.length, payments: snap.payments.length, targets: snap.targets.length, columns: snap.columns })]);
  });
}

// ------------------------------------------------------------------ revenue model
export type SourceKey = "jazz_internal" | "jazz_sourced" | "callperks_sourced";
export function sourceKey(s: unknown): SourceKey {
  const x = String(s ?? "").toLowerCase();
  if (x.includes("callperks") || x.includes("toneperks")) return "callperks_sourced";
  if (x.includes("sourced")) return "jazz_sourced";
  return "jazz_internal";
}
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export interface SfpLine {
  id: string; code: string | null; client: string; type: string | null; source: SourceKey; sourceLabel: string; status: string | null;
  manager: string | null; month: string; billing: string | null; foc: boolean;
  campaignValue: number;  // gross campaign value excl. sales tax (SFP revenue_pkr)
  jazzShare: number; toneperksShare: number;
  revenue: number;        // what TonePerks books as revenue
  platformFee: number;    // Jazz share TonePerks owes (CallPerks-sourced only)
  basis: string;
}

/**
 * Accounting policy, consistent with the official accounts:
 * - CallPerks/TonePerks-sourced: TonePerks invoices the client for the full campaign value (revenue) and owes Jazz its share (platform fee).
 * - Jazz Internal / Jazz Sourced (e.g. Jazz Cash): Jazz collects; TonePerks invoices only its own share (revenue), no platform fee.
 * - FOC campaigns carry no revenue.
 */
export function revenueLine(c: any, s: SfpSettings): SfpLine {
  const src = sourceKey(c.source);
  const value = num(c.revenue_pkr) ?? 0;
  const explicitTp = num(c.callperks_share_pkr); const explicitJazz = num(c.jazz_share_pkr);
  const tp = explicitTp ?? value * s.defaultShare[src];
  const jazz = explicitJazz ?? value - tp;
  const foc = String(c.billing_type ?? "").toUpperCase() === "FOC";
  // campaign_month/year in SFP are often left at a default, so the start date decides the month.
  let month: string;
  if (c.start_date) month = isoDate(c.start_date).slice(0, 7);
  else if (c.campaign_year && c.campaign_month) month = `${c.campaign_year}-${String(c.campaign_month).padStart(2, "0")}`;
  else month = isoDate(c.created_at ?? new Date()).slice(0, 7);
  const revenue = foc ? 0 : src === "callperks_sourced" ? value : tp;
  const platformFee = foc ? 0 : src === "callperks_sourced" ? jazz : 0;
  return { id: String(c.id), code: c.campaign_code ?? null, client: String(c.client_name ?? "").trim(), type: c.type ?? null, source: src, sourceLabel: c.source ?? src,
    status: c.status ?? null, manager: c.manager_name ?? null, month, billing: c.billing_type ?? null, foc, campaignValue: value, jazzShare: jazz, toneperksShare: tp,
    revenue, platformFee,
    basis: foc ? "Free of charge" : src === "callperks_sourced" ? "Full value invoiced; Jazz share is a platform fee" : "TonePerks share only (Jazz collects)" + (explicitTp === null ? " — default split" : "") };
}

/**
 * Monthly retainers (e.g. the Jazz Cash recovery campaign) carry one SFP payment row per service month
 * with that month's campaign value. Each becomes its own revenue line, split in the campaign's ratio.
 */
export function campaignLines(c: any, payments: any[], s: SfpSettings): SfpLine[] {
  const base = revenueLine(c, s);
  const rows = payments.filter((p) => String(p.campaign_id) === String(c.id) && p.year && p.month);
  if (!c.is_monthly_retainer || !rows.length) return [base];
  const seen = new Set<string>();
  const out: SfpLine[] = [];
  for (const p of rows.sort((a, b) => a.year - b.year || a.month - b.month)) {
    const month = `${p.year}-${String(p.month).padStart(2, "0")}`;
    if (seen.has(month)) continue; // duplicate rows for a month (e.g. an empty placeholder) count once
    const value = num(p.amount_pkr) ?? num(c.revenue_pkr) ?? 0;
    if (!value) continue;
    seen.add(month);
    const ratio = base.campaignValue ? base.toneperksShare / base.campaignValue : s.defaultShare[base.source];
    const tp = value * ratio, jazz = value - tp;
    out.push({ ...base, id: `${base.id}:${month}`, month, campaignValue: value, toneperksShare: tp, jazzShare: jazz,
      revenue: base.foc ? 0 : base.source === "callperks_sourced" ? value : tp, platformFee: base.foc ? 0 : base.source === "callperks_sourced" ? jazz : 0,
      basis: `${base.basis} · retainer month` });
  }
  return out.length ? out : [base];
}

export async function loadSfpLines(db: Db) {
  const s = { ...DEFAULT_SFP, ...((await db.query<any>("SELECT value FROM settings WHERE key='sfp'"))[0]?.value ?? {}) } as SfpSettings;
  const parse = (r: any) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data);
  const rows = (await db.query<any>("SELECT data FROM sfp_campaigns")).map(parse);
  const payments = (await db.query<any>("SELECT data FROM sfp_payments")).map(parse);
  const lines = rows.flatMap((c) => campaignLines(c, payments, s));
  const lastSync = (await db.query<any>("SELECT value FROM settings WHERE key='sfp.lastSync'"))[0]?.value ?? null;
  return { settings: s, lines, lastSync };
}

/** Campaign-by-invoice matching across ALL periods (invoices often follow the service month). */
export async function matchCampaigns(db: Db, lines: SfpLine[], aliases: Record<string, string>) {
  const allInv = (await db.query<any>("SELECT id, number, client, invoice_date, net_amount, status FROM invoices WHERE coalesce(status,'') <> 'cancelled' AND net_amount > 0"))
    .map((i) => ({ id: i.id, number: i.number, client: i.client as string, date: isoDate(i.invoice_date), net: Number(i.net_amount) }));
  const k2 = clientKeyer([...lines.map((l) => l.client), ...allInv.map((i) => i.client)], aliases);
  const used = new Set<number>();
  const monthStart = (m: string) => `${m}-01`;
  const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;
  const matches = new Map<string, any>();
  const billable = lines.filter((l) => l.revenue > 0).sort((a, b) => (a.month < b.month ? -1 : 1));
  for (const l of billable) {
    const cands = allInv.filter((i) => !used.has(i.id) && k2(i.client) === k2(l.client) && days(monthStart(l.month), i.date) >= -45 && days(monthStart(l.month), i.date) <= 185);
    cands.sort((a, b) => Math.abs(a.net - l.revenue) / l.revenue - Math.abs(b.net - l.revenue) / l.revenue || (a.date < b.date ? -1 : 1));
    const best = cands.find((i) => Math.abs(i.net - l.revenue) <= Math.max(0.25 * l.revenue, 1000));
    if (best) { used.add(best.id); matches.set(l.id, best); }
  }
  // Second pass: one invoice can bill several campaigns of the same customer (e.g. branches, repeats).
  for (const inv of allInv.filter((i) => !used.has(i.id))) {
    const pool = billable.filter((l) => !matches.has(l.id) && k2(l.client) === k2(inv.client) && days(monthStart(l.month), inv.date) >= -45 && days(monthStart(l.month), inv.date) <= 185).slice(0, 12);
    let best: SfpLine[] | null = null;
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      const sub = pool.filter((_, i) => mask & (1 << i));
      if (sub.length < 2) continue;
      const sum = sub.reduce((a, l) => a + l.revenue, 0);
      if (Math.abs(sum - inv.net) <= Math.max(0.02 * inv.net, 1000) && (!best || sub.length < best.length)) best = sub;
    }
    if (best) { used.add(inv.id); for (const l of best) matches.set(l.id, { ...inv, net: l.revenue, grouped: best.length }); }
  }
  // Third pass: an invoice and a campaign-month that are the only unmatched pair for that customer in the window
  // (e.g. a "final settlement" invoice that differs from the campaign value).
  for (const inv of allInv.filter((i) => !used.has(i.id))) {
    const pool = billable.filter((l) => !matches.has(l.id) && k2(l.client) === k2(inv.client) && days(monthStart(l.month), inv.date) >= -45 && days(monthStart(l.month), inv.date) <= 185);
    const otherInv = allInv.filter((j) => j.id !== inv.id && !used.has(j.id) && k2(j.client) === k2(inv.client) && pool.some((l) => days(monthStart(l.month), j.date) >= -45 && days(monthStart(l.month), j.date) <= 185));
    if (pool.length === 1 && otherInv.length === 0) { used.add(inv.id); matches.set(pool[0].id, { ...inv, loose: true }); }
  }
  return { matches, used, allInv, billable };
}

/** Normalise company names for matching ("Ideas Pvt. Ltd" ~ "IDEAS PRIVATE LIMITED"). */
export function normClient(n: string) {
  return n.toLowerCase().replace(/\(.*?\)/g, " ").replace(/\b(pvt|private|ltd|limited|pakistan|plc|co|company|bank|the|via)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 2).join(" ");
}

/**
 * Groups client names that refer to the same customer: explicit aliases first, then names whose
 * normalised form is a prefix of another ("metro" ~ "metro cash carry", "jazzcash" ~ "jazz cash").
 */
export function clientKeyer(names: string[], aliases: Record<string, string>) {
  const norm = (n: string) => n.toLowerCase().replace(/\(.*?\)/g, " ").replace(/\b(pvt|private|ltd|limited|pakistan|plc|co|company|bank|the|via|inc)\b/g, " ").replace(/[^a-z0-9]+/g, "");
  const aliasNorm = new Map(Object.entries(aliases).map(([k, v]) => [norm(k), norm(v)]));
  const base = (n: string) => { const c = norm(n) || n.toLowerCase(); return aliasNorm.get(c) ?? c; };
  const uniq = [...new Set(names.map(base))].sort((a, b) => a.length - b.length);
  const root = new Map<string, string>();
  for (const k of uniq) {
    const parent = [...root.keys()].find((r) => r.length >= 3 && k.startsWith(r));
    root.set(k, parent ? root.get(parent)! : k);
  }
  return (n: string) => root.get(base(n)) ?? base(n);
}

export async function reconcile(db: Db, lines: SfpLine[], fy: number, ledgerSalesByMonth: Map<string, number>, aliases: Record<string, string> = {}, today = new Date().toISOString().slice(0, 10)) {
  const { from, to } = fyRange(fy);
  const months = monthsBetween(from, to);
  const inFy = lines.filter((l) => l.month >= from.slice(0, 7) && l.month <= to.slice(0, 7));
  const inv = (await db.query<any>("SELECT client, invoice_date, net_amount, jazz_share, status FROM invoices WHERE coalesce(status,'') <> 'cancelled'"))
    .map((i) => ({ client: i.client as string, month: isoDate(i.invoice_date).slice(0, 7), net: Number(i.net_amount), jazz: Number(i.jazz_share) }))
    .filter((i) => i.month >= from.slice(0, 7) && i.month <= to.slice(0, 7));
  const byMonth = months.map((m) => {
    const ls = inFy.filter((l) => l.month === m);
    const sum = (k: keyof SfpLine) => ls.reduce((a, l) => a + (l[k] as number), 0);
    return { month: m, campaigns: ls.length, campaignValue: sum("campaignValue"), revenue: sum("revenue"), platformFee: sum("platformFee"),
      bySource: Object.fromEntries((["callperks_sourced", "jazz_sourced", "jazz_internal"] as SourceKey[]).map((k) => [k, ls.filter((l) => l.source === k).reduce((a, l) => a + l.revenue, 0)])),
      invoiced: inv.filter((i) => i.month === m).reduce((a, i) => a + i.net, 0), booked: ledgerSalesByMonth.get(m) ?? 0 };
  });
  const clients = new Map<string, any>();
  const key = clientKeyer([...inFy.map((l) => l.client), ...inv.map((i) => i.client)], aliases);
  for (const l of inFy) { const k = key(l.client); const c = clients.get(k) ?? { key: k, names: new Set<string>(), sfpRevenue: 0, sfpPlatformFee: 0, invoiced: 0, invoicedJazz: 0, campaigns: 0, invoices: 0 }; c.names.add(l.client); c.sfpRevenue += l.revenue; c.sfpPlatformFee += l.platformFee; c.campaigns++; clients.set(k, c); }
  for (const i of inv) { const k = key(i.client); const c = clients.get(k) ?? { key: k, names: new Set<string>(), sfpRevenue: 0, sfpPlatformFee: 0, invoiced: 0, invoicedJazz: 0, campaigns: 0, invoices: 0 }; c.names.add(i.client); c.invoiced += i.net; c.invoicedJazz += i.jazz; c.invoices++; clients.set(k, c); }
  const byClient = [...clients.values()].map((c) => ({ ...c, names: [...c.names], difference: c.sfpRevenue - c.invoiced, jazzDifference: c.sfpPlatformFee - c.invoicedJazz }))
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  const { matches, used, allInv, billable } = await matchCampaigns(db, lines, aliases);
  const inFyIds = new Set(inFy.map((l) => l.id));
  const notInvoiced = billable.filter((l) => inFyIds.has(l.id) && !matches.has(l.id) && l.month <= today.slice(0, 7))
    .map((l) => ({ id: l.id, month: l.month, client: l.client, code: l.code, source: l.source, revenue: l.revenue, platformFee: l.platformFee, status: l.status }));
  const matched = billable.filter((l) => inFyIds.has(l.id) && matches.has(l.id))
    .map((l) => ({ id: l.id, month: l.month, client: l.client, code: l.code, revenue: l.revenue, invoice: matches.get(l.id).number, invoiceDate: matches.get(l.id).date, invoiced: matches.get(l.id).net, difference: l.revenue - matches.get(l.id).net }));
  const invoicedNotInSfp = allInv.filter((i) => !used.has(i.id) && i.date >= from && i.date <= to);
  return { fy, from, to, byMonth, byClient, notInvoiced, matched, invoicedNotInSfp, totals: {
    notInvoiced: notInvoiced.reduce((a, l) => a + l.revenue, 0),
    sfpRevenue: inFy.reduce((a, l) => a + l.revenue, 0), sfpPlatformFee: inFy.reduce((a, l) => a + l.platformFee, 0),
    invoiced: inv.reduce((a, i) => a + i.net, 0), invoicedJazz: inv.reduce((a, i) => a + i.jazz, 0), booked: [...ledgerSalesByMonth.entries()].filter(([m]) => months.includes(m)).reduce((a, [, v]) => a + v, 0) } };
}

/**
 * Proposed accruals for campaign revenue that has no invoice yet (accrued / unbilled revenue).
 * Dr Receivable (unbilled) / Cr Sales, and for TonePerks-sourced campaigns Dr Platform fee / Cr Payable to Jazz.
 * No sales tax: output tax arises when the invoice is issued. Re-running replaces earlier SFP proposals.
 */
export async function proposeAccruals(db: Db, items: { id: string; month: string; client: string; code: string | null; source: string; revenue: number; platformFee: number }[], upTo: string, userId: number | null) {
  const accts = new Map((await db.query<any>("SELECT id, system_role FROM accounts WHERE system_role IS NOT NULL")).map((a) => [a.system_role, a.id]));
  const need = ["receivable", "revenue", "platform_fee", "jazz_payable"];
  const miss = need.filter((r) => !accts.has(r));
  if (miss.length) throw new Error(`Import the accounts first (missing account roles: ${miss.join(", ")})`);
  const todo = items.filter((l) => l.revenue > 0 && l.month <= upTo.slice(0, 7));
  return db.tx(async (q) => {
    await q("DELETE FROM journal_entries WHERE kind = 'proposed' AND source = 'sfp-accrual'");
    for (const l of todo) {
      const date = monthEnd(l.month) > upTo ? upTo : monthEnd(l.month);
      const lines2: any[] = [
        { accountId: accts.get("receivable"), debit: l.revenue, credit: 0, description: `Unbilled: ${l.client}` },
        { accountId: accts.get("revenue"), debit: 0, credit: l.revenue, description: `Sales Flow Pro ${l.code ?? ""} ${l.month}` },
      ];
      if (l.platformFee > 0) lines2.push(
        { accountId: accts.get("platform_fee"), debit: l.platformFee, credit: 0, description: "Jazz share" },
        { accountId: accts.get("jazz_payable"), debit: 0, credit: l.platformFee, description: "Jazz share" });
      await postEntry(q, { date, ref: `SFP-${l.code ?? l.id.slice(0, 8)}-${l.month}`, memo: `Accrued revenue, not yet invoiced (Sales Flow Pro): ${l.client} ${l.month}`, source: "sfp-accrual", kind: "proposed", userId, lines: lines2 });
    }
    return { entries: todo.length, revenue: todo.reduce((a, l) => a + l.revenue, 0), months: [...new Set(todo.map((l) => l.month))] };
  });
}
export { fiscalYearOf };

/** ISO dates found in the register's free-text "receiving date" field (e.g. "2026-07-07", "5th May 2026"). */
function parseDates(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) out.push(m[0]);
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  for (const m of text.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/g)) {
    const mi = months.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3)));
    if (mi >= 0) out.push(`${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`);
  }
  return out.sort();
}

/**
 * Pre-fills the "Received" folder from the accountant's invoice register: for every invoice with money
 * received, the cash and the tax withheld by the customer are attached to the campaign(s) it billed
 * (split by revenue when one invoice covers several campaigns). Earlier pre-filled entries are replaced;
 * entries typed in by hand are never touched.
 */
export async function prefillReceived(db: Db, lines: SfpLine[], aliases: Record<string, string>, userId: number | null) {
  const { matches } = await matchCampaigns(db, lines, aliases);
  const inv = new Map((await db.query<any>("SELECT * FROM invoices WHERE coalesce(status,'') <> 'cancelled'")).map((i) => [i.id, i]));
  const byInvoice = new Map<number, SfpLine[]>();
  for (const l of lines) { const m = matches.get(l.id); if (m) { const a = byInvoice.get(m.id) ?? []; a.push(l); byInvoice.set(m.id, a); } }
  const entries: { campaignId: string; date: string; amount: number; withheld: number; counterparty: string; reference: string; note: string }[] = [];
  const unallocated: { number: string | null; client: string; received: number }[] = [];
  for (const [id, i] of inv) {
    const received = Number(i.received); if (received <= 0.5) continue;
    const ls = byInvoice.get(id);
    const withheld = Number(i.income_tax_withheld || 0) + Number(i.sales_tax_withheld || 0);
    if (!ls) { unallocated.push({ number: i.number, client: i.client, received }); continue; }
    const total = ls.reduce((a, l) => a + l.revenue, 0) || 1;
    const dates = parseDates(i.received_dates);
    const date = dates.length ? dates[dates.length - 1] : isoDate(i.invoice_date);
    for (const l of ls) {
      const share = l.revenue / total;
      entries.push({ campaignId: l.id.split(":")[0], date, amount: Math.round(received * share * 100) / 100, withheld: Math.round(withheld * share * 100) / 100,
        counterparty: i.billed_to || i.client, reference: `Invoice #${i.number ?? "–"} (books)`,
        note: `Pre-filled from the accountant's invoice register${ls.length > 1 ? ` · invoice split over ${ls.length} campaigns` : ""}${l.id.includes(":") ? ` · ${l.month}` : ""}` });
    }
  }
  await db.tx(async (q) => {
    await q("DELETE FROM campaign_cash WHERE source = 'register'");
    for (const e of entries) await q(`INSERT INTO campaign_cash (campaign_id, kind, entry_date, amount, withheld, counterparty, reference, note, source, created_by)
      VALUES ($1,'received',$2,$3,$4,$5,$6,$7,'register',$8)`, [e.campaignId, e.date, e.amount, e.withheld, e.counterparty, e.reference, e.note, userId]);
  });
  return { entries: entries.length, received: entries.reduce((a, e) => a + e.amount, 0), withheld: entries.reduce((a, e) => a + e.withheld, 0), unallocated };
}
