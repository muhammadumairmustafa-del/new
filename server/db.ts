import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal database adapter. Uses PostgreSQL when DATABASE_URL is set
 * (e.g. Replit / Neon / any managed Postgres) and an embedded PGlite
 * database in ./.data otherwise, so the app runs with zero setup.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (q: Db["query"]) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function schemaSql(): string {
  const candidates = [path.join(here, "schema.sql"), path.join(here, "../../server/schema.sql")];
  for (const c of candidates) if (fs.existsSync(c)) return fs.readFileSync(c, "utf8");
  throw new Error("schema.sql not found");
}

export async function openDb(opts: { url?: string; dataDir?: string; memory?: boolean } = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL;
  let db: Db;
  if (url && !opts.memory) {
    const pg = (await import("pg")).default;
    pg.types.setTypeParser(1700, (v: string) => v); // numeric stays a string; converted explicitly
    pg.types.setTypeParser(1082, (v: string) => v); // date stays YYYY-MM-DD
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    db = {
      async query(sql, params = []) { return (await pool.query(sql, params as any[])).rows; },
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const r = await fn(async (s, p = []) => (await client.query(s, p as any[])).rows);
          await client.query("COMMIT");
          return r;
        } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite, types } = await import("@electric-sql/pglite");
    const dir = opts.memory ? undefined : (opts.dataDir ?? path.resolve(".data/pglite"));
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      // The embedded database is single-process: refuse to open it twice (that corrupts it).
      const lock = path.join(dir, "..", `${path.basename(dir)}.lock`);
      if (fs.existsSync(lock)) {
        const pid = Number(fs.readFileSync(lock, "utf8"));
        let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* not running */ }
        if (alive && pid !== process.pid) throw new Error(`Embedded database ${dir} is already in use by process ${pid}. Stop it first, or set DATABASE_URL.`);
      }
      fs.writeFileSync(lock, String(process.pid));
      const release = () => { try { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock); } catch { /* ignore */ } };
      process.once("exit", release);
    }
    const lite = new PGlite(dir, {
      parsers: { [types.NUMERIC]: (v: string) => v, [types.DATE]: (v: string) => v },
    });
    let chain: Promise<unknown> = Promise.resolve();
    db = {
      async query(sql, params = []) { return (await lite.query(sql, params as any[])).rows as any[]; },
      async tx(fn) {
        // PGlite is single-connection: serialise transactions.
        const run = chain.then(() => lite.transaction(async (t) => fn(async (s, p = []) => (await t.query(s, p as any[])).rows as any[])));
        chain = run.catch(() => undefined);
        return run as any;
      },
      close: () => lite.close(),
    };
  }
  for (const stmt of schemaSql().split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await db.query(stmt);
  }
  return db;
}
