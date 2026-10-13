import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { openDb } from "../server/db";
import { readSfp, storeSnapshot, loadSfpLines, revenueLine, DEFAULT_SFP, normClient, reconcile, proposeAccruals } from "../server/sfp";

/** A stand-in with the Sales Flow Pro table layout (synthetic data only). */
async function fakeSfp() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id text primary key, name text);
    CREATE TABLE campaigns (id text primary key, campaign_code text, client_name text, type text, source text, status text, start_date date,
      revenue_pkr numeric, jazz_share_pkr numeric, callperks_share_pkr numeric, billing_type text, campaign_month int, campaign_year int, manager_id text);
    CREATE TABLE campaign_payments (id text primary key, campaign_id text, month int, year int, amount_pkr numeric);
    INSERT INTO users VALUES ('u1','Sales Person');
    INSERT INTO campaigns VALUES
      ('c1','C-1','Client X Pvt Ltd','Voice','CallPerks Sourced','Completed','2025-08-05',1000000,400000,600000,'Paid',8,2025,'u1'),
      ('c2','C-2','Wallet Co','RBT','Jazz Internal','Active','2025-08-01',40000000,36000000,4000000,'Paid',8,2025,null),
      ('c3','C-3','Promo Co','Voice','CallPerks Sourced','Completed','2025-09-01',500000,null,null,'FOC',9,2025,null),
      ('c4','C-4','Client X Private Limited','Voice','CallPerks Sourced','Active','2025-10-02',2000000,800000,1200000,'Paid',10,2025,'u1');
    INSERT INTO campaign_payments VALUES ('p1','c2',8,2025,4000000);`);
  return (s: string, p: unknown[] = []) => pg.query(s, p as any[]).then((r) => r.rows as any[]);
}

describe("Sales Flow Pro", () => {
  it("applies the revenue policy per source", () => {
    const cp = revenueLine({ id: 1, client_name: "A", source: "CallPerks Sourced", revenue_pkr: 1000, jazz_share_pkr: 400, callperks_share_pkr: 600, campaign_month: 1, campaign_year: 2026 }, DEFAULT_SFP);
    expect([cp.revenue, cp.platformFee, cp.month]).toEqual([1000, 400, "2026-01"]);
    const ji = revenueLine({ id: 2, client_name: "B", source: "Jazz Internal", revenue_pkr: 40000000, start_date: "2025-12-03" }, DEFAULT_SFP);
    expect([ji.revenue, ji.platformFee, ji.month]).toEqual([4000000, 0, "2025-12"]); // default 10% split
    const foc = revenueLine({ id: 3, client_name: "C", source: "CallPerks Sourced", revenue_pkr: 500, billing_type: "FOC", start_date: "2025-12-01" }, DEFAULT_SFP);
    expect(foc.revenue).toBe(0);
    expect(normClient("Ideas Pvt. Ltd")).toBe(normClient("IDEAS PRIVATE LIMITED"));
  });

  it("reads, snapshots, reconciles and proposes accruals", async () => {
    const snap = await readSfp(await fakeSfp());
    expect(snap.campaigns).toHaveLength(4);
    expect(snap.campaigns.find((c: any) => c.id === "c1").manager_name).toBe("Sales Person");
    const db = await openDb({ memory: true });
    await storeSnapshot(db, snap);
    const { lines } = await loadSfpLines(db);
    await db.query(`INSERT INTO invoices (number, invoice_date, client, net_amount, jazz_share) VALUES ('1','2025-08-10','Client X',1000000,400000)`);
    const rec = await reconcile(db, lines, 2026, new Map([["2025-08", 1000000]]));
    expect(rec.totals.sfpRevenue).toBe(1000000 + 4000000 + 0 + 2000000);
    const x = rec.byClient.find((c: any) => c.names.includes("Client X"));
    expect(x.difference).toBe(2000000); // October campaign not invoiced
    // accounts with the roles the accrual needs
    for (const [code, name, type, role] of [["1100", "Receivable", "asset", "receivable"], ["4000", "Sales", "income", "revenue"], ["2110", "Sales Tax Payable", "liability", "sales_tax_payable"], ["5000", "Platform Fee", "expense", "platform_fee"], ["2000", "Payable to Jazz", "liability", "jazz_payable"]])
      await db.query("INSERT INTO accounts (code, name, type, grp, fs_line, system_role) VALUES ($1,$2,$3,'g','f',$4)", [code, name, type, role]);
    const r = await proposeAccruals(db, lines, DEFAULT_SFP, "2025-09-30", "2025-10-31", null);
    expect(r.entries).toBe(1);
    const [{ dr, cr }] = await db.query<any>("SELECT sum(debit)::float AS dr, sum(credit)::float AS cr FROM journal_lines");
    expect(dr).toBeCloseTo(2000000 * 1.15 + 800000); expect(dr).toBeCloseTo(cr);
    const again = await proposeAccruals(db, lines, DEFAULT_SFP, "2025-09-30", "2025-10-31", null);
    expect(again.entries).toBe(1);
    const [{ n }] = await db.query<any>("SELECT count(*)::int AS n FROM journal_entries");
    expect(n).toBe(1); // re-running replaces, never duplicates
  });
});
