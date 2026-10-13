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
}
export const DEFAULT_SFP: SfpSettings = { gstRate: 0.15, defaultShare: { jazz_internal: 0.10, jazz_sourced: 0.30, callperks_sourced: 0.60 } };

const WANT_CAMPAIGN = ["id", "campaign_code", "client_name", "type", "source", "status", "start_date", "end_date", "revenue_pkr", "jazz_share_pkr",
  "callperks_share_pkr", "billing_type", "is_monthly_retainer", "campaign_month", "campaign_year", "manager_id", "created_at", "notes"];
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
  let month: string;
  if (c.campaign_year && c.campaign_month) month = `${c.campaign_year}-${String(c.campaign_month).padStart(2, "0")}`;
  else month = (c.start_date ? isoDate(c.start_date) : isoDate(c.created_at ?? new Date())).slice(0, 7);
  const revenue = foc ? 0 : src === "callperks_sourced" ? value : tp;
  const platformFee = foc ? 0 : src === "callperks_sourced" ? jazz : 0;
  return { id: String(c.id), code: c.campaign_code ?? null, client: String(c.client_name ?? "").trim(), type: c.type ?? null, source: src, sourceLabel: c.source ?? src,
    status: c.status ?? null, manager: c.manager_name ?? null, month, billing: c.billing_type ?? null, foc, campaignValue: value, jazzShare: jazz, toneperksShare: tp,
    revenue, platformFee,
    basis: foc ? "Free of charge" : src === "callperks_sourced" ? "Full value invoiced; Jazz share is a platform fee" : "TonePerks share only (Jazz collects)" + (explicitTp === null ? " — default split" : "") };
}

export async function loadSfpLines(db: Db) {
  const s = { ...DEFAULT_SFP, ...((await db.query<any>("SELECT value FROM settings WHERE key='sfp'"))[0]?.value ?? {}) } as SfpSettings;
  const rows = await db.query<any>("SELECT data FROM sfp_campaigns");
  const lines = rows.map((r) => revenueLine(typeof r.data === "string" ? JSON.parse(r.data) : r.data, s));
  const lastSync = (await db.query<any>("SELECT value FROM settings WHERE key='sfp.lastSync'"))[0]?.value ?? null;
  return { settings: s, lines, lastSync };
}

/** Normalise company names for matching ("Ideas Pvt. Ltd" ~ "IDEAS PRIVATE LIMITED"). */
export function normClient(n: string) {
  return n.toLowerCase().replace(/\(.*?\)/g, " ").replace(/\b(pvt|private|ltd|limited|pakistan|plc|co|company|bank|the|via)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).slice(0, 2).join(" ");
}

export async function reconcile(db: Db, lines: SfpLine[], fy: number, ledgerSalesByMonth: Map<string, number>) {
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
  const key = (n: string) => normClient(n) || n.toLowerCase();
  for (const l of inFy) { const k = key(l.client); const c = clients.get(k) ?? { key: k, names: new Set<string>(), sfpRevenue: 0, sfpPlatformFee: 0, invoiced: 0, invoicedJazz: 0, campaigns: 0, invoices: 0 }; c.names.add(l.client); c.sfpRevenue += l.revenue; c.sfpPlatformFee += l.platformFee; c.campaigns++; clients.set(k, c); }
  for (const i of inv) { const k = key(i.client); const c = clients.get(k) ?? { key: k, names: new Set<string>(), sfpRevenue: 0, sfpPlatformFee: 0, invoiced: 0, invoicedJazz: 0, campaigns: 0, invoices: 0 }; c.names.add(i.client); c.invoiced += i.net; c.invoicedJazz += i.jazz; c.invoices++; clients.set(k, c); }
  const byClient = [...clients.values()].map((c) => ({ ...c, names: [...c.names], difference: c.sfpRevenue - c.invoiced, jazzDifference: c.sfpPlatformFee - c.invoicedJazz }))
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  return { fy, from, to, byMonth, byClient, totals: {
    sfpRevenue: inFy.reduce((a, l) => a + l.revenue, 0), sfpPlatformFee: inFy.reduce((a, l) => a + l.platformFee, 0),
    invoiced: inv.reduce((a, i) => a + i.net, 0), invoicedJazz: inv.reduce((a, i) => a + i.jazz, 0), booked: [...ledgerSalesByMonth.entries()].filter(([m]) => months.includes(m)).reduce((a, [, v]) => a + v, 0) } };
}

/** Proposed revenue accruals from SFP for months after the last date in the books. */
export async function proposeAccruals(db: Db, lines: SfpLine[], s: SfpSettings, afterDate: string, upTo: string, userId: number | null) {
  const accts = new Map((await db.query<any>("SELECT id, system_role FROM accounts WHERE system_role IS NOT NULL")).map((a) => [a.system_role, a.id]));
  const need = ["receivable", "revenue", "sales_tax_payable", "platform_fee", "jazz_payable"];
  const miss = need.filter((r) => !accts.has(r));
  if (miss.length) throw new Error(`Import the accounts first (missing account roles: ${miss.join(", ")})`);
  const months = new Set(monthsBetween(afterDate, upTo).filter((m) => monthEnd(m) > afterDate));
  const todo = lines.filter((l) => months.has(l.month) && l.revenue > 0);
  return db.tx(async (q) => {
    await q("DELETE FROM journal_entries WHERE kind = 'proposed' AND source = 'sfp-accrual' AND entry_date > $1", [afterDate]);
    let n = 0;
    for (const l of todo) {
      const gst = Math.round(l.revenue * s.gstRate * 100) / 100;
      const date = monthEnd(l.month) > upTo ? upTo : monthEnd(l.month);
      const ref = `SFP-${l.code ?? l.id.slice(0, 8)}-${l.month}`;
      const lines2 = [
        { accountId: accts.get("receivable"), debit: l.revenue + gst, credit: 0, description: `${l.client} (${l.sourceLabel})` },
        { accountId: accts.get("revenue"), debit: 0, credit: l.revenue, description: l.basis },
        { accountId: accts.get("sales_tax_payable"), debit: 0, credit: gst, description: `Output tax ${(s.gstRate * 100).toFixed(0)}%` },
      ];
      if (l.platformFee > 0) lines2.push(
        { accountId: accts.get("platform_fee"), debit: l.platformFee, credit: 0, description: "Jazz share" },
        { accountId: accts.get("jazz_payable"), debit: 0, credit: l.platformFee, description: "Jazz share" });
      await postEntry(q, { date, ref, memo: `Revenue accrual from Sales Flow Pro: ${l.client} ${l.type ?? ""} ${l.month}`, source: "sfp-accrual", kind: "proposed", userId, lines: lines2 as any });
      n++;
    }
    return { entries: n, months: [...months], revenue: todo.reduce((a, l) => a + l.revenue, 0) };
  });
}
export { fiscalYearOf };
