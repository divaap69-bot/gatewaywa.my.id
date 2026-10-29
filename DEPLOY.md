# Deploy ke VPS

Target: Ubuntu 24.04 · user `ubuntu` · `43.173.41.124` · domain `gatewaywa.my.id` (+ www) · Node 22 + PM2 + Nginx · DB Supabase · app di `~/apps/gatewaywa`.

Aturan: kode **tidak pernah diedit di VPS**. Semua perubahan lewat `git push` ke `main` → GitHub Actions menjalankan `deploy.sh` di VPS.

## 1. Setup awal (sekali saja)

### a. DNS
Buat A record `gatewaywa.my.id` dan `www` → `43.173.41.124`.

### b. Supabase
Project Settings → Database → Connection string → **URI (Session pooler)**. Simpan untuk `DATABASE_URL`. Tabel dibuat otomatis saat app pertama start.

Unduh juga sertifikat CA: Project Settings → Database → **SSL Configuration → Download certificate**. Nanti diunggah ke VPS (langkah c) supaya koneksi database diverifikasi.

### c. Clone & env (di VPS)
```bash
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/divaap69-bot/gatewaywa.my.id.git gatewaywa
cd gatewaywa
cp .env.example .env
nano .env            # isi ADMIN_PASSWORD, API_TOKEN (openssl rand -hex 24), DATABASE_URL
chmod 600 .env
chmod +x deploy.sh
```
Sertifikat CA Supabase (dari PC lokal):
```bash
scp prod-ca-2021.crt ubuntu@43.173.41.124:~/apps/gatewaywa/storage/supabase-ca.crt
```
Lalu di `.env` VPS isi `DATABASE_CA_CERT=./storage/supabase-ca.crt`.
Repo private? Pasang deploy key read-only dulu: `ssh-keygen -t ed25519 -f ~/.ssh/gatewaywa_deploy -N ""`, tambahkan isi `.pub` di GitHub → Settings → Deploy keys, lalu clone pakai URL SSH `git@github.com:divaap69-bot/gatewaywa.my.id.git`.

### d. PM2
```bash
npm i -g pm2
./deploy.sh main                 # install, start PM2, cek /health
pm2 startup systemd -u ubuntu --hp /home/ubuntu   # jalankan perintah sudo yang dicetak
pm2 save
pm2 install pm2-logrotate        # rotasi log otomatis
```

### e. Nginx
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/gatewaywa
sudo ln -s /etc/nginx/sites-available/gatewaywa /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### f. SSL (Certbot)
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d gatewaywa.my.id -d www.gatewaywa.my.id --redirect
```

### g. Firewall
```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```
Port 3000 tidak perlu dibuka; app hanya listen di `127.0.0.1`.

### h. Scan QR
Buka https://gatewaywa.my.id, login, scan QR. Sesi tersimpan di `storage/auth`.

### i. GitHub Actions
1. Di VPS buat key khusus CI: `ssh-keygen -t ed25519 -f ~/.ssh/gh_actions -N ""` lalu `cat ~/.ssh/gh_actions.pub >> ~/.ssh/authorized_keys`.
2. GitHub repo → Settings → Secrets and variables → Actions, tambahkan:
   - `VPS_HOST` = `43.173.41.124`
   - `VPS_USER` = `ubuntu`
   - `VPS_SSH_KEY` = isi `~/.ssh/gh_actions` (private key)
   - `VPS_FINGERPRINT` = fingerprint host key VPS, supaya GitHub tidak bisa diarahkan ke server palsu. Ambil di VPS dengan `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | cut -d' ' -f2`, lalu salin hasilnya utuh, termasuk awalan `SHA256:`. Workflow menolak deploy kalau secret ini kosong.

## 2. Deploy rutin
```bash
git add . && git commit -m "..." && git push origin main
```
Pantau di tab **Actions** GitHub. Manual dari VPS: `cd ~/apps/gatewaywa && ./deploy.sh`.

## 3. Rollback
```bash
cd ~/apps/gatewaywa
git log --oneline -10
git checkout <commit>
npm ci --omit=dev
pm2 reload ecosystem.config.cjs --update-env
```
Rollback permanen: `git revert` di lokal lalu push, karena deploy berikutnya akan menyamakan VPS dengan `main`.

## 4. Log & status
```bash
pm2 status
pm2 logs gatewaywa              # live
pm2 logs gatewaywa --lines 200 --nostream
curl -s http://127.0.0.1:3000/health
tail -f /var/log/nginx/gatewaywa.error.log
```
File log app: `~/apps/gatewaywa/logs/`.

## 5. Backup sesi WhatsApp
Data pesan ada di Supabase (backup harian otomatis dari Supabase). Yang perlu di-backup di VPS cuma sesi WA + `.env`:
```bash
mkdir -p ~/backups
tar czf ~/backups/gatewaywa-$(date +%F).tar.gz -C ~/apps/gatewaywa storage .env
```
Otomatis tiap hari jam 02:00 + simpan 14 hari (`crontab -e`):
```
0 2 * * * tar czf ~/backups/gatewaywa-$(date +\%F).tar.gz -C ~/apps/gatewaywa storage .env && find ~/backups -name 'gatewaywa-*.tar.gz' -mtime +14 -delete
```
Restore: `pm2 stop gatewaywa && tar xzf ~/backups/gatewaywa-YYYY-MM-DD.tar.gz -C ~/apps/gatewaywa && pm2 start gatewaywa`.

Jangan jalankan sesi yang sama di 2 tempat (lokal + VPS) bersamaan, nanti saling memutus.
