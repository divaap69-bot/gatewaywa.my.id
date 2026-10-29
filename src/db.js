import pg from 'pg';
import { readFileSync } from 'node:fs';
import { config } from './config.js';

// SSL: verifikasi sertifikat kalau CA Supabase tersedia (DATABASE_CA_CERT), selain itu terenkripsi tanpa verifikasi
function sslOptions() {
  if (!config.databaseSsl) return false;
  if (config.databaseCaCert) return { ca: readFileSync(config.databaseCaCert, 'utf8'), rejectUnauthorized: true };
  if (config.isProd) console.warn('[db] DATABASE_CA_CERT kosong: sertifikat Supabase tidak diverifikasi (rawan MITM).');
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: sslOptions(),
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000, // gagal cepat kalau Supabase tidak bisa dihubungi
  query_timeout: 15_000,           // jangan menunggu query selamanya
  statement_timeout: 15_000,
});
pool.on('error', (e) => console.error('[db] pool error:', e.message));

const TZ = "AT TIME ZONE 'Asia/Jakarta'";
const fmt = (col) => `to_char(${col} ${TZ}, 'YYYY-MM-DD HH24:MI:SS')`;

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      target TEXT NOT NULL,
      message TEXT,
      url TEXT,
      source TEXT DEFAULT 'api',
      status TEXT DEFAULT 'pending',
      error TEXT,
      wa_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      sent_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS messages_status_idx ON messages (status);
    CREATE TABLE IF NOT EXISTS inbox (
      id BIGSERIAL PRIMARY KEY,
      sender TEXT,
      name TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

const MSG_COLS = `id::int, target, message, url, source, status, error, wa_id,
  ${fmt('created_at')} AS created_at, ${fmt('sent_at')} AS sent_at`;

export const insertMessage = async (target, message, url, source) =>
  (await pool.query('INSERT INTO messages (target, message, url, source) VALUES ($1,$2,$3,$4) RETURNING id::int',
    [target, message, url ?? null, source])).rows[0].id;

export const markMessage = (id, status, error = null, waId = null) =>
  pool.query(`UPDATE messages SET status=$1, error=$2, wa_id=$3,
    sent_at = CASE WHEN $1='sent' THEN now() ELSE sent_at END WHERE id=$4`, [status, error, waId, id]);

export const getMessage = async (id) =>
  (await pool.query(`SELECT ${MSG_COLS} FROM messages WHERE id=$1`, [id])).rows[0];

export const pendingIds = async () =>
  (await pool.query("SELECT id::int FROM messages WHERE status='pending' ORDER BY id")).rows.map((r) => r.id);

export const listMessages = async (limit = 100, q = '') =>
  (await pool.query(`SELECT ${MSG_COLS} FROM messages WHERE target ILIKE $1 OR message ILIKE $1 ORDER BY id DESC LIMIT $2`,
    [`%${q}%`, limit])).rows;

export const insertInbox = (sender, name, message) =>
  pool.query('INSERT INTO inbox (sender, name, message) VALUES ($1,$2,$3)', [sender, name, message]);

export const listInbox = async (limit = 100) =>
  (await pool.query(`SELECT id::int, sender, name, message, ${fmt('created_at')} AS created_at FROM inbox ORDER BY id DESC LIMIT $1`,
    [limit])).rows;

// Dashboard polling tiap 4 detik; hitungan di-cache supaya tidak full scan setiap request
const STATS_TTL_MS = 15_000;
let statsCache = { at: 0, value: null, pending: null };
export async function stats() {
  if (statsCache.value && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.value;
  statsCache.pending ??= queryStats()
    .then((value) => { statsCache = { at: Date.now(), value, pending: null }; return value; })
    .finally(() => { statsCache.pending = null; });
  return statsCache.pending;
}

const queryStats = async () => (await pool.query(`
  SELECT
    COUNT(*)::int total,
    COUNT(*) FILTER (WHERE status='sent')::int sent,
    COUNT(*) FILTER (WHERE status='failed')::int failed,
    COUNT(*) FILTER (WHERE status='pending')::int pending,
    COUNT(*) FILTER (WHERE (created_at ${TZ})::date = (now() ${TZ})::date)::int today
  FROM messages`)).rows[0];
