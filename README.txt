OCHILD BOT AI - PATCH FFmpeg

Isi ZIP:
- index.js: script yang telah dipatch untuk mendeteksi FFmpeg dan memberikan error yang jelas.
- nixpacks.toml: konfigurasi Nixpacks untuk memasang Node.js 20, FFmpeg, fontconfig, dan DejaVu Fonts.

CARA PASANG:
1. Backup index.js lama.
2. Ganti index.js lama dengan index.js dari ZIP ini.
3. Letakkan nixpacks.toml di ROOT repository GitHub (sejajar dengan package.json dan index.js), bukan di dalam folder lain.
4. Pastikan Railway menggunakan builder Nixpacks. Jika project memakai Railpack, konfigurasi nixpacks.toml mungkin tidak diterapkan; ubah builder ke Nixpacks atau gunakan konfigurasi builder yang aktif.
5. Commit dan push ke GitHub, lalu lakukan Redeploy di Railway. Jika masih memakai image lama, lakukan deploy ulang dengan clear build cache.
6. Periksa log startup. Seharusnya muncul [FFMPEG] Siap: ...

CATATAN:
- Jalankan `node --check index.js` untuk pemeriksaan sintaks.
- Script ini tetap memerlukan dependency npm yang memang digunakan project (misalnya @whiskeysockets/baileys, axios, pino, qrcode-terminal).
- Pengujian koneksi WhatsApp dan semua fitur memerlukan environment Railway serta kredensial/session milik Anda; tidak dapat divalidasi penuh secara lokal di sini.
