# 🤖 Telegram SEO Rank Monitor Bot

Bot Telegram **private** untuk memonitor ranking domain di **Google Mobile Indonesia SERP** secara otomatis — seperti Ahrefs / SERPWatcher versi Telegram.

---

## ✨ Fitur

| Fitur | Detail |
|-------|--------|
| 🌎 Google Mobile Indonesia | `gl=id`, `hl=id`, `google_domain=google.co.id`, `device=mobile`, `location=Indonesia` |
| ⏱️ Auto Monitoring | Setiap 30 menit otomatis cek & kirim update ke topic |
| 📊 Snapshot Rutin | Update dikirim tiap 30 menit walau tidak ada perubahan |
| 🔔 Detect Perubahan | Notif rank naik, turun, domain muncul, domain hilang |
| 🗂️ Forum Topics | Support Telegram Supergroup Forum, 1 topic = 1 keyword |
| 🗄️ PostgreSQL | Data persistent, auto-create table |
| 🚂 Railway Ready | Deploy 1-klik ke Railway |

---

## 📋 Commands

Semua command dijalankan **di dalam topic** yang sesuai. Bot otomatis tahu keyword dari topic ID.

| Command | Fungsi |
|---------|--------|
| `/add domain.com` | Tambah domain ke keyword topic ini |
| `/remove domain.com` | Hapus domain dari keyword topic ini |
| `/list` | Lihat semua domain + ranking saat ini |
| `/check` | Force check ranking sekarang (realtime) |
| `/ping` | Cek apakah bot aktif |

---

## 🗂️ Struktur Topic Forum

```
Supergroup Forum
├── Topic: SATSET138   (topic_id = 4)  → keyword: SATSET138
├── Topic: MAHJONG138  (topic_id = 3)  → keyword: MAHJONG138
└── Topic: DOLAR138    (topic_id = 2)  → keyword: DOLAR138
```

Untuk menambah topic baru, edit bagian ini di `index.js`:

```js
const TOPIC_KEYWORD_MAP = {
  4: 'SATSET138',
  3: 'MAHJONG138',
  2: 'DOLAR138',
  // Tambah di sini: topic_id: 'KEYWORD'
};
```

---

## 🚀 Cara Install & Jalankan Lokal

### 1. Clone / copy project

