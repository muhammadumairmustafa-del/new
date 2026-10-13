import React, { useEffect, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { api, useApi, useMut, qs } from "../api";
import { usePeriod } from "../App";
import { Badge, Button, Callout, Card, Field, Loading, Modal, Money, Stat, Toggle } from "../components/ui";
import { dmy, pkr } from "../format";

const catTone: Record<string, string> = { statutory: "critical", payroll: "high", jazz: "medium", vendor: "low", partner: "info", other: "low" };

export default function CashPlan() {
  const { proposed } = usePeriod();
  const [weeks, setWeeks] = useState(13);
  const q = useApi<any>(`/cashplan${qs({ weeks, proposed })}`, [weeks, proposed]);
  const settings = useApi<any>("/settings/cashplan");
  const [edit, setEdit] = useState<any>(null);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const saveSettings = useMut((v: any) => api("/settings/cashplan", { method: "PUT", body: v }));
  if (!q.data || !settings.data) return <Loading q={q.data ? settings : q} />;
  const d = q.data; const s = d.summary;
  const setOverride = (key: string, ov: any) => saveSettings.mutate({ ...settings.data, overrides: { ...settings.data.overrides, [key]: { ...(settings.data.overrides[key] ?? {}), ...ov } } });
  const clearOverride = (key: string) => { const o = { ...settings.data.overrides }; delete o[key]; saveSettings.mutate({ ...settings.data, overrides: o }); };
  const chart = d.weeks.map((w: any) => ({ ...w, label: `W${w.week}`, outflowNeg: -w.outflow }));
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div><h1 className="text-2xl font-bold tracking-tight">Cash &amp; payment plan</h1>
          <p className="text-sm text-muted-foreground">Every obligation, by priority and due date, against cash and expected collections. Opening cash {d.bankBalanceOverride ? <>from your bank balance entry on <b>{dmy(d.startDate)}</b></> : <>from the ledger at <b>{dmy(d.asOf)}</b></>}.</p></div>
        <div className="flex gap-2">
          <select className="input" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[8, 13, 26, 52].map((w) => <option key={w} value={w}>{w} weeks</option>)}</select>
          <Button variant="secondary" onClick={() => setShowAssumptions(true)}>Assumptions</Button>
          <Button onClick={() => setAddOpen(true)}>Add obligation</Button>
        </div>
      </div>
      {!d.bankBalanceOverride && <Callout tone="warn" title="Books are behind">The ledger ends {dmy(d.asOf)}. Enter today's actual bank balance under <b>Assumptions</b> so the plan starts from reality.</Callout>}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat label="Cash available" value={<Money v={d.openingCash} compact />} sub={dmy(d.startDate)} />
        <Stat label="Due now (overdue + today)" value={<Money v={s.dueNow} compact />} tone="bad" sub={`of which taxes ${pkr(s.statutoryDueNow, { compact: true })}`} />
        <Stat label="Shortfall now" value={<Money v={s.shortfallNow} compact />} tone={s.shortfallNow > 0 ? "bad" : "good"} sub={`Taxes alone: ${pkr(s.statutoryShortfallNow, { compact: true })}`} />
        <Stat label="Expected collections" value={<Money v={s.expectedCollections} compact />} sub="probability-weighted, net of WHT" />
        <Stat label="Peak funding gap" value={<Money v={s.fundingGap} compact />} tone={s.fundingGap > 0 ? "bad" : "good"} sub={s.fundingGap > 0 ? `lowest in week ${d.minWeek}` : "cash never negative"} />
      </div>
      <Card title="Weekly forecast" subtitle="Bars: cash in / out per week. Line: closing cash">
        <div className="h-80"><ResponsiveContainer>
          <ComposedChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" fontSize={12} /><YAxis tickFormatter={(v) => pkr(v, { compact: true })} fontSize={12} width={60} />
            <Tooltip formatter={(v: number) => pkr(v)} labelFormatter={(l, x: any) => x?.[0]?.payload ? `${dmy(x[0].payload.from)} → ${dmy(x[0].payload.to)}` : l} /><Legend />
            <ReferenceLine y={0} stroke="#64748b" />
            <Bar dataKey="inflow" name="Collections" fill="#10b981" /><Bar dataKey="outflowNeg" name="Payments" fill="#f43f5e" />
            <Line dataKey="closing" name="Closing cash" stroke="#1f4f8a" strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer></div>
      </Card>
      <Card pad={false} title="Obligations in payment-priority order" subtitle="1 = statutory (penalties accrue) · 2 = staff & Jazz on collected cash · 3 = Jazz after collection · 4 = vendors · 5 = partners (discretionary)">
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>P</th><th>Obligation</th><th>Due</th><th className="num">Overdue</th><th className="num">Amount</th><th>Basis</th><th className="no-print"></th></tr></thead>
          <tbody>
            {d.items.map((i: any) => (
              <tr key={i.key} className={i.overdueDays > 0 ? "bg-rose-50/50" : ""}>
                <td><Badge tone={catTone[i.category]}>{i.priority}</Badge></td>
                <td className="font-medium">{i.title}{i.penaltyNote && <div className="text-xs text-rose-600 font-normal">{i.penaltyNote}</div>}</td>
                <td className="whitespace-nowrap">{dmy(i.dueDate)}</td>
                <td className="num">{i.overdueDays ? <span className="text-rose-600">{i.overdueDays}d</span> : "–"}</td>
                <td className="num font-medium"><Money v={i.amount} /></td>
                <td className="text-xs text-muted-foreground max-w-md">{i.basis}</td>
                <td className="no-print whitespace-nowrap">{!i.key.startsWith("manual_") && <Button size="sm" variant="ghost" onClick={() => setEdit(i)}>Adjust</Button>}</td>
              </tr>
            ))}
            <tr className="total"><td></td><td>Total</td><td></td><td></td><td className="num"><Money v={s.totalObligations} /></td><td colSpan={2}></td></tr>
          </tbody>
        </table></div>
        {d.excluded.length > 0 && <div className="px-4 py-3 text-xs text-muted-foreground">Excluded (paid/deferred): {d.excluded.map((x: any) => <button key={x.key} className="underline mr-3" onClick={() => clearOverride(x.key)}>{x.title} ({x.status}) ↺</button>)}</div>}
      </Card>
      <div className="grid lg:grid-cols-2 gap-6">
        <Card pad={false} title="Expected collections" subtitle="Set expected dates and probabilities on the Receivables page">
          <table className="tbl"><thead><tr><th>Expected</th><th>Customer</th><th className="num">Prob.</th><th className="num">Cash</th></tr></thead>
            <tbody>{d.collections.map((c: any, i: number) => <tr key={i}><td>{dmy(c.date)}</td><td>{c.client}</td><td className="num">{Math.round(c.probability * 100)}%</td><td className="num"><Money v={c.amount} /></td></tr>)}</tbody></table>
        </Card>
        <Card pad={false} title="Partners' current accounts" subtitle="Not a cash obligation until partners agree a distribution — pay only after statutory dues">
          <table className="tbl"><tbody>{d.partnersCurrentAccounts.map((p: any) => <tr key={p.name}><td>{p.name.replace("Payable to ", "")}</td><td className="num"><Money v={p.balance} colored /></td></tr>)}</tbody></table>
        </Card>
      </div>
      {edit && <EditItem item={edit} current={settings.data.overrides[edit.key]} onClose={() => setEdit(null)} onSave={(ov) => { setOverride(edit.key, ov); setEdit(null); }} onClear={() => { clearOverride(edit.key); setEdit(null); }} />}
      {showAssumptions && <Assumptions value={settings.data} onClose={() => setShowAssumptions(false)} onSave={(v) => { saveSettings.mutate(v); setShowAssumptions(false); }} />}
      {addOpen && <AddObligation onClose={() => setAddOpen(false)} />}
    </div>
  );
}

