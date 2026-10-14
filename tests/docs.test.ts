import { describe, expect, it } from "vitest";
import { applyJazzBilled, docRegister, resolveBooks, type InvoiceDoc } from "../server/docs.js";
import type { SfpLine } from "../server/sfp.js";

const line = (id: string, client: string, month: string, value: number, source: SfpLine["source"] = "callperks_sourced"): SfpLine => ({
  id, code: null, client, type: null, source, sourceLabel: source, status: "Completed", manager: null, month, billing: "Paid", foc: false,
  campaignValue: value, jazzShare: value * 0.4, toneperksShare: value * 0.6, revenue: source === "callperks_sourced" ? value : value * 0.6,
  platformFee: source === "callperks_sourced" ? value * 0.4 : 0, basis: "" });
const doc = (o: Partial<InvoiceDoc>): InvoiceDoc => ({ id: 1, kind: "invoice", docNo: null, docDate: "2026-08-25", client: "X", billedTo: null, campaignPeriod: null,
  net: 0, gst: 0, gross: 0, booksNumber: null, booksClient: null, campaignIds: [], title: null, url: null, note: null, ...o });
const inv = (id: number, number: string | null, client: string, net: number, date = "2026-08-25") => ({ id, number, client, invoice_date: date, net_amount: net, gst: net * 0.15, gross_amount: net * 1.15, received: 0 });

describe("invoice documents", () => {
  it("finds the register row by the books' number, and by client when the row has none", () => {
    const rows = [inv(1, "33", "ACME BANK LIMITED", 5e6), inv(2, null, "Resort", 1e5)];
    expect(resolveBooks(doc({ booksNumber: "33" }), rows)?.id).toBe(1);
    expect(resolveBooks(doc({ booksClient: "Resort" }), rows)?.id).toBe(2);
    expect(resolveBooks(doc({ booksNumber: "41" }), rows)).toBeNull();
  });
  it("treats Jazz-billed campaigns as TonePerks' share with no platform fee", () => {
    const [l] = applyJazzBilled([line("s", "Brand", "2026-03", 1e6)], [doc({ kind: "jazz_billed", campaignIds: ["s"] })]);
    expect(l.revenue).toBe(600000); expect(l.platformFee).toBe(0); expect(l.billedByJazz).toBe(true);
  });
  it("flags invoices missing from the books, renumbered invoices and reused numbers", () => {
    const lines = [line("e:2026-09", "Acme", "2026-09", 5e6), line("i", "Beta", "2026-08", 2e6), line("d", "Gamma", "2026-08", 400000)];
    const docs = [
      doc({ id: 1, docNo: "41", client: "Acme", net: 5e6, gst: 750000, campaignIds: ["e"] }),
      doc({ id: 2, docNo: "38", client: "Beta", net: 2e6, gst: 300000, booksNumber: "32", campaignIds: ["i"] }),
      doc({ id: 3, docNo: "38", client: "Gamma Co", net: 400000, gst: 60000, booksNumber: "38", campaignIds: ["d"] }),
    ];
    const r = docRegister(docs, [inv(10, "32", "Beta", 2e6), inv(11, "38", "Gamma Co", 400000)], lines);
    expect(r[0].status).toBe("missing");
    expect(r[1].issues.map((i) => i.text).join(" ")).toMatch(/recorded as #32/);
    expect(r[2].issues.some((i) => /also issued to Beta/.test(i.text))).toBe(true);
  });
});
