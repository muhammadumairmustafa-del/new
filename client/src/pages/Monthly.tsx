import React, { useState } from "react";
import { CalendarRange, Download, TrendingUp, HandCoins, Handshake, ChevronRight, ChevronDown } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useApi, qs } from "../api";
import { usePeriod } from "../App";
import { Badge, Button, Callout, Card, Loading, Money, PageHeader, Stat, Tabs } from "../components/ui";
import { monthLabel, pkr } from "../format";

const SRC: Record<string, { label: string; color: string; tone: string }> = {
  callperks_sourced: { label: "Brought by TonePerks", color: "hsl(160 75% 35%)", tone: "good" },
  jazz_sourced: { label: "Jazz sourced", color: "hsl(195 80% 40%)", tone: "info" },
  jazz_internal: { label: "Jazz Cash (Jazz internal)", color: "hsl(30 80% 50%)", tone: "medium" },
};
type Tab = "months" | "clients" | "books";

export default function Monthly() {
  const { proposed, meta } = usePeriod();
  const [range, setRange] = useState<string>("all");
  const params = { ...(range === "all" ? {} : { fy: Number(range) }), proposed: proposed ? 1 : undefined };
  const q = useApi<any>(`/monthly${qs(params)}`, [range, proposed]);
  const [tab, setTab] = useState<Tab>("months");
  const header = (
    <PageHeader title="Monthly breakdown" subtitle="Revenue each month, who brought it, what goes to Jazz, what TonePerks keeps, and what is still to collect"
      actions={<>
        <select className="input" value={range} onChange={(e) => setRange(e.target.value)}>
          <option value="all">Jul 2025 – this month</option>
          {(meta?.fiscalYears ?? []).filter((y: number) => y >= 2026).map((y: number) => <option key={y} value={y}>FY{y} (Jul {y - 1} – Jun {y})</option>)}
        </select>
        <a href={`/api/monthly.xlsx${qs(params)}`}><Button variant="secondary"><Download size={15} />Excel</Button></a>
      </>} />);
  if (!q.data) return <div className="space-y-6">{header}<Loading q={q} /></div>;
  const d = q.data; const t = d.totals;
  return (
    <div className="space-y-6">
      {header}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon={TrendingUp} tone="blue" label="Revenue" value={<Money v={t.revenue} compact />} sub={`${d.campaigns.length} campaign-months · not invoiced yet ${pkr(t.notInvoiced, { compact: true })}`} />
        <Stat icon={CalendarRange} tone="good" label="TonePerks keeps" value={<Money v={t.toneperksKeeps} compact />} sub={`after the Jazz 40% fee of ${pkr(t.jazzFee, { compact: true })}`} />
        <Stat icon={HandCoins} tone="warn" label="Still to collect (incl. tax)" value={<Money v={t.toCollect} compact />} sub={`from customers ${pkr(t.toCollect - t.toCollectFromJazz, { compact: true })} · from Jazz ${pkr(t.toCollectFromJazz, { compact: true })}`} />
        <Stat icon={Handshake} tone="bad" label="Owed to Jazz (fee)" value={<Money v={t.jazzToPay} compact />} sub={`due now ${pkr(t.jazzDueNow, { compact: true })} — on money customers have already paid`} />
      </div>
      <Callout tone="info">Each campaign is counted in the month it <b>ran</b> (Sales Flow Pro). <b>Brought by TonePerks</b>: you bill the customer the full amount and owe Jazz 40%. <b>Jazz sourced</b> and <b>Jazz Cash</b>: Jazz bills the customer and you bill Jazz for your share only, with no fee. "Due now" is the Jazz fee on the part the customer has already paid. The <b>Books</b> tab shows the same months as the accountant booked them, by invoice date.</Callout>
      <Card title="Revenue by month and who brought it">
        <div className="h-72"><ResponsiveContainer>
          <BarChart data={d.byMonth.map((m: any) => ({ label: monthLabel(m.month), ...m.bySource, fee: -m.jazzFee }))}>
            <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="label" fontSize={12} /><YAxis tickFormatter={(v) => pkr(v, { compact: true })} fontSize={12} width={60} />
            <Tooltip formatter={(v: number) => pkr(Math.abs(v))} /><Legend />
            {Object.entries(SRC).map(([k, s]) => <Bar key={k} dataKey={k} name={s.label} stackId="r" fill={s.color} />)}
          </BarChart>
        </ResponsiveContainer></div>
      </Card>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "months", label: "By month" }, { id: "clients", label: "By client" }, { id: "books", label: "Books by month" }]} />
      {tab === "months" && <Months d={d} />}
      {tab === "clients" && <Clients d={d} />}
      {tab === "books" && <Books d={d} proposed={proposed} />}
    </div>
  );
}