function EditItem({ item, current, onClose, onSave, onClear }: { item: any; current: any; onClose: () => void; onSave: (v: any) => void; onClear: () => void }) {
  const [dueDate, setDue] = useState(current?.dueDate ?? item.dueDate);
  const [amount, setAmt] = useState<string>(current?.amount !== undefined ? String(current.amount) : "");
  const [status, setStatus] = useState(current?.status ?? "open");
  const [note, setNote] = useState(current?.note ?? "");
  return (
    <Modal title={`Adjust: ${item.title}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Use this to plan, e.g. an instalment agreement with FBR, a negotiated date with Jazz, or a deferral agreed with partners. The ledger is not changed.</p>
        <Field label="Planned payment date"><input type="date" className="input w-full" value={dueDate} onChange={(e) => setDue(e.target.value)} /></Field>
        <Field label={`Amount (blank = ${pkr(item.amount)})`}><input className="input w-full" inputMode="numeric" value={amount} onChange={(e) => setAmt(e.target.value)} /></Field>
        <Field label="Status"><select className="input w-full" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="scheduled">Scheduled</option><option value="paid">Paid (exclude)</option><option value="deferred">Deferred (exclude)</option></select></Field>
        <Field label="Note"><input className="input w-full" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <div className="flex justify-between pt-2"><Button variant="ghost" onClick={onClear}>Reset</Button>
          <Button onClick={() => onSave({ dueDate, status, note: note || undefined, ...(amount.trim() ? { amount: Number(amount.replace(/,/g, "")) } : {}) })}>Save</Button></div>
      </div>
    </Modal>
  );
}

function Assumptions({ value, onClose, onSave }: { value: any; onClose: () => void; onSave: (v: any) => void }) {
  const [v, setV] = useState<any>(value);
  const [bal, setBal] = useState(value.bankBalanceOverride?.amount?.toString() ?? "");
  const [balDate, setBalDate] = useState(value.bankBalanceOverride?.date ?? new Date().toISOString().slice(0, 10));
  useEffect(() => setV(value), [value]);
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value === "" ? null : Number(e.target.value) });
  return (
    <Modal title="Cash plan assumptions" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Actual bank balance (PKR)"><input className="input w-full" inputMode="numeric" value={bal} onChange={(e) => setBal(e.target.value)} placeholder="leave blank to use ledger" /></Field>
          <Field label="As of"><input type="date" className="input w-full" value={balDate} onChange={(e) => setBalDate(e.target.value)} /></Field>
        </div>
        <Field label="Income tax basis"><select className="input w-full" value={v.incomeTaxBasis} onChange={(e) => setV({ ...v, incomeTaxBasis: e.target.value })}><option value="recomputed">Recomputed at configured rates (prudent)</option><option value="booked">As booked by the accountant</option></select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Default days to collect"><input type="number" className="input w-full" value={v.defaultCollectionDays} onChange={num("defaultCollectionDays")} /></Field>
          <Field label="Customer WHT on collection %"><input type="number" className="input w-full" value={v.withholdingOnCollectionPct} onChange={num("withholdingOnCollectionPct")} /></Field>
          <Field label="Pay Jazz N days after collection"><input type="number" className="input w-full" value={v.jazzPaysAfterCollectionDays} onChange={num("jazzPaysAfterCollectionDays")} /></Field>
          <Field label="Default surcharge % p.a."><input type="number" className="input w-full" value={v.defaultSurchargeRatePa} onChange={num("defaultSurchargeRatePa")} /></Field>
          <Field label="Staff payroll / month (blank = last month)"><input type="number" className="input w-full" value={v.staffPayrollMonthly ?? ""} onChange={num("staffPayrollMonthly")} /></Field>
          <Field label="Partner salaries / month (blank = last month)"><input type="number" className="input w-full" value={v.partnerSalariesMonthly ?? ""} onChange={num("partnerSalariesMonthly")} /></Field>
        </div>
        <Toggle checked={v.includePartnerSalaries} onChange={(b) => setV({ ...v, includePartnerSalaries: b })} label="Include partners' salaries as a cash outflow" />
        <div className="flex justify-end pt-2"><Button onClick={() => onSave({ ...v, bankBalanceOverride: bal.trim() ? { amount: Number(bal.replace(/,/g, "")), date: balDate } : null })}>Save</Button></div>
      </div>
    </Modal>
  );
}

function AddObligation({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ title: "", category: "other", amount: "", dueDate: new Date().toISOString().slice(0, 10), priority: 3, notes: "" });
  const [err, setErr] = useState<string | null>(null);
  const m = useMut((b: any) => api("/obligations", { body: b }));
  return (
    <Modal title="Add obligation" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Title"><input className="input w-full" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category"><select className="input w-full" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{["statutory", "payroll", "jazz", "vendor", "partner", "other"].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Priority (1 highest)"><input type="number" min={1} max={5} className="input w-full" value={f.priority} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })} /></Field>
          <Field label="Amount"><input className="input w-full" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Due date"><input type="date" className="input w-full" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        </div>
        <Field label="Notes"><input className="input w-full" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {err && <Callout tone="bad">{err}</Callout>}
        <div className="flex justify-end"><Button onClick={() => m.mutate({ ...f, amount: Number(f.amount.replace(/,/g, "")) }, { onSuccess: onClose, onError: (e: any) => setErr(e.message) })}>Add</Button></div>
      </div>
    </Modal>
  );
}
