import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { rmSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { insertMessage, markMessage, getMessage, insertInbox, pendingIds } from './db.js';

const makeWASocket = baileys.makeWASocket ?? baileys.default?.default ?? baileys.default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;

const AUTH_DIR = config.authDir;
const logger = pino({ level: config.logLevel });

export const state = { status: 'disconnected', qr: null, me: null };
let sock = null;
let shuttingDown = false;
let reconnectTimer = null;
const queue = [];
let working = false;

// 08xxx / +62xxx / 62xxx -> 62xxx
export function normalizeNumber(raw) {
  let n = String(raw).replace(/\D/g, '');
  if (n.startsWith('0')) n = '62' + n.slice(1);
  return n;
}

function scheduleReconnect(ms = 3000) {
  if (shuttingDown) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect().catch((e) => {
    console.error('[wa] gagal connect:', e.message);
    scheduleReconnect(10_000);
  }), ms);
}

export async function connect() {
  mkdirSync(AUTH_DIR, { recursive: true });
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  state.status = 'connecting';
  sock = makeWASocket({ version, auth, logger, browser: Browsers.ubuntu('WA Gateway') });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      state.qr = await QRCode.toDataURL(qr);
      state.status = 'qr';
    }
    if (connection === 'open') {
      state.status = 'connected';
      state.qr = null;
      state.me = sock.user;
      console.log('WhatsApp terhubung:', sock.user?.id);
      // Pesan yang masih pending (mis. sebelum restart) dimasukkan lagi ke antrian
      try {
        for (const id of await pendingIds()) if (!queue.includes(id)) queue.push(id);
      } catch (e) { console.error('[wa] gagal memuat antrian pending:', e.message); }
      processQueue();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      state.me = null;
      state.status = 'disconnected';
      if (shuttingDown) return;
      if (code === DisconnectReason.loggedOut) {
        console.log('Logout dari HP, sesi dihapus. Scan QR ulang.');
        rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      scheduleReconnect();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (m.key.fromMe || m.key.remoteJid?.endsWith('@g.us') || m.key.remoteJid === 'status@broadcast') continue;
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text
        || m.message?.imageMessage?.caption || '';
      const sender = m.key.remoteJid.split('@')[0];
      insertInbox(sender, m.pushName ?? '', text).catch((e) => console.error('[db] inbox:', e.message));
      if (config.webhookUrl) {
        fetch(config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender, name: m.pushName, message: text, timestamp: m.messageTimestamp }),
          signal: AbortSignal.timeout(10_000),
        }).catch((e) => console.error('Webhook gagal:', e.message));
      }
    }
  });
}

export async function logout() {
  try { await sock?.logout(); } catch {}
  rmSync(AUTH_DIR, { recursive: true, force: true });
}

// Tutup socket tanpa logout (sesi tetap tersimpan) saat server dimatikan
export function shutdown() {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  try { sock?.end(undefined); } catch {}
}

// Masukkan ke antrian, kembalikan id riwayat
export async function enqueue(target, message, url, source = 'api') {
  const number = normalizeNumber(target);
  const id = await insertMessage(number, message, url, source);
  queue.push(id);
  processQueue();
  return id;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = () => (config.delayMin + Math.random() * (config.delayMax - config.delayMin)) * 1000;

function buildContent({ message, url }) {
  if (!url) return { text: message };
  const file = url.split('?')[0].split('/').pop();
  if (/\.(jpe?g|png|webp)$/i.test(file)) return { image: { url }, caption: message };
  if (/\.(mp4|mov)$/i.test(file)) return { video: { url }, caption: message };
  return { document: { url }, fileName: file, mimetype: 'application/octet-stream', caption: message };
}

async function processQueue() {
  if (working || state.status !== 'connected') return;
  working = true;
  try {
    while (queue.length && state.status === 'connected' && !shuttingDown) {
      const id = queue.shift();
      const row = await getMessage(id);
      if (!row || row.status !== 'pending') continue;
      try {
        const [check] = await sock.onWhatsApp(row.target);
        if (!check?.exists) throw new Error('Nomor tidak terdaftar di WhatsApp');
        const res = await sock.sendMessage(check.jid, buildContent(row));
        await markMessage(id, 'sent', null, res?.key?.id);
      } catch (e) {
        await markMessage(id, 'failed', e.message).catch(() => {});
      }
      if (queue.length) await sleep(randomDelay());
    }
  } catch (e) {
    console.error('[wa] antrian error:', e.message);
  } finally {
    working = false;
  }
}
