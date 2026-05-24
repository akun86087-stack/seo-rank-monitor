-- ============================================================
--  SEO Rank Monitor — Database Schema
--  PostgreSQL
--  Jalankan sekali saat setup awal, atau biarkan auto-create
--  (index.js akan auto-create tabel saat startup)
-- ============================================================

-- Drop jika ingin reset bersih (hati-hati: data hilang!)
-- DROP TABLE IF EXISTS domains;

-- ── Main table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domains (
  id              SERIAL PRIMARY KEY,

  -- Nama keyword / topic (SATSET138, MAHJONG138, DOLAR138)
  keyword         VARCHAR(100)  NOT NULL,

  -- Domain tanpa www dan tanpa protocol (contoh: satset138.com)
  domain          VARCHAR(255)  NOT NULL,

  -- Status terakhir: TRUE = ada di SERP, FALSE = tidak ada, NULL = belum dicek
  last_status     BOOLEAN       DEFAULT NULL,

  -- Berapa kali berturut-turut domain tidak ditemukan di SERP
  disappear_count INTEGER       DEFAULT 0,

  -- Rank terakhir yang ditemukan (NULL jika tidak ditemukan)
  last_rank       INTEGER       DEFAULT NULL,

  -- Waktu domain pertama kali ditambahkan
  created_at      TIMESTAMPTZ   DEFAULT NOW(),

  -- Kombinasi keyword + domain harus unik
  UNIQUE(keyword, domain)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_domains_keyword
  ON domains(keyword);

CREATE INDEX IF NOT EXISTS idx_domains_last_status
  ON domains(last_status);

CREATE INDEX IF NOT EXISTS idx_domains_created_at
  ON domains(created_at DESC);

-- ── Contoh data awal (opsional, hapus jika tidak perlu) ──────
-- INSERT INTO domains (keyword, domain)
-- VALUES
--   ('SATSET138',  'satset138murni.com'),
--   ('MAHJONG138', 'mahjong138.net'),
--   ('DOLAR138',   'dolar138.com')
-- ON CONFLICT DO NOTHING;
