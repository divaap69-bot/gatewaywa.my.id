// Muat .env (kalau ada) dan validasi env wajib. Diimpor paling awal oleh modul lain.
import { existsSync } from 'node:fs';
import path from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

const REQUIRED = {
  ADMIN_PASSWORD: 'password login dashboard',
  API_TOKEN: 'token untuk memanggil /api/*',
  DATABASE_URL: 'connection string Postgres Supabase',
};

const missing = Object.entries(REQUIRED).filter(([k]) => !process.env[k]?.trim());
if (missing.length) {
  console.error('\n[config] Env wajib belum diisi:');
  for (const [k, desc] of missing) console.error(`  - ${k}: ${desc}`);
  console.error('Salin .env.example menjadi .env lalu isi nilainya.\n');
  process.exit(1);
}

const int = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) { console.error(`[config] ${name} harus angka, dapat "${v}"`); process.exit(1); }
  return n;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  host: process.env.HOST || '0.0.0.0',
  port: int('PORT', 3000),
  adminPassword: process.env.ADMIN_PASSWORD,
  apiToken: process.env.API_TOKEN,
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL !== 'false',
  authDir: path.resolve(process.env.AUTH_DIR || 'storage/auth'),
  ipWhitelist: (process.env.IP_WHITELIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  webhookUrl: process.env.WEBHOOK_URL || '',
  delayMin: int('DELAY_MIN', 2),
  delayMax: int('DELAY_MAX', 5),
  logLevel: process.env.LOG_LEVEL || 'warn',
};
