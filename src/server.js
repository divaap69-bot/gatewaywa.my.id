import { config } from './config.js';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { connect, logout, enqueue, state, shutdown as shutdownWa } from './wa.js';
import { initDb, pool, listMessages, listInbox, stats, getMessage } from './db.js';

const app = express();
app.set('trust proxy', config.isProd ? 'loopback' : true);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Bungkus handler async supaya error masuk ke error handler, bukan crash
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Health check ----------
app.get('/health', h(async (req, res) => {
  let db = 'ok';
  try { await pool.query('SELECT 1'); } catch { db = 'error'; }
  res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', uptime: Math.round(process.uptime()), db, whatsapp: state.status });
}));

// ---------- API untuk web e-commerce (pakai token) ----------
function apiAuth(req, res, next) {
  const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (token !== config.apiToken) return res.status(401).json({ status: false, reason: 'token salah' });
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

app.post('/dash/login', (req, res) => {
  if (req.body.password !== config.adminPassword) return res.status(401).json({ error: 'Password salah' });
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

app.use((err, req, res, next) => {
  console.error(`[http] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ status: false, error: 'Terjadi kesalahan server' });
});

// Error internal Baileys (mis. koneksi putus 1006) jangan sampai mematikan server; reconnect ditangani wa.js
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e?.message ?? e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e?.message ?? e));

// ---------- Start ----------
try {
  await initDb();
} catch (e) {
  console.error('[db] gagal konek ke database. Cek DATABASE_URL:', e.message);
  process.exit(1);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`[${config.env}] Dashboard: http://${config.host}:${config.port}`);
  process.send?.('ready'); // untuk PM2 wait_ready
});
connect().catch((e) => console.error('[wa] gagal connect awal:', e.message));

// ---------- Graceful shutdown (pm2 reload/stop kirim SIGINT/SIGTERM) ----------
let closing = false;
async function gracefulShutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[${signal}] mematikan server dengan rapi...`);
  const force = setTimeout(() => { console.error('Shutdown terlalu lama, paksa keluar'); process.exit(1); }, 8000);
  force.unref();
  server.close();
  server.closeIdleConnections?.();
  shutdownWa();
  await pool.end().catch(() => {});
  console.log('Selesai.');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
