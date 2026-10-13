import React, { createContext, useContext, useEffect, useState } from "react";
import { NavLink, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { LayoutDashboard, FileSpreadsheet, Wallet, Landmark, Users, BookOpen, ShieldAlert, Upload, Settings as Cog, LogOut, Receipt, Sun, Moon, TrendingUp } from "lucide-react";
import { api, useApi } from "./api";
import { cx } from "./components/ui";
import { fyLabel } from "./format";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Statements from "./pages/Statements";
import CashPlan from "./pages/CashPlan";
import Tax from "./pages/Tax";
import Receivables from "./pages/Receivables";
import Revenue from "./pages/Revenue";
import Partners from "./pages/Partners";
import Ledger from "./pages/Ledger";
import Audit from "./pages/Audit";
import ImportPage from "./pages/Import";
import Settings from "./pages/Settings";

interface Period { fy: number; setFy: (n: number) => void; proposed: boolean; setProposed: (b: boolean) => void; meta: any }
const Ctx = createContext<Period>(null as any);
export const usePeriod = () => useContext(Ctx);

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/statements", label: "Financial statements", icon: FileSpreadsheet },
  { to: "/revenue", label: "Revenue (Sales Flow Pro)", icon: TrendingUp },
  { to: "/cash-plan", label: "Cash & payment plan", icon: Wallet },
  { to: "/tax", label: "Tax", icon: Landmark },
  { to: "/receivables", label: "Receivables", icon: Receipt },
  { to: "/partners", label: "Partners", icon: Users },
  { to: "/ledger", label: "Ledger & journals", icon: BookOpen },
  { to: "/audit", label: "Audit & questions", icon: ShieldAlert },
  { to: "/import", label: "Import accounts", icon: Upload },
  { to: "/settings", label: "Settings", icon: Cog },
];

function readLS(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function writeLS(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export default function App() {
  const status = useApi<{ needsSetup: boolean; user: any }>("/auth/status");
  if (status.isLoading) return <div className="p-10 text-slate-500">Loading…</div>;
  if (!status.data?.user) return <Login needsSetup={!!status.data?.needsSetup} />;
  return <Shell user={status.data.user} />;
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => (readLS("tp.theme") as any) || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); writeLS("tp.theme", theme); }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "light" ? "dark" : "light")) };
}

