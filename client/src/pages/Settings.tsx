import React, { useState } from "react";
import { api, useApi, useMut } from "../api";
import { usePeriod } from "../App";
import { Button, Callout, Card, Field, Loading } from "../components/ui";
import { dmy, fyLabel } from "../format";

export default function Settings() {
  const { meta } = usePeriod();
  const isPartner = meta?.user?.role === "partner";
  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <Password />
      {isPartner && <Company />}
      {isPartner && <Users />}
      {isPartner && <AuditLog />}
    </div>
  );
}

function Password() {
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card title="Change your password">
      <div className="flex gap-3 items-end flex-wrap">
        <Field label="Current"><input type="password" className="input" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="New (10+ chars, letters and numbers)"><input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Button onClick={async () => { try { await api("/auth/password", { body: { current: cur, next } }); setMsg("Password changed."); setCur(""); setNext(""); } catch (e: any) { setMsg(e.message); } }}>Change</Button>
      </div>
      {msg && <div className="mt-2 text-sm">{msg}</div>}
    </Card>
  );
}

function Company() {
  const q = useApi<any>("/settings/company"); const { meta } = usePeriod();
  const m = useMut((b: any) => api("/settings/company", { method: "PUT", body: b }));
  const [v, setV] = useState<any>(null);
  if (!q.data) return <Loading q={q} />;
  const val = v ?? q.data;
  return (
    <Card title="Company">
      <div className="flex gap-3 items-end flex-wrap">
        <Field label="Name"><input className="input w-64" value={val.name} onChange={(e) => setV({ ...val, name: e.target.value })} /></Field>
        <Field label="Default fiscal year when opening the app"><select className="input" value={val.defaultFy ?? ""} onChange={(e) => setV({ ...val, defaultFy: e.target.value ? Number(e.target.value) : null })}><option value="">Latest</option>{(meta?.fiscalYears ?? []).map((f: number) => <option key={f} value={f}>{fyLabel(f)}</option>)}</select></Field>
        <Button onClick={() => m.mutate(val)}>Save</Button>
      </div>
    </Card>
  );
}

function Users() {
  const q = useApi<any[]>("/users");
  const [f, setF] = useState({ username: "", fullName: "", role: "viewer", password: "" }); const [err, setErr] = useState<string | null>(null);
  const add = useMut((b: any) => api("/users", { body: b }));
  const upd = useMut(({ id, ...b }: any) => api(`/users/${id}`, { method: "PATCH", body: b }));
  return (
    <Card title="Users" subtitle="Partner: everything · Accountant: import, journals, plans · Viewer: read-only and can answer questions">
      {!q.data ? <Loading q={q} /> : (
        <table className="tbl mb-4"><thead><tr><th>User</th><th>Name</th><th>Role</th><th>Active</th><th></th></tr></thead>
          <tbody>{q.data.map((u) => <tr key={u.id}><td>{u.username}</td><td>{u.full_name}</td>
            <td><select className="input" value={u.role} onChange={(e) => upd.mutate({ id: u.id, role: e.target.value })}><option value="partner">Partner</option><option value="accountant">Accountant</option><option value="viewer">Viewer</option></select></td>
            <td><input type="checkbox" checked={u.active} onChange={(e) => upd.mutate({ id: u.id, active: e.target.checked })} /></td>
            <td><Button size="sm" variant="ghost" onClick={() => { const p = prompt("New password for " + u.username); if (p) upd.mutate({ id: u.id, password: p }, { onError: (e: any) => alert(e.message) }); }}>Reset password</Button></td></tr>)}</tbody></table>)}
      <div className="flex gap-2 items-end flex-wrap">
        <Field label="Username"><input className="input w-32" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Full name"><input className="input w-44" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label="Role"><select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="viewer">Viewer</option><option value="accountant">Accountant</option><option value="partner">Partner</option></select></Field>
        <Field label="Initial password"><input type="password" className="input w-40" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Button onClick={() => add.mutate(f, { onSuccess: () => { setF({ username: "", fullName: "", role: "viewer", password: "" }); setErr(null); }, onError: (e: any) => setErr(e.message) })}>Add user</Button>
      </div>
      {err && <div className="mt-2"><Callout tone="bad">{err}</Callout></div>}
    </Card>
  );
}

function AuditLog() {
  const q = useApi<any[]>("/audit-log");
  return (
    <Card pad={false} title="Activity log" subtitle="Who changed what (latest 300)">
      {!q.data ? <Loading q={q} /> : <div className="max-h-96 overflow-y-auto"><table className="tbl"><tbody>{q.data.map((a) => <tr key={a.id}><td className="whitespace-nowrap text-xs">{dmy(a.at)} {String(a.at).slice(11, 16)}</td><td>{a.full_name ?? "system"}</td><td className="font-medium">{a.action}</td><td className="text-xs text-muted-foreground max-w-md truncate">{a.detail ? JSON.stringify(a.detail) : ""}</td></tr>)}</tbody></table></div>}
    </Card>
  );
}
