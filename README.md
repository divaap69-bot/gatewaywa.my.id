# WhatsApp Gateway (1 device)

Gateway WhatsApp pribadi berbasis **Baileys**: dashboard untuk scan QR, kirim pesan, riwayat, dan inbox, plus **API** untuk notifikasi pesanan dari web e-commerce.

## Menjalankan

```bash
npm install
cp .env.example .env   # lalu isi ADMIN_PASSWORD dan API_TOKEN
npm start
```

Buka http://localhost:3000, login, lalu scan QR dari WhatsApp → **Perangkat tertaut**. Sesi tersimpan di `AUTH_DIR` (default `storage/auth/`), jadi tidak perlu scan ulang setelah restart. Data pesan disimpan di Postgres Supabase (`DATABASE_URL`).

Deploy ke VPS: lihat [DEPLOY.md](DEPLOY.md).

## API

| Method | Endpoint | Keterangan |
|---|---|---|
| POST | `/api/send` | body `{ target, message, url? }`, target bisa banyak (pisah koma) |
| GET | `/api/status` | status koneksi WA |
| GET | `/api/message/:id` | status pesan: `pending` / `sent` / `failed` |

Header wajib: `Authorization: <API_TOKEN>`. Contoh kode PHP/JS ada di menu **API & Token** pada dashboard.

## Konfigurasi `.env`

- `IP_WHITELIST`: batasi IP yang boleh memanggil API (misalnya IP hosting e-commerce)
- `WEBHOOK_URL`: pesan masuk diteruskan sebagai POST JSON `{ sender, name, message, timestamp }`
- `DELAY_MIN` / `DELAY_MAX`: jeda acak antar pesan (detik)

## Struktur

```
src/server.js   Express: API + endpoint dashboard
src/wa.js       Koneksi Baileys, antrian kirim, pesan masuk, webhook
src/config.js   Baca + validasi env
src/db.js       Postgres (Supabase), tabel dibuat otomatis
public/         Dashboard (HTML/CSS/JS, tema dark indigo)
```

## Catatan

- Baileys tidak resmi: hindari spam/broadcast massal supaya nomor tidak diblokir.
- Supaya bisa dipanggil dari hosting e-commerce, jalankan di VPS (misalnya dengan `pm2`) dan pasang HTTPS lewat reverse proxy (Nginx/Caddy).
