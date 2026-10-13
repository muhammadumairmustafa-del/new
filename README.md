# TonePerks Finance Platform

A ledger-based finance platform for TonePerks LLP. Every number on every screen is derived from a **double-entry general ledger**: imported from the external accountant's workbooks, plus manual and adjusting journals.

It replaces the earlier Replit portal, which computed statements in the browser from ad-hoc sums.

## What it does

| Area | What you get |
| --- | --- |
| **Dashboard** | Fiscal-year KPIs, monthly results, cash vs receivables, live audit findings and a 13-week cash forecast |
| **Financial statements** | P&L by month, balance sheet at each month-end (with an option to show partners' current accounts inside partners' funds), direct cash flow, trial balance. Excel pack export and print |
| **Revenue (Sales Flow Pro)** | Read-only sync of campaigns from Sales Flow Pro, with value, Jazz share and TonePerks share. Shows revenue by month and source, reconciles against the invoice register and the ledger by client, and proposes revenue accruals for months not yet in the books |
| **Cash & payment plan** | Every obligation (income tax, s.147 advance tax, salary and sales tax, payroll, Jazz share on collected and uncollected invoices, vendors, partner salaries) in priority order. Includes due dates, overdue days, a probability-weighted collections forecast and a weekly cash forecast with the funding gap. Due dates, amounts and deferrals can be adjusted |
| **Tax** | AOP income-tax computation with configurable slabs, s.4AB surcharge, super tax, add-backs and WHT credit. Compares against the tax booked; computes the s.147 advance-tax schedule |
| **Receivables** | Ageing by customer from the invoice register. Expected payment dates and collection probabilities feed the cash plan |
| **Partners** | Current-account movements, classified from the ledger (profit allocation, salary, cash withdrawn, expenses paid on the firm's behalf), plus ratios and capital |
| **Ledger & journals** | Chart of accounts, account ledgers with running balance and first-in-first-out ageing, journal search, new manual entries, proposed adjustments that can be toggled on or off and accepted |
| **Audit & questions** | Automated checks that re-run against the live ledger, a findings register, a Q&A list for open questions, and import of review packs (findings + questions + proposed entries) |
| **Import** | Upload the accountant's `.xlsx` (year-end `Journal Entries` sheet, or monthly/quarterly `Data_Journal` + `Data_Invoices`). Preview first; re-importing a period replaces earlier imported entries for those dates |
| **Security** | No default users (first run creates the partner account), scrypt passwords, httpOnly session cookies, partner/accountant/viewer roles enforced on the server, CSRF header check, login throttling, activity log |

## Running it

```bash
npm install
npm run dev        # API on :5000, web on :5173 (proxied)
# or
npm run build && npm start   # single server on $PORT (default 5000)
```

- **Database:** set `DATABASE_URL` to use PostgreSQL (Replit, Neon, Supabase…). Without it, the app uses an embedded PGlite database in `./.data/`. Back that folder up if you rely on it.
- **Sales Flow Pro:** set the `SFP_DATABASE_URL` secret (Replit → Secrets) to a **read-only** database user. The app opens the connection in read-only mode and never writes to Sales Flow Pro.
- **First visit:** you create the partner (admin) account. Then go to **Import accounts** and upload the FY2026 year-end workbook first, then the FY2027 period workbooks in date order.
- **Tests:** `npm test` runs on synthetic data only.

### Deploying on Replit

Import the GitHub repo, add a PostgreSQL database (which sets `DATABASE_URL`), set the run command to `npm run build && npm start`, and deploy.

## Data privacy

This repository contains **code only**. Accounting workbooks, exports and the local database are git-ignored and must never be committed. CNICs and bank account numbers are not imported.

## Tax rates

Defaults in `shared/tax.ts` are the non-salaried / AOP slabs plus the s.4AB surcharge as understood for TY2026–TY2027. They are marked **unverified** until your tax adviser confirms them in *Tax → Tax rates & treatment*. Return due dates (including extensions) are also set there.
