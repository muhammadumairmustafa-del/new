import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import type { Db } from "./db.js";
import { createSession, destroySession, hashPassword, loginFailed, loginOk, loginThrottled, passwordProblem, requireRole, verifyPassword } from "./auth.js";
import { loadSnapshot, postEntry, ROLES, isoDate } from "./ledger.js";
import { balanceSheet, cashFlow, liabilitySchedule, monthlySeries, partnerStatement, profitAndLoss, trialBalance, lastActivityDate, fifoAging } from "./reports.js";
import { importWorkbook } from "./importer.js";
import { taxPosition, advanceTaxSchedule } from "./tax-position.js";
import { buildCashPlan } from "./cashplan.js";
import { runChecks } from "./checks.js";
import { DEFAULT_CASHPLAN, DEFAULT_TAX, getSetting, putSetting, type CashPlanSettings, type TaxSettings } from "./settings.js";
import { statementsWorkbook } from "./export.js";
import { docRegister, DOC_INSERT, DOC_ROW, linkedLines, loadDocs, resolveBooks } from "./docs.js";
import { DEFAULT_SFP, loadSfpLines, matchCampaigns, prefillReceived, proposeAccruals, readSfpFromEnv, reconcile, storeSnapshot } from "./sfp.js";
import { fiscalYearOf, fyRange, monthEnd, monthsBetween } from "../shared/fiscal.js";
import { fromUnits, toUnits } from "../shared/money.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const zDate = z.string().regex(dateRe);
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const todayPk = () => new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);

