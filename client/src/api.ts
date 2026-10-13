import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export class ApiError extends Error { constructor(msg: string, public status: number) { super(msg); } }
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body || opts.form ? "POST" : "GET"),
    headers: { "x-requested-with": "toneperks", ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ? `${data.error}${data.issues ? ": " + data.issues.join("; ") : ""}` : res.statusText, res.status);
  return data as T;
}
export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(v === true ? "1" : String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};
export const useApi = <T = any,>(path: string | null, deps: unknown[] = []) =>
  useQuery<T>({ queryKey: [path, ...deps], queryFn: () => api<T>(path!), enabled: !!path });
export function useMut<V = any>(fn: (v: V) => Promise<any>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries() });
}
