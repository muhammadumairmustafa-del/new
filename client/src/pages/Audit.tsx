import React, { useState } from "react";
import { api, useApi, useMut, qs } from "../api";
import { usePeriod } from "../App";
import { Badge, Button, Callout, Card, Loading, Money, Tabs } from "../components/ui";
import { dmy } from "../format";

type Tab = "checks" | "findings" | "questions";
export default function Audit() {
  const [tab, setTab] = useState<Tab>("checks");
  const qn = useApi<any[]>("/questions");
  const open = qn.data?.filter((q) => q.status === "open").length ?? 0;
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-1">Audit &amp; questions</h1>
      <p className="text-sm text-muted-foreground mb-4">Automated checks re-run on every visit against the live ledger. The findings register and questions hold the reviewer's points and your answers.</p>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "checks", label: "Automated checks" }, { id: "findings", label: "Findings register" }, { id: "questions", label: `Questions${open ? ` (${open} open)` : ""}` }]} />
      {tab === "checks" && <Checks />}
      {tab === "findings" && <Findings />}
      {tab === "questions" && <Questions />}
    </div>
  );
}

function Checks() {
  const { proposed } = usePeriod();
  const q = useApi<any>(`/checks${qs({ proposed })}`, [proposed]);
  if (!q.data) return <Loading q={q} />;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">As at {dmy(q.data.asOf)} (latest books).</p>
      {q.data.checks.map((c: any) => (
        <Card key={c.code}>
          <div className="flex gap-3 items-start pt-4">
            <Badge tone={c.severity}>{c.severity}</Badge>
            <div className="flex-1">
              <div className="flex justify-between gap-4"><h3 className="font-semibold">{c.title}</h3>{c.amount !== null && <Money v={c.amount} className="font-semibold" />}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{c.code} · {c.area}</div>
              <p className="text-sm text-foreground/80 mt-2">{c.detail}</p>
              <p className="text-sm mt-2"><span className="font-medium text-emerald-700">Action: </span>{c.recommendation}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Findings() {
  const q = useApi<any[]>("/findings");
  const upd = useMut(({ id, ...b }: any) => api(`/findings/${id}`, { method: "PATCH", body: b }));
  const [msg, setMsg] = useState<string | null>(null);
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append("file", f);
    try { const r = await api("/review-pack", { form: fd }); setMsg(`Loaded ${r.findings} findings, ${r.questions} questions, ${r.proposedEntries} proposed adjusting entries.`); q.refetch(); }
    catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="space-y-4">
      <Card title="Load a review pack" subtitle="A JSON file from your reviewer containing findings, questions and proposed adjusting entries. Re-loading updates existing items.">
        <input type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        {msg && <div className="mt-2"><Callout tone="info">{msg}</Callout></div>}
      </Card>
      {!q.data ? <Loading q={q} /> : q.data.length === 0 ? <Callout tone="info">No findings recorded yet.</Callout> : q.data.map((f) => (
        <Card key={f.id}>
          <div className="flex gap-3 items-start pt-4">
            <Badge tone={f.severity}>{f.severity}</Badge>
            <div className="flex-1">
              <div className="flex justify-between gap-4"><h3 className="font-semibold">{f.code && <span className="text-muted-foreground mr-2">{f.code}</span>}{f.title}</h3>{f.impact !== null && <Money v={Number(f.impact)} className="font-semibold" />}</div>
              <div className="text-xs text-muted-foreground">{f.area}{f.owner && ` · owner: ${f.owner}`}{f.due_date && ` · due ${dmy(f.due_date)}`}</div>
              <p className="text-sm text-foreground/80 mt-2 whitespace-pre-line">{f.detail}</p>
              {f.recommendation && <p className="text-sm mt-2 whitespace-pre-line"><span className="font-medium text-emerald-700">Recommendation: </span>{f.recommendation}</p>}
              <div className="mt-3 flex gap-2 items-center">
                <select className="input" value={f.status} onChange={(e) => upd.mutate({ id: f.id, status: e.target.value })}><option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="accepted">Risk accepted</option></select>
                <input className="input" placeholder="Owner" defaultValue={f.owner ?? ""} onBlur={(e) => e.target.value !== (f.owner ?? "") && upd.mutate({ id: f.id, owner: e.target.value || null })} />
              </div>
            </div>
          </div>
        </Card>))}
    </div>
  );
}

function Questions() {
  const q = useApi<any[]>("/questions");
  const ans = useMut(({ id, answer }: any) => api(`/questions/${id}`, { method: "PATCH", body: { answer } }));
  const [draft, setDraft] = useState<Record<number, string>>({});
  if (!q.data) return <Loading q={q} />;
  if (!q.data.length) return <Callout tone="info">No questions yet. Load a review pack on the Findings tab.</Callout>;
  const topics = [...new Set(q.data.map((x) => x.topic))];
  return (
    <div className="space-y-6">
      {topics.map((t) => (
        <Card key={t} title={t}>
          <ul className="divide-y divide-slate-100">
            {q.data!.filter((x) => x.topic === t).map((x) => (
              <li key={x.id} className="py-3">
                <div className="flex gap-2 items-start"><Badge tone={x.status === "open" ? "high" : "good"}>{x.status}</Badge><div className="flex-1"><div className="font-medium text-sm">{x.code && <span className="text-muted-foreground mr-1">{x.code}</span>}{x.question}</div>{x.why && <div className="text-xs text-muted-foreground mt-0.5">Why it matters: {x.why}</div>}</div></div>
                {x.answer && <div className="mt-2 ml-14 text-sm bg-emerald-50 rounded p-2 whitespace-pre-line">{x.answer}<div className="text-xs text-muted-foreground mt-1">— {x.answered_by_name ?? "?"}, {dmy(x.answered_at)}</div></div>}
                <div className="mt-2 ml-14 flex gap-2">
                  <textarea className="input flex-1" rows={2} placeholder={x.answer ? "Update answer…" : "Your answer…"} value={draft[x.id] ?? ""} onChange={(e) => setDraft({ ...draft, [x.id]: e.target.value })} />
                  <Button size="sm" disabled={!draft[x.id]?.trim()} onClick={() => ans.mutate({ id: x.id, answer: draft[x.id] }, { onSuccess: () => setDraft({ ...draft, [x.id]: "" }) })}>Save</Button>
                </div>
              </li>))}
          </ul>
        </Card>))}
    </div>
  );
}
