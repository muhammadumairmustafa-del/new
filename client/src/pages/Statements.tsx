import React, { useState } from "react";
import { Download, Printer } from "lucide-react";
import { useApi, qs } from "../api";
import { usePeriod } from "../App";
import { Button, Callout, Card, Loading, Money, Tabs, Toggle } from "../components/ui";
import { dmy, fyLabel, monthLabel } from "../format";

type Tab = "pl" | "bs" | "cf" | "tb";

export default function Statements() {
  const { fy, proposed } = usePeriod();
  const [tab, setTab] = useState<Tab>("pl");
  const [partnersInEquity, setPIE] = useState(false);
  const exportUrl = `/api/reports/export.xlsx${qs({ fy, proposed, partnersInEquity })}`;
  return (
    <div>
      <div className="flex items-end justify-between mb-4 gap-4 flex-wrap">
        <div><h1 className="text-2xl font-bold tracking-tight">Financial statements</h1><p className="text-sm text-muted-foreground">{fyLabel(fy)} · generated live from the double-entry ledger{proposed ? " · including proposed adjustments" : ""}</p></div>
        <div className="flex gap-2 no-print">
          <Button variant="secondary" onClick={() => window.print()}><Printer size={15} />Print</Button>
          <a href={exportUrl}><Button><Download size={15} />Excel pack</Button></a>
        </div>
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "pl", label: "Profit & loss" }, { id: "bs", label: "Balance sheet" }, { id: "cf", label: "Cash flow" }, { id: "tb", label: "Trial balance" }]} />
      {tab === "pl" && <PL fy={fy} proposed={proposed} />}
      {tab === "bs" && <BS fy={fy} proposed={proposed} pie={partnersInEquity} setPie={setPIE} />}
      {tab === "cf" && <CF fy={fy} proposed={proposed} />}
      {tab === "tb" && <TB fy={fy} proposed={proposed} />}
    </div>
  );
}

function Row({ label, values, cls, indent }: { label: string; values: number[]; cls?: string; indent?: boolean }) {
  return <tr className={cls}><td className={indent ? "pl-6" : ""}>{label}</td>{values.map((v, i) => <td key={i} className={`num ${i === values.length - 1 ? "font-medium bg-muted/50" : ""}`}><Money v={v} /></td>)}</tr>;
}

function PL({ fy, proposed }: { fy: number; proposed: boolean }) {
  const q = useApi<any>(`/reports/pl${qs({ fy, proposed })}`, [fy, proposed]);
  if (!q.data) return <Loading q={q} />;
  const d = q.data; const cols = [...d.months.map(monthLabel), "Total"];
  const rev = d.sections[0].total;
  const margin = d.profitBeforeTax.map((v: number, i: number) => (rev[i] ? v / rev[i] : 0));
  return (
    <Card pad={false} title="Statement of profit or loss" subtitle={`${dmy(d.from)} – ${dmy(d.to)}`}>
      <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th>Line item</th>{cols.map((c) => <th key={c} className="num">{c}</th>)}</tr></thead>
        <tbody>
          {d.sections.map((s: any) => s.lines.length === 0 ? null : (
            <React.Fragment key={s.key}>
              <tr className="section"><td colSpan={cols.length + 1}>{s.title}</td></tr>
              {s.lines.map((l: any) => <Row key={l.label} label={l.label} values={l.values} indent />)}
              {s.lines.length > 1 && <Row label={`Total ${s.title.toLowerCase()}`} values={s.total} cls="total" />}
              {s.key === "Cost of sales" && <Row label="Gross profit" values={d.grossProfit} cls="total" />}
              {s.key === "Finance cost" && <Row label="Profit / (loss) before tax" values={d.profitBeforeTax} cls="total" />}
            </React.Fragment>
          ))}
          {!d.sections.find((s: any) => s.key === "Finance cost")?.lines.length && <Row label="Profit / (loss) before tax" values={d.profitBeforeTax} cls="total" />}
          <Row label="Profit / (loss) after tax" values={d.profitAfterTax} cls="total" />
          <tr><td className="text-muted-foreground">Net margin before tax</td>{margin.map((m: number, i: number) => <td key={i} className="num text-muted-foreground">{(m * 100).toFixed(1)}%</td>)}</tr>
        </tbody>
      </table></div>
    </Card>
  );
}

