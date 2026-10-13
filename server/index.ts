import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 5000;
const clientDir = [path.resolve(here, "../../dist"), path.resolve(here, "../dist")].find((p) => fs.existsSync(path.join(p, "index.html")));
const { app, db } = createApp({ clientDir });
await db.ready();
const server = app.listen(port, "0.0.0.0", () => console.log(`TonePerks finance API on :${port}${clientDir ? " (serving client)" : ""} · db: ${process.env.DATABASE_URL ? "postgres" : "embedded (./.data)"}`));

// Close the database cleanly so the embedded store is never left half-written.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => { server.close(); db.close().finally(() => process.exit(0)); });
}
