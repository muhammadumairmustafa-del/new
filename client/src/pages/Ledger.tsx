import React, { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, useApi, useMut, qs } from "../api";
import { usePeriod } from "../App";
import { Badge, Button, Callout, Card, Field, Loading, Modal, Money, Tabs } from "../components/ui";
import { dmy, pkr } from "../format";

type Tab = "accounts" | "journal";
export default function Ledger() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [account, setAccount] = useState<number | null>(null);
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight mb-4">Ledger &amp; journals</h1>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "accounts", label: "Chart of accounts" }, { id: "journal", label: "Journal entries" }]} />
      {tab === "accounts" && (account ? <AccountLedger id={account} onBack={() => setAccount(null)} /> : <Accounts onOpen={setAccount} />)}
      {tab === "journal" && <Journal />}
    </div>
  );
}

function Accounts({ onOpen }: { onOpen: (id: number) => void }) {
  const { proposed } = usePeriod();
  const q = useApi<any>(`/accounts${qs({ proposed })}`, [proposed]);
  if (!q.data) return <Loading q={q} />;
  const groups = new Map<string, any[]>();
  for (const a of q.data.accounts) { const k = `${a.type}|${a.grp}`; groups.set(k, [...(groups.get(k) ?? []), a]); }
  return (
    <Card pad={false}>
      <table className="tbl"><thead><tr><th>Code</th><th>Account</th><th>Statement line</th><th>Role</th><th className="num">Balance (Dr +)</th></tr></thead>
        <tbody>{[...groups.entries()].map(([k, list]) => (
          <React.Fragment key={k}>
            <tr className="section"><td colSpan={5}>{k.split("|")[1]} <span className="text-xs text-muted-foreground font-normal">({k.split("|")[0]})</span></td></tr>
            {list.map((a) => <tr key={a.id} className="cursor-pointer hover:bg-primary/5" onClick={() => onOpen(a.id)}><td className="text-muted-foreground">{a.code}</td><td className="font-medium text-primary">{a.name}</td><td className="text-muted-foreground">{a.fs_line}</td><td>{a.system_role && <Badge tone="info">{a.system_role}</Badge>}{a.party_type && <Badge>{a.party_type}</Badge>}</td><td className="num"><Money v={a.balance} /></td></tr>)}
          </React.Fragment>))}</tbody></table>
    </Card>
  );
}

function AccountLedger({ id, onBack }: { id: number; onBack: () => void }) {
  const { fy, proposed } = usePeriod();
  const q = useApi<any>(`/ledger/${id}${qs({ fy, proposed })}`, [id, fy, proposed]);
  const [entry, setEntry] = useState<number | null>(null);
  if (!q.data) return <Loading q={q} />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack}>← All accounts</Button>
      <Card pad={false} title={`${d.account.code} · ${d.account.name}`} subtitle={`${dmy(d.from)} – ${dmy(d.to)} · opening ${pkr(d.opening)} · positive = debit`}>
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Date</th><th>Ref</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
          <tbody>{d.rows.map((r: any, i: number) => <tr key={i} className="cursor-pointer hover:bg-muted/50" onClick={() => setEntry(r.entryId)}><td className="whitespace-nowrap">{dmy(r.date)}</td><td className="text-xs text-muted-foreground whitespace-nowrap">{r.ref}{r.kind !== "normal" && <> <Badge tone="medium">{r.kind}</Badge></>}</td><td>{r.memo}</td><td className="num"><Money v={r.debit || null} /></td><td className="num"><Money v={r.credit || null} /></td><td className="num font-medium"><Money v={r.balance} /></td></tr>)}</tbody>
        </table></div>
      </Card>
      {d.aging.layers.length > 0 && (
        <Card pad={false} title="What makes up the closing balance (first-in, first-out)">
          <table className="tbl"><thead><tr><th>Arose on</th><th>Description</th><th className="num">Days</th><th className="num">Amount</th></tr></thead>
            <tbody>{d.aging.layers.map((l: any, i: number) => <tr key={i}><td>{dmy(l.date)}</td><td>{l.memo}</td><td className="num">{l.days}</td><td className="num"><Money v={l.amount} /></td></tr>)}</tbody></table>
        </Card>
      )}
      {entry && <EntryModal id={entry} onClose={() => setEntry(null)} />}
    </div>
  );
}

function Journal() {
  const [search, setSearch] = useState(""); const [kind, setKind] = useState("");
  const q = useApi<any[]>(`/journal${qs({ q: search, kind })}`, [search, kind]);
  const [entry, setEntry] = useState<number | null>(null);
  const [create, setCreate] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center flex-wrap">
        <input className="input w-72" placeholder="Search memo, reference, account…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option><option value="normal">Normal</option><option value="adjustment">Adjustments</option><option value="proposed">Proposed</option></select>
        <div className="flex-1" />
        <Button onClick={() => setCreate(true)}><Plus size={15} />New journal entry</Button>
      </div>
      {!q.data ? <Loading q={q} /> : (
        <Card pad={false} subtitle="Latest 500 entries">
          <table className="tbl"><thead><tr><th>Date</th><th>Ref</th><th>Memo</th><th>Accounts</th><th className="num">Amount</th><th>Source</th></tr></thead>
            <tbody>{q.data.map((e) => <tr key={e.id} className={`cursor-pointer hover:bg-muted/50 ${e.status === "void" ? "line-through text-muted-foreground" : ""}`} onClick={() => setEntry(e.id)}>
              <td className="whitespace-nowrap">{dmy(e.entry_date)}</td><td className="text-xs whitespace-nowrap">{e.ref}</td><td className="max-w-sm truncate">{e.memo}</td><td className="text-xs text-muted-foreground max-w-xs truncate">{e.accounts}</td>
              <td className="num"><Money v={e.total} /></td><td>{e.kind !== "normal" ? <Badge tone={e.kind === "proposed" ? "medium" : "info"}>{e.kind}</Badge> : <span className="text-xs text-muted-foreground">{e.source.startsWith("import") ? "import" : e.source}</span>}</td></tr>)}</tbody></table>
        </Card>)}
      {entry && <EntryModal id={entry} onClose={() => setEntry(null)} />}
      {create && <NewEntry onClose={() => setCreate(false)} />}
    </div>
  );
}

function EntryModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { meta } = usePeriod();
  const q = useApi<any>(`/journal/${id}`, [id]);
  const voidM = useMut(() => api(`/journal/${id}/void`, { method: "POST" }));
  const accept = useMut(() => api(`/journal/${id}/accept`, { method: "POST" }));
  const e = q.data;
  return (
    <Modal wide title={e ? `${e.ref ?? "Entry"} · ${dmy(e.entry_date)}` : "Entry"} onClose={onClose}>
      {!e ? <Loading q={q} /> : (
        <div className="space-y-3">
          <p className="text-sm">{e.memo}</p>
          <p className="text-xs text-muted-foreground">Source: {e.source} · {e.kind} · {e.status}</p>
          <table className="tbl"><thead><tr><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>{e.lines.map((l: any) => <tr key={l.id}><td>{l.code} · {l.name}</td><td className="text-xs text-muted-foreground">{l.description}</td><td className="num"><Money v={l.debit || null} /></td><td className="num"><Money v={l.credit || null} /></td></tr>)}</tbody></table>
          {e.status === "posted" && meta?.user?.role !== "viewer" && (
            <div className="flex justify-end gap-2">
              {e.kind === "proposed" && meta?.user?.role === "partner" && <Button onClick={() => accept.mutate(undefined, { onSuccess: onClose })}>Accept adjustment into the books</Button>}
              <Button variant="danger" onClick={() => { if (confirm("Void this entry? It stays visible but stops affecting balances.")) voidM.mutate(undefined, { onSuccess: onClose }); }}><Trash2 size={14} />Void</Button>
            </div>)}
        </div>)}
    </Modal>
  );
}

function NewEntry({ onClose }: { onClose: () => void }) {
  const accts = useApi<any>("/accounts");
  const { meta } = usePeriod();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [ref, setRef] = useState(""); const [memo, setMemo] = useState(""); const [kind, setKind] = useState("normal");
  const [lines, setLines] = useState([{ accountId: 0, debit: "", credit: "", description: "" }, { accountId: 0, debit: "", credit: "", description: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const m = useMut((b: any) => api("/journal", { body: b }));
  const n = (s: string) => Number(s.replace(/,/g, "")) || 0;
  const totals = useMemo(() => lines.reduce((a, l) => ({ d: a.d + n(l.debit), c: a.c + n(l.credit) }), { d: 0, c: 0 }), [lines]);
  const set = (i: number, k: string, v: any) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const balanced = Math.abs(totals.d - totals.c) < 0.005 && totals.d > 0;
  return (
    <Modal wide title="New journal entry" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-4 gap-3">
          <Field label="Date"><input type="date" className="input w-full" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Reference"><input className="input w-full" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <Field label="Kind"><select className="input w-full" value={kind} onChange={(e) => setKind(e.target.value)}><option value="normal">Normal</option><option value="proposed">Proposed adjustment (not in books until accepted)</option>{meta?.user?.role === "partner" && <option value="adjustment">Adjustment</option>}</select></Field>
        </div>
        <Field label="Memo / narration"><input className="input w-full" value={memo} onChange={(e) => setMemo(e.target.value)} /></Field>
        <table className="tbl"><thead><tr><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th></th></tr></thead>
          <tbody>{lines.map((l, i) => <tr key={i}>
            <td><select className="input w-72" value={l.accountId} onChange={(e) => set(i, "accountId", Number(e.target.value))}><option value={0}>Select account…</option>{accts.data?.accounts.map((a: any) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></td>
            <td><input className="input w-full" value={l.description} onChange={(e) => set(i, "description", e.target.value)} /></td>
            <td><input className="input w-32 text-right" value={l.debit} onChange={(e) => set(i, "debit", e.target.value)} /></td>
            <td><input className="input w-32 text-right" value={l.credit} onChange={(e) => set(i, "credit", e.target.value)} /></td>
            <td>{lines.length > 2 && <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-rose-600"><Trash2 size={14} /></button>}</td></tr>)}
            <tr className="total"><td><Button size="sm" variant="ghost" onClick={() => setLines([...lines, { accountId: 0, debit: "", credit: "", description: "" }])}><Plus size={13} />Line</Button></td><td className="num">Totals</td><td className="num">{pkr(totals.d)}</td><td className="num">{pkr(totals.c)}</td><td></td></tr></tbody></table>
        {!balanced && totals.d + totals.c > 0 && <Callout tone="warn">Debits and credits must be equal (difference {pkr(totals.d - totals.c)}).</Callout>}
        {err && <Callout tone="bad">{err}</Callout>}
        <div className="flex justify-end"><Button disabled={!balanced || !memo || lines.some((l) => !l.accountId)} onClick={() => m.mutate({ date, ref: ref || null, memo, kind, lines: lines.map((l) => ({ accountId: l.accountId, debit: n(l.debit), credit: n(l.credit), description: l.description || null })) }, { onSuccess: onClose, onError: (e: any) => setErr(e.message) })}>Post entry</Button></div>
      </div>
    </Modal>
  );
}
