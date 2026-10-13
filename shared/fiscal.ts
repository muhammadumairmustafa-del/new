/** Pakistan fiscal year runs 1 July – 30 June. "FY2027" = Jul 2026 – Jun 2027 = Tax Year 2027. */
export function fiscalYearOf(dateIso: string): number {
  const [y, m] = dateIso.split("-").map(Number);
  return m >= 7 ? y + 1 : y;
}
export function fyRange(fy: number): { from: string; to: string } {
  return { from: `${fy - 1}-07-01`, to: `${fy}-06-30` };
}
export function monthKey(dateIso: string): string { return dateIso.slice(0, 7); }
export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
export function addDays(dateIso: string, days: number): string {
  const d = new Date(dateIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
export const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
};
