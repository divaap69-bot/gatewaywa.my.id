// PM2 config. Jalankan dari folder app: pm2 start ecosystem.config.cjs
// Hanya 1 instance (fork): sesi WhatsApp tidak boleh dipakai 2 proses sekaligus.
module.exports = {
  apps: [
    {
      name: 'gatewaywa',
      script: 'src/server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      exp_backoff_restart_delay: 200, // jeda restart naik bertahap kalau crash berulang
      max_restarts: 20,
      min_uptime: '20s',
      kill_timeout: 10000, // beri waktu graceful shutdown (server.js paksa keluar di 8 detik)
      wait_ready: true,    // tunggu process.send('ready') dari server.js
      listen_timeout: 15000,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
