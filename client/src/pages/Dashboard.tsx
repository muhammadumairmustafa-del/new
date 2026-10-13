import React from "react";
import { useNavigate, Link } from "react-router-dom";
import { TrendingUp, PiggyBank, Landmark, Building2, Handshake, AlertTriangle } from "lucide-react";
import { Cell, Bar, BarChart, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import { useApi, qs } from "../api";
import { usePeriod } from "../App";
import { Badge, Callout, Card, Loading, Money, Stat, PageHeader } from "../components/ui";
import { dmy, fyLabel, monthLabel, pkr } from "../format";

const axis = (v: number) => pkr(v, { compact: true });

export default function Dashboard() {
  const { fy, proposed } = usePeriod();
  const q = useApi<any>(fy ? `/dashboard${qs({ fy, proposed })}` : null, [fy, proposed]);
  const nav = useNavigate();
  if (!q.data) return <Loading q={q} />;
  const d = q.data; const k = d.kpis; const p = d.plan;
  const statutory = k.incomeTax + k.salaryTax + k.salesTax;
  const series = d.series.map((x: any) => ({ ...x, label: monthLabel(x.month) }));
  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle={<>TonePerks LLP — {fyLabel(d.fy)} · position as at {dmy(d.periodEnd)}{d.periodEnd !== d.asOf ? ` · latest books ${dmy(d.asOf)}` : ""}</>} />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat icon={TrendingUp} tone="blue" label="Revenue" value={<Money v={k.ytdRevenue} compact />} sub={`Gross profit ${pkr(k.ytdGrossProfit, { compact: true })}`} />
        <Stat icon={PiggyBank} label="Profit before tax" value={<Money v={k.ytdProfit} compact />} tone={k.ytdProfit < 0 ? "bad" : "good"} sub={k.ytdTax ? `After tax ${pkr(k.ytdProfitAfterTax, { compact: true })}` : "No tax provision booked"} />
        <Stat icon={Building2} tone="good" label="Cash at bank" value={<Money v={k.cash} compact />} sub={`Receivables ${pkr(k.receivables, { compact: true })}`} onClick={() => nav("/cash-plan")} />
        <Stat icon={Landmark} label="Tax owed (books)" value={<Money v={statutory} compact />} tone="bad" sub={`Income ${pkr(k.incomeTax, { compact: true })} · salary ${pkr(k.salaryTax, { compact: true })} · sales ${pkr(k.salesTax, { compact: true })}`} onClick={() => nav("/tax")} />
        <Stat icon={Handshake} label="Owed to Jazz" value={<Money v={k.jazz} compact />} tone="warn" sub={`Partners' accounts ${pkr(k.partnersAccounts, { compact: true })}`} />
      </div>

      {p.summary.statutoryDueNow > p.openingCash && (
        <Callout tone="bad" title="Liquidity alert — today">
          Taxes due now total <b>PKR {pkr(p.summary.statutoryDueNow)}</b> against cash of <b>PKR {pkr(p.openingCash)}</b> ({dmy(p.startDate)}). All obligations due now: PKR {pkr(p.summary.dueNow)}.
          The 13-week forecast bottoms at <b>PKR {pkr(p.minCash)}</b> in week {p.minWeek}. <Link className="underline font-medium" to="/cash-plan">Open the payment plan →</Link>
        </Callout>
      )}

      <div className="grid lg:grid-cols-2 gap-6">
        <Card title="Monthly results" subtitle="Revenue, gross profit and profit before tax">
          <div className="h-72"><ResponsiveContainer>
            <ComposedChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" fontSize={12} /><YAxis tickFormatter={axis} fontSize={12} width={60} />
              <Tooltip formatter={(v: number) => pkr(v)} /><Legend /><ReferenceLine y={0} stroke="#94a3b8" />
              <Bar dataKey="revenue" name="Revenue" fill="hsl(210 60% 75%)" /><Bar dataKey="grossProfit" name="Gross profit" fill="hsl(210 85% 40%)" />
              <Line dataKey="profitBeforeTax" name="Profit before tax" stroke="#e11d48" strokeWidth={2} dot />
            </ComposedChart>
          </ResponsiveContainer></div>
        </Card>
        <Card title="Cash vs receivables" subtitle="Month-end balances — profit is sitting in unpaid invoices">
          <div className="h-72"><ResponsiveContainer>
            <BarChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="label" fontSize={12} /><YAxis tickFormatter={axis} fontSize={12} width={60} />
              <Tooltip formatter={(v: number) => pkr(v)} /><Legend />
              <Bar dataKey="cash" name="Cash at bank" fill="hsl(160 75% 35%)" /><Bar dataKey="receivables" name="Trade receivables" fill="hsl(30 80% 50%)" />
            </BarChart>
          </ResponsiveContainer></div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title="Top audit findings (live)" subtitle={`${d.checkCounts.critical} critical · ${d.checkCounts.high} high · ${d.checkCounts.total} total`} actions={<Link className="text-sm text-primary font-medium" to="/audit">All checks →</Link>}>
          <ul className="divide-y divide-slate-100">
            {d.checks.map((c: any) => (
              <li key={c.code} className="py-2.5 flex gap-3 items-start">
                <Badge tone={c.severity}>{c.severity}</Badge>
                <div className="text-sm"><div className="font-medium text-foreground">{c.title}</div><div className="text-muted-foreground text-xs mt-0.5 line-clamp-2">{c.recommendation}</div></div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="13-week cash forecast" subtitle={`From ${dmy(p.startDate)} · opening ${pkr(p.openingCash, { compact: true })}`}>
          <div className="h-64"><ResponsiveContainer>
            <BarChart data={p.weeks.map((w: any) => ({ ...w, label: `W${w.week}` }))}>
              <XAxis dataKey="label" fontSize={11} /><YAxis tickFormatter={axis} fontSize={11} width={55} /><Tooltip formatter={(v: number) => pkr(v)} labelFormatter={(l, x: any) => x?.[0]?.payload ? `${x[0].payload.from} → ${x[0].payload.to}` : l} />
              <ReferenceLine y={0} stroke="#64748b" />
              <Bar dataKey="closing" name="Closing cash">{p.weeks.map((w: any) => <Cell key={w.week} fill={w.closing < 0 ? "hsl(350 75% 50%)" : "hsl(210 85% 40%)"} />)}</Bar>
            </BarChart>
          </ResponsiveContainer></div>
          <div className="text-xs text-muted-foreground">Funding gap: <b className="text-rose-600">PKR {pkr(p.summary.fundingGap)}</b></div>
        </Card>
      </div>
    </div>
  );
}