export function apiRouter(db: Db) {
  const r = express.Router();
  const log = (req: Request, action: string, detail: unknown) => db.query("INSERT INTO audit_log (user_id, action, detail) VALUES ($1,$2,$3)", [req.user?.id ?? null, action, JSON.stringify(detail)]);
  const snap = (req: Request) => loadSnapshot(db, { includeProposed: req.query.proposed === "1" });
  const asOfOf = async (req: Request, s: Awaited<ReturnType<typeof snap>>) => (typeof req.query.asOf === "string" && dateRe.test(req.query.asOf) ? req.query.asOf : lastActivityDate(s) ?? todayPk());
  const today = (req: Request) => (typeof req.query.today === "string" && dateRe.test(req.query.today) ? req.query.today : todayPk());
  const range = (req: Request, fallbackTo: string) => {
    const fy = Number(req.query.fy) || fiscalYearOf(fallbackTo);
    const d = fyRange(fy);
    const from = typeof req.query.from === "string" && dateRe.test(req.query.from) ? req.query.from : d.from;
    let to = typeof req.query.to === "string" && dateRe.test(req.query.to) ? req.query.to : d.to;
    if (!req.query.to && to > fallbackTo) to = fallbackTo < from ? d.to : monthEnd(fallbackTo.slice(0, 7));
    return { fy, from, to };
  };

  // ------------------------------------------------------------------ auth
  r.get("/auth/status", wrap(async (req, res) => {
    const [{ n }] = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM users");
    res.json({ needsSetup: n === "0", setupTokenRequired: !!process.env.SETUP_TOKEN || !!process.env.VERCEL, user: req.user ?? null });
  }));
  r.post("/auth/setup", wrap(async (req, res) => {
    const body = z.object({ username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i), fullName: z.string().min(2).max(80), password: z.string(), setupToken: z.string().optional() }).parse(req.body);
    // On a public deployment the first visitor must not be able to claim the admin account.
    const expected = process.env.SETUP_TOKEN;
    if (process.env.VERCEL && !expected) return res.status(403).json({ error: "Set the SETUP_TOKEN environment variable in Vercel, redeploy, then enter it here." });
    if (expected && !safeEqual(body.setupToken ?? "", expected)) return res.status(403).json({ error: "Invalid setup code" });
    const p = passwordProblem(body.password); if (p) return res.status(400).json({ error: p });
    const created = await db.tx(async (q) => {
      const [{ n }] = await q<{ n: string }>("SELECT count(*)::text AS n FROM users");
      if (n !== "0") return null;
      const [u] = await q<{ id: number }>("INSERT INTO users (username, full_name, password_hash, role) VALUES ($1,$2,$3,'partner') RETURNING id", [body.username.toLowerCase(), body.fullName, hashPassword(body.password)]);
      return u;
    });
    if (!created) return res.status(409).json({ error: "Setup already completed" });
    await createSession(db, res, created.id);
    res.json({ ok: true });
  }));
  r.post("/auth/login", wrap(async (req, res) => {
    const body = z.object({ username: z.string().max(60), password: z.string().max(200) }).parse(req.body);
    const key = `${req.ip}|${body.username.toLowerCase()}`;
    if (loginThrottled(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const [u] = await db.query<any>("SELECT * FROM users WHERE username = $1 AND active", [body.username.toLowerCase()]);
    if (!u || !verifyPassword(body.password, u.password_hash)) { loginFailed(key); return res.status(401).json({ error: "Invalid username or password" }); }
    loginOk(key); await createSession(db, res, u.id);
    await db.query("INSERT INTO audit_log (user_id, action) VALUES ($1,'login')", [u.id]);
    res.json({ ok: true });
  }));
  r.post("/auth/logout", wrap(async (req, res) => { await destroySession(db, req, res); res.json({ ok: true }); }));
  r.post("/auth/password", requireRole("viewer"), wrap(async (req, res) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const [u] = await db.query<any>("SELECT * FROM users WHERE id = $1", [req.user!.id]);
    if (!verifyPassword(body.current, u.password_hash)) return res.status(400).json({ error: "Current password is wrong" });
    const p = passwordProblem(body.next); if (p) return res.status(400).json({ error: p });
    await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [u.id, hashPassword(body.next)]);
    await db.query("DELETE FROM sessions WHERE user_id = $1", [u.id]);
    await createSession(db, res, u.id);
    res.json({ ok: true });
  }));

  // Everything below requires a signed-in user.
  r.use(requireRole("viewer"));

  r.get("/users", requireRole("partner"), wrap(async (_req, res) => res.json(await db.query("SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id"))));
  r.post("/users", requireRole("partner"), wrap(async (req, res) => {
    const b = z.object({ username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i), fullName: z.string().min(2), role: z.enum(["partner", "accountant", "viewer"]), password: z.string() }).parse(req.body);
    const p = passwordProblem(b.password); if (p) return res.status(400).json({ error: p });
    await db.query("INSERT INTO users (username, full_name, password_hash, role) VALUES ($1,$2,$3,$4)", [b.username.toLowerCase(), b.fullName, hashPassword(b.password), b.role]);
    await log(req, "user.create", { username: b.username, role: b.role }); res.json({ ok: true });
  }));
  r.patch("/users/:id", requireRole("partner"), wrap(async (req, res) => {
    const b = z.object({ role: z.enum(["partner", "accountant", "viewer"]).optional(), active: z.boolean().optional(), password: z.string().optional() }).parse(req.body);
    const id = Number(req.params.id);
    if (id === req.user!.id && (b.active === false || (b.role && b.role !== "partner"))) return res.status(400).json({ error: "You cannot demote or deactivate yourself" });
    if (b.password) { const p = passwordProblem(b.password); if (p) return res.status(400).json({ error: p }); await db.query("UPDATE users SET password_hash=$2 WHERE id=$1", [id, hashPassword(b.password)]); await db.query("DELETE FROM sessions WHERE user_id=$1", [id]); }
    if (b.role) await db.query("UPDATE users SET role=$2 WHERE id=$1", [id, b.role]);
    if (b.active !== undefined) { await db.query("UPDATE users SET active=$2 WHERE id=$1", [id, b.active]); if (!b.active) await db.query("DELETE FROM sessions WHERE user_id=$1", [id]); }
    await log(req, "user.update", { id, role: b.role, active: b.active, passwordReset: !!b.password }); res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ meta & dashboard
  r.get("/meta", wrap(async (req, res) => {
    const s = await snap(req);
    const first = s.lines[0]?.date ?? null; const last = lastActivityDate(s);
    const fys = first && last ? [...new Set(monthsBetween(first, last).map((m) => fiscalYearOf(`${m}-01`)))] : [];
    const imports = await db.query("SELECT id, file_name, kind, period_from, period_to, entries, created_at FROM import_batches ORDER BY id DESC");
    const [{ proposed }] = await db.query<{ proposed: string }>("SELECT count(*)::text AS proposed FROM journal_entries WHERE kind='proposed' AND status='posted'");
    const company = await getSetting<{ name: string; defaultFy: number | null }>(db, "company", { name: "TonePerks LLP", defaultFy: null });
    res.json({ company: company.name, defaultFy: company.defaultFy, firstDate: first, lastDate: last, fiscalYears: fys, today: todayPk(), entries: s.byEntry.size, imports, proposedAdjustments: Number(proposed), user: req.user });
  }));
  r.get("/dashboard", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s);
    const fy = Number(req.query.fy) || fiscalYearOf(asOf); const { from, to: fyEnd } = fyRange(fy);
    const periodEnd = fyEnd < asOf ? fyEnd : asOf;
    const series = monthlySeries(s, from, periodEnd);
    const bs = balanceSheet(s, [periodEnd]);
    const tax = await getSetting<TaxSettings>(db, "tax", DEFAULT_TAX);
    const cp = await getSetting<CashPlanSettings>(db, "cashplan", DEFAULT_CASHPLAN);
    const plan = await buildCashPlan(db, s, cp, tax, { asOf, today: today(req), weeks: 13 });
    const checks = await runChecks(db, s, tax, asOf, today(req));
    const ytd = profitAndLoss(s, from, periodEnd);
    const line = (sec: any, label: string) => sec.lines.find((l: any) => l.label === label)?.values[0] ?? 0;
    const cl = bs.currentLiabilities;
    res.json({ asOf, fy, periodEnd, series,
      kpis: {
        cash: line(bs.currentAssets, "Cash and bank balances"), receivables: line(bs.currentAssets, "Trade receivables"),
        taxReceivables: line(bs.currentAssets, "Withholding tax receivable") + line(bs.currentAssets, "Sales tax input receivable"),
        liabilitiesExPartners: cl.total[0], partnersAccounts: bs.partnersCurrentAccounts.total[0],
        incomeTax: line(cl, "Income tax liability"), salaryTax: line(cl, "Salary tax payable (s.149)"), salesTax: line(cl, "Sales tax payable"),
        jazz: line(cl, "Payable to Jazz (platform share)"),
        ytdRevenue: ytd.sections[0].total.at(-1), ytdGrossProfit: ytd.grossProfit.at(-1), ytdProfit: ytd.profitBeforeTax.at(-1), ytdTax: ytd.sections.find((x) => x.key === "Taxation")!.total.at(-1), ytdProfitAfterTax: ytd.profitAfterTax.at(-1),
      },
      plan: { summary: plan.summary, minCash: plan.minCash, minWeek: plan.minWeek, weeks: plan.weeks, openingCash: plan.openingCash, startDate: plan.startDate },
      checks: checks.slice(0, 8), checkCounts: { critical: checks.filter((c) => c.severity === "critical").length, high: checks.filter((c) => c.severity === "high").length, total: checks.length },
    });
  }));

  // ------------------------------------------------------------------ reports
  r.get("/reports/pl", wrap(async (req, res) => { const s = await snap(req); const { from, to } = range(req, await asOfOf(req, s)); res.json(profitAndLoss(s, from, to)); }));
  r.get("/reports/bs", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s);
    let dates: string[];
    if (typeof req.query.dates === "string") dates = req.query.dates.split(",").filter((d) => dateRe.test(d)).slice(0, 14);
    else { const { from, to } = range(req, asOf); dates = monthsBetween(from, to).map((m) => (monthEnd(m) > asOf ? asOf : monthEnd(m))); dates = [...new Set(dates)]; }
    res.json(balanceSheet(s, dates, { partnersInEquity: req.query.partnersInEquity === "1" }));
  }));
  r.get("/reports/cf", wrap(async (req, res) => { const s = await snap(req); const { from, to } = range(req, await asOfOf(req, s)); res.json(cashFlow(s, from, to)); }));
  r.get("/reports/tb", wrap(async (req, res) => { const s = await snap(req); const { from, to } = range(req, await asOfOf(req, s)); res.json(trialBalance(s, from, to)); }));
  r.get("/reports/partners", wrap(async (req, res) => {
    const s = await snap(req); const { from, to } = range(req, await asOfOf(req, s));
    const partners = await db.query<any>("SELECT * FROM partners ORDER BY ratio DESC");
    const st = partnerStatement(s, from, to, new Map(partners.map((p) => [p.name, Number(p.ratio)])));
    res.json({ ...st, partners: partners.map((p) => ({ ...p, ratio: Number(p.ratio), committed_capital: Number(p.committed_capital) })) });
  }));
  r.get("/reports/liabilities", wrap(async (req, res) => { const s = await snap(req); res.json(liabilitySchedule(s, await asOfOf(req, s))); }));
  r.get("/reports/export.xlsx", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s); const { fy, from, to } = range(req, asOf);
    const tax = await getSetting<TaxSettings>(db, "tax", DEFAULT_TAX); const cp = await getSetting<CashPlanSettings>(db, "cashplan", DEFAULT_CASHPLAN);
    const partners = await db.query<any>("SELECT * FROM partners");
    const bsDates = [...new Set(monthsBetween(from, to).map((m) => (monthEnd(m) > asOf ? asOf : monthEnd(m))))];
    const buf = await statementsWorkbook({ company: "TonePerks LLP", fyLabel: `FY${fy} (${from} to ${to})`, generated: todayPk(), adjusted: req.query.proposed === "1",
      pl: profitAndLoss(s, from, to), bs: balanceSheet(s, bsDates, { partnersInEquity: req.query.partnersInEquity === "1" }), cf: cashFlow(s, from, to), tb: trialBalance(s, from, to),
      partners: partnerStatement(s, from, to, new Map(partners.map((p) => [p.name, Number(p.ratio)]))), liabilities: liabilitySchedule(s, asOf) as any[],
      tax: taxPosition(s, tax, Math.min(fy, fiscalYearOf(asOf)), asOf), checks: await runChecks(db, s, tax, asOf, today(req)),
      plan: await buildCashPlan(db, s, cp, tax, { asOf, today: today(req), weeks: 13 }) });
    await log(req, "export", { fy, proposed: req.query.proposed === "1" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="TonePerks_FY${fy}_statements${req.query.proposed === "1" ? "_adjusted" : ""}.xlsx"`);
    res.send(buf);
  }));

  // ------------------------------------------------------------------ ledger
  r.get("/accounts", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s);
    const b = new Map<number, number>(); for (const l of s.lines) if (l.date <= asOf) b.set(l.account.id, (b.get(l.account.id) ?? 0) + l.dr - l.cr);
    res.json({ roles: ROLES, accounts: s.accounts.map((a) => ({ ...a, balance: fromUnits(b.get(a.id) ?? 0) })) });
  }));
  r.post("/accounts", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ code: z.string().min(1).max(10), name: z.string().min(2).max(120), type: z.enum(["asset", "liability", "equity", "income", "expense"]), grp: z.string().min(2), fs_line: z.string().min(2),
      party_type: z.enum(["partner", "employee", "vendor", "customer", "tax"]).nullable().optional(), party: z.string().nullable().optional() }).parse(req.body);
    await db.query("INSERT INTO accounts (code, name, type, grp, fs_line, party_type, party) VALUES ($1,$2,$3,$4,$5,$6,$7)", [b.code, b.name, b.type, b.grp, b.fs_line, b.party_type ?? null, b.party ?? null]);
    await log(req, "account.create", b); res.json({ ok: true });
  }));
  r.patch("/accounts/:id", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ grp: z.string().min(2).optional(), fs_line: z.string().min(2).optional(), system_role: z.enum(ROLES).nullable().optional(),
      party_type: z.enum(["partner", "employee", "vendor", "customer", "tax"]).nullable().optional(), active: z.boolean().optional() }).parse(req.body);
    const id = Number(req.params.id);
    for (const [k, v] of Object.entries(b)) await db.query(`UPDATE accounts SET ${k} = $2 WHERE id = $1`, [id, v]); // keys are whitelisted by zod
    await log(req, "account.update", { id, ...b }); res.json({ ok: true });
  }));
  r.get("/ledger/:accountId", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s); const id = Number(req.params.accountId);
    const { from, to } = range(req, asOf);
    let run = 0; const rows: any[] = [];
    for (const l of s.lines) {
      if (l.account.id !== id || l.date > to) continue;
      run += l.dr - l.cr;
      if (l.date >= from) rows.push({ entryId: l.entryId, date: l.date, ref: l.ref, memo: l.description || l.memo, payee: l.payee, kind: l.kind, debit: fromUnits(l.dr), credit: fromUnits(l.cr), balance: fromUnits(run) });
    }
    const opening = rows.length ? rows[0].balance - rows[0].debit + rows[0].credit : fromUnits(run);
    res.json({ account: s.accounts.find((a) => a.id === id), from, to, opening, rows, aging: fifoAging(s, id, to) });
  }));
  r.get("/journal", wrap(async (req, res) => {
    const q = typeof req.query.q === "string" ? `%${req.query.q.toLowerCase()}%` : null;
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    const rows = await db.query<any>(`
      SELECT e.id, e.entry_date, e.ref, e.memo, e.source, e.kind, e.status, e.created_at,
             sum(l.debit)::text AS total, string_agg(DISTINCT a.name, ' · ') AS accounts
        FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
       WHERE ($1::text IS NULL OR lower(e.memo) LIKE $1 OR lower(coalesce(e.ref,'')) LIKE $1 OR lower(a.name) LIKE $1 OR lower(coalesce(l.description,'')) LIKE $1)
         AND ($2::text IS NULL OR e.kind = $2)
       GROUP BY e.id ORDER BY e.entry_date DESC, e.id DESC LIMIT 500`, [q, kind]);
    res.json(rows.map((r) => ({ ...r, entry_date: isoDate(r.entry_date), total: Number(r.total) })));
  }));
  r.get("/journal/:id", wrap(async (req, res) => {
    const [e] = await db.query<any>("SELECT * FROM journal_entries WHERE id = $1", [Number(req.params.id)]);
    if (!e) return res.status(404).json({ error: "Not found" });
    const lines = await db.query<any>("SELECT l.*, a.code, a.name FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE entry_id = $1 ORDER BY l.id", [e.id]);
    res.json({ ...e, entry_date: isoDate(e.entry_date), lines: lines.map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) })) });
  }));
  const zEntry = z.object({ date: zDate, ref: z.string().max(60).optional().nullable(), memo: z.string().min(3).max(500), kind: z.enum(["normal", "adjustment", "proposed"]).default("normal"),
    lines: z.array(z.object({ accountId: z.number().int(), debit: z.number().min(0), credit: z.number().min(0), description: z.string().max(300).optional().nullable() })).min(2).max(60) });
  r.post("/journal", requireRole("accountant"), wrap(async (req, res) => {
    const b = zEntry.parse(req.body);
    if (b.kind === "proposed" || b.kind === "adjustment") { if (req.user!.role !== "partner" && b.kind === "adjustment") return res.status(403).json({ error: "Only partners can post adjustments" }); }
    const id = await db.tx((q) => postEntry(q, { ...b, source: "manual", userId: req.user!.id }));
    await log(req, "journal.post", { id, ...b }); res.json({ id });
  }));
  r.post("/journal/:id/void", requireRole("accountant"), wrap(async (req, res) => {
    const id = Number(req.params.id);
    const [e] = await db.query<any>("SELECT * FROM journal_entries WHERE id=$1", [id]);
    if (!e) return res.status(404).json({ error: "Not found" });
    if (e.batch_id && req.user!.role !== "partner") return res.status(403).json({ error: "Imported entries can only be voided by a partner" });
    await db.query("UPDATE journal_entries SET status='void' WHERE id=$1", [id]);
    await log(req, "journal.void", { id }); res.json({ ok: true });
  }));
  r.post("/journal/:id/accept", requireRole("partner"), wrap(async (req, res) => {
    await db.query("UPDATE journal_entries SET kind='adjustment' WHERE id=$1 AND kind='proposed'", [Number(req.params.id)]);
    await log(req, "journal.accept", { id: Number(req.params.id) }); res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ receivables
  r.get("/receivables", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s);
    const inv = await db.query<any>("SELECT * FROM invoices ORDER BY invoice_date, id");
    const rows = inv.map((i) => {
      const d = isoDate(i.invoice_date); const age = Math.round((Date.parse(asOf) - Date.parse(d)) / 86400000);
      return { id: i.id, number: i.number, date: d, client: i.client, billedTo: i.billed_to, campaignPeriod: i.campaign_period, net: Number(i.net_amount), gst: Number(i.gst), gross: Number(i.gross_amount),
        jazzShare: Number(i.jazz_share), itWithheld: Number(i.income_tax_withheld), stWithheld: Number(i.sales_tax_withheld), received: Number(i.received), outstanding: Number(i.outstanding),
        receivedDates: i.received_dates, notes: i.notes, status: i.status, expectedDate: i.expected_date ? isoDate(i.expected_date) : null, probability: Number(i.collection_probability), age };
    });
    const open = rows.filter((r) => r.outstanding > 1 && r.status !== "cancelled");
    const bucket = (a: number) => (a <= 30 ? "0-30" : a <= 60 ? "31-60" : a <= 90 ? "61-90" : a <= 180 ? "91-180" : "180+");
    const buckets = ["0-30", "31-60", "61-90", "91-180", "180+"];
    const clients = new Map<string, any>();
    for (const r of open) {
      const c = clients.get(r.client) ?? { client: r.client, total: 0, invoices: 0, oldest: r.date, ...Object.fromEntries(buckets.map((b) => [b, 0])) };
      c.total += r.outstanding; c.invoices++; c[bucket(r.age)] += r.outstanding; if (r.date < c.oldest) c.oldest = r.date; clients.set(r.client, c);
    }
    const rec = s.accounts.find((a) => a.system_role === "receivable");
    let ledger = 0; if (rec) for (const l of s.lines) if (l.account.id === rec.id && l.date <= asOf) ledger += l.dr - l.cr;
    res.json({ asOf, invoices: rows, byClient: [...clients.values()].sort((a, b) => b.total - a.total), buckets,
      totals: { register: open.reduce((a, r) => a + r.outstanding, 0), ledger: fromUnits(ledger), billed: rows.reduce((a, r) => a + r.gross, 0), received: rows.reduce((a, r) => a + r.received, 0) } });
  }));
  r.patch("/invoices/:id", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ expectedDate: zDate.nullable().optional(), probability: z.number().min(0).max(100).optional(), status: z.enum(["disputed", "confirmed", "chasing", "cancelled", "written_off"]).nullable().optional() }).parse(req.body);
    const id = Number(req.params.id);
    if (b.expectedDate !== undefined) await db.query("UPDATE invoices SET expected_date=$2 WHERE id=$1", [id, b.expectedDate]);
    if (b.probability !== undefined) await db.query("UPDATE invoices SET collection_probability=$2 WHERE id=$1", [id, b.probability]);
    if (b.status !== undefined) await db.query("UPDATE invoices SET status=$2 WHERE id=$1", [id, b.status]);
    await log(req, "invoice.update", { id, ...b }); res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ tax
  r.get("/tax", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s);
    const settings = await getSetting<TaxSettings>(db, "tax", DEFAULT_TAX);
    const ty = Number(req.query.ty) || fiscalYearOf(asOf);
    const pos = taxPosition(s, settings, ty, asOf);
    const prev = taxPosition(s, settings, ty - 1, asOf);
    const latest = Math.max(prev.bookedTaxExpense, Math.round(prev.computation.totalTax));
    res.json({ asOf, settings, position: pos, previous: prev, advanceTax: advanceTaxSchedule(s, settings, ty, latest, asOf), liabilities: (liabilitySchedule(s, asOf) as any[]).filter((l) => /tax/i.test(l.fsLine)) });
  }));

  // ------------------------------------------------------------------ cash plan
  r.get("/cashplan", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s);
    const weeks = Math.min(52, Math.max(4, Number(req.query.weeks) || 13));
    res.json(await buildCashPlan(db, s, await getSetting(db, "cashplan", DEFAULT_CASHPLAN), await getSetting(db, "tax", DEFAULT_TAX), { asOf, today: today(req), weeks }));
  }));
  r.get("/obligations", wrap(async (_req, res) => res.json(await db.query("SELECT * FROM obligations ORDER BY due_date"))));
  r.post("/obligations", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ title: z.string().min(2), category: z.enum(["statutory", "payroll", "jazz", "vendor", "partner", "other"]), amount: z.number().positive(), dueDate: zDate, priority: z.number().int().min(1).max(5), notes: z.string().optional() }).parse(req.body);
    await db.query("INSERT INTO obligations (title, category, amount, due_date, priority, notes) VALUES ($1,$2,$3,$4,$5,$6)", [b.title, b.category, b.amount, b.dueDate, b.priority, b.notes ?? null]);
    await log(req, "obligation.create", b); res.json({ ok: true });
  }));
  r.patch("/obligations/:id", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ status: z.enum(["open", "scheduled", "paid", "deferred"]) }).parse(req.body);
    await db.query("UPDATE obligations SET status=$2 WHERE id=$1", [Number(req.params.id), b.status]); res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ audit checks, findings, questions
  r.get("/checks", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s);
    res.json({ asOf, checks: await runChecks(db, s, await getSetting(db, "tax", DEFAULT_TAX), asOf, today(req)) });
  }));
  r.get("/findings", wrap(async (_req, res) => res.json(await db.query("SELECT * FROM findings ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, id"))));
  const zFinding = z.object({ code: z.string().max(30).optional().nullable(), title: z.string().min(3), severity: z.enum(["critical", "high", "medium", "low"]), area: z.string().min(2), detail: z.string().min(3),
    impact: z.number().nullable().optional(), recommendation: z.string().optional().nullable(), owner: z.string().optional().nullable(), dueDate: zDate.optional().nullable(), status: z.enum(["open", "in_progress", "resolved", "accepted"]).optional() });
  r.post("/findings", requireRole("accountant"), wrap(async (req, res) => {
    const b = zFinding.parse(req.body);
    await db.query(`INSERT INTO findings (code, title, severity, area, detail, impact, recommendation, owner, due_date, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                    ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title, severity=EXCLUDED.severity, area=EXCLUDED.area, detail=EXCLUDED.detail, impact=EXCLUDED.impact, recommendation=EXCLUDED.recommendation, updated_at=now()`,
      [b.code ?? null, b.title, b.severity, b.area, b.detail, b.impact ?? null, b.recommendation ?? null, b.owner ?? null, b.dueDate ?? null, b.status ?? "open"]);
    res.json({ ok: true });
  }));
  r.patch("/findings/:id", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ status: z.enum(["open", "in_progress", "resolved", "accepted"]).optional(), owner: z.string().nullable().optional(), dueDate: zDate.nullable().optional() }).parse(req.body);
    const id = Number(req.params.id);
    if (b.status) await db.query("UPDATE findings SET status=$2, updated_at=now() WHERE id=$1", [id, b.status]);
    if (b.owner !== undefined) await db.query("UPDATE findings SET owner=$2, updated_at=now() WHERE id=$1", [id, b.owner]);
    if (b.dueDate !== undefined) await db.query("UPDATE findings SET due_date=$2, updated_at=now() WHERE id=$1", [id, b.dueDate]);
    await log(req, "finding.update", { id, ...b }); res.json({ ok: true });
  }));
  r.get("/questions", wrap(async (_req, res) => res.json(await db.query("SELECT q.*, u.full_name AS answered_by_name FROM questions q LEFT JOIN users u ON u.id = q.answered_by ORDER BY q.status, q.id"))));
  r.post("/questions", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ code: z.string().max(30).optional().nullable(), topic: z.string().min(2), question: z.string().min(5), why: z.string().optional().nullable() }).parse(req.body);
    await db.query("INSERT INTO questions (code, topic, question, why) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET topic=EXCLUDED.topic, question=EXCLUDED.question, why=EXCLUDED.why", [b.code ?? null, b.topic, b.question, b.why ?? null]);
    res.json({ ok: true });
  }));
  r.patch("/questions/:id", requireRole("viewer"), wrap(async (req, res) => {
    const b = z.object({ answer: z.string().max(5000).optional(), status: z.enum(["open", "answered", "closed"]).optional() }).parse(req.body);
    const id = Number(req.params.id);
    if (b.answer !== undefined) await db.query("UPDATE questions SET answer=$2, answered_by=$3, answered_at=now(), status='answered' WHERE id=$1", [id, b.answer, req.user!.id]);
    if (b.status) await db.query("UPDATE questions SET status=$2 WHERE id=$1", [id, b.status]);
    await log(req, "question.answer", { id }); res.json({ ok: true });
  }));
  /** Load a review pack: { findings: [...], questions: [...], proposedEntries: [...] } prepared by the reviewer. */
  r.post("/review-pack", requireRole("partner"), upload.single("file"), wrap(async (req, res) => {
    const raw = req.file ? req.file.buffer.toString("utf8") : JSON.stringify(req.body);
    const pack = z.object({
      findings: z.array(zFinding).default([]),
      questions: z.array(z.object({ code: z.string(), topic: z.string(), question: z.string(), why: z.string().optional() })).default([]),
      proposedEntries: z.array(z.object({ date: zDate, ref: z.string(), memo: z.string(), lines: z.array(z.object({ account: z.string(), debit: z.number().min(0), credit: z.number().min(0), description: z.string().optional() })) })).default([]),
      settings: z.object({ cashplan: z.record(z.unknown()).optional(), company: z.record(z.unknown()).optional(), tax: z.record(z.unknown()).optional(), sfp: z.record(z.unknown()).optional() }).optional(),
    }).parse(JSON.parse(raw));
    if (pack.settings?.cashplan) await putSetting(db, "cashplan", { ...(await getSetting(db, "cashplan", DEFAULT_CASHPLAN)), ...pack.settings.cashplan });
    if (pack.settings?.company) await putSetting(db, "company", { ...(await getSetting(db, "company", { name: "TonePerks LLP", defaultFy: null })), ...pack.settings.company });
    if (pack.settings?.sfp) await putSetting(db, "sfp", { ...(await getSetting(db, "sfp", DEFAULT_SFP)), ...pack.settings.sfp });
    if (pack.settings?.tax) await putSetting(db, "tax", { ...(await getSetting(db, "tax", DEFAULT_TAX)), ...pack.settings.tax });
    const accts = new Map((await db.query<any>("SELECT id, name FROM accounts")).map((a) => [a.name, a.id]));
    const missing = [...new Set(pack.proposedEntries.flatMap((e) => e.lines.map((l) => l.account)).filter((n) => !accts.has(n)))];
    if (missing.length) return res.status(400).json({ error: `Unknown accounts in proposed entries (import the ledger first): ${missing.join(", ")}` });
    await db.tx(async (q) => {
      for (const f of pack.findings) await q(`INSERT INTO findings (code, title, severity, area, detail, impact, recommendation, owner, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (code) DO UPDATE SET title=EXCLUDED.title, severity=EXCLUDED.severity, area=EXCLUDED.area, detail=EXCLUDED.detail, impact=EXCLUDED.impact, recommendation=EXCLUDED.recommendation, updated_at=now()`,
        [f.code ?? null, f.title, f.severity, f.area, f.detail, f.impact ?? null, f.recommendation ?? null, f.owner ?? null, f.dueDate ?? null]);
      for (const x of pack.questions) await q("INSERT INTO questions (code, topic, question, why) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO UPDATE SET topic=EXCLUDED.topic, question=EXCLUDED.question, why=EXCLUDED.why", [x.code, x.topic, x.question, x.why ?? null]);
      for (const e of pack.proposedEntries) {
        await q("DELETE FROM journal_entries WHERE ref = $1 AND kind = 'proposed'", [e.ref]);
        await postEntry(q, { date: e.date, ref: e.ref, memo: e.memo, source: "review-pack", kind: "proposed", userId: req.user!.id,
          lines: e.lines.map((l) => ({ accountId: accts.get(l.account)!, debit: l.debit, credit: l.credit, description: l.description })) });
      }
    });
    await log(req, "review-pack", { findings: pack.findings.length, questions: pack.questions.length, proposed: pack.proposedEntries.length });
    res.json({ ok: true, findings: pack.findings.length, questions: pack.questions.length, proposedEntries: pack.proposedEntries.length });
  }));

  // ------------------------------------------------------------------ import
  r.post("/import", requireRole("accountant"), upload.single("file"), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!/\.xlsx$/i.test(req.file.originalname)) return res.status(400).json({ error: "Please upload an .xlsx workbook" });
    const result = await importWorkbook(db, req.file.buffer, req.file.originalname.replace(/[^\w .'()-]/g, "_"), { dryRun: req.query.dryRun === "1", userId: req.user!.id });
    res.json(result);
  }));
  r.delete("/imports/:id", requireRole("partner"), wrap(async (req, res) => {
    await db.query("DELETE FROM import_batches WHERE id = $1", [Number(req.params.id)]);
    await log(req, "import.delete", { id: Number(req.params.id) }); res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ Sales Flow Pro (revenue source)
  r.get("/sfp/status", wrap(async (_req, res) => {
    const { lastSync, lines } = await loadSfpLines(db);
    res.json({ configured: !!process.env.SFP_DATABASE_URL, lastSync, campaigns: lines.length });
  }));
  r.post("/sfp/sync", requireRole("accountant"), wrap(async (req, res) => {
    const snapshot = await readSfpFromEnv();
    await storeSnapshot(db, snapshot);
    await log(req, "sfp.sync", { campaigns: snapshot.campaigns.length, payments: snapshot.payments.length });
    res.json({ ok: true, campaigns: snapshot.campaigns.length, payments: snapshot.payments.length, targets: snapshot.targets.length });
  }));
  r.get("/sfp/revenue", wrap(async (req, res) => {
    const s = await snap(req); const asOf = await asOfOf(req, s);
    const fy = Number(req.query.fy) || fiscalYearOf(asOf);
    const { lines, lastSync, settings } = await loadSfpLines(db);
    const sales = new Map<string, number>();
    for (const l of s.lines) if (l.account.system_role === "revenue") sales.set(l.date.slice(0, 7), (sales.get(l.date.slice(0, 7)) ?? 0) + fromUnits(l.cr - l.dr));
    const rec = await reconcile(db, lines, fy, sales, settings.clientAliases ?? {}, today(req));
    const { from, to } = fyRange(fy);
    const targets = (await db.query<any>("SELECT data FROM sfp_targets")).map((t) => (typeof t.data === "string" ? JSON.parse(t.data) : t.data));
    res.json({ lastSync, settings, booksTo: asOf, ...rec,
      campaigns: lines.filter((l) => l.month >= from.slice(0, 7) && l.month <= to.slice(0, 7)).sort((a, b) => (a.month < b.month ? 1 : -1)),
      unbookedMonths: rec.byMonth.filter((m) => m.month > asOf.slice(0, 7) && m.month <= today(req).slice(0, 7) && m.revenue > 0).map((m) => m.month),
      targets });
  }));
  r.post("/sfp/accruals", requireRole("partner"), wrap(async (req, res) => {
    const b = z.object({ fys: z.array(z.number().int()).min(1).max(5) }).parse(req.body);
    const s = await snap(req);
    const { lines, settings } = await loadSfpLines(db);
    const sales = new Map<string, number>();
    for (const l of s.lines) if (l.account.system_role === "revenue") sales.set(l.date.slice(0, 7), (sales.get(l.date.slice(0, 7)) ?? 0) + fromUnits(l.cr - l.dr));
    const items = [];
    for (const fy of b.fys) items.push(...(await reconcile(db, lines, fy, sales, settings.clientAliases ?? {}, today(req))).notInvoiced);
    const r2 = await proposeAccruals(db, items, today(req), req.user!.id);
    await log(req, "sfp.accruals", { ...r2, fys: b.fys }); res.json(r2);
  }));

  // ------------------------------------------------------------------ campaign cash folders (received / paid)
  r.get("/campaign-cash", wrap(async (_req, res) => {
    const rows = await db.query<any>("SELECT c.*, u.full_name AS created_by_name FROM campaign_cash c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.entry_date DESC, c.id DESC");
    const { lines, settings: sfpSet } = await loadSfpLines(db);
    // One row per campaign (retainer months roll up to their campaign).
    const camp = new Map<string, any>();
    const thisMonth = today(_req).slice(0, 7);
    for (const l of lines) {
      if (l.month > thisMonth) continue; // future retainer months are not yet due
      const id = l.id.split(":")[0];
      const c = camp.get(id) ?? { id, code: l.code, client: l.client, source: l.source, status: l.status, firstMonth: l.month, lastMonth: l.month, campaignValue: 0, revenue: 0, jazzShare: 0, toneperksShare: 0, received: 0, withheld: 0, paid: 0 };
      c.campaignValue += l.campaignValue; c.revenue += l.revenue; c.jazzShare += l.source === "callperks_sourced" ? l.platformFee : 0; c.toneperksShare += l.toneperksShare;
      if (l.month < c.firstMonth) c.firstMonth = l.month; if (l.month > c.lastMonth) c.lastMonth = l.month;
      camp.set(id, c);
    }
    for (const e of rows) { const c = camp.get(e.campaign_id); if (c) { c[e.kind] += Number(e.amount); if (e.kind === "received") c.withheld += Number(e.withheld || 0); } }
    // Invoice total: the actual invoice in the books where the campaign was billed, else revenue + sales tax.
    const { matches } = await matchCampaigns(db, lines, sfpSet.clientAliases ?? {});
    const gross = new Map((await db.query<any>("SELECT id, gross_amount FROM invoices")).map((i) => [i.id, Number(i.gross_amount)]));
    const perInvoice = new Map<number, number>();
    for (const l of lines) { const m = matches.get(l.id); if (m) perInvoice.set(m.id, (perInvoice.get(m.id) ?? 0) + l.revenue); }
    for (const l of lines) {
      if (l.month > thisMonth) continue;
      const c = camp.get(l.id.split(":")[0]); if (!c) continue;
      const m = matches.get(l.id);
      const share = m ? l.revenue / (perInvoice.get(m.id) || l.revenue || 1) : 0;
      c.invoiceTotal = (c.invoiceTotal ?? 0) + (m ? ((m.gross ?? gross.get(m.id)) ?? 0) * share : l.revenue * (1 + sfpSet.gstRate));
      if (l.billedByJazz) c.billedByJazz = true;
      if (m) c.invoiced = true;
    }
    res.json({
      gstRate: sfpSet.gstRate,
      entries: rows.map((e) => ({ ...e, entry_date: isoDate(e.entry_date), amount: Number(e.amount), withheld: Number(e.withheld || 0) })),
      campaigns: [...camp.values()].filter((c) => c.revenue > 0 || c.received > 0 || c.paid > 0)
        .map((c) => ({ ...c, invoiceTotal: c.invoiceTotal ?? 0, toCollect: (c.invoiceTotal ?? 0) - c.received - c.withheld, toPay: c.jazzShare - c.paid }))
        .sort((a, b) => (a.lastMonth < b.lastMonth ? 1 : -1)),
    });
  }));
  r.post("/campaign-cash", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ campaignId: z.string().min(1).max(80), kind: z.enum(["received", "paid"]), date: zDate, amount: z.number().positive(), withheld: z.number().min(0).default(0),
      counterparty: z.string().max(120).optional().nullable(), reference: z.string().max(120).optional().nullable(), note: z.string().max(500).optional().nullable() }).parse(req.body);
    const [{ n }] = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM sfp_campaigns WHERE id = $1", [b.campaignId]);
    if (n === "0") return res.status(400).json({ error: "Unknown campaign — sync Sales Flow Pro first" });
    await db.query("INSERT INTO campaign_cash (campaign_id, kind, entry_date, amount, withheld, counterparty, reference, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [b.campaignId, b.kind, b.date, b.amount, b.kind === "received" ? b.withheld : 0, b.counterparty ?? null, b.reference ?? null, b.note ?? null, req.user!.id]);
    await log(req, "campaign_cash.add", b); res.json({ ok: true });
  }));
  r.post("/campaign-cash/prefill", requireRole("partner"), wrap(async (req, res) => {
    const { lines, settings } = await loadSfpLines(db);
    if (!lines.length) return res.status(400).json({ error: "Sync Sales Flow Pro first" });
    const r2 = await prefillReceived(db, lines, settings.clientAliases ?? {}, req.user!.id);
    await log(req, "campaign_cash.prefill", { entries: r2.entries, received: r2.received }); res.json(r2);
  }));
  r.delete("/campaign-cash/:id", requireRole("accountant"), wrap(async (req, res) => {
    await db.query("DELETE FROM campaign_cash WHERE id = $1", [Number(req.params.id)]);
    await log(req, "campaign_cash.delete", { id: Number(req.params.id) }); res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ source documents (issued invoices, receipts, Jazz release orders)
  r.get("/invoice-docs", wrap(async (_req, res) => {
    const docs = await loadDocs(db);
    const invoices = await db.query<any>("SELECT * FROM invoices WHERE coalesce(status,'') <> 'cancelled' ORDER BY invoice_date, id");
    const { lines, settings } = await loadSfpLines(db);
    const { matches } = await matchCampaigns(db, lines, settings.clientAliases ?? {});
    res.json({
      docs: docRegister(docs, invoices, lines, new Map([...matches].map(([k, m]) => [k, m.id]))),
      invoices: invoices.map((i) => ({ id: i.id, number: i.number, client: i.client, date: isoDate(i.invoice_date), net: Number(i.net_amount) })),
      campaigns: lines.map((l) => ({ id: l.id, client: l.client, code: l.code, month: l.month, value: l.campaignValue, revenue: l.revenue, source: l.source })),
    });
  }));
  const zDoc = z.object({ kind: z.enum(["invoice", "receipt", "jazz_billed"]), docNo: z.string().max(40).nullable().optional(), docDate: zDate.nullable().optional(),
    client: z.string().min(1).max(160), billedTo: z.string().max(200).nullable().optional(), campaignPeriod: z.string().max(200).nullable().optional(),
    net: z.number().min(0).default(0), gst: z.number().min(0).default(0), gross: z.number().min(0).default(0),
    booksNumber: z.string().max(40).nullable().optional(), booksClient: z.string().max(160).nullable().optional(),
    campaignIds: z.array(z.string().max(80)).max(40).default([]), title: z.string().max(300).nullable().optional(),
    url: z.string().max(500).regex(/^https:\/\//).nullable().optional(), note: z.string().max(1000).nullable().optional() });
  r.post("/invoice-docs/import", requireRole("partner"), wrap(async (req, res) => {
    const b = z.object({ docs: z.array(zDoc).max(500), replace: z.boolean().default(false) }).parse(req.body);
    await db.tx(async (q) => {
      if (b.replace) await q("DELETE FROM invoice_docs");
      for (const d of b.docs) await q(DOC_INSERT, DOC_ROW(d));
    });
    await log(req, "invoice_docs.import", { docs: b.docs.length, replace: b.replace }); res.json({ ok: true, docs: b.docs.length });
  }));
  r.patch("/invoice-docs/:id", requireRole("accountant"), wrap(async (req, res) => {
    const b = z.object({ booksNumber: z.string().max(40).nullable().optional(), booksClient: z.string().max(160).nullable().optional(),
      campaignIds: z.array(z.string().max(80)).max(40).optional(), note: z.string().max(1000).nullable().optional() }).parse(req.body);
    const id = Number(req.params.id);
    const sets: string[] = []; const vals: unknown[] = [];
    if (b.booksNumber !== undefined) { vals.push(b.booksNumber); sets.push(`books_number = $${vals.length}`); }
    if (b.booksClient !== undefined) { vals.push(b.booksClient); sets.push(`books_client = $${vals.length}`); }
    if (b.campaignIds !== undefined) { vals.push(JSON.stringify(b.campaignIds)); sets.push(`campaign_ids = $${vals.length}::jsonb`); }
    if (b.note !== undefined) { vals.push(b.note); sets.push(`note = $${vals.length}`); }
    if (sets.length) { vals.push(id); await db.query(`UPDATE invoice_docs SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals); }
    await log(req, "invoice_docs.update", { id, ...b }); res.json({ ok: true });
  }));
  r.delete("/invoice-docs/:id", requireRole("partner"), wrap(async (req, res) => {
    await db.query("DELETE FROM invoice_docs WHERE id = $1", [Number(req.params.id)]);
    await log(req, "invoice_docs.delete", { id: Number(req.params.id) }); res.json({ ok: true });
  }));
  /** Proposed journal entries for issued invoices that are missing from the books (replacing any SFP accrual for the same campaign-month). */
  r.post("/invoice-docs/propose", requireRole("partner"), wrap(async (req, res) => {
    const docs = await loadDocs(db);
    const invoices = await db.query<any>("SELECT * FROM invoices WHERE coalesce(status,'') <> 'cancelled'");
    const { lines } = await loadSfpLines(db);
    const accts = new Map((await db.query<any>("SELECT id, system_role FROM accounts WHERE system_role IS NOT NULL")).map((a) => [a.system_role, a.id]));
    const miss = ["receivable", "revenue", "sales_tax_payable", "platform_fee", "jazz_payable"].filter((k) => !accts.has(k));
    if (miss.length) return res.status(400).json({ error: `Import the accounts first (missing account roles: ${miss.join(", ")})` });
    // missing from the books, or booked at nil value
    const todo = docs.filter((d) => { const b = d.kind === "invoice" && d.docDate && d.net > 0 ? resolveBooks(d, invoices) : undefined; return b === null || (b && Number(b.net_amount) === 0); });
    const out = await db.tx(async (q) => {
      await q("DELETE FROM journal_entries WHERE kind = 'proposed' AND source = 'doc-invoice'");
      let accrualsRemoved = 0;
      for (const d of todo) {
        const ls = linkedLines(d, lines);
        const value = ls.reduce((a, l) => a + l.revenue, 0);
        const fee = value ? ls.reduce((a, l) => a + l.platformFee, 0) * (d.net / value) : 0;
        const jl: any[] = [
          { accountId: accts.get("receivable"), debit: d.gross || d.net + d.gst, credit: 0, description: `Invoice #${d.docNo ?? "–"} ${d.client}` },
          { accountId: accts.get("revenue"), debit: 0, credit: d.net, description: d.campaignPeriod ?? null },
        ];
        if (d.gst > 0) jl.push({ accountId: accts.get("sales_tax_payable"), debit: 0, credit: d.gst, description: "Output sales tax" });
        const diff = Math.round(((d.gross || d.net + d.gst) - d.net - d.gst) * 100) / 100;
        if (Math.abs(diff) >= 0.01) jl.push({ accountId: accts.get("revenue"), debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, description: "Rounding on invoice" });
        if (fee > 0.5) jl.push({ accountId: accts.get("platform_fee"), debit: Math.round(fee * 100) / 100, credit: 0, description: "Jazz share" },
          { accountId: accts.get("jazz_payable"), debit: 0, credit: Math.round(fee * 100) / 100, description: "Jazz share" });
        // revenue belongs to the month the campaign ran when the invoice is dated later
        const served = ls.length ? ls.map((l) => monthEnd(l.month)).sort().at(-1)! : d.docDate!;
        await postEntry(q, { date: served < d.docDate! ? served : d.docDate!, ref: `INV-${d.docNo ?? d.id}`, memo: `Invoice issued but not in the books: #${d.docNo ?? "–"} ${d.client} (${d.campaignPeriod ?? ""})`, source: "doc-invoice", kind: "proposed", userId: req.user!.id, lines: jl });
        for (const l of ls) {
          const r2 = await q<any>("DELETE FROM journal_entries WHERE kind = 'proposed' AND source = 'sfp-accrual' AND ref = $1 RETURNING id", [`SFP-${l.code ?? l.id.slice(0, 8)}-${l.month}`]);
          accrualsRemoved += r2.length;
        }
      }
      return { entries: todo.length, revenue: todo.reduce((a, d) => a + d.net, 0), salesTax: todo.reduce((a, d) => a + d.gst, 0), accrualsRemoved };
    });
    await log(req, "invoice_docs.propose", out); res.json(out);
  }));

  // ------------------------------------------------------------------ partners & settings
  r.patch("/partners/:id", requireRole("partner"), wrap(async (req, res) => {
    const b = z.object({ ratio: z.number().min(0).max(1).optional(), committed_capital: z.number().min(0).optional(), aka: z.string().nullable().optional() }).parse(req.body);
    const id = Number(req.params.id);
    for (const [k, v] of Object.entries(b)) await db.query(`UPDATE partners SET ${k} = $2 WHERE id = $1`, [id, v]);
    await log(req, "partner.update", { id, ...b }); res.json({ ok: true });
  }));
  r.get("/settings/:key", wrap(async (req, res) => {
    const defs: Record<string, unknown> = { tax: DEFAULT_TAX, cashplan: DEFAULT_CASHPLAN, company: { name: "TonePerks LLP" }, sfp: DEFAULT_SFP };
    if (!(req.params.key in defs)) return res.status(404).json({ error: "Unknown setting" });
    res.json(await getSetting(db, req.params.key, defs[req.params.key]));
  }));
  r.put("/settings/:key", requireRole("partner"), wrap(async (req, res) => {
    const key = req.params.key;
    if (!["tax", "cashplan", "company", "sfp"].includes(key)) return res.status(404).json({ error: "Unknown setting" });
    if (typeof req.body !== "object" || req.body === null) return res.status(400).json({ error: "Invalid body" });
    await putSetting(db, key, req.body); await log(req, "settings.update", { key }); res.json({ ok: true });
  }));
  r.get("/audit-log", requireRole("partner"), wrap(async (_req, res) => res.json(await db.query("SELECT a.*, u.full_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 300"))));

  void toUnits;
  return r;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: "Invalid input", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  if (err?.code === "23505") return res.status(409).json({ error: "That record already exists" });
  const msg = typeof err?.message === "string" && err.message.length < 300 ? err.message : "Unexpected error";
  console.error("[api]", err?.stack ?? err);
  res.status(err?.status ?? 500).json({ error: msg });
}
