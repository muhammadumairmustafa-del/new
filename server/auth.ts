import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Db } from "./db.js";

export type Role = "partner" | "accountant" | "viewer";
export interface SessionUser { id: number; username: string; fullName: string; role: Role }
declare global { namespace Express { interface Request { user?: SessionUser } } }

const COOKIE = "tp_session";
const SESSION_DAYS = 7;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, keyHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !keyHex) return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  const want = Buffer.from(keyHex, "hex");
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}
export function passwordProblem(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 10) return "Password must be at least 10 characters";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers";
  return null;
}
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export async function createSession(db: Db, res: Response, userId: number) {
  const token = crypto.randomBytes(32).toString("base64url");
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)", [sha(token), userId, exp.toISOString()]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", expires: exp, path: "/" });
}
export async function destroySession(db: Db, req: Request, res: Response) {
  const t = req.cookies?.[COOKIE];
  if (t) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha(t)]);
  res.clearCookie(COOKIE, { path: "/" });
}
export function sessionMiddleware(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const t = req.cookies?.[COOKIE];
      if (t) {
        const r = await db.query<any>(
          `SELECT u.id, u.username, u.full_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha(t)]);
        if (r[0]) req.user = { id: r[0].id, username: r[0].username, fullName: r[0].full_name, role: r[0].role };
      }
      next();
    } catch (e) { next(e); }
  };
}
const rank: Record<Role, number> = { viewer: 1, accountant: 2, partner: 3 };
export const requireRole = (min: Role) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: "Not signed in" });
  if (rank[req.user.role] < rank[min]) return res.status(403).json({ error: "You do not have permission for this action" });
  next();
};

/** Very small in-memory login throttle: 8 failures per 15 minutes per IP+username. */
const fails = new Map<string, { n: number; until: number }>();
export function loginThrottled(key: string) { const f = fails.get(key); return !!f && f.n >= 8 && f.until > Date.now(); }
export function loginFailed(key: string) { const f = fails.get(key); const until = Date.now() + 15 * 60000; fails.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until }); }
export function loginOk(key: string) { fails.delete(key); }
