import type { Db } from "./db.js";
import type { SfpLine } from "./sfp.js";
import { isoDate } from "./ledger.js";

/**
 * Source documents (issued invoices, bank receipts, Jazz release orders) mapped to the accountant's
 * invoice register and to Sales Flow Pro campaigns. The mapping is explicit evidence and takes
 * precedence over the automatic campaign-to-invoice matching:
 * - invoice:     the invoice as issued; linked to its register row (whatever number the books gave it)
 *                and to the campaign(s) it bills. Not in the books → it still counts as invoiced and
 *                can be proposed as a journal entry.
 * - receipt:     money received (gross = cash, gst = tax the customer withheld) that the register does not show
 *                against the campaign it paid for — booked on another invoice, on none, or after the register's date; the receipt
 *                is moved to the campaign it actually paid for.
 * - jazz_billed: the customer was billed and paid by Jazz (release order / payment approval to PMCL);
 *                TonePerks' revenue is its share, to be invoiced to Jazz, with no platform fee.
 */
export type DocKind = "invoice" | "receipt" | "jazz_billed";
export interface InvoiceDoc {
  id: number; kind: DocKind; docNo: string | null; docDate: string | null; client: string; billedTo: string | null; campaignPeriod: string | null;
  net: number; gst: number; gross: number; booksNumber: string | null; booksClient: string | null; campaignIds: string[];
  title: string | null; url: string | null; note: string | null;
}

export async function loadDocs(db: Db): Promise<InvoiceDoc[]> {
  const rows = await db.query<any>("SELECT * FROM invoice_docs ORDER BY doc_date NULLS LAST, id");
  return rows.map((r) => ({
    id: r.id, kind: r.kind, docNo: r.doc_no, docDate: r.doc_date ? isoDate(r.doc_date) : null, client: r.client, billedTo: r.billed_to, campaignPeriod: r.campaign_period,
    net: Number(r.net), gst: Number(r.gst), gross: Number(r.gross), booksNumber: r.books_number, booksClient: r.books_client,
    campaignIds: (typeof r.campaign_ids === "string" ? JSON.parse(r.campaign_ids) : r.campaign_ids) ?? [], title: r.title, url: r.url, note: r.note,
  }));
}

const squash = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The register row a document corresponds to: by the books' invoice number, or by client for rows without a number. */
export function resolveBooks(doc: InvoiceDoc, invoices: any[]) {
  if (doc.booksNumber) {
    const cands = invoices.filter((i) => String(i.number ?? "") === doc.booksNumber);
    if (cands.length <= 1) return cands[0] ?? null;
    const want = squash(doc.booksClient ?? doc.client);
    return cands.find((i) => squash(i.client).startsWith(want.slice(0, 5))) ?? cands[0];
  }
  if (doc.booksClient) return invoices.find((i) => !i.number && squash(i.client) === squash(doc.booksClient)) ?? null;
  return null;
}

/** Lines a document links to: a campaign id covers all its retainer months; "id:YYYY-MM" names one month. */
export function linkedLines(doc: InvoiceDoc, lines: SfpLine[]) {
  const ids = new Set(doc.campaignIds);
  return lines.filter((l) => ids.has(l.id) || ids.has(l.id.split(":")[0]));
}

/** Campaigns billed by Jazz: TonePerks' share is its revenue (invoiced to Jazz), no platform fee. */
export function applyJazzBilled(lines: SfpLine[], docs: InvoiceDoc[]): SfpLine[] {
  const ids = new Set(docs.filter((d) => d.kind === "jazz_billed").flatMap((d) => d.campaignIds));
  if (!ids.size) return lines;
  return lines.map((l) => (ids.has(l.id) || ids.has(l.id.split(":")[0])) && !l.foc
    ? { ...l, revenue: l.toneperksShare, platformFee: 0, billedByJazz: true, basis: "Billed and collected by Jazz — TonePerks invoices Jazz for its share" }
    : l);
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const dmy = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "–");

