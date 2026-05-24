# 🤖 SEO Rank Monitor Bot

Bot Telegram untuk memonitor ranking domain di **Google Mobile SERP Indonesia** secara otomatis.

## ✨ Fitur

| Fitur | Keterangan |
|---|---|
| 📱 Mobile SERP Indonesia | Scraping dengan Android user-agent, `gl=id`, `hl=id` |
| 🏷️ Forum Topic Support | Otomatis routing ke topic Telegram yang tepat |
| ⏰ Auto Monitoring | Cek otomatis setiap 30 menit |
| 🔔 Smart Notification | Notif hanya saat status berubah (anti-spam) |
| 🗑️ Auto Remove | Domain hilang 2x berturut-turut otomatis dihapus |
| 💾 PostgreSQL | Semua data tersimpan persistent |
| 🚂 Railway Ready | Deploy langsung ke Railway |

## 📁 Struktur Project

```
seo-rank-monitor/
├── index.js          # Main bot logic
├── package.json
├── .env.example      # Template environment variables
├── .env              # File env kamu (jangan di-commit!)
├── railway.json      # Railway deployment config
├── schema.sql        # Database schema (auto-create saat startup)
└── README.md
```

## ⚙️ Topic Config

Bot membaca `message_thread_id` dari setiap pesan untuk menentukan keyword:

| Topic Name | Topic ID | Keyword |
|---|---|---|
| SATSET138 | 4 | SATSET138 |
| MAHJONG138 | 3 | MAHJONG138 |
| DOLAR138 | 2 | DOLAR138 |

> **Untuk menambah topic:** Edit objek `TOPICS` dan `TOPIC_IDS` di `index.js`.

## 🚀 Setup & Deploy

### 1. Clone & Install

```bash
git clone <repo-url>
cd seo-rank-monitor
npm install
```

### 2. Buat Bot Telegram

