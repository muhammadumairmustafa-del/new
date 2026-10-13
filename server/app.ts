import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { openDb, type Db } from "./db.js";
import { sessionMiddleware } from "./auth.js";
import { apiRouter, errorHandler } from "./routes.js";

/** A Db that connects on first use (so a serverless cold start does not block on import). */
function lazyDb(): Db & { ready: () => Promise<Db> } {
  let p: Promise<Db> | null = null;
  const ready = () => (p ??= openDb().catch((e) => { p = null; throw e; }));
  return {
    ready,
    query: async (sql, params) => (await ready()).query(sql, params),
    tx: async (fn) => (await ready()).tx(fn),
    close: async () => { if (p) await (await p).close(); },
  };
}

export function createApp(opts: { clientDir?: string } = {}) {
  const db = lazyDb();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  // Surface a clear message if the database is not configured / reachable.
  app.use("/api", (req, res, next) => { db.ready().then(() => next(), (e) => res.status(503).json({ error: String(e.message ?? e), code: "db_unavailable" })); });
  app.use(sessionMiddleware(db));
  // CSRF defence: state-changing API calls must come from our own pages.
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.get("x-requested-with") !== "toneperks") return res.status(403).json({ error: "Missing request header" });
    next();
  });
  app.use("/api", apiRouter(db));
  app.use("/api", errorHandler);
  if (opts.clientDir && fs.existsSync(path.join(opts.clientDir, "index.html"))) {
    app.use(express.static(opts.clientDir, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) => res.sendFile(path.join(opts.clientDir!, "index.html")));
  }
  return { app, db };
}
