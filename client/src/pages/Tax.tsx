import React, { useState } from "react";
import { api, useApi, useMut, qs } from "../api";
import { usePeriod } from "../App";
import { Badge, Button, Callout, Card, Field, Loading, Modal, Money, Stat, Toggle } from "../components/ui";
import { dmy, pct, pkr } from "../format";

export default function Tax() {
  const { fy, proposed } = usePeriod();
  const q = useApi<any>(`/tax${qs({ ty: fy, proposed })}`, [fy, proposed]);
  const [edit, setEdit] = useState(false);
  if (!q.data) return <Loading q={q} />;
  const { position: p, previous, advanceTax, liabilities, settings } = q.data;
  const c = p.computation;
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div><h1 className="text-2xl font-bold tracking-tight">Tax — TY{p.taxYear}</h1>
          <p className="text-sm text-muted-foreground">Income year {dmy(p.period.from)} – {dmy(p.period.to)}{p.period.complete ? "" : ` (${p.period.months} months to date)`} · AOP / LLP</p></div>
        <Button variant="secondary" onClick={() => setEdit(true)}>Tax rates &amp; treatment</Button>
      </div>
      {!p.rules.verified && <Callout tone="warn" title="Rates not yet verified by your tax adviser">{p.rules.source}. Mark them verified in "Tax rates &amp; treatment" once confirmed.</Callout>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Accounting profit before tax" value={<Money v={c.accountingProfit} compact />} />
        <Stat label="Tax at configured rates" value={<Money v={c.totalTax} compact />} tone="bad" sub={`Effective ${pct(c.effectiveRate)} of taxable income`} />
        <Stat label="Tax booked in accounts" value={<Money v={p.bookedTaxExpense} compact />} sub={p.accountantMethodTax !== null ? `Accountant's 35% table: ${pkr(p.accountantMethodTax, { compact: true })}` : undefined} />
        <Stat label={p.period.complete ? "Under-provision" : "Annualised full-year tax"} value={<Money v={p.period.complete ? p.understatement : p.annualisedEstimate?.totalTax} compact />} tone="bad" />
      </div>
      <div className="grid lg:grid-cols-2 gap-6">
        <Card title="Income tax computation" subtitle={`Rates: ${p.rules.source}`}>
          <table className="tbl"><tbody>
            <tr><td>Accounting profit before tax</td><td className="num"><Money v={c.accountingProfit} /></td></tr>
            {c.addBacks.map((a: any) => <tr key={a.label}><td className="pl-6">Add: {a.label}</td><td className="num"><Money v={a.amount} /></td></tr>)}
            {c.deductions.map((a: any) => <tr key={a.label}><td className="pl-6">Less: {a.label}</td><td className="num"><Money v={-a.amount} /></td></tr>)}
            <tr className="total"><td>Taxable income</td><td className="num"><Money v={c.taxableIncome} /></td></tr>
            <tr><td className="pl-6">Tax on slabs</td><td className="num"><Money v={c.normalTax} /></td></tr>
            <tr><td className="pl-6">Surcharge s.4AB ({pct(p.rules.surchargeRate, 0)} of tax, income &gt; {pkr(p.rules.surchargeThreshold, { compact: true })})</td><td className="num"><Money v={c.surcharge} /></td></tr>
            <tr><td className="pl-6">Super tax s.4C</td><td className="num"><Money v={c.superTax} /></td></tr>
            <tr className="total"><td>Total tax liability</td><td className="num"><Money v={c.totalTax} /></td></tr>
            <tr><td className="pl-6">Less: tax withheld by customers in the year</td><td className="num"><Money v={-c.withholdingCredit} /></td></tr>
            <tr className="total"><td>Net tax payable with return</td><td className="num"><Money v={c.netPayable} /></td></tr>
          </tbody></table>
        </Card>
        <div className="space-y-6">
          <Card title="Prior year carried in the books" subtitle={`TY${previous.taxYear}`}>
            <table className="tbl"><tbody>
              <tr><td>Income tax liability per ledger at {dmy(q.data.asOf)}</td><td className="num"><Money v={previous.bookedLiabilityAsOf} /></td></tr>
              <tr><td>Tax recomputed at configured rates</td><td className="num"><Money v={previous.computation.totalTax} /></td></tr>
              <tr><td>Return due</td><td className="num">{dmy(previous.rules.returnDueDate)}</td></tr>
            </tbody></table>
          </Card>
          <Card pad={false} title={`Advance tax s.147 — TY${advanceTax.taxYear}`} subtitle={`Based on latest-year tax ${pkr(advanceTax.latestYearTax)} and turnover ${pkr(advanceTax.latestYearTurnover)}`}>
            <table className="tbl"><thead><tr><th>Quarter</th><th>Due</th><th className="num">Turnover</th><th className="num">WHT in qtr</th><th className="num">Instalment</th></tr></thead>
              <tbody>{advanceTax.quarters.map((x: any) => <tr key={x.quarter}><td>Q{x.quarter}{!x.complete && <span className="text-muted-foreground"> (open)</span>}</td><td>{dmy(x.dueDate)}</td><td className="num"><Money v={x.turnover} /></td><td className="num"><Money v={x.withheld} /></td><td className="num font-medium"><Money v={x.instalment} /></td></tr>)}</tbody></table>
          </Card>
        </div>
      </div>
      <Card pad={false} title="Tax balances in the ledger">
        <table className="tbl"><thead><tr><th>Account</th><th className="num">Balance</th><th>Unpaid since</th><th className="num">Days</th></tr></thead>
          <tbody>{liabilities.map((l: any) => <tr key={l.accountId}><td>{l.name}</td><td className="num"><Money v={l.balance} /></td><td>{dmy(l.oldestUnpaidSince)}</td><td className="num">{l.oldestDays ?? "–"}</td></tr>)}</tbody></table>
      </Card>
      {edit && <TaxSettings value={settings} onClose={() => setEdit(false)} />}
    </div>
  );
}

