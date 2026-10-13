import React, { useState } from "react";
import { api, useApi, useMut, qs } from "../api";
import { usePeriod } from "../App";
import { Button, Callout, Card, Loading, Modal, Money, Field } from "../components/ui";
import { dmy, pct, pkr } from "../format";

export default function Partners() {
  const { fy, proposed, meta } = usePeriod();
  const q = useApi<any>(`/reports/partners${qs({ fy, proposed })}`, [fy, proposed]);
  const [edit, setEdit] = useState<any>(null);
  if (!q.data) return <Loading q={q} />;
  const d = q.data;
  const tot = (k: string) => d.rows.reduce((a: number, r: any) => a + (r[k] || 0), 0);
  const cols: [string, string][] = [["opening", "Opening"], ["profit", "Profit / (loss) allocated"], ["salary", "Salary credited"], ["expensesOnBehalf", "Expenses paid for firm"], ["cashWithdrawn", "Cash paid to partner"], ["cashIntroduced", "Cash introduced"], ["other", "Other"], ["closing", "Closing"]];
  const isPartner = meta?.user?.role === "partner";
  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold tracking-tight">Partners</h1><p className="text-sm text-muted-foreground">Current account movements {dmy(d.from)} – {dmy(d.to)}. Credit balance = owed to the partner; negative = partner owes the firm.</p></div>
      <Callout tone="info">Movements are classified from the double-entry ledger by counter-account: profit allocation (from the profit-transfer account), salary (from payroll), cash (from the bank) and expenses paid personally on the firm's behalf.</Callout>
      <Card pad={false} title="Current accounts">
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Partner</th><th className="num">Ratio</th>{cols.map(([, l]) => <th key={l} className="num">{l}</th>)}</tr></thead>
          <tbody>
            {d.rows.map((r: any) => <tr key={r.partner}><td className="font-medium">{r.partner}</td><td className="num">{pct(r.ratio ?? r.impliedRatio)}</td>{cols.map(([k]) => <td key={k} className={`num ${k === "closing" ? "font-semibold" : ""}`}><Money v={k === "cashWithdrawn" ? -r[k] : r[k]} colored={k === "closing"} /></td>)}</tr>)}
            <tr className="total"><td>Total</td><td></td>{cols.map(([k]) => <td key={k} className="num"><Money v={k === "cashWithdrawn" ? -tot(k) : tot(k)} /></td>)}</tr>
          </tbody>
        </table></div>
      </Card>
      <Card pad={false} title="Profit-sharing ratios and capital">
        <table className="tbl"><thead><tr><th>Partner</th><th>Also known as</th><th className="num">Profit share</th><th className="num">Committed capital</th><th></th></tr></thead>
          <tbody>{d.partners.map((p: any) => <tr key={p.id}><td className="font-medium">{p.name}</td><td>{p.aka ?? "–"}</td><td className="num">{pct(p.ratio)}</td><td className="num"><Money v={p.committed_capital || null} /></td><td>{isPartner && <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Edit</Button>}</td></tr>)}
            <tr className="total"><td>Total</td><td></td><td className="num">{pct(d.partners.reduce((a: number, p: any) => a + p.ratio, 0))}</td><td className="num"><Money v={d.partners.reduce((a: number, p: any) => a + p.committed_capital, 0)} /></td><td></td></tr></tbody></table>
      </Card>
      {edit && <EditPartner p={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function EditPartner({ p, onClose }: { p: any; onClose: () => void }) {
  const [ratio, setRatio] = useState(String(p.ratio)); const [cap, setCap] = useState(String(p.committed_capital)); const [aka, setAka] = useState(p.aka ?? "");
  const m = useMut((b: any) => api(`/partners/${p.id}`, { method: "PATCH", body: b }));
  return (
    <Modal title={`Edit ${p.name}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Profit share (fraction, e.g. 0.414)"><input className="input w-full" value={ratio} onChange={(e) => setRatio(e.target.value)} /></Field>
        <Field label="Committed capital (PKR)"><input className="input w-full" value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
        <Field label="Also known as"><input className="input w-full" value={aka} onChange={(e) => setAka(e.target.value)} /></Field>
        <p className="text-xs text-muted-foreground">Changing the ratio here does not re-allocate profit already posted; it is used for checks and future allocations. Make sure all partners total 100%.</p>
        <div className="flex justify-end"><Button onClick={() => m.mutate({ ratio: Number(ratio), committed_capital: Number(cap), aka: aka || null }, { onSuccess: onClose })}>Save</Button></div>
      </div>
    </Modal>
  );
}
