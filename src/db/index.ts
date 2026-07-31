import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { createLogger, setLogSink } from '../logger.js';

const log = createLogger('db');

export const pool = new pg.Pool({
  // Empty when unconfigured; index.ts checks for that before using the pool
  // and reports it through /healthz rather than connecting to a default host.
  connectionString: config.DATABASE_URL || undefined,
  max: 5,
  connectionTimeoutMillis: 10_000,
  // Railway's internal Postgres URL doesn't need TLS; public proxy URLs do and
  // present a self-signed chain, so accept it rather than failing to boot.
  ssl: /(\.proxy\.rlwy\.net|sslmode=require)/.test(config.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});

// An idle client error is emitted on the pool, and an unhandled 'error' event
// would take the whole process down — e.g. when Railway restarts Postgres.
pool.on('error', (e) => log.error(`idle client error: ${e.message}`));

/**
 * Without this, an unset DATABASE_URL makes pg quietly fall back to
 * localhost:5432 and every query fails with a bare ECONNREFUSED that says
 * nothing about the actual problem.
 */
function assertConfigured(): void {
  if (!config.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL が設定されていません。Railway で「New → Database → Add PostgreSQL」を実行してください。',
    );
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  assertConfigured();
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function migrate(): Promise<void> {
  assertConfigured();
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(resolve(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
  log.info('schema applied');
}

/**
 * Mirrors info/warn/error logs into the `logs` table so the admin UI can show
 * recent activity without shelling into Railway.
 */
export function attachLogSink(): void {
  let writing = false;
  setLogSink((level, scope, message, meta) => {
    if (writing) return; // avoid recursion if the insert itself logs
    writing = true;
    pool
      .query('INSERT INTO logs (level, scope, message, meta) VALUES ($1,$2,$3,$4)', [
        level,
        scope,
        message,
        meta === undefined ? null : JSON.stringify(meta, replaceErrors).slice(0, 8000),
      ])
      .catch(() => {})
      .finally(() => {
        writing = false;
      });
  });
}

function replaceErrors(_k: string, v: unknown) {
  if (v instanceof Error) return { name: v.name, message: v.message };
  return v;
}

/** Keeps the logs table from growing forever on a hobby-tier database. */
export async function pruneLogs(keepDays = 30): Promise<void> {
  await pool.query(`DELETE FROM logs WHERE created_at < now() - ($1 || ' days')::interval`, [keepDays]);
}
