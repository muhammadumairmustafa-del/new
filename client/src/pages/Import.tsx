import React, { useState } from "react";
import { Upload } from "lucide-react";
import { api, useApi, useMut } from "../api";
import { Button, Callout, Card, Loading, Money } from "../components/ui";
import { dmy, pkr } from "../format";

export default function ImportPage() {
  const meta = useApi<any>("/meta");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const del = useMut((id: number) => api(`/imports/${id}`, { method: "DELETE" }));
  const run = async (dry: boolean) => {
    if (!file) return; setBusy(true); setErr(null);
    const fd = new FormData(); fd.append("file", file);
    try { const r = await api(`/import${dry ? "?dryRun=1" : ""}`, { form: fd }); if (dry) setPreview(r.summary); else { setDone(r.summary); setPreview(null); setFile(null); meta.refetch(); } }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-6 max-w-4xl">
      <div><h1 className="text-2xl font-bold tracking-tight">Import accounts</h1>
        <p className="text-sm text-muted-foreground">Upload the accountant's Excel workbook (year-end file with a "Journal Entries" sheet, or the monthly/quarterly file with "Data_Journal" and "Data_Invoices"). Import in date order: FY2026 first, then FY2027 periods. Re-importing a period replaces the previously imported entries for those dates; manual and adjusting entries are kept.</p></div>
      <Card title="1. Choose workbook">
        <label className="flex items-center gap-3 border-2 border-dashed border-border rounded-lg p-6 cursor-pointer hover:border-primary">
          <Upload className="text-muted-foreground" /><span className="text-sm">{file ? file.name : "Click to choose an .xlsx file"}</span>
          <input type="file" accept=".xlsx" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); setDone(null); }} />
        </label>
        <div className="mt-3"><Button disabled={!file || busy} onClick={() => run(true)}>{busy ? "Reading…" : "Preview"}</Button></div>
        {err && <div className="mt-3"><Callout tone="bad">{err}</Callout></div>}
      </Card>
      {preview && (
        <Card title="2. Check and confirm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Journal sheet</dt><dd>{preview.journalSheet ?? "–"}</dd>
            <dt className="text-muted-foreground">Invoice register</dt><dd>{preview.invoiceSheet ? `${preview.invoiceSheet} (${preview.invoices} invoices)` : "–"}</dd>
            <dt className="text-muted-foreground">Period</dt><dd>{dmy(preview.periodFrom)} – {dmy(preview.periodTo)}</dd>
            <dt className="text-muted-foreground">Entries / lines</dt><dd>{preview.entries} / {preview.lines}</dd>
            <dt className="text-muted-foreground">Debits = credits</dt><dd className={preview.debits === preview.credits ? "text-emerald-600" : "text-rose-600"}>{pkr(preview.debits)} / {pkr(preview.credits)}</dd>
            <dt className="text-muted-foreground">New accounts</dt><dd>{preview.newAccounts.length}</dd>
            <dt className="text-muted-foreground">Existing entries in this period</dt><dd>{preview.existingEntriesInPeriod}{preview.existingEntriesInPeriod > 0 && " (imported ones will be replaced)"}</dd>
            {Object.keys(preview.impliedRatios).length > 0 && <><dt className="text-muted-foreground">Profit-sharing ratios detected</dt><dd>{Object.entries(preview.impliedRatios).map(([k, v]: any) => `${k} ${(v * 100).toFixed(1)}%`).join(", ")}</dd></>}
          </dl>
          {preview.newAccounts.length > 0 && <details className="mt-3 text-sm"><summary className="cursor-pointer text-primary">Show new accounts and their classification</summary>
            <table className="tbl mt-2"><tbody>{preview.newAccounts.map((a: any) => <tr key={a.name}><td>{a.code}</td><td>{a.name}</td><td className="text-muted-foreground">{a.type} · {a.fs_line}</td><td>{a.party_type}</td></tr>)}</tbody></table></details>}
          {preview.warnings.length > 0 && <div className="mt-3"><Callout tone="warn" title="Warnings"><ul className="list-disc ml-4">{preview.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul></Callout></div>}
          <div className="mt-4"><Button disabled={busy} onClick={() => run(false)}>{busy ? "Importing…" : "Import into ledger"}</Button></div>
        </Card>
      )}
      {done && <Callout tone="info" title="Imported">{done.entries} entries from {dmy(done.periodFrom)} to {dmy(done.periodTo)}. Open Financial statements to review.</Callout>}
      <Card pad={false} title="Import history">
        {!meta.data ? <Loading q={meta} /> : (
          <table className="tbl"><thead><tr><th>When</th><th>File</th><th>Period</th><th className="num">Entries</th><th></th></tr></thead>
            <tbody>{meta.data.imports.map((i: any) => <tr key={i.id}><td>{dmy(i.created_at)}</td><td>{i.file_name}</td><td>{dmy(i.period_from)} – {dmy(i.period_to)}</td><td className="num">{i.entries}</td>
              <td>{meta.data.user?.role === "partner" && <Button size="sm" variant="ghost" onClick={() => confirm("Remove this import and all its entries?") && del.mutate(i.id)}>Remove</Button>}</td></tr>)}</tbody></table>)}
      </Card>
      <p className="text-xs text-muted-foreground">Uploaded workbooks are parsed in memory and not stored; only the journal lines and invoice register are saved to the database. Personal data such as CNICs is not imported.</p>
    </div>
  );
}