/** Each document with its register row, linked campaigns and the differences found. */
/** `matchedInvoice` maps a campaign line id to the register invoice id it is matched to. */
export function docRegister(docs: InvoiceDoc[], invoices: any[], lines: SfpLine[], matchedInvoice = new Map<string, number>()) {
  const invDocs = docs.filter((d) => d.kind === "invoice");
  return docs.map((d) => {
    const b = resolveBooks(d, invoices);
    const ls = linkedLines(d, lines);
    const issues: { tone: "bad" | "warn" | "info"; text: string }[] = [];
    const camp = ls.map((l) => ({ id: l.id, client: l.client, code: l.code, month: l.month, value: l.campaignValue, revenue: l.revenue, toneperksShare: l.toneperksShare, source: l.source }));
    if (d.kind === "invoice") {
      if (!b) issues.push({ tone: "bad", text: `Not in the accountant's books: PKR ${fmt(d.net)} revenue and PKR ${fmt(d.gst)} output sales tax are missing.` });
      else {
        if (Math.abs(Number(b.net_amount) - d.net) > 1) issues.push({ tone: "bad", text: `Books show net PKR ${fmt(Number(b.net_amount))}; the invoice says PKR ${fmt(d.net)}.` });
        if (Math.abs(Number(b.gst) - d.gst) > 1) issues.push({ tone: "bad", text: `Books show sales tax PKR ${fmt(Number(b.gst))}; the invoice says PKR ${fmt(d.gst)}.` });
        if (d.docNo && String(b.number ?? "") !== d.docNo) issues.push({ tone: "warn", text: `Issued as #${d.docNo} but recorded as #${b.number ?? "–"} in the books.` });
        const bd = isoDate(b.invoice_date);
        if (d.docDate && Math.abs(Date.parse(bd) - Date.parse(d.docDate)) > 3 * 86400000)
          issues.push({ tone: bd.slice(0, 7) !== d.docDate.slice(0, 7) ? "warn" : "info", text: `Dated ${dmy(d.docDate)} on the invoice, ${dmy(bd)} in the books${bd.slice(0, 7) !== d.docDate.slice(0, 7) ? " — a different sales-tax month" : ""}.` });
      }
      const dup = d.docNo ? invDocs.filter((o) => o.id !== d.id && o.docNo === d.docNo) : [];
      if (dup.length) issues.push({ tone: "bad", text: `Invoice number ${d.docNo} was also issued to ${dup.map((o) => o.client).join(", ")}. Sales-tax invoices need unique serial numbers.` });
      if (!ls.length) issues.push({ tone: "warn", text: "No Sales Flow Pro campaign linked." });
      else {
        const v = ls.reduce((a, l) => a + l.revenue, 0);
        if (Math.abs(v - d.net) > Math.max(1000, 0.01 * d.net)) issues.push({ tone: "warn", text: `Sales Flow Pro has PKR ${fmt(v)} for ${ls.length > 1 ? "these campaigns" : "this campaign"}; the invoice bills PKR ${fmt(d.net)}.` });
      }
    } else if (d.kind === "receipt") {
      if (!ls.length) issues.push({ tone: "warn", text: "No campaign linked to this receipt." });
      const onRight = b && ls.some((l) => matchedInvoice.get(l.id) === b.id);
      if (b && !onRight) issues.push({ tone: "warn", text: `The books put this receipt on #${b.number ?? "–"} ${b.client}${ls.length ? `; it is moved to ${ls[0].client} (${ls[0].month})` : ""}.` });
      if (onRight) issues.push({ tone: "info", text: `Agrees with the books: received on #${b.number ?? "–"}.` });
      if (ls.length && !ls.some((l) => l.revenue > 0)) issues.push({ tone: "info", text: "The linked campaign carries no revenue." });
    } else {
      const tp = ls.reduce((a, l) => a + l.toneperksShare, 0);
      issues.push({ tone: "info", text: `Billed by Jazz${d.net ? ` (PKR ${fmt(d.net)} to the customer)` : ""}. TonePerks invoices Jazz for its share${tp ? `: PKR ${fmt(tp)} + sales tax` : ""}; no Jazz platform fee on this one.` });
      if (!ls.length) issues.push({ tone: "warn", text: "No Sales Flow Pro campaign linked." });
    }
    const status = issues.some((i) => i.tone === "bad") ? (d.kind === "invoice" && !b ? "missing" : "differs") : issues.some((i) => i.tone === "warn") ? "check" : "ok";
    return { ...d, status, issues, campaigns: camp,
      books: b ? { id: b.id, number: b.number, client: b.client, date: isoDate(b.invoice_date), net: Number(b.net_amount), gst: Number(b.gst), gross: Number(b.gross_amount), received: Number(b.received) } : null };
  });
}

export const DOC_ROW = (d: any) => [d.kind, d.docNo ?? null, d.docDate ?? null, d.client, d.billedTo ?? null, d.campaignPeriod ?? null, d.net ?? 0, d.gst ?? 0, d.gross ?? 0,
  d.booksNumber ?? null, d.booksClient ?? null, JSON.stringify(d.campaignIds ?? []), d.title ?? null, d.url ?? null, d.note ?? null];
export const DOC_INSERT = `INSERT INTO invoice_docs (kind, doc_no, doc_date, client, billed_to, campaign_period, net, gst, gross, books_number, books_client, campaign_ids, title, url, note)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`;