function TaxSettings({ value, onClose }: { value: any; onClose: () => void }) {
  const [v, setV] = useState<any>(JSON.parse(JSON.stringify(value)));
  const [ty, setTy] = useState<number>(v.rules[v.rules.length - 1].taxYear);
  const m = useMut((b: any) => api("/settings/tax", { method: "PUT", body: b }));
  const rule = v.rules.find((r: any) => r.taxYear === ty);
  const upd = (patch: any) => setV({ ...v, rules: v.rules.map((r: any) => (r.taxYear === ty ? { ...r, ...patch } : r)) });
  const updSlab = (i: number, k: string, val: string) => upd({ slabs: rule.slabs.map((s: any, j: number) => (j === i ? { ...s, [k]: val === "" ? null : Number(val) } : s)) });
  return (
    <Modal wide title="Tax rates & treatment" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-3 items-end">
          <Field label="Tax year"><select className="input" value={ty} onChange={(e) => setTy(Number(e.target.value))}>{v.rules.map((r: any) => <option key={r.taxYear} value={r.taxYear}>TY{r.taxYear}</option>)}</select></Field>
          <Button variant="secondary" size="sm" onClick={() => { const last = v.rules[v.rules.length - 1]; const n = { ...JSON.parse(JSON.stringify(last)), taxYear: last.taxYear + 1, verified: false, returnDueDate: `${last.taxYear + 1}-09-30`, advanceTaxDueDates: [`${last.taxYear}-09-25`, `${last.taxYear}-12-25`, `${last.taxYear + 1}-03-25`, `${last.taxYear + 1}-06-15`] }; setV({ ...v, rules: [...v.rules, n] }); setTy(n.taxYear); }}>Add next year</Button>
          <div className="flex-1" />
          <Toggle checked={rule.verified} onChange={(b) => upd({ verified: b })} label="Verified by tax adviser" />
        </div>
        <table className="tbl"><thead><tr><th>Up to (blank = no limit)</th><th>Fixed tax</th><th>Rate on excess</th><th>Excess over</th></tr></thead>
          <tbody>{rule.slabs.map((s: any, i: number) => <tr key={i}>
            <td><input className="input w-36" value={s.upTo ?? ""} onChange={(e) => updSlab(i, "upTo", e.target.value)} /></td>
            <td><input className="input w-32" value={s.fixed} onChange={(e) => updSlab(i, "fixed", e.target.value)} /></td>
            <td><input className="input w-20" value={s.rate} onChange={(e) => updSlab(i, "rate", e.target.value)} /></td>
            <td><input className="input w-32" value={s.over} onChange={(e) => updSlab(i, "over", e.target.value)} /></td></tr>)}</tbody></table>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Surcharge rate (fraction of tax)"><input className="input w-full" value={rule.surchargeRate} onChange={(e) => upd({ surchargeRate: Number(e.target.value) })} /></Field>
          <Field label="Surcharge threshold (taxable income)"><input className="input w-full" value={rule.surchargeThreshold} onChange={(e) => upd({ surchargeThreshold: Number(e.target.value) })} /></Field>
          <Field label="Return due date"><input type="date" className="input w-full" value={rule.returnDueDate} onChange={(e) => upd({ returnDueDate: e.target.value })} /></Field>
        </div>
        <Field label="Source / reference"><input className="input w-full" value={rule.source} onChange={(e) => upd({ source: e.target.value })} /></Field>
        <div className="border-t pt-3 space-y-2">
          <Toggle checked={v.treatPartnerSalaryAsInadmissible} onChange={(b) => setV({ ...v, treatPartnerSalaryAsInadmissible: b })} label="Add back partners' salaries (member remuneration) — confirm with adviser" />
          <Field label="Brought-forward loss claimed in TY2026 (only if TY2025 return was filed)"><input className="input w-48" value={v.carryForwardLossTY2026} onChange={(e) => setV({ ...v, carryForwardLossTY2026: Number(e.target.value) || 0 })} /></Field>
        </div>
        <div className="flex justify-end"><Button onClick={() => m.mutate(v, { onSuccess: onClose })}>Save</Button></div>
        <p className="text-xs text-muted-foreground">These settings drive the tax page, cash plan and audit checks. They do not post entries; to correct the provision in the books, post an adjusting journal.</p>
        <Badge tone="info">Sales tax is taken from the ledger as booked</Badge>
      </div>
    </Modal>
  );
}