function Months({ d }: { d: any }) {
  const [open, setOpen] = useState<string | null>(null);
  const tot = (k: string) => d.byMonth.reduce((a: number, m: any) => a + m[k], 0);
  const src = (k: string) => d.byMonth.reduce((a: number, m: any) => a + m.bySource[k], 0);
  return (
    <Card pad={false} title="By month" subtitle="Click a month to see its campaigns">
      <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th>Month</th><th className="num">Revenue</th><th className="num">Brought by TonePerks</th><th className="num">Jazz sourced</th><th className="num">Jazz Cash</th><th className="num">Jazz 40% fee</th><th className="num">TonePerks keeps</th><th className="num">Not invoiced</th><th className="num">Received</th><th className="num">To collect</th><th className="num">Jazz fee to pay</th><th className="num">…due now</th></tr></thead>
        <tbody>{d.byMonth.map((m: any) => (
          <React.Fragment key={m.month}>
            <tr className={m.campaigns ? "cursor-pointer hover:bg-muted/50" : ""} onClick={() => m.campaigns && setOpen(open === m.month ? null : m.month)}>
              <td className="whitespace-nowrap font-medium">{m.campaigns ? (open === m.month ? <ChevronDown size={13} className="inline -ml-1 mr-1" /> : <ChevronRight size={13} className="inline -ml-1 mr-1" />) : null}{monthLabel(m.month)}</td>
              <td className="num font-semibold"><Money v={m.revenue || null} /></td><td className="num"><Money v={m.bySource.callperks_sourced || null} /></td><td className="num"><Money v={m.bySource.jazz_sourced || null} /></td><td className="num"><Money v={m.bySource.jazz_internal || null} /></td>
              <td className="num text-rose-600"><Money v={m.jazzFee || null} /></td><td className="num font-medium"><Money v={m.toneperksKeeps || null} /></td>
              <td className={`num ${m.notInvoiced > 1 ? "text-amber-600 font-semibold" : ""}`}><Money v={m.notInvoiced || null} /></td>
              <td className="num text-emerald-700 dark:text-emerald-400"><Money v={m.received || null} /></td><td className={`num ${m.toCollect > 1 ? "text-amber-600 font-semibold" : ""}`}><Money v={m.toCollect || null} /></td>
              <td className="num"><Money v={m.jazzToPay || null} /></td><td className={`num ${m.jazzDueNow > 1 ? "text-rose-600 font-semibold" : ""}`}><Money v={m.jazzDueNow || null} /></td>
            </tr>
            {open === m.month && <tr><td colSpan={12} className="bg-muted/40 p-0"><MonthCampaigns rows={d.campaigns.filter((r: any) => r.month === m.month)} /></td></tr>}
          </React.Fragment>))}
          <tr className="total"><td>Total</td><td className="num"><Money v={tot("revenue")} /></td><td className="num"><Money v={src("callperks_sourced")} /></td><td className="num"><Money v={src("jazz_sourced")} /></td><td className="num"><Money v={src("jazz_internal")} /></td><td className="num"><Money v={tot("jazzFee")} /></td><td className="num"><Money v={tot("toneperksKeeps")} /></td><td className="num"><Money v={tot("notInvoiced")} /></td><td className="num"><Money v={tot("received")} /></td><td className="num"><Money v={tot("toCollect")} /></td><td className="num"><Money v={tot("jazzToPay")} /></td><td className="num"><Money v={tot("jazzDueNow")} /></td></tr>
        </tbody>
      </table></div>
    </Card>
  );
}

function MonthCampaigns({ rows }: { rows: any[] }) {
  return (
    <table className="tbl text-xs">
      <thead><tr><th>Client</th><th>Brought by</th><th>Manager</th><th className="num">Campaign value</th><th className="num">Revenue</th><th className="num">Jazz fee</th><th className="num">TonePerks keeps</th><th>Invoice</th><th className="num">Invoice incl. tax</th><th className="num">Received</th><th className="num">To collect</th><th>From</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}><td className="font-medium">{r.client} <span className="text-muted-foreground">{r.code}</span></td>
          <td><Badge tone={SRC[r.source].tone}>{SRC[r.source].label}</Badge>{r.billedByJazz && <> <Badge tone="medium">billed by Jazz</Badge></>}</td><td>{r.manager ?? "–"}</td>
          <td className="num"><Money v={r.campaignValue} /></td><td className="num font-semibold"><Money v={r.revenue} /></td><td className="num"><Money v={r.jazzFee || null} /></td><td className="num"><Money v={r.toneperksKeeps} /></td>
          <td>{r.invoiced ? `#${r.invoiceNo ?? "–"}` : <span className="text-amber-600 font-semibold">not invoiced</span>}</td>
          <td className="num"><Money v={r.invoiceTotal} /></td><td className="num"><Money v={r.received || null} /></td><td className={`num ${r.toCollect > 1 ? "text-amber-600 font-semibold" : "text-emerald-600"}`}>{r.toCollect > 1 ? <Money v={r.toCollect} /> : "✓"}</td><td>{r.collectFrom}</td></tr>))}</tbody>
    </table>
  );
}

