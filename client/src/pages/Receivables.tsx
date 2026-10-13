import React, { useState } from "react";
import { api, useApi, useMut } from "../api";
import { Badge, Button, Callout, Card, Field, Loading, Modal, Money, Stat, Toggle } from "../components/ui";
import { dmy, pkr } from "../format";

export default function Receivables() {
  const q = useApi<any>("/receivables");
  const [edit, setEdit] = useState<any>(null);
  const [openOnly, setOpenOnly] = useState(true);
  if (!q.data) return <Loading q={q} />;
  const d = q.data;
  const rows = d.invoices.filter((i: any) => !openOnly || (i.outstanding > 1 && i.status !== "cancelled"));
  const ageTone = (a: number) => (a > 180 ? "critical" : a > 90 ? "high" : a > 60 ? "medium" : "low");
  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold tracking-tight">Receivables</h1><p className="text-sm text-muted-foreground">From the sales invoice register, aged at {dmy(d.asOf)}. Set expected payment dates here; they feed the cash plan.</p></div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Outstanding (register)" value={<Money v={d.totals.register} compact />} />
        <Stat label="Ledger control account" value={<Money v={d.totals.ledger} compact />} sub={Math.abs(d.totals.ledger - d.totals.register) > 1000 ? `Difference ${pkr(d.totals.ledger - d.totals.register)}` : "Agrees to register"} />
        <Stat label="Billed to date (incl. GST)" value={<Money v={d.totals.billed} compact />} />
        <Stat label="Collected to date" value={<Money v={d.totals.received} compact />} sub={`${((d.totals.received / Math.max(1, d.totals.billed)) * 100).toFixed(0)}% of billings`} />
      </div>
      <Card pad={false} title="Ageing by customer">
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Customer</th><th>Oldest invoice</th>{d.buckets.map((b: string) => <th key={b} className="num">{b} days</th>)}<th className="num">Total</th></tr></thead>
          <tbody>{d.byClient.map((c: any) => <tr key={c.client}><td className="font-medium">{c.client}</td><td>{dmy(c.oldest)}</td>{d.buckets.map((b: string) => <td key={b} className={`num ${c[b] && (b === "91-180" || b === "180+") ? "text-rose-600" : ""}`}><Money v={c[b] || null} /></td>)}<td className="num font-semibold"><Money v={c.total} /></td></tr>)}</tbody>
        </table></div>
      </Card>
      <Card pad={false} title="Invoices" actions={<Toggle checked={openOnly} onChange={setOpenOnly} label="Open only" />}>
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Campaign</th><th className="num">Net</th><th className="num">GST</th><th className="num">Jazz share</th><th className="num">Received</th><th className="num">Outstanding</th><th>Age</th><th>Expected</th><th></th></tr></thead>
          <tbody>{rows.map((i: any) => (
            <tr key={i.id}>
              <td className="text-muted-foreground">{i.number ?? "–"}</td><td className="whitespace-nowrap">{dmy(i.date)}</td><td className="font-medium">{i.client}{i.status && <> <Badge tone={i.status === "disputed" ? "critical" : "info"}>{i.status}</Badge></>}</td>
              <td className="text-xs text-muted-foreground max-w-[180px] truncate" title={i.campaignPeriod}>{i.campaignPeriod}</td>
              <td className="num"><Money v={i.net} /></td><td className="num"><Money v={i.gst} /></td><td className="num"><Money v={i.jazzShare || null} /></td><td className="num"><Money v={i.received || null} /></td>
              <td className="num font-medium"><Money v={i.outstanding} /></td>
              <td>{i.outstanding > 1 ? <Badge tone={ageTone(i.age)}>{i.age}d</Badge> : "–"}</td>
              <td className="whitespace-nowrap text-xs">{i.expectedDate ? `${dmy(i.expectedDate)} · ${i.probability}%` : "–"}</td>
              <td>{i.outstanding > 1 && <Button size="sm" variant="ghost" onClick={() => setEdit(i)}>Plan</Button>}</td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      {edit && <PlanInvoice inv={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PlanInvoice({ inv, onClose }: { inv: any; onClose: () => void }) {
  const [expectedDate, setDate] = useState(inv.expectedDate ?? "");
  const [probability, setP] = useState(inv.probability ?? 100);
  const [status, setStatus] = useState(inv.status ?? "");
  const [err, setErr] = useState<string | null>(null);
  const m = useMut((b: any) => api(`/invoices/${inv.id}`, { method: "PATCH", body: b }));
  return (
    <Modal title={`${inv.client} — invoice ${inv.number ?? ""}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Outstanding PKR {pkr(inv.outstanding)} since {dmy(inv.date)}.</p>
        <Field label="Expected payment date"><input type="date" className="input w-full" value={expectedDate} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={`Probability of collection: ${probability}%`}><input type="range" min={0} max={100} step={5} className="w-full" value={probability} onChange={(e) => setP(Number(e.target.value))} /></Field>
        <Field label="Status"><select className="input w-full" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">—</option><option value="confirmed">Balance confirmed by customer</option><option value="chasing">Chasing</option><option value="disputed">Disputed</option><option value="written_off">Written off</option></select></Field>
        {err && <Callout tone="bad">{err}</Callout>}
        <div className="flex justify-end"><Button onClick={() => m.mutate({ expectedDate: expectedDate || null, probability, status: status || null }, { onSuccess: onClose, onError: (e: any) => setErr(e.message) })}>Save</Button></div>
      </div>
    </Modal>
  );
}
