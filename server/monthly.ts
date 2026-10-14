import type { Db } from "./db.js";
import type { Snapshot } from "./ledger.js";
import { fromUnits } from "../shared/money.js";
import { monthEnd, monthsBetween } from "../shared/fiscal.js";
import { loadSfpLines, matchCampaigns, type SfpLine } from "./sfp.js";

/**
 * Month-by-month view of the business, two ways:
 * - campaigns (what was sold in the month, from Sales Flow Pro): who brought it, revenue, the Jazz share,
 *   what TonePerks keeps, whether it was invoiced, what has been received and what is still to collect;
 * - books (the ledger): revenue and Jazz fee as booked, payments to Jazz, and month-end balances.
 */
export interface CampaignMonth {
  id: string; campaignId: string; month: string; client: string; code: string | null; manager: string | null;
  source: SfpLine["source"]; billedByJazz: boolean; collectFrom: "customer" | "Jazz";
  campaignValue: number; revenue: number; jazzFee: number; toneperksKeeps: number; jazzKeepsDirect: number;
  invoiced: boolean; invoiceNo: string | null; invoiceTotal: number; received: number; toCollect: number;
  jazzPaid: number; jazzToPay: number; jazzDueNow: number;
}

export async function monthlyBreakdown(db: Db, s: Snapshot, from: string, to: string) {
  const { lines, settings } = await loadSfpLines(db);
  const { matches } = await matchCampaigns(db, lines, settings.clientAliases ?? {});
  const gross = new Map((await db.query<any>("SELECT id, gross_amount FROM invoices")).map((i) => [i.id, Number(i.gross_amount)]));
  const perInvoice = new Map<number, number>();
  for (const l of lines) { const m = matches.get(l.id); if (m) perInvoice.set(m.id, (perInvoice.get(m.id) ?? 0) + l.revenue); }
  const cash = new Map<string, { received: number; paid: number }>();
  for (const e of await db.query<any>("SELECT campaign_id, kind, amount, withheld FROM campaign_cash")) {
    const c = cash.get(e.campaign_id) ?? { received: 0, paid: 0 };
    if (e.kind === "received") c.received += Number(e.amount) + Number(e.withheld || 0); else c.paid += Number(e.amount);
    cash.set(e.campaign_id, c);
  }
  const fromM = from.slice(0, 7), toM = to.slice(0, 7);
  // All campaign-months up to the end month (earlier months take a campaign's cash first).
  const billable = lines.filter((l) => (l.revenue > 0 || l.campaignValue > 0) && !l.foc && l.month <= toM).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const left = new Map([...cash].map(([k, v]) => [k, { ...v }]));
  const rows: CampaignMonth[] = billable.map((l) => {
    const campaignId = l.id.split(":")[0];
    const m = matches.get(l.id);
    const share = m ? l.revenue / (perInvoice.get(m.id) || l.revenue || 1) : 0;
    const invoiceTotal = m ? ((m.gross ?? gross.get(m.id)) ?? 0) * share : l.revenue * (1 + settings.gstRate);
    const c = left.get(campaignId) ?? { received: 0, paid: 0 };
    const received = Math.min(c.received, invoiceTotal); c.received -= received;
    const jazzPaid = Math.min(c.paid, l.platformFee); c.paid -= jazzPaid;
    left.set(campaignId, c);
    const jazzToPay = l.platformFee - jazzPaid;
    const collectFrom = l.source === "callperks_sourced" && !l.billedByJazz ? "customer" : "Jazz";
    return {
      id: l.id, campaignId, month: l.month, client: l.client, code: l.code, manager: l.manager, source: l.source, billedByJazz: !!l.billedByJazz, collectFrom,
      campaignValue: l.campaignValue, revenue: l.revenue, jazzFee: l.platformFee, toneperksKeeps: l.revenue - l.platformFee,
      jazzKeepsDirect: collectFrom === "Jazz" ? Math.max(l.campaignValue - l.revenue, 0) : 0,
      invoiced: !!m, invoiceNo: m ? (m.number ?? null) : null, invoiceTotal, received, toCollect: Math.max(invoiceTotal - received, 0),
      jazzPaid, jazzToPay, jazzDueNow: invoiceTotal > 0 ? jazzToPay * Math.min(1, received / invoiceTotal) : 0,
    };
  });
  // Any cash left over (more received than invoiced) stays on the campaign's last month.
  for (const [id, c] of left) {
    if (c.received <= 0.5) continue;
    const last = [...rows].reverse().find((r) => r.campaignId === id);
    if (last) { last.received += c.received; last.toCollect = Math.max(last.invoiceTotal - last.received, 0); }
  }
  const months = monthsBetween(from, to);
  const inRange = rows.filter((r) => r.month >= fromM && r.month <= toM);
  const sum = (rs: CampaignMonth[], k: keyof CampaignMonth) => rs.reduce((a, r) => a + (r[k] as number), 0);

  // Books: revenue and Jazz fee as booked, payments to Jazz, month-end balances.
  const role = (r: string) => s.lines.filter((l) => l.account.system_role === r);
  const books = months.map((m) => {
    const end = monthEnd(m);
    const inM = (l: { date: string }) => l.date.slice(0, 7) === m;
    const upTo = (l: { date: string }) => l.date <= end;
    const bal = (r: string, sign: 1 | -1) => fromUnits(role(r).filter(upTo).reduce((a, l) => a + sign * (l.dr - l.cr), 0));
    let collected = 0;
    for (const [, ls] of s.byEntry) {
      if (!inM(ls[0])) continue;
      if (!ls.some((l) => l.account.system_role === "receivable" && l.cr > 0)) continue;
      collected += fromUnits(ls.filter((l) => l.account.system_role === "bank").reduce((a, l) => a + l.dr - l.cr, 0));
    }
    return {
      month: m,
      revenue: fromUnits(role("revenue").filter(inM).reduce((a, l) => a + l.cr - l.dr, 0)),
      jazzFee: fromUnits(role("platform_fee").filter(inM).reduce((a, l) => a + l.dr - l.cr, 0)),
      jazzPaid: fromUnits(role("jazz_payable").filter(inM).reduce((a, l) => a + l.dr, 0)),
      collected: Math.max(collected, 0),
      jazzPayableEnd: bal("jazz_payable", -1), receivableEnd: bal("receivable", 1), bankEnd: bal("bank", 1),
    };
  });

  const byMonth = months.map((m) => {
    const rs = inRange.filter((r) => r.month === m);
    return {
      month: m, campaigns: rs.length, revenue: sum(rs, "revenue"),
      bySource: { callperks_sourced: sum(rs.filter((r) => r.source === "callperks_sourced"), "revenue"), jazz_sourced: sum(rs.filter((r) => r.source === "jazz_sourced"), "revenue"), jazz_internal: sum(rs.filter((r) => r.source === "jazz_internal"), "revenue") },
      jazzFee: sum(rs, "jazzFee"), toneperksKeeps: sum(rs, "toneperksKeeps"),
      invoiced: sum(rs.filter((r) => r.invoiced), "revenue"), notInvoiced: sum(rs.filter((r) => !r.invoiced), "revenue"),
      invoiceTotal: sum(rs, "invoiceTotal"), received: sum(rs, "received"), toCollect: sum(rs, "toCollect"),
      toCollectFromJazz: sum(rs.filter((r) => r.collectFrom === "Jazz"), "toCollect"),
      jazzToPay: sum(rs, "jazzToPay"), jazzDueNow: sum(rs, "jazzDueNow"),
      books: books.find((b) => b.month === m)!,
    };
  });

  const clients = new Map<string, any>();
  for (const r of inRange) {
    const k = `${r.client.toLowerCase().replace(/[^a-z0-9]+/g, "")}|${r.source}`;
    const c = clients.get(k) ?? { client: r.client, source: r.source, collectFrom: r.collectFrom, campaigns: 0, months: new Set<string>(), revenue: 0, jazzFee: 0, toneperksKeeps: 0, invoiceTotal: 0, received: 0, toCollect: 0, jazzToPay: 0, jazzDueNow: 0, notInvoiced: 0 };
    c.campaigns++; c.months.add(r.month);
    for (const f of ["revenue", "jazzFee", "toneperksKeeps", "invoiceTotal", "received", "toCollect", "jazzToPay", "jazzDueNow"] as const) c[f] += r[f];
    if (!r.invoiced) c.notInvoiced += r.revenue;
    clients.set(k, c);
  }
  const byClient = [...clients.values()].map((c) => ({ ...c, months: [...c.months].sort() })).sort((a, b) => b.revenue - a.revenue);
  const totals = Object.fromEntries((["revenue", "jazzFee", "toneperksKeeps", "invoiceTotal", "received", "toCollect", "jazzToPay", "jazzDueNow"] as const).map((k) => [k, sum(inRange, k)]));
  return { from, to, months, byMonth, byClient, campaigns: inRange, totals: { ...totals, toCollectFromJazz: sum(inRange.filter((r) => r.collectFrom === "Jazz"), "toCollect"), notInvoiced: sum(inRange.filter((r) => !r.invoiced), "revenue") } };
}
