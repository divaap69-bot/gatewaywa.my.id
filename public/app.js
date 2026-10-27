const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const titles = { dashboard: 'Dashboard', send: 'Kirim Pesan', history: 'Riwayat', inbox: 'Inbox', api: 'API & Token' };
let page = 'dashboard';

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401 && !url.includes('login')) { showLogin(); throw new Error('unauthorized'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.reason || 'Gagal');
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2500);
}

function greeting() {
  const h = new Date().getHours();
  return h < 11 ? 'Selamat pagi 👋' : h < 15 ? 'Selamat siang 👋' : h < 19 ? 'Selamat sore 👋' : 'Selamat malam 👋';
}

const showLogin = () => { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); };
const showApp = () => { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); $('#greeting').textContent = greeting(); refresh(); };

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/dash/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) }); showApp(); }
  catch (err) { $('#login-err').textContent = err.message; }
};
$('#logout-btn').onclick = async () => { await api('/dash/logout', { method: 'POST' }); showLogin(); };
$('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');

document.querySelectorAll('.nav button').forEach((b) => b.onclick = () => {
  page = b.dataset.page;
  document.querySelectorAll('.nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('[data-section]').forEach((s) => s.classList.toggle('hidden', s.dataset.section !== page));
  $('#page-title').textContent = titles[page];
  $('#sidebar').classList.remove('open');
  refresh();
});

// ---------- Dashboard ----------
const statusPill = { connected: ['ok', 'Terhubung'], qr: ['warn', 'Menunggu scan QR'], connecting: ['warn', 'Menghubungkan…'], disconnected: ['bad', 'Terputus'] };

async function loadState() {
  const s = await api('/dash/state');
  const [cls, label] = statusPill[s.status] || statusPill.disconnected;
  $('#status-pill').className = 'pill ' + cls; $('#status-pill').textContent = label;
  for (const k of ['today', 'sent', 'pending', 'failed']) $('#s-' + k).textContent = s.stats[k] ?? 0;
  $('#side-name').textContent = s.name || 'WhatsApp';
  $('#side-number').textContent = s.number ? '+' + s.number : 'belum terhubung';
  $('#avatar').textContent = (s.name || 'WA').slice(0, 2).toUpperCase();
  $('#disconnect-btn').classList.toggle('hidden', s.status !== 'connected');

  const box = $('#device-box');
  if (s.status === 'connected') {
    box.innerHTML = `<div><span class="badge">Aktif</span><h2 style="margin:10px 0 4px;font-size:20px">+${esc(s.number)}</h2>
      <p class="sub">${esc(s.name || '')} · siap mengirim pesan dari API maupun dashboard.</p></div>`;
  } else if (s.qr) {
    box.innerHTML = `<img class="qr" src="${s.qr}" alt="QR WhatsApp"><div><h2 style="font-size:16px">Scan untuk menghubungkan</h2>
      <ol><li>Buka WhatsApp di HP</li><li>Ketuk ⋮ / Pengaturan → <b>Perangkat tertaut</b></li><li>Ketuk <b>Tautkan perangkat</b> lalu scan QR ini</li></ol>
      <p class="hint">QR berganti otomatis setiap ±20 detik.</p></div>`;
  } else {
    box.innerHTML = `<p class="sub">Menyiapkan koneksi WhatsApp…</p>`;
  }
}

$('#disconnect-btn').onclick = async () => {
  if (!confirm('Putuskan WhatsApp? Anda harus scan QR lagi untuk menyambung.')) return;
  await api('/dash/disconnect', { method: 'POST' }); toast('WhatsApp diputus'); loadState();
};

// ---------- Kirim ----------
$('#send-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/dash/send', { method: 'POST', body: JSON.stringify({ target: $('#f-target').value, message: $('#f-message').value, url: $('#f-url').value || undefined }) });
    toast(`${r.id.length} pesan ${r.detail}`); $('#f-message').value = ''; $('#f-url').value = '';
  } catch (err) { toast(err.message); }
};

// ---------- Riwayat ----------
const stPill = { sent: 'ok', pending: 'warn', failed: 'bad' };
async function loadHistory() {
  const rows = await api('/dash/history?q=' + encodeURIComponent($('#h-search').value));
  $('#h-body').innerHTML = rows.length ? rows.map((r) => `<tr>
    <td>${r.id}</td><td>${esc(r.created_at)}</td><td>${esc(r.target)}</td>
    <td class="msg">${esc(r.message)}${r.url ? `<div class="hint">📎 ${esc(r.url)}</div>` : ''}</td>
    <td><span class="badge">${esc(r.source)}</span></td>
    <td><span class="pill ${stPill[r.status]}">${r.status}</span>${r.error ? `<div class="hint">${esc(r.error)}</div>` : ''}</td>
    <td>${r.status === 'failed' ? `<button class="btn outline sm" data-resend="${r.id}">Kirim ulang</button>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">Belum ada pesan</td></tr>';
}
$('#h-search').oninput = () => { clearTimeout(loadHistory._t); loadHistory._t = setTimeout(loadHistory, 300); };
$('#h-body').onclick = async (e) => {
  const id = e.target.dataset.resend; if (!id) return;
  await api('/dash/resend/' + id, { method: 'POST' }); toast('Masuk antrian ulang'); loadHistory();
};

// ---------- Inbox ----------
async function loadInbox() {
  const rows = await api('/dash/inbox');
  $('#i-body').innerHTML = rows.length ? rows.map((r) => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.sender)}</td><td>${esc(r.name)}</td><td class="msg">${esc(r.message)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">Belum ada pesan masuk</td></tr>';
}

// ---------- API ----------
async function loadToken() {
  const t = await api('/dash/token');
  $('#token').value = t.token; $('#wl').textContent = t.whitelist || 'semua IP'; $('#wh').textContent = t.webhook || 'nonaktif';
  document.querySelectorAll('.base').forEach((el) => el.textContent = location.origin);
}
$('#show-token').onclick = () => { const i = $('#token'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('#copy-token').onclick = async () => { await navigator.clipboard.writeText($('#token').value); toast('Token disalin'); };

// ---------- Refresh ----------
async function refresh() {
  try {
    await loadState();
    if (page === 'history') await loadHistory();
    if (page === 'inbox') await loadInbox();
    if (page === 'api') await loadToken();
  } catch {}
}
setInterval(() => { if (!$('#app').classList.contains('hidden') && page !== 'api') refresh(); }, 4000);

api('/dash/state').then(showApp).catch(() => {});
