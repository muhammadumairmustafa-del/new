/** Money is handled as integer "units" of 1/10000 PKR to avoid float drift. */
export const SCALE = 10000;
export const toUnits = (v: number | string | null | undefined): number =>
  Math.round(Number(v ?? 0) * SCALE);
export const fromUnits = (u: number): number => u / SCALE;
export const roundPkr = (v: number): number => Math.round(v);

export function formatPkr(v: number, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const n = Number(v) || 0;
  if (opts.compact) {
    const a = Math.abs(n);
    const s = n < 0 ? "-" : "";
    if (a >= 1e7) return `${s}${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e6) return `${s}${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${s}${(a / 1e3).toFixed(0)}K`;
    return `${s}${a.toFixed(0)}`;
  }
  const r = Math.round(n);
  const str = Math.abs(r).toLocaleString("en-PK");
  if (r < 0) return `(${str})`;
  return opts.sign && r > 0 ? `+${str}` : str;
}