function BS({ fy, proposed, pie, setPie }: { fy: number; proposed: boolean; pie: boolean; setPie: (b: boolean) => void }) {
  const q = useApi<any>(`/reports/bs${qs({ fy, proposed, partnersInEquity: pie })}`, [fy, proposed, pie]);
  if (!q.data) return <Loading q={q} />;
  const d = q.data;
  const sec = (title: string, s: any) => (<>
    <tr className="section"><td colSpan={d.dates.length + 1}>{title}</td></tr>
    {s.lines.map((l: any) => <tr key={l.label}><td className="pl-6">{l.label}</td>{l.values.map((v: number, i: number) => <td key={i} className="num"><Money v={v} /></td>)}</tr>)}
  </>);
  const tot = (label: string, vals: number[]) => <tr className="total"><td>{label}</td>{vals.map((v, i) => <td key={i} className="num"><Money v={v} /></td>)}</tr>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 no-print">
        <Toggle checked={pie} onChange={setPie} label="Show partners' current accounts within partners' funds (recommended)" />
      </div>
      {!pie && <Callout tone="info">As presented by the accountant, all accumulated profit sits in partners' current accounts and is shown as a current liability. Toggle above to see the economic position.</Callout>}
      <Card pad={false} title="Statement of financial position">
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Line item</th>{d.dates.map((x: string) => <th key={x} className="num">{dmy(x)}</th>)}</tr></thead>
          <tbody>
            {sec("Non-current assets", d.nonCurrentAssets)}
            {sec("Current assets", d.currentAssets)}
            {tot("TOTAL ASSETS", d.totalAssets)}
            {sec("Current liabilities", d.currentLiabilities)}
            {!pie && d.partnersCurrentAccounts.lines.map((l: any) => <tr key={l.label}><td className="pl-6">{l.label}</td>{l.values.map((v: number, i: number) => <td key={i} className="num"><Money v={v} /></td>)}</tr>)}
            {tot("Total liabilities", d.totalLiabilities)}
            <tr className="section"><td colSpan={d.dates.length + 1}>Partners' funds</td></tr>
            <tr><td className="pl-6">Share capital</td>{d.equity.shareCapital.map((v: number, i: number) => <td key={i} className="num"><Money v={v} /></td>)}</tr>
            <tr><td className="pl-6">Accumulated profit</td>{d.equity.accumulatedProfit.map((v: number, i: number) => <td key={i} className="num"><Money v={v} /></td>)}</tr>
            <tr><td className="pl-6">Profit transferred to partners' current accounts</td>{d.equity.profitTransferred.map((v: number, i: number) => <td key={i} className="num"><Money v={v} /></td>)}</tr>
            {pie && <tr><td className="pl-6">Partners' current accounts</td>{d.partnersCurrentAccounts.total.map((v: number, i: number) => <td key={i} className="num"><Money v={v} /></td>)}</tr>}
            {tot("Total partners' funds", d.equity.total)}
            <tr><td className="text-muted-foreground">Balance check (should be 0)</td>{d.check.map((v: number, i: number) => <td key={i} className={`num ${Math.abs(v) > 1 ? "text-rose-600 font-semibold" : "text-emerald-600"}`}>{Math.abs(v) > 1 ? v.toFixed(2) : "✓"}</td>)}</tr>
          </tbody>
        </table></div>
      </Card>
    </div>
  );
}

function CF({ fy, proposed }: { fy: number; proposed: boolean }) {
  const q = useApi<any>(`/reports/cf${qs({ fy, proposed })}`, [fy, proposed]);
  if (!q.data) return <Loading q={q} />;
  const d = q.data; const cols = [...d.months.map(monthLabel), "Total"];
  return (
    <Card pad={false} title="Cash flow — direct method" subtitle="Every bank movement classified by its counter-account">
      <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th></th>{cols.map((c) => <th key={c} className="num">{c}</th>)}</tr></thead>
        <tbody>
          <Row label="Opening bank balance" values={d.opening} cls="total" />
          <tr className="section"><td colSpan={cols.length + 1}>Cash in</td></tr>
          {d.inflows.map((r: any) => <Row key={r.label} label={r.label} values={r.values} indent />)}
          <tr className="section"><td colSpan={cols.length + 1}>Cash out</td></tr>
          {d.outflows.map((r: any) => <Row key={r.label} label={r.label} values={r.values} indent />)}
          <Row label="Net cash flow" values={d.net} cls="total" />
          <Row label="Closing bank balance" values={d.closing} cls="total" />
        </tbody>
      </table></div>
    </Card>
  );
}

function TB({ fy, proposed }: { fy: number; proposed: boolean }) {
  const q = useApi<any>(`/reports/tb${qs({ fy, proposed })}`, [fy, proposed]);
  if (!q.data) return <Loading q={q} />;
  const d = q.data;
  return (
    <Card pad={false} title="Trial balance" subtitle={`${dmy(d.from)} – ${dmy(d.to)} · positive = debit`}>
      <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th>Code</th><th>Account</th><th className="num">Opening</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Closing</th></tr></thead>
        <tbody>
          {d.rows.map((r: any) => <tr key={r.code}><td className="text-muted-foreground">{r.code}</td><td>{r.name}</td><td className="num"><Money v={r.opening} /></td><td className="num"><Money v={r.debit} /></td><td className="num"><Money v={r.credit} /></td><td className="num"><Money v={r.closing} /></td></tr>)}
          <tr className="total"><td></td><td>Total (must be zero)</td><td className="num"><Money v={d.totals.opening} /></td><td className="num"><Money v={d.totals.debit} /></td><td className="num"><Money v={d.totals.credit} /></td><td className="num"><Money v={d.totals.closing} /></td></tr>
        </tbody>
      </table></div>
    </Card>
  );
}
