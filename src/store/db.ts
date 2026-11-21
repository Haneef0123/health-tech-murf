import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/** Minimal async SQL interface. Real Postgres (Supabase) in production, PGlite (in-process Postgres) locally and in tests. */
export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}
export interface OpenDb extends Db { close(): Promise<void> }

/** `postgres://...` connects to Postgres; anything else is a PGlite data directory (or ':memory:'). */
export function openDb(target: string): OpenDb {
  return /^postgres(ql)?:\/\//.test(target) ? openPg(target) : openPglite(target);
}

function openPg(url: string): OpenDb {
  // pg lets the URL's sslmode override the ssl option, so drop it and set TLS explicitly.
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  // shortcut: TLS is on but the server certificate is not verified (Supabase's CA is not in Node's trust store); pin their CA for production.
  const pool = new pg.Pool({ connectionString: u.toString(), max: 5, ssl: local ? undefined : { rejectUnauthorized: false } });

  const clientDb = (c: pg.PoolClient): Db => {
    const self: Db = {
      query: async (sql, params) => (await c.query(sql, params as any[])).rows,
      exec: async (sql) => void (await c.query(sql)),
      transaction: (fn) => fn(self), // already inside a transaction
    };
    return self;
  };
  return {
    query: async (sql, params) => (await pool.query(sql, params as any[])).rows,
    exec: async (sql) => void (await pool.query(sql)),
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(clientDb(c));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

function openPglite(path: string): OpenDb {
  const db = path === ':memory:' ? new PGlite() : new PGlite(path);
  const wrap = (c: { query: PGlite['query']; exec: PGlite['exec'] }, inTx: boolean): Db => {
    const self: Db = {
      query: async (sql, params) => (await c.query(sql, params as any[])).rows as any,
      exec: async (sql) => void (await c.exec(sql)),
      transaction: inTx ? (fn) => fn(self) : (fn) => db.transaction((tx) => fn(wrap(tx as any, true))),
    };
    return self;
  };
  return { ...wrap(db, false), close: () => db.close() };
}
