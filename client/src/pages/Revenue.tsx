import React, { useMemo, useState } from "react";
import { RefreshCw, TrendingUp, Handshake, FileCheck2, AlertTriangle, FolderInput, FolderOutput, Trash2, ExternalLink, Pencil, FileText } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, useApi, useMut, qs } from "../api";
import { usePeriod } from "../App";
import { Badge, Button, Callout, Card, Field, Loading, Modal, Money, PageHeader, Stat, Tabs } from "../components/ui";
import { dmy, fyLabel, monthLabel, pkr } from "../format";

type Tab = "monthly" | "uninvoiced" | "reconcile" | "campaigns" | "cash" | "docs";
const SRC: Record<string, { label: string; color: string; tone: string }> = {
  callperks_sourced: { label: "TonePerks sourced", color: "hsl(160 75% 35%)", tone: "good" },
  jazz_sourced: { label: "Jazz sourced", color: "hsl(195 80% 40%)", tone: "info" },
  jazz_internal: { label: "Jazz internal", color: "hsl(30 80% 50%)", tone: "medium" },
};

export default function Revenue() {
  const { fy, meta } = usePeriod();
  const status = useApi<any>("/sfp/status");
  const q = useApi<any>(fy ? `/sfp/revenue${qs({ fy })}` : null, [fy]);
  const [tab, setTab] = useState<Tab>("monthly");
  const [msg, setMsg] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const sync = useMut(() => api("/sfp/sync", { method: "POST" }));
  const accrue = useMut(() => api("/sfp/accruals", { method: "POST", body: { fys: [fy] } }));
  const role = meta?.user?.role;
  const doSync = () => sync.mutate(undefined, { onSuccess: (r: any) => setMsg({ tone: "info", text: `Synced ${r.campaigns} campaigns and ${r.payments} payment records from Sales Flow Pro.` }), onError: (e: any) => setMsg({ tone: "bad", text: e.message }) });
  const doAccrue = () => accrue.mutate(undefined, { onSuccess: (r: any) => setMsg({ tone: "info", text: `${r.entries} proposed revenue accruals (PKR ${pkr(r.revenue)}) created for ${r.months.join(", ") || "no months"}. Review them in Ledger → Journal entries (Proposed).` }), onError: (e: any) => setMsg({ tone: "bad", text: e.message }) });
  const header = (
    <PageHeader title="Revenue" subtitle={<>Campaign revenue and Jazz / TonePerks split from Sales Flow Pro, reconciled to the books · {fyLabel(fy)}</>}
      actions={<>
        {status.data?.lastSync && <span className="text-xs text-muted-foreground">Last sync {dmy(status.data.lastSync.at)} {String(status.data.lastSync.at).slice(11, 16)}</span>}
        {role !== "viewer" && <Button variant="secondary" onClick={doSync} disabled={sync.isPending || !status.data?.configured}><RefreshCw size={15} className={sync.isPending ? "animate-spin" : ""} />Sync Sales Flow Pro</Button>}
        {role === "partner" && <Button onClick={doAccrue} disabled={accrue.isPending || !status.data?.campaigns}>Propose accruals for uninvoiced</Button>}
      </>} />);
  if (!status.data) return <Loading q={status} />;
  if (!status.data.campaigns) return (
    <div className="space-y-6">{header}
      {!status.data.configured
        ? <Callout tone="warn" title="Sales Flow Pro is not connected">Set the <code>SFP_DATABASE_URL</code> secret on the server (Replit: Secrets; never in code). Use a <b>read-only</b> database user. Then press Sync.</Callout>
        : <Callout tone="info" title="Ready to sync">The connection is configured. Press <b>Sync Sales Flow Pro</b> to load campaigns.</Callout>}
      {msg && <Callout tone={msg.tone}>{msg.text}</Callout>}
    </div>);
  if (!q.data) return <div className="space-y-6">{header}<Loading q={q} /></div>;
  const d = q.data; const t = d.totals;
  return (
    <div className="space-y-6">
      {header}
      {msg && <Callout tone={msg.tone}>{msg.text}</Callout>}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon={TrendingUp} tone="blue" label="Revenue per Sales Flow Pro" value={<Money v={t.sfpRevenue} compact />} sub={`${d.campaigns.length} campaigns in ${fyLabel(fy)}`} />
        <Stat icon={FileCheck2} tone="good" label="Invoiced (register)" value={<Money v={t.invoiced} compact />} sub={`Booked in ledger ${pkr(t.booked, { compact: true })}`} />
        <Stat icon={AlertTriangle} tone={t.notInvoiced > 1000 ? "warn" : "good"} label="Campaigns with no invoice" value={<Money v={t.notInvoiced} compact />} sub={`${d.notInvoiced.length} campaign-months · SFP minus register ${pkr(t.sfpRevenue - t.invoiced, { compact: true })}`} />
        <Stat icon={Handshake} tone="warn" label="Jazz share per Sales Flow Pro" value={<Money v={t.sfpPlatformFee} compact />} sub={`In the register: ${pkr(t.invoicedJazz, { compact: true })}`} />
      </div>
      {d.unbookedMonths.length > 0 && <Callout tone="info" title="Months not yet in the books">{d.unbookedMonths.map(monthLabel).join(", ")} have campaign revenue in Sales Flow Pro but no accounts yet. Use <b>Propose accruals for uninvoiced</b> to see them in the statements as proposed entries until they are invoiced and the accountant's file arrives.</Callout>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "monthly", label: "By month" }, { id: "uninvoiced", label: `Not invoiced (${d.notInvoiced.length})` }, { id: "reconcile", label: "Reconciliation by client" }, { id: "cash", label: "Received & paid" }, { id: "docs", label: "Invoice documents" }, { id: "campaigns", label: "All campaigns" }]} />
      {tab === "monthly" && <Monthly d={d} />}
      {tab === "uninvoiced" && <NotInvoiced d={d} />}
      {tab === "reconcile" && <Reconcile d={d} />}
      {tab === "campaigns" && <Campaigns d={d} />}
      {tab === "cash" && <CampaignCash canEdit={role !== "viewer"} />}
      {tab === "docs" && <Documents canEdit={role !== "viewer"} isPartner={role === "partner"} />}
      <p className="text-xs text-muted-foreground">Policy: TonePerks-sourced campaigns are revenue at full value with the Jazz share as a platform fee; Jazz-sourced / Jazz-internal campaigns (e.g. Jazz Cash) are revenue at the TonePerks share only. Free-of-charge campaigns carry no revenue. Accruals carry no sales tax (it arises on invoicing); the 'sales tax to charge' column shows what each invoice will add at {(d.settings.gstRate * 100).toFixed(0)}%.</p>
    </div>
  );
}

function Monthly({ d }: { d: any }) {
  const data = d.byMonth.map((m: any) => ({ ...m, label: monthLabel(m.month), ...m.bySource }));
  return (
    <div className="space-y-6">
      <Card title="Revenue by source vs invoiced" subtitle="Stacked bars: Sales Flow Pro revenue by source · grey: invoiced per register">
        <div className="h-80"><ResponsiveContainer>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" fontSize={12} /><YAxis tickFormatter={(v) => pkr(v, { compact: true })} fontSize={12} width={60} />
            <Tooltip formatter={(v: number) => pkr(v)} /><Legend />
            {Object.entries(SRC).map(([k, s]) => <Bar key={k} dataKey={k} name={s.label} stackId="sfp" fill={s.color} />)}
            <Bar dataKey="invoiced" name="Invoiced" fill="hsl(0 0% 70%)" />
          </BarChart>
        </ResponsiveContainer></div>
      </Card>
      <Card pad={false}>
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Month</th><th className="num">Campaigns</th><th className="num">Campaign value</th><th className="num">TonePerks revenue</th><th className="num">Jazz share (fee)</th><th className="num">Invoiced</th><th className="num">Booked</th><th className="num">Difference</th></tr></thead>
          <tbody>{d.byMonth.map((m: any) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="num">{m.campaigns || "–"}</td><td className="num"><Money v={m.campaignValue} /></td><td className="num font-medium"><Money v={m.revenue} /></td><td className="num"><Money v={m.platformFee} /></td><td className="num"><Money v={m.invoiced} /></td><td className="num"><Money v={m.booked} /></td><td className={`num ${Math.abs(m.revenue - m.booked) > 1000 ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}><Money v={m.revenue - m.booked} /></td></tr>)}
            <tr className="total"><td>Total</td><td className="num">{d.byMonth.reduce((a: number, m: any) => a + m.campaigns, 0)}</td><td className="num"><Money v={d.byMonth.reduce((a: number, m: any) => a + m.campaignValue, 0)} /></td><td className="num"><Money v={d.totals.sfpRevenue} /></td><td className="num"><Money v={d.totals.sfpPlatformFee} /></td><td className="num"><Money v={d.totals.invoiced} /></td><td className="num"><Money v={d.totals.booked} /></td><td className="num"><Money v={d.totals.sfpRevenue - d.totals.booked} /></td></tr></tbody>
        </table></div>
      </Card>
    </div>
  );
}

function Reconcile({ d }: { d: any }) {
  return (
    <Card pad={false} title="Sales Flow Pro vs invoice register, by client" subtitle="Positive difference = campaign revenue not (yet) invoiced; negative = invoiced without a matching campaign in Sales Flow Pro">
      <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th>Client</th><th className="num">Campaigns</th><th className="num">SFP revenue</th><th className="num">Invoices</th><th className="num">Invoiced</th><th className="num">Difference</th><th className="num">Jazz share diff.</th></tr></thead>
        <tbody>{d.byClient.map((c: any) => <tr key={c.key}><td className="font-medium">{c.names.join(" / ")}</td><td className="num">{c.campaigns || "–"}</td><td className="num"><Money v={c.sfpRevenue} /></td><td className="num">{c.invoices || "–"}</td><td className="num"><Money v={c.invoiced} /></td>
          <td className={`num font-semibold ${Math.abs(c.difference) > 1000 ? (c.difference > 0 ? "text-amber-600" : "text-rose-600") : "text-emerald-600"}`}>{Math.abs(c.difference) > 1000 ? <Money v={c.difference} /> : "✓"}</td>
          <td className={`num ${Math.abs(c.jazzDifference) > 1000 ? "text-amber-600" : "text-muted-foreground"}`}><Money v={c.jazzDifference} /></td></tr>)}</tbody>
      </table></div>
    </Card>
  );
}

function Campaigns({ d }: { d: any }) {
  const [src, setSrc] = useState("");
  const rows = useMemo(() => d.campaigns.filter((c: any) => !src || c.source === src), [d, src]);
  return (
    <Card pad={false} actions={<select className="input" value={src} onChange={(e) => setSrc(e.target.value)}><option value="">All sources</option>{Object.entries(SRC).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</select>} title="Campaigns">
      <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th>Month</th><th>Code</th><th>Client</th><th>Source</th><th>Status</th><th>Manager</th><th className="num">Value</th><th className="num">Jazz</th><th className="num">TonePerks</th><th className="num">Revenue</th></tr></thead>
        <tbody>{rows.map((c: any) => <tr key={c.id}><td className="whitespace-nowrap">{monthLabel(c.month)}</td><td className="text-xs text-muted-foreground">{c.code}</td><td className="font-medium">{c.client}{c.foc && <> <Badge>FOC</Badge></>}</td>
          <td><Badge tone={SRC[c.source].tone}>{SRC[c.source].label}</Badge></td><td className="text-xs">{c.status}</td><td className="text-xs">{c.manager ?? "–"}</td>
          <td className="num"><Money v={c.campaignValue} /></td><td className="num"><Money v={c.jazzShare} /></td><td className="num"><Money v={c.toneperksShare} /></td><td className="num font-medium"><Money v={c.revenue} /></td></tr>)}</tbody>
      </table></div>
    </Card>
  );
}

function NotInvoiced({ d }: { d: any }) {
  return (
    <div className="space-y-6">
      <Callout tone="warn" title="Revenue in Sales Flow Pro with no matching invoice">Each campaign-month was matched to the invoice register by customer, amount (±25%) and date (up to 5 months after the campaign month). Anything left here has either not been invoiced, was invoiced under a different customer name, or should not have been recorded as paid in Sales Flow Pro. Each one is cash you may be able to bill now.</Callout>
      <Card pad={false} title="Not invoiced">
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Month</th><th>Code</th><th>Customer</th><th>Source</th><th>Status</th><th className="num">TonePerks revenue</th><th className="num">Jazz share</th><th className="num">Sales tax to charge</th></tr></thead>
          <tbody>{d.notInvoiced.map((l: any) => <tr key={l.id}><td>{monthLabel(l.month)}</td><td className="text-xs text-muted-foreground">{l.code}</td><td className="font-medium">{l.client}</td><td><Badge tone={SRC[l.source].tone}>{SRC[l.source].label}</Badge></td><td className="text-xs">{l.status}</td><td className="num font-semibold"><Money v={l.revenue} /></td><td className="num"><Money v={l.platformFee || null} /></td><td className="num"><Money v={l.revenue * d.settings.gstRate} /></td></tr>)}
            <tr className="total"><td colSpan={5}>Total</td><td className="num"><Money v={d.totals.notInvoiced} /></td><td className="num"><Money v={d.notInvoiced.reduce((a: number, l: any) => a + l.platformFee, 0)} /></td><td className="num"><Money v={d.totals.notInvoiced * d.settings.gstRate} /></td></tr></tbody>
        </table></div>
      </Card>
      <div className="grid lg:grid-cols-2 gap-6">
        <Card pad={false} title="Matched campaigns" subtitle="Campaign revenue vs the invoice it was matched to">
          <div className="overflow-x-auto max-h-[480px]"><table className="tbl"><thead><tr><th>Month</th><th>Customer</th><th>Invoice</th><th className="num">SFP</th><th className="num">Invoiced</th><th className="num">Diff.</th></tr></thead>
            <tbody>{d.matched.map((m: any) => <tr key={m.id}><td>{monthLabel(m.month)}</td><td>{m.client}</td><td className="text-xs">#{m.invoice ?? "–"} · {dmy(m.invoiceDate)}</td><td className="num"><Money v={m.revenue} /></td><td className="num"><Money v={m.invoiced} /></td><td className={`num ${Math.abs(m.difference) > 1000 ? "text-amber-600" : "text-muted-foreground"}`}><Money v={m.difference} /></td></tr>)}</tbody></table></div>
        </Card>
        <Card pad={false} title="Invoiced, but no campaign in Sales Flow Pro">
          <table className="tbl"><thead><tr><th>Date</th><th>#</th><th>Customer</th><th className="num">Net</th></tr></thead>
            <tbody>{d.invoicedNotInSfp.map((i: any) => <tr key={i.id}><td>{dmy(i.date)}</td><td className="text-xs">{i.number ?? "–"}</td><td>{i.client}</td><td className="num"><Money v={i.net} /></td></tr>)}</tbody></table>
        </Card>
      </div>
    </div>
  );
}

type Folder = "received" | "paid";
function CampaignCash({ canEdit }: { canEdit: boolean }) {
  const { meta } = usePeriod();
  const q = useApi<any>("/campaign-cash");
  const [prefillMsg, setPrefillMsg] = useState<any>(null);
  const prefill = useMut(() => api("/campaign-cash/prefill", { method: "POST" }));
  const [folder, setFolder] = useState<Folder>("received");
  const [add, setAdd] = useState<{ campaignId?: string } | null>(null);
  const del = useMut((id: number) => api(`/campaign-cash/${id}`, { method: "DELETE" }));
  if (!q.data) return <Loading q={q} />;
  const { campaigns, entries } = q.data;
  const name = new Map(campaigns.map((c: any) => [c.id, c]));
  const tot = (k: string) => campaigns.reduce((a: number, c: any) => a + (c[k] || 0), 0);
  const list = entries.filter((e: any) => e.kind === folder);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon={FolderInput} tone="good" label="Received (recorded)" value={<Money v={tot("received")} compact />} sub={`Still to collect ${pkr(tot("toCollect"), { compact: true })}`} onClick={() => setFolder("received")} />
        <Stat icon={FolderOutput} tone="warn" label="Paid (recorded)" value={<Money v={tot("paid")} compact />} sub={`Jazz share still to pay ${pkr(tot("toPay"), { compact: true })}`} onClick={() => setFolder("paid")} />
        <Stat label="TonePerks revenue (SFP)" value={<Money v={tot("revenue")} compact />} sub={`${campaigns.length} paid campaigns`} />
        <Stat label="Jazz share on TonePerks-sourced" value={<Money v={tot("jazzShare")} compact />} />
      </div>
      <Callout tone="info">Record money as it actually moves: <b>Received</b> = cash from the customer (or from Jazz for Jazz-sourced and Jazz Cash campaigns, your share); <b>Paid</b> = Jazz's share or any other campaign cost you paid. These folders are a campaign-level tracker; the bank and the books stay the official record, and nothing is written back to Sales Flow Pro.</Callout>
      <Card pad={false} title={<div className="flex items-center gap-1 -ml-1">
          {(["received", "paid"] as Folder[]).map((f) => (
            <button key={f} onClick={() => setFolder(f)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold ${folder === f ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {f === "received" ? <FolderInput size={16} /> : <FolderOutput size={16} />}{f === "received" ? "Received" : "Paid"} <span className="text-xs font-normal">({entries.filter((e: any) => e.kind === f).length})</span>
            </button>))}
        </div>} actions={<>
          {folder === "received" && meta?.user?.role === "partner" && <Button variant="secondary" disabled={prefill.isPending} onClick={() => prefill.mutate(undefined, { onSuccess: (r: any) => setPrefillMsg(r), onError: (e: any) => setPrefillMsg({ error: e.message }) })}>{prefill.isPending ? "Pre-filling…" : "Pre-fill from books"}</Button>}
          {canEdit && <Button onClick={() => setAdd({})}>{folder === "received" ? "Add amount received" : "Add amount paid"}</Button>}</>}>
        {prefillMsg && <div className="px-5 pb-3">{prefillMsg.error ? <Callout tone="bad">{prefillMsg.error}</Callout> :
          <Callout tone="info" title={`Pre-filled ${prefillMsg.entries} receipts from the invoice register: PKR ${pkr(prefillMsg.received)} cash + PKR ${pkr(prefillMsg.withheld)} withheld`}>
            Entries marked <b>books</b> are replaced each time you pre-fill; entries you add by hand are kept.
            {prefillMsg.unallocated.length > 0 && <> Receipts with no matching campaign in Sales Flow Pro (not added): {prefillMsg.unallocated.map((u: any) => `${u.client} #${u.number ?? "–"} (${pkr(u.received)})`).join("; ")}.</>}
          </Callout>}</div>}
        {list.length === 0 ? <div className="px-5 py-8 text-sm text-muted-foreground text-center">Nothing in this folder yet.</div> : (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>Date</th><th>Campaign</th><th>{folder === "received" ? "From" : "To"}</th><th>Reference</th><th>Note</th>{folder === "received" && <th className="num">Tax withheld</th>}<th className="num">Amount</th><th></th></tr></thead>
            <tbody>{list.map((e: any) => { const c: any = name.get(String(e.campaign_id).split(":")[0]); const month = String(e.campaign_id).split(":")[1]; return (
              <tr key={e.id}><td className="whitespace-nowrap">{dmy(e.entry_date)}</td><td className="font-medium">{c ? `${c.client}` : e.campaign_id}<span className="text-xs text-muted-foreground"> {c?.code}{month ? ` · ${monthLabel(month)}` : ""}</span>{e.source === "register" && <> <Badge tone="info">books</Badge></>}</td>
                <td>{e.counterparty ?? "–"}</td><td className="text-xs">{e.reference ?? "–"}</td><td className="text-xs text-muted-foreground max-w-xs truncate" title={e.note ?? ""}>{e.note ?? ""}</td>
                {folder === "received" && <td className="num"><Money v={e.withheld || null} /></td>}
                <td className="num font-semibold"><Money v={e.amount} /></td>
                <td>{canEdit && <button className="text-muted-foreground hover:text-rose-600" onClick={() => confirm("Delete this entry?") && del.mutate(e.id)}><Trash2 size={14} /></button>}</td></tr>); })}
              <tr className="total"><td colSpan={5}>Total</td>{folder === "received" && <td className="num"><Money v={list.reduce((a: number, e: any) => a + e.withheld, 0)} /></td>}<td className="num"><Money v={list.reduce((a: number, e: any) => a + e.amount, 0)} /></td><td></td></tr></tbody>
          </table></div>)}
      </Card>
      <Card pad={false} title="By campaign" subtitle={`Invoice total = TonePerks revenue + ${(q.data.gstRate * 100).toFixed(0)}% sales tax; collected = cash received + income tax withheld by the customer (claimable)`}>
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Period</th><th>Code</th><th>Customer</th><th>Source</th><th className="num">TonePerks revenue</th><th className="num">Invoice incl. tax</th><th className="num">Received + withheld</th><th className="num">To collect</th><th className="num">Jazz share</th><th className="num">Paid</th><th className="num">To pay</th><th></th></tr></thead>
          <tbody>{campaigns.map((c: any) => (
            <tr key={c.id}><td className="whitespace-nowrap text-xs">{c.firstMonth === c.lastMonth ? monthLabel(c.firstMonth) : `${monthLabel(c.firstMonth)} – ${monthLabel(c.lastMonth)}`}</td><td className="text-xs text-muted-foreground">{c.code}</td><td className="font-medium">{c.client}</td>
              <td><Badge tone={SRC[c.source].tone}>{SRC[c.source].label}</Badge>{c.billedByJazz && <> <Badge tone="medium">billed by Jazz</Badge></>}</td>
              <td className="num"><Money v={c.revenue} /></td><td className="num"><Money v={c.invoiceTotal} /></td><td className="num text-emerald-700 dark:text-emerald-400"><Money v={c.received + c.withheld || null} /></td>
              <td className={`num font-semibold ${c.toCollect > 1 ? "text-amber-600" : "text-emerald-600"}`}>{c.toCollect > 1 ? <Money v={c.toCollect} /> : "✓"}</td>
              <td className="num"><Money v={c.jazzShare || null} /></td><td className="num"><Money v={c.paid || null} /></td>
              <td className={`num ${c.toPay > 1 ? "text-amber-600 font-semibold" : "text-muted-foreground"}`}>{c.jazzShare ? (c.toPay > 1 ? <Money v={c.toPay} /> : "✓") : "–"}</td>
              <td className="whitespace-nowrap">{canEdit && <><Button size="sm" variant="ghost" onClick={() => { setFolder("received"); setAdd({ campaignId: c.id }); }}>+ Received</Button><Button size="sm" variant="ghost" onClick={() => { setFolder("paid"); setAdd({ campaignId: c.id }); }}>+ Paid</Button></>}</td></tr>))}
            <tr className="total"><td colSpan={4}>Total</td><td className="num"><Money v={tot("revenue")} /></td><td className="num"><Money v={tot("invoiceTotal")} /></td><td className="num"><Money v={tot("received") + tot("withheld")} /></td><td className="num"><Money v={tot("toCollect")} /></td><td className="num"><Money v={tot("jazzShare")} /></td><td className="num"><Money v={tot("paid")} /></td><td className="num"><Money v={tot("toPay")} /></td><td></td></tr></tbody>
        </table></div>
      </Card>
      {add && <AddCash folder={folder} campaigns={campaigns} campaignId={add.campaignId} onClose={() => setAdd(null)} />}
    </div>
  );
}

function AddCash({ folder, campaigns, campaignId, onClose }: { folder: Folder; campaigns: any[]; campaignId?: string; onClose: () => void }) {
  const [f, setF] = useState({ campaignId: campaignId ?? "", date: new Date().toISOString().slice(0, 10), amount: "", withheld: "", counterparty: folder === "paid" ? "Jazz (PMCL)" : "", reference: "", note: "" });
  const [err, setErr] = useState<string | null>(null);
  const m = useMut((b: any) => api("/campaign-cash", { body: b }));
  const c = campaigns.find((x) => x.id === f.campaignId);
  const suggested = c ? (folder === "received" ? c.toCollect : c.toPay) : 0;
  return (
    <Modal title={folder === "received" ? "Add amount received" : "Add amount paid"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Campaign"><select className="input w-full" value={f.campaignId} onChange={(e) => setF({ ...f, campaignId: e.target.value })}>
          <option value="">Select a campaign…</option>{campaigns.map((x) => <option key={x.id} value={x.id}>{x.client} · {x.code ?? ""} · {monthLabel(x.firstMonth)}</option>)}</select></Field>
        {c && suggested > 1 && <p className="text-xs text-muted-foreground">Outstanding {folder === "received" ? "to collect (incl. sales tax)" : "to pay Jazz"}: PKR {pkr(suggested)} <button className="underline" onClick={() => setF({ ...f, amount: String(Math.round(suggested)) })}>use this</button></p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><input type="date" className="input w-full" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label={folder === "received" ? "Cash received (PKR)" : "Amount paid (PKR)"}><input className="input w-full" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        </div>
        {folder === "received" && <Field label="Income / sales tax withheld by the customer (PKR, optional)"><input className="input w-full" inputMode="numeric" value={f.withheld} onChange={(e) => setF({ ...f, withheld: e.target.value })} /></Field>}
        <Field label={folder === "received" ? "Received from" : "Paid to"}><input className="input w-full" value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} /></Field>
        <Field label="Reference (cheque / transfer / CPR no.)"><input className="input w-full" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Note"><input className="input w-full" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        {err && <Callout tone="bad">{err}</Callout>}
        <div className="flex justify-end"><Button disabled={!f.campaignId || !f.amount} onClick={() => m.mutate({ campaignId: f.campaignId, kind: folder, date: f.date, amount: Number(f.amount.replace(/,/g, "")), withheld: Number((f.withheld || "0").replace(/,/g, "")) || 0, counterparty: f.counterparty || null, reference: f.reference || null, note: f.note || null }, { onSuccess: onClose, onError: (e: any) => setErr(e.message) })}>Save</Button></div>
      </div>
    </Modal>
  );
}

const DOC_KIND: Record<string, string> = { invoice: "Invoice", receipt: "Receipt", jazz_billed: "Billed by Jazz" };
const DOC_STATUS: Record<string, { label: string; tone: string }> = {
  ok: { label: "matches", tone: "good" }, check: { label: "check", tone: "medium" }, differs: { label: "differs", tone: "bad" }, missing: { label: "not in books", tone: "bad" },
};
function Documents({ canEdit, isPartner }: { canEdit: boolean; isPartner: boolean }) {
  const q = useApi<any>("/invoice-docs");
  const [kind, setKind] = useState("");
  const [edit, setEdit] = useState<any>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "bad"; text: string } | null>(null);
  const propose = useMut(() => api("/invoice-docs/propose", { method: "POST" }));
  if (!q.data) return <Loading q={q} />;
  const docs: any[] = q.data.docs;
  if (!docs.length) return <Callout tone="info" title="No invoice documents yet">Issued invoices, bank receipts and Jazz release orders from the invoice folder are loaded here and mapped to the books and to Sales Flow Pro campaigns.</Callout>;
  const rows = docs.filter((d) => !kind || d.kind === kind);
  const inv = docs.filter((d) => d.kind === "invoice");
  const missing = inv.filter((d) => d.status === "missing");
  const count = (st: string) => inv.filter((d) => d.status === st).length;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon={FileText} label="Invoices in the folder" value={inv.length} sub={`${count("ok")} match the books · ${count("check")} to check`} />
        <Stat icon={AlertTriangle} tone={missing.length ? "bad" : "good"} label="Issued but not in the books" value={<Money v={missing.reduce((a, d) => a + d.net, 0)} compact />} sub={missing.length ? `${missing.map((d) => `#${d.docNo} ${d.client}`).join(", ")} · sales tax ${pkr(missing.reduce((a, d) => a + d.gst, 0), { compact: true })}` : "none"} />
        <Stat icon={FileCheck2} tone={count("differs") ? "warn" : "good"} label="Differ from the books" value={count("differs")} sub="amount, sales tax or a reused invoice number" />
        <Stat label="Receipts & Jazz-billed" value={docs.length - inv.length} sub="moved to the campaign they belong to" />
      </div>
      {msg && <Callout tone={msg.tone}>{msg.text}</Callout>}
      <Card pad={false} title="Invoice documents" subtitle="Each document from the invoice folder, matched to the accountant's register and to Sales Flow Pro. These links override the automatic matching."
        actions={<>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All documents</option>{Object.entries(DOC_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {isPartner && missing.length > 0 && <Button disabled={propose.isPending} onClick={() => propose.mutate(undefined, { onSuccess: (r: any) => { setMsg({ tone: "info", text: `${r.entries} proposed entr${r.entries === 1 ? "y" : "ies"} for invoices missing from the books: PKR ${pkr(r.revenue)} revenue + PKR ${pkr(r.salesTax)} output sales tax${r.accrualsRemoved ? ` (replacing ${r.accrualsRemoved} Sales Flow Pro accrual${r.accrualsRemoved > 1 ? "s" : ""})` : ""}. See Ledger → Journal entries (Proposed).` }); q.refetch(); }, onError: (e: any) => setMsg({ tone: "bad", text: e.message }) })}>Propose entries for missing invoices</Button>}
        </>}>
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Document</th><th>Date</th><th>Customer</th><th className="num">Net</th><th className="num">Sales tax</th><th className="num">Gross</th><th>In the books</th><th>Campaign(s)</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((d) => (
            <tr key={d.id} className="align-top">
              <td className="whitespace-nowrap"><div className="font-medium">{d.kind === "invoice" ? `#${d.docNo ?? "–"}` : DOC_KIND[d.kind]}</div>
                {d.url ? <a href={d.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 dark:text-blue-400 inline-flex items-center gap-1 max-w-[14rem] truncate" title={d.title ?? ""}>{d.title ?? "open"}<ExternalLink size={11} /></a> : <span className="text-xs text-muted-foreground">{d.title}</span>}</td>
              <td className="whitespace-nowrap">{dmy(d.docDate)}</td>
              <td><div className="font-medium">{d.client}</div>{d.campaignPeriod && <div className="text-xs text-muted-foreground">{d.campaignPeriod}</div>}</td>
              <td className="num"><Money v={d.net || null} /></td><td className="num"><Money v={d.gst || null} /></td><td className="num"><Money v={d.gross || null} /></td>
              <td className="whitespace-nowrap text-xs">{d.books ? <>#{d.books.number ?? "–"} · {dmy(d.books.date)}<div className="text-muted-foreground">{d.books.client}</div></> : d.kind === "invoice" ? <span className="text-rose-600 font-semibold">not recorded</span> : <span className="text-muted-foreground">{d.kind === "jazz_billed" ? "billed by Jazz" : "–"}</span>}</td>
              <td className="text-xs">{d.campaigns.length ? d.campaigns.map((c: any) => <div key={c.id} className="whitespace-nowrap">{c.client} · {monthLabel(c.month)} · <Money v={c.value} /></div>) : <span className="text-muted-foreground">–</span>}</td>
              <td className="min-w-[16rem]"><Badge tone={DOC_STATUS[d.status].tone}>{DOC_STATUS[d.status].label}</Badge>
                <ul className="mt-1 space-y-0.5">{d.issues.map((i: any, k: number) => <li key={k} className={`text-xs ${i.tone === "bad" ? "text-rose-600" : i.tone === "warn" ? "text-amber-600" : "text-muted-foreground"}`}>{i.text}</li>)}</ul>
                {d.note && <div className="text-xs text-muted-foreground italic mt-1">{d.note}</div>}</td>
              <td>{canEdit && <button className="text-muted-foreground hover:text-foreground" title="Change the links" onClick={() => setEdit(d)}><Pencil size={14} /></button>}</td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      {edit && <EditDoc doc={edit} invoices={q.data.invoices} campaigns={q.data.campaigns} onClose={() => { setEdit(null); q.refetch(); }} />}
    </div>
  );
}

function EditDoc({ doc, invoices, campaigns, onClose }: { doc: any; invoices: any[]; campaigns: any[]; onClose: () => void }) {
  const [books, setBooks] = useState<string>(doc.books ? String(doc.books.id) : "");
  const [ids, setIds] = useState<string[]>(doc.campaignIds);
  const [note, setNote] = useState(doc.note ?? "");
  const [filter, setFilter] = useState(doc.client.split(/\s+/)[0]);
  const [err, setErr] = useState<string | null>(null);
  const m = useMut((b: any) => api(`/invoice-docs/${doc.id}`, { method: "PATCH", body: b }));
  const shown = campaigns.filter((c) => ids.includes(c.id) || !filter || c.client.toLowerCase().includes(filter.toLowerCase()));
  const save = () => {
    const b = invoices.find((i) => String(i.id) === books);
    m.mutate({ booksNumber: b ? b.number ?? null : null, booksClient: b ? b.client : null, campaignIds: ids, note: note || null }, { onSuccess: onClose, onError: (e: any) => setErr(e.message) });
  };
  return (
    <Modal title={`${DOC_KIND[doc.kind]} ${doc.docNo ? `#${doc.docNo}` : ""} · ${doc.client}`} onClose={onClose} wide>
      <div className="space-y-3">
        <Field label="Row in the accountant's invoice register"><select className="input w-full" value={books} onChange={(e) => setBooks(e.target.value)}>
          <option value="">Not in the books</option>{invoices.map((i) => <option key={i.id} value={i.id}>#{i.number ?? "–"} · {dmy(i.date)} · {i.client} · {pkr(i.net)}</option>)}</select></Field>
        <Field label="Sales Flow Pro campaign(s)"><input className="input w-full mb-2" placeholder="Filter by customer" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="max-h-64 overflow-y-auto border border-border rounded-md divide-y divide-border">{shown.map((c) => (
            <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted">
              <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
              <span className="flex-1">{c.client} <span className="text-xs text-muted-foreground">{c.code} · {monthLabel(c.month)}</span></span><Money v={c.value} /></label>))}</div></Field>
        <Field label="Note"><input className="input w-full" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {err && <Callout tone="bad">{err}</Callout>}
        <div className="flex justify-end"><Button disabled={m.isPending} onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}
