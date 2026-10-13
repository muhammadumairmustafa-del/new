import React, { useState } from "react";
import { api } from "../api";
import { Button, Callout, Field } from "../components/ui";

export default function Login({ needsSetup }: { needsSetup: boolean }) {
  const [username, setU] = useState(""); const [password, setP] = useState(""); const [fullName, setN] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api(needsSetup ? "/auth/setup" : "/auth/login", { body: needsSetup ? { username, password, fullName } : { username, password } });
      location.reload();
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-900 to-brand-700 p-4">
      <form onSubmit={submit} className="bg-card rounded-2xl shadow-xl w-full max-w-sm p-7 space-y-4">
        <div>
          <h1 className="text-xl font-semibold">TonePerks Finance</h1>
          <p className="text-sm text-muted-foreground">{needsSetup ? "First-time setup: create the partner (administrator) account." : "Sign in to continue."}</p>
        </div>
        {needsSetup && <Field label="Full name"><input className="input w-full" value={fullName} onChange={(e) => setN(e.target.value)} required /></Field>}
        <Field label="Username"><input className="input w-full" autoComplete="username" value={username} onChange={(e) => setU(e.target.value)} required /></Field>
        <Field label="Password"><input className="input w-full" type="password" autoComplete={needsSetup ? "new-password" : "current-password"} value={password} onChange={(e) => setP(e.target.value)} required /></Field>
        {needsSetup && <p className="text-xs text-muted-foreground">At least 10 characters with letters and numbers.</p>}
        {err && <Callout tone="bad">{err}</Callout>}
        <Button className="w-full justify-center" disabled={busy}>{needsSetup ? "Create account" : "Sign in"}</Button>
      </form>
    </div>
  );
}
