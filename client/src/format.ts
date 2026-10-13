export { formatPkr as pkr } from "@shared/money";
export { monthLabel } from "@shared/fiscal";
export const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !isFinite(v) ? "–" : `${(v * 100).toFixed(d)}%`);
export const dmy = (iso: string | null | undefined) => {
  if (!iso) return "–";
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
};
export const fyLabel = (fy: number) => `FY${fy} (Jul ${fy - 1} – Jun ${fy})`;