function ToolbarButton({ to, label, icon: Icon }: { to: string; label: string; icon: any }) {
  return (
    <NavLink to={to} end={to === "/"} aria-label={label} className={({ isActive }) => cx("group relative flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200",
      isActive ? "text-amber-500 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40" : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800")}>
      <Icon className="w-[18px] h-[18px]" />
      <span className="pointer-events-none absolute bottom-full mb-3 px-2 py-1 rounded-md text-xs whitespace-nowrap bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 opacity-0 group-hover:opacity-100 transition">{label}</span>
    </NavLink>
  );
}

function FloatingToolbar({ user, theme, toggleTheme }: { user: any; theme: string; toggleTheme: () => void }) {
  const [open, setOpen] = useState(false);
  const logout = async () => { await api("/auth/logout", { method: "POST" }); location.href = "/"; };
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 no-print">
      <div className="relative flex items-center h-12 px-4 gap-1 rounded-3xl shadow-[0_8px_32px_rgba(0,0,0,0.18),0_2px_8px_rgba(0,0,0,0.12)] backdrop-blur-md bg-white/90 dark:bg-zinc-950/90 text-zinc-950 dark:text-white border border-zinc-200/50 dark:border-zinc-800/50">
        {NAV.filter((n) => n.to !== "/settings").map((n) => <ToolbarButton key={n.to} to={n.to} label={n.label} icon={n.icon} />)}
        <div className="w-px h-5 bg-zinc-300 dark:bg-zinc-700 mx-1" />
        <button onClick={toggleTheme} aria-label="Toggle theme" className="group relative flex items-center justify-center w-9 h-9 rounded-xl text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800">
          {theme === "light" ? <Moon className="w-[18px] h-[18px]" /> : <Sun className="w-[18px] h-[18px]" />}
        </button>
        <div className="w-px h-5 bg-zinc-300 dark:bg-zinc-700 mx-1" />
        <div className="relative">
          <button onClick={() => setOpen(!open)} aria-label="User menu" className="flex items-center justify-center w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700 text-xs font-bold hover:ring-1 hover:ring-zinc-400">{user.fullName?.charAt(0) ?? "?"}</button>
          {open && (
            <div className="absolute bottom-full right-0 mb-3 min-w-[200px] py-1.5 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-[0_8px_32px_rgba(0,0,0,0.16)]" onMouseLeave={() => setOpen(false)}>
              <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800"><div className="text-sm font-semibold">{user.fullName}</div><div className="text-xs text-zinc-500 capitalize">{user.role}</div></div>
              <NavLink to="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"><Cog size={15} />Settings &amp; users</NavLink>
              <button onClick={logout} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-rose-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"><LogOut size={15} />Sign out</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Shell({ user }: { user: any }) {
  const meta = useApi<any>("/meta");
  const { theme, toggle } = useTheme();
  const [fy, setFyState] = useState<number>(() => Number(readLS("tp.fy")) || 0);
  const [proposed, setProposed] = useState(false);
  const setFy = (n: number) => { setFyState(n); writeLS("tp.fy", String(n)); };
  useEffect(() => {
    const fys: number[] = meta.data?.fiscalYears ?? [];
    if (fys.length && !fys.includes(fy)) setFy(meta.data?.defaultFy && fys.includes(meta.data.defaultFy) ? meta.data.defaultFy : fys[fys.length - 1]);
  }, [meta.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const fys: number[] = meta.data?.fiscalYears ?? [];
  const loc = useLocation();
  const here = NAV.find((n) => (n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to)));
  return (
    <Ctx.Provider value={{ fy, setFy, proposed, setProposed, meta: meta.data }}>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-40 bg-background/85 backdrop-blur border-b border-border no-print">
          <div className="max-w-[1500px] mx-auto px-6 h-14 flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary text-primary-foreground grid place-items-center text-xs font-bold">TP</div>
              <div className="leading-tight"><div className="text-sm font-bold tracking-tight">TonePerks</div><div className="text-[10px] text-muted-foreground -mt-0.5">{here?.label ?? "Finance"}</div></div>
            </div>
            <div className="hidden md:block text-xs text-muted-foreground ml-4">
              {meta.data?.lastDate ? <>Books up to <b className="text-foreground">{meta.data.lastDate}</b> · {meta.data.entries} journal entries</> : "No accounts imported yet"}
            </div>
            <div className="flex-1" />
            {meta.data?.proposedAdjustments > 0 && (
              <label className={cx("text-xs flex items-center gap-2 px-2.5 py-1.5 rounded-md border cursor-pointer", proposed ? "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-200" : "border-border text-muted-foreground")}>
                <input type="checkbox" checked={proposed} onChange={(e) => setProposed(e.target.checked)} />Show with {meta.data.proposedAdjustments} proposed adjustments
              </label>
            )}
            {fys.length > 0 && (
              <select className="input" value={fy} onChange={(e) => setFy(Number(e.target.value))}>
                {fys.map((f) => <option key={f} value={f}>{fyLabel(f)}</option>)}
              </select>
            )}
          </div>
        </header>
        <main className="max-w-[1500px] mx-auto px-6 pt-6 pb-32">
          {meta.data && meta.data.entries === 0 && !loc.pathname.startsWith("/import") && !loc.pathname.startsWith("/settings") ? <Navigate to="/import" /> : (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/statements" element={<Statements />} />
              <Route path="/cash-plan" element={<CashPlan />} />
              <Route path="/tax" element={<Tax />} />
              <Route path="/receivables" element={<Receivables />} />
              <Route path="/revenue" element={<Revenue />} />
              <Route path="/partners" element={<Partners />} />
              <Route path="/ledger" element={<Ledger />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          )}
        </main>
        <FloatingToolbar user={user} theme={theme} toggleTheme={toggle} />
      </div>
    </Ctx.Provider>
  );
}