```bash
git clone https://github.com/username/telegram-seo-rank-bot.git
cd telegram-seo-rank-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Buat file `.env`

```bash
cp .env.example .env
```

Isi nilai di `.env`:

```env
TELEGRAM_BOT_TOKEN=1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=-1001234567890
SERPAPI_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
DATABASE_URL=postgresql://user:password@localhost:5432/seo_bot
PORT=3000
```

### 4. Jalankan

```bash
npm start
```

---

## 🚂 Deploy ke Railway

### Langkah 1 — Buat project baru di Railway

1. Buka [railway.app](https://railway.app)
2. Klik **New Project**
3. Pilih **Deploy from GitHub repo** (atau upload manual)

### Langkah 2 — Tambah PostgreSQL

1. Di dashboard project, klik **+ New**
2. Pilih **Database → Add PostgreSQL**
3. Railway akan otomatis buat database dan set `DATABASE_URL`

### Langkah 3 — Set Environment Variables

Di **Variables** tab project Railway, tambahkan:

| Key | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | Token dari @BotFather |
| `TELEGRAM_CHAT_ID` | Chat ID supergroup (angka negatif) |
| `SERPAPI_KEY` | API key dari serpapi.com |
| `DATABASE_URL` | Otomatis diisi jika pakai PostgreSQL Railway |
| `PORT` | Biarkan kosong (Railway isi otomatis) |

### Langkah 4 — Deploy

Railway akan otomatis deploy saat push ke GitHub, atau klik **Deploy** manual.

---

## 🔧 Cara Dapat Credentials

### TELEGRAM_BOT_TOKEN

1. Buka Telegram, cari **@BotFather**
2. Ketik `/newbot`
3. Ikuti instruksi, dapatkan token

### TELEGRAM_CHAT_ID

1. Tambahkan bot ke supergroup
2. Jadikan bot sebagai **Admin**
3. Kirim pesan di group, lalu buka:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. Cari `"chat":{"id":` — nilai negatif itu adalah CHAT_ID

### SERPAPI_KEY

1. Daftar di [serpapi.com](https://serpapi.com)
2. Pergi ke **Dashboard → API Key**
3. Copy API key

### Topic IDs

1. Di Telegram Desktop, klik kanan pada topic
2. Pilih **Copy Link** → URL berakhir dengan `/NUMBER`
3. Angka tersebut adalah `message_thread_id` (topic ID)

Atau lihat dari `getUpdates`:
```json
"message_thread_id": 4
```

---

## 🗄️ Database Schema

Table `domains` dibuat otomatis:

```sql
CREATE TABLE domains (
  id            SERIAL PRIMARY KEY,
  keyword       VARCHAR(255) NOT NULL,
  domain        VARCHAR(255) NOT NULL,
  current_rank  INTEGER,
  previous_rank INTEGER,
  status        VARCHAR(50)  DEFAULT 'NOT_FOUND',
  change_type   VARCHAR(50),
  last_checked  TIMESTAMPTZ,
  last_seen     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (keyword, domain)
);
```

**Status values:** `FOUND` / `NOT_FOUND`

**Change type values:** `NEW` / `LOST` / `UP` / `DOWN` / `STABLE`

---

## 📡 SERPAPI Parameters

Bot menggunakan parameter ini untuk mensimulasikan user mobile Indonesia:

```json
{
  "engine": "google",
  "gl": "id",
  "hl": "id",
  "google_domain": "google.co.id",
  "device": "mobile",
  "location": "Indonesia",
  "num": 100,
  "no_cache": true
}
```

---

## 📊 Format Pesan Bot

### Update Rutin (tiap 30 menit)
```
📊 UPDATE SERP SATSET138
🕒 24/05/2026 13:30 WIB
🌎 Google Mobile Indonesia

1. satset138asia.com
   🏆 Rank #3

2. satset138murni.com
   🏆 Rank #12

3. domainlain.com
   ❌ Tidak ditemukan di Top 100

━━━━━━━━━━
📈 Total ditemukan: 2/3
```

### Notifikasi Perubahan
```
🔥 DOMAIN MUNCUL        → Baru masuk Top 100
❌ DOMAIN HILANG        → Keluar dari Top 100
📈 RANK NAIK            → Posisi membaik
📉 RANK TURUN           → Posisi memburuk
```

---

## 🔍 Health Check

Bot menyediakan endpoint untuk keepalive:

```
GET /health  → Status JSON
GET /        → Info bot
```

---

## ⚙️ Konfigurasi Lanjutan

### Ubah interval monitoring

Di `index.js`, cari:
```js
cron.schedule('*/30 * * * *', ...)
```

Contoh ubah ke 15 menit:
```js
cron.schedule('*/15 * * * *', ...)
```

### Ubah delay antar SERPAPI call

```js
const SERPAPI_DELAY_MS = 2500; // milliseconds
```

Naikkan jika kena rate limit SERPAPI.

---

## 📁 Struktur File

```
telegram-seo-rank-bot/
├── index.js          ← Main application (bot + cron + express)
├── package.json      ← Dependencies
├── railway.json      ← Railway deployment config
├── .env.example      ← Template environment variables
├── .gitignore
└── README.md
```

---

## 🛡️ Notes Keamanan

- **JANGAN** commit file `.env` ke Git
- Pastikan `.gitignore` menyertakan `.env`
- Bot token hanya untuk 1 bot — jangan share
- Chat ID bersifat rahasia

---

## 📞 Troubleshooting

**Bot tidak response di topic?**
→ Pastikan bot sudah jadi Admin di supergroup dan punya izin kirim pesan.

**Error `TELEGRAM_CHAT_ID` tidak valid?**
→ Chat ID supergroup harus berupa angka **negatif** (contoh: `-1001234567890`).

**SERPAPI error 429?**
→ Rate limit. Naikkan `SERPAPI_DELAY_MS` atau upgrade plan SERPAPI.

**PostgreSQL connection failed di Railway?**
→ Pastikan pakai PostgreSQL plugin Railway, bukan external. `DATABASE_URL` otomatis diisi.

**Rank selalu NOT FOUND?**
→ Cek apakah domain sudah benar (tanpa https://, tanpa trailing slash). Coba `/check` manual.
