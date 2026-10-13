import React, { useMemo, useState } from "react";
import { RefreshCw, TrendingUp, Handshake, FileCheck2, AlertTriangle } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, useApi, useMut, qs } from "../api";
import { usePeriod } from "../App";
import { Badge, Button, Callout, Card, Loading, Money, PageHeader, Stat, Tabs } from "../components/ui";
import { dmy, fyLabel, monthLabel, pkr } from "../format";

type Tab = "monthly" | "reconcile" | "campaigns";
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
  const accrue = useMut(() => api("/sfp/accruals", { method: "POST", body: {} }));
  const role = meta?.user?.role;
  const doSync = () => sync.mutate(undefined, { onSuccess: (r: any) => setMsg({ tone: "info", text: `Synced ${r.campaigns} campaigns and ${r.payments} payment records from Sales Flow Pro.` }), onError: (e: any) => setMsg({ tone: "bad", text: e.message }) });
  const doAccrue = () => accrue.mutate(undefined, { onSuccess: (r: any) => setMsg({ tone: "info", text: `${r.entries} proposed revenue accruals (PKR ${pkr(r.revenue)}) created for ${r.months.join(", ") || "no months"}. Review them in Ledger → Journal entries (Proposed).` }), onError: (e: any) => setMsg({ tone: "bad", text: e.message }) });
  const header = (
    <PageHeader title="Revenue" subtitle={<>Campaign revenue and Jazz / TonePerks split from Sales Flow Pro, reconciled to the books · {fyLabel(fy)}</>}
      actions={<>
        {status.data?.lastSync && <span className="text-xs text-muted-foreground">Last sync {dmy(status.data.lastSync.at)} {String(status.data.lastSync.at).slice(11, 16)}</span>}
        {role !== "viewer" && <Button variant="secondary" onClick={doSync} disabled={sync.isPending || !status.data?.configured}><RefreshCw size={15} className={sync.isPending ? "animate-spin" : ""} />Sync Sales Flow Pro</Button>}
        {role === "partner" && <Button onClick={doAccrue} disabled={accrue.isPending || !status.data?.campaigns}>Propose accruals after books</Button>}
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
        <Stat icon={AlertTriangle} tone={Math.abs(t.sfpRevenue - t.invoiced) > 1000 ? "warn" : "good"} label="Not yet invoiced / difference" value={<Money v={t.sfpRevenue - t.invoiced} compact />} sub="Sales Flow Pro minus invoice register" />
        <Stat icon={Handshake} tone="warn" label="Jazz share per Sales Flow Pro" value={<Money v={t.sfpPlatformFee} compact />} sub={`In the register: ${pkr(t.invoicedJazz, { compact: true })}`} />
      </div>
      {d.unbookedMonths.length > 0 && <Callout tone="info" title="Months not yet in the books">{d.unbookedMonths.map(monthLabel).join(", ")} have campaign revenue in Sales Flow Pro but no accounts yet. Use <b>Propose accruals after books</b> to see them in the statements as proposed entries until the accountant's file arrives.</Callout>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "monthly", label: "By month" }, { id: "reconcile", label: "Reconciliation by client" }, { id: "campaigns", label: "Campaigns" }]} />
      {tab === "monthly" && <Monthly d={d} />}
      {tab === "reconcile" && <Reconcile d={d} />}
      {tab === "campaigns" && <Campaigns d={d} />}
      <p className="text-xs text-muted-foreground">Policy: TonePerks-sourced campaigns are revenue at full value with the Jazz share as a platform fee; Jazz-sourced / Jazz-internal campaigns (e.g. Jazz Cash) are revenue at the TonePerks share only. Free-of-charge campaigns carry no revenue. Sales tax {(d.settings.gstRate * 100).toFixed(0)}% on accruals.</p>
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