function Clients({ d }: { d: any }) {
  const tot = (k: string) => d.byClient.reduce((a: number, c: any) => a + c[k], 0);
  return (
    <Card pad={false} title="By client" subtitle="Who brought each client, what TonePerks keeps, what is still to collect and what is owed to Jazz">
      <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th>Client</th><th>Brought by</th><th>Months</th><th className="num">Revenue</th><th className="num">Jazz fee</th><th className="num">TonePerks keeps</th><th className="num">Not invoiced</th><th className="num">Received</th><th className="num">To collect</th><th>From</th><th className="num">Jazz fee to pay</th><th className="num">…due now</th></tr></thead>
        <tbody>{d.byClient.map((c: any) => (
          <tr key={c.client + c.source}><td className="font-medium">{c.client}</td><td><Badge tone={SRC[c.source].tone}>{SRC[c.source].label}</Badge></td>
            <td className="text-xs text-muted-foreground whitespace-nowrap">{c.months.length > 1 ? `${monthLabel(c.months[0])} – ${monthLabel(c.months[c.months.length - 1])}` : monthLabel(c.months[0])}</td>
            <td className="num font-semibold"><Money v={c.revenue} /></td><td className="num"><Money v={c.jazzFee || null} /></td><td className="num"><Money v={c.toneperksKeeps} /></td>
            <td className={`num ${c.notInvoiced > 1 ? "text-amber-600" : ""}`}><Money v={c.notInvoiced || null} /></td><td className="num"><Money v={c.received || null} /></td>
            <td className={`num ${c.toCollect > 1 ? "text-amber-600 font-semibold" : "text-emerald-600"}`}>{c.toCollect > 1 ? <Money v={c.toCollect} /> : "✓"}</td><td className="text-xs">{c.collectFrom}</td>
            <td className="num"><Money v={c.jazzToPay || null} /></td><td className={`num ${c.jazzDueNow > 1 ? "text-rose-600 font-semibold" : ""}`}><Money v={c.jazzDueNow || null} /></td></tr>))}
          <tr className="total"><td colSpan={3}>Total</td><td className="num"><Money v={tot("revenue")} /></td><td className="num"><Money v={tot("jazzFee")} /></td><td className="num"><Money v={tot("toneperksKeeps")} /></td><td className="num"><Money v={tot("notInvoiced")} /></td><td className="num"><Money v={tot("received")} /></td><td className="num"><Money v={tot("toCollect")} /></td><td></td><td className="num"><Money v={tot("jazzToPay")} /></td><td className="num"><Money v={tot("jazzDueNow")} /></td></tr>
        </tbody>
      </table></div>
    </Card>
  );
}

function Books({ d, proposed }: { d: any; proposed: boolean }) {
  const tot = (k: string) => d.byMonth.reduce((a: number, m: any) => a + m.books[k], 0);
  return (
    <Card pad={false} title="Books by month" subtitle={`The accountant's books${proposed ? " with the proposed adjustments" : ""}: revenue in the month of the invoice, and balances at each month end`}>
      <div className="overflow-x-auto"><table className="tbl">
        <thead><tr><th>Month</th><th className="num">Revenue booked</th><th className="num">Jazz fee booked</th><th className="num">Paid to Jazz</th><th className="num">Owed to Jazz (month end)</th><th className="num">Collected from customers</th><th className="num">Receivables (month end)</th><th className="num">Bank (month end)</th></tr></thead>
        <tbody>{d.byMonth.map((m: any) => (
          <tr key={m.month}><td className="font-medium whitespace-nowrap">{monthLabel(m.month)}</td><td className="num"><Money v={m.books.revenue || null} /></td><td className="num"><Money v={m.books.jazzFee || null} /></td><td className="num"><Money v={m.books.jazzPaid || null} /></td>
            <td className="num text-rose-600 font-medium"><Money v={m.books.jazzPayableEnd} /></td><td className="num text-emerald-700 dark:text-emerald-400"><Money v={m.books.collected || null} /></td><td className="num"><Money v={m.books.receivableEnd} /></td><td className="num font-medium"><Money v={m.books.bankEnd} /></td></tr>))}
          <tr className="total"><td>Total</td><td className="num"><Money v={tot("revenue")} /></td><td className="num"><Money v={tot("jazzFee")} /></td><td className="num"><Money v={tot("jazzPaid")} /></td><td></td><td className="num"><Money v={tot("collected")} /></td><td></td><td></td></tr>
        </tbody>
      </table></div>
    </Card>
  );
}
