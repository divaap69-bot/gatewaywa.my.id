import { config } from './config.js';
import express from 'express';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { start as startWa, logout, enqueue, state, shutdown as shutdownWa } from './wa.js';
import { initDb, pool, listMessages, listInbox, stats, getMessage } from './db.js';

const app = express();
// Hanya percaya X-Forwarded-For dari proxy lokal (Nginx di mesin yang sama)
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Bungkus handler async supaya error masuk ke error handler, bukan crash
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Bandingkan secret tanpa bocor lewat waktu respons
const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();
const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

// ---------- Health check ----------
app.get('/health', h(async (req, res) => {
  let db = 'ok';
  try { await pool.query('SELECT 1'); } catch { db = 'error'; }
  res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', uptime: Math.round(process.uptime()), db, whatsapp: state.status });
}));

// ---------- API untuk web e-commerce (pakai token) ----------
function apiAuth(req, res, next) {
  const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(token, config.apiToken)) return res.status(401).json({ status: false, reason: 'token salah' });
  const ip = (req.ip || '').replace('::ffff:', '');
  if (config.ipWhitelist.length && !config.ipWhitelist.includes(ip)) return res.status(403).json({ status: false, reason: `IP ${ip} tidak diizinkan` });
  next();
}

async function handleSend(req, res, source) {
  const { target, message, url } = req.body;
  if (!target || (!message && !url)) return res.status(400).json({ status: false, reason: 'target dan message wajib diisi' });
  const targets = String(target).split(',').map((t) => t.trim()).filter(Boolean);
  const ids = [];
  for (const t of targets) ids.push(await enqueue(t, message ?? '', url, source));
  res.json({ status: true, id: ids, device_status: state.status, detail: state.status === 'connected' ? 'masuk antrian' : 'masuk antrian, dikirim saat WA terhubung' });
}

app.post('/api/send', apiAuth, h((req, res) => handleSend(req, res, 'api')));
app.get('/api/status', apiAuth, (req, res) => res.json({ status: state.status, number: state.me?.id?.split(':')[0] ?? null }));
app.get('/api/message/:id', apiAuth, h(async (req, res) => {
  const row = await getMessage(Number(req.params.id) || 0);
  row ? res.json(row) : res.status(404).json({ status: false, reason: 'tidak ditemukan' });
}));

// ---------- Dashboard (pakai login password) ----------
const sessions = new Set();
const cookie = (req) => Object.fromEntries((req.get('Cookie') || '').split(';').map((c) => c.trim().split('=')));
function dashAuth(req, res, next) {
  if (sessions.has(cookie(req).sid)) return next();
  res.status(401).json({ error: 'login dulu' });
}

// Batasi percobaan login gagal per IP (anti brute-force)
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginFails = new Map(); // ip -> { count, resetAt }
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of loginFails) if (v.resetAt <= now) loginFails.delete(ip);
}, LOGIN_WINDOW_MS).unref();

app.post('/dash/login', (req, res) => {
  const ip = req.ip || '';
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (rec && rec.resetAt > now && rec.count >= LOGIN_MAX_FAILS) {
    const menit = Math.ceil((rec.resetAt - now) / 60_000);
    return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${menit} menit.` });
  }
  if (!safeEqual(req.body.password, config.adminPassword)) {
    const cur = rec && rec.resetAt > now ? rec : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    cur.count++;
    loginFails.set(ip, cur);
    return res.status(401).json({ error: 'Password salah' });
  }
  loginFails.delete(ip);
  const sid = randomBytes(24).toString('hex');
  sessions.add(sid);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/${config.isProd ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/dash/logout', (req, res) => { sessions.delete(cookie(req).sid); res.json({ ok: true }); });

app.get('/dash/state', dashAuth, h(async (req, res) => res.json({
  status: state.status,
  qr: state.qr,
  number: state.me?.id?.split(':')[0] ?? null,
  name: state.me?.name ?? null,
  stats: await stats(),
})));
app.get('/dash/history', dashAuth, h(async (req, res) => res.json(await listMessages(200, req.query.q ?? ''))));
app.get('/dash/inbox', dashAuth, h(async (req, res) => res.json(await listInbox(200))));
app.get('/dash/token', dashAuth, (req, res) => res.json({ token: config.apiToken, whitelist: config.ipWhitelist.join(', '), webhook: config.webhookUrl }));
app.post('/dash/send', dashAuth, h((req, res) => handleSend(req, res, 'dashboard')));
app.post('/dash/resend/:id', dashAuth, h(async (req, res) => {
  const row = await getMessage(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: 'tidak ditemukan' });
  res.json({ id: await enqueue(row.target, row.message, row.url, 'resend') });
}));
app.post('/dash/disconnect', dashAuth, h(async (req, res) => { await logout(); res.json({ ok: true }); }));

const CLIENT_ERRORS = {
  'entity.parse.failed': 'Body bukan JSON yang valid',
  'entity.too.large': 'Body terlalu besar (maks 1 MB)',
};
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status < 500) {
    return res.status(status).json({ status: false, reason: CLIENT_ERRORS[err.type] || err.message });
  }
  console.error(`[http] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ status: false, error: 'Terjadi kesalahan server' });
});

// Rejection internal Baileys (mis. koneksi putus 1006) cukup dicatat; reconnect ditangani wa.js.
// Exception sinkron yang tidak tertangkap = state tidak jelas -> keluar, PM2 yang menyalakan ulang.
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e?.message ?? e));
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception, keluar:', e?.stack ?? e);
  process.exit(1);
});

// ---------- Graceful shutdown (pm2 reload/stop kirim SIGINT/SIGTERM) ----------
let server = null;
let closing = false;
async function gracefulShutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[${signal}] mematikan server dengan rapi...`);
  const force = setTimeout(() => { console.error('Shutdown terlalu lama, paksa keluar'); process.exit(1); }, 8000);
  force.unref();
  // 1. Berhenti terima request baru, tunggu request yang sedang jalan selesai
  if (server) {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    await closed;
  }
  // 2. Tunggu pesan yang sedang dikirim selesai ditandai, lalu tutup socket WA
  await shutdownWa().catch((e) => console.error('[wa] shutdown:', e.message));
  // 3. Baru tutup koneksi database
  await pool.end().catch(() => {});
  console.log('Selesai.');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------- Start ----------
// Database belum siap (mis. Supabase maintenance) -> coba terus dengan jeda, jangan exit
// supaya PM2 tidak berhenti me-restart setelah max_restarts.
for (let attempt = 1; !closing; attempt++) {
  try {
    await initDb();
    break;
  } catch (e) {
    const wait = Math.min(30_000, 2 ** attempt * 1000);
    console.error(`[db] gagal konek ke database (percobaan ${attempt}), coba lagi ${wait / 1000} detik. Cek DATABASE_URL: ${e.message}`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

if (!closing) {
  server = app.listen(config.port, config.host, () => {
    console.log(`[${config.env}] Dashboard: http://${config.host}:${config.port}`);
    process.send?.('ready'); // untuk PM2 wait_ready
    startWa();
  });
  server.on('error', (e) => {
    console.error(`[http] gagal listen di ${config.host}:${config.port}:`, e.message);
    process.exit(1);
  });
}
