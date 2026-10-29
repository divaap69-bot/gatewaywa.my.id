import * as baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { rmSync, mkdirSync } from 'node:fs';
import { config } from './config.js';
import { insertMessage, markMessage, getMessage, insertInbox, pendingIds } from './db.js';

const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, isLidUser, isJidUser } = baileys;

const AUTH_DIR = config.authDir;
const logger = pino({ level: config.logLevel });

export const state = { status: 'disconnected', qr: null, me: null };
let sock = null;
let shuttingDown = false;
let reconnectTimer = null;
const queue = [];
let running = null; // promise processQueue yang sedang jalan
let wakeSleep = null;

// Kode putus yang tidak boleh reconnect cepat (bisa saling tendang / akun diblokir)
const LONG_BACKOFF_CODES = new Set([DisconnectReason.connectionReplaced, DisconnectReason.forbidden]);
const LONG_BACKOFF_MS = 5 * 60_000;

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

// Mulai koneksi; kalau gagal (mis. folder sesi tidak bisa dibuat) dicoba ulang otomatis
export const start = () => scheduleReconnect(0);

async function connect() {
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
      // Pesan yang masih pending (mis. sebelum restart / putus koneksi) dimasukkan lagi ke antrian
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
      if (LONG_BACKOFF_CODES.has(code)) {
        state.status = code === DisconnectReason.connectionReplaced ? 'replaced' : 'forbidden';
        console.warn(code === DisconnectReason.connectionReplaced
          ? '[wa] Sesi dipakai di tempat lain (connectionReplaced). Matikan instance lain; coba lagi 5 menit.'
          : '[wa] Akses ditolak WhatsApp (forbidden). Cek status nomor; coba lagi 5 menit.');
        return scheduleReconnect(LONG_BACKOFF_MS);
      }
      scheduleReconnect();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const jid = m.key.remoteJid;
      // Hanya chat pribadi (nomor biasa atau LID); lewati grup, status, newsletter, broadcast
      if (m.key.fromMe || !(isJidUser(jid) || isLidUser(jid))) continue;
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text
        || m.message?.imageMessage?.caption || '';
      // WhatsApp bisa mengirim LID (bukan nomor HP); pakai senderPn kalau tersedia
      const pnJid = isLidUser(jid) ? m.key.senderPn : jid;
      const sender = pnJid ? pnJid.split('@')[0] : jid;
      insertInbox(sender, m.pushName ?? '', text).catch((e) => console.error('[db] inbox:', e.message));
      if (config.webhookUrl) {
        fetch(config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender, jid, name: m.pushName, message: text, timestamp: m.messageTimestamp }),
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

// Hentikan antrian dengan rapi: tunggu pesan yang sedang dikirim selesai ditandai, lalu tutup socket
// tanpa logout (sesi tetap tersimpan).
export async function shutdown() {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  wakeSleep?.();
  await running;
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

// Sleep yang bisa dibangunkan saat shutdown
const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  wakeSleep = () => { clearTimeout(t); resolve(); };
});
const randomDelay = () => (config.delayMin + Math.random() * (config.delayMax - config.delayMin)) * 1000;

function buildContent({ message, url }) {
  if (!url) return { text: message };
  const file = url.split('?')[0].split('/').pop();
  if (/\.(jpe?g|png|webp)$/i.test(file)) return { image: { url }, caption: message };
  if (/\.(mp4|mov)$/i.test(file)) return { video: { url }, caption: message };
  return { document: { url }, fileName: file, mimetype: 'application/octet-stream', caption: message };
}

// Error karena koneksi WA putus: pesan tetap pending dan dikirim ulang saat tersambung lagi
const isConnectionError = (e) => state.status !== 'connected'
  || e?.output?.statusCode === DisconnectReason.connectionClosed;

function processQueue() {
  if (running || state.status !== 'connected' || shuttingDown) return running;
  running = drainQueue().finally(() => { running = null; });
  return running;
}

async function drainQueue() {
  while (queue.length && state.status === 'connected' && !shuttingDown) {
    const id = queue.shift();
    let row;
    try {
      row = await getMessage(id);
    } catch (e) {
      console.error('[wa] gagal baca pesan dari DB, coba lagi 10 detik:', e.message);
      queue.unshift(id);
      setTimeout(processQueue, 10_000);
      return;
    }
    if (!row || row.status !== 'pending') continue;

    let res;
    try {
      const [check] = await sock.onWhatsApp(row.target);
      if (!check?.exists) throw new Error('Nomor tidak terdaftar di WhatsApp');
      res = await sock.sendMessage(check.jid, buildContent(row));
    } catch (e) {
      if (isConnectionError(e)) {
        console.warn(`[wa] koneksi putus saat kirim #${id}, dicoba lagi setelah tersambung`);
        queue.unshift(id);
        return;
      }
      await markMessage(id, 'failed', e.message).catch((err) => console.error('[db] tandai gagal:', err.message));
      continue;
    }
    // Pesan sudah terkirim: tandai 'sent' (dicoba 3x supaya tidak dikirim ulang setelah restart)
    for (let i = 1; i <= 3; i++) {
      try { await markMessage(id, 'sent', null, res?.key?.id); break; }
      catch (e) { console.error(`[db] tandai terkirim #${id} gagal (${i}/3):`, e.message); if (i < 3) await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (queue.length && !shuttingDown) await sleep(randomDelay());
  }
}