1. Buka [@BotFather](https://t.me/botfather) di Telegram
2. Kirim `/newbot` dan ikuti instruksi
3. Salin **Bot Token** yang diberikan

### 3. Setup Supergroup Telegram

1. Buat Telegram Supergroup dengan Topics diaktifkan  
   (Settings → Topics → Enable)
2. Tambahkan bot sebagai **Administrator** dengan izin:
   - Send Messages ✅
   - Manage Topics ✅
3. Cari Chat ID grup:
   - Forward pesan dari grup ke [@userinfobot](https://t.me/userinfobot)
   - Atau gunakan `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Cari Topic ID:
   - Kirim pesan di setiap topic
   - Cek di `getUpdates` → `message.message_thread_id`

### 4. Setup Environment Variables

```bash
cp .env.example .env
nano .env  # isi semua variable
```

```env
TELEGRAM_BOT_TOKEN=123456789:AAxxxxxx
TELEGRAM_CHAT_ID=-1001234567890
DATABASE_URL=postgresql://user:pass@host:5432/dbname
DATABASE_SSL=true
PORT=3000
NODE_ENV=production
```

### 5. Setup Database

Bot akan **auto-create** tabel saat pertama kali dijalankan.

Jika ingin setup manual:
```bash
psql $DATABASE_URL -f schema.sql
```

### 6. Jalankan Lokal

```bash
node index.js
# atau untuk development:
npm run dev
```

---

## 🚂 Deploy ke Railway

### Cara 1: Deploy via GitHub (Recommended)

1. Push project ke GitHub repository
2. Buka [railway.app](https://railway.app) → **New Project**
3. Pilih **Deploy from GitHub** → pilih repo kamu
4. Railway akan auto-detect `railway.json`

### Cara 2: Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Init project
railway init

# Deploy
railway up
```

### Setup PostgreSQL di Railway

1. Di dashboard Railway → **New** → **Database** → **PostgreSQL**
2. Railway otomatis inject `DATABASE_URL` ke service kamu
3. Tidak perlu setting manual!

### Setup Environment Variables di Railway

Di Railway dashboard → service kamu → **Variables** tab:

```
TELEGRAM_BOT_TOKEN  = token dari BotFather
TELEGRAM_CHAT_ID    = chat id supergroup
NODE_ENV            = production
```

> `DATABASE_URL` dan `PORT` otomatis di-inject Railway.

---

## 📋 Commands

Semua command dikirim **di dalam topic** yang sesuai:

| Command | Fungsi |
|---|---|
| `/add domain.com` | Tambah domain ke monitoring |
| `/remove domain.com` | Hapus domain dari monitoring |
| `/list` | Lihat semua domain di topic ini |
| `/check` | Cek ranking manual sekarang |
| `/ping` | Test bot online |

### Contoh Penggunaan

Di topic **SATSET138**:
```
/add satset138murni.com
/add satset138slot.com
/check
/list
/remove satset138slot.com
```

---

## 📊 Format Notifikasi

### Hasil /check
```
📊 STATUS KEYWORD SATSET138
📱 Google Mobile Indonesia
🕐 24/01/2025, 14:30:00 WIB
──────────────────────────────

✅ satset138murni.com
   📌 Rank Mobile Indonesia: 7

❌ domainlain.com
   📌 NOT FOUND (Top 100)

──────────────────────────────
📡 Data SERP: 98 hasil ditemukan
```

### Domain Muncul
```
🚀 DOMAIN MUNCUL!
🌐 Domain : satset138.com
🔑 Keyword: SATSET138
📌 Rank   : 12
🕐 24/01/2025, 15:00:00 WIB
```

### Domain Hilang
```
⚠️ DOMAIN HILANG!
🌐 Domain : satset138.com
🔑 Keyword: SATSET138
🕐 24/01/2025, 15:00:00 WIB
🔄 Akan auto-remove jika hilang 1x lagi.
```

### Auto Remove
```
🗑️ AUTO REMOVED
🌐 Domain : satset138.com
🔑 Keyword: SATSET138
❌ Tidak ditemukan 2x berturut-turut.
🕐 24/01/2025, 15:30:00 WIB
```

---

## 🔧 Kustomisasi

### Ubah Interval Monitoring

Di `index.js`, cari baris:
```javascript
cron.schedule('*/30 * * * *', () => {
```

Contoh ganti jadi setiap 1 jam:
```javascript
cron.schedule('0 * * * *', () => {
```

### Tambah Topic Baru

Di `index.js`:
```javascript
const TOPICS = {
  4: 'SATSET138',
  3: 'MAHJONG138',
  2: 'DOLAR138',
  5: 'KEYWORD_BARU',  // ← tambah ini
};
```

### Ubah Jumlah Disappear untuk Auto-Remove

Cari `>= 2` dan ubah angkanya:
```javascript
if (!isFound && newDisappearCount >= 3) {  // ubah ke 3
```

---

## ⚠️ Penting

- **Jangan** commit file `.env` ke Git (sudah ada di `.gitignore`)
- Bot membutuhkan **akses Admin** di supergroup
- Google dapat memblokir sementara jika terlalu banyak request — bot sudah punya delay random antar halaman
- Scraping Google melanggar ToS Google — gunakan untuk keperluan pribadi/edukasi
- Disarankan tidak monitor lebih dari **20-30 domain** sekaligus untuk menghindari rate limit

---

## 📝 Troubleshooting

**Bot tidak merespons command**
- Pastikan bot sudah jadi Admin di supergroup
- Pastikan `TELEGRAM_CHAT_ID` benar (harus angka negatif untuk supergroup)
- Cek log Railway untuk error

**SERP kosong / 0 hasil**
- Google mungkin memblokir sementara — tunggu 10-15 menit
- Cek log: jika ada "Rate-limited by Google", normal — bot akan skip dan coba lagi di siklus berikutnya

**Error koneksi database**
- Pastikan `DATABASE_URL` valid
- Di Railway, pastikan PostgreSQL plugin sudah di-linked ke service

**Topic ID tidak dikenali**
- Gunakan `getUpdates` untuk verifikasi `message_thread_id` dari topic
- Update objek `TOPICS` di `index.js`
