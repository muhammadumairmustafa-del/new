import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { sessionMiddleware } from "./auth.js";
import { apiRouter, errorHandler } from "./routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 5000;

const db = await openDb();
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
app.use(sessionMiddleware(db));
// CSRF defence: state-changing API calls must come from our own pages (same-origin header set by the client).
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-requested-with") !== "toneperks") return res.status(403).json({ error: "Missing request header" });
  next();
});
app.use("/api", apiRouter(db));
app.use("/api", errorHandler);

const clientDist = [path.resolve(here, "../../dist"), path.resolve(here, "../dist")].find((p) => fs.existsSync(path.join(p, "index.html")));
if (clientDist) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}
app.listen(port, "0.0.0.0", () => console.log(`TonePerks finance API on :${port}${clientDist ? " (serving client)" : ""} · db: ${process.env.DATABASE_URL ? "postgres" : "embedded (./.data)"}`));
