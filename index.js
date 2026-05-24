'use strict';

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const axios = require('axios');
const cron = require('node-cron');
const { URL } = require('url');

// ============================================================
// VALIDATE REQUIRED ENV
// ============================================================

const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DATABASE_URL', 'SERPAPI_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ============================================================
// CONSTANTS & CONFIG
// ============================================================

const PORT = process.env.PORT || 3000;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Topic ID → Keyword mapping (edit to match your Telegram forum topics)
const TOPIC_KEYWORD_MAP = {
  4: 'SATSET138',
  3: 'MAHJONG138',
  2: 'DOLAR138',
};

// Reverse map for lookup
const KEYWORD_TOPIC_MAP = Object.fromEntries(
  Object.entries(TOPIC_KEYWORD_MAP).map(([id, kw]) => [kw, parseInt(id)])
);

// Delay between SERPAPI calls (ms) to avoid rate limiting
const SERPAPI_DELAY_MS = 2500;

// ============================================================
// EXPRESS SERVER (Railway keepalive)
// ============================================================

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    bot: 'Telegram SEO Rank Monitor',
    version: '1.0.0',
    status: 'running',
    uptime_seconds: Math.floor(process.uptime()),
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'production',
  });
});

// ============================================================
// POSTGRESQL POOL
// ============================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err.message);
});

// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: { timeout: 10 },
  },
});

bot.on('polling_error', (err) => {
  console.error('❌ Telegram polling error:', err.message);
});

bot.on('error', (err) => {
  console.error('❌ Telegram bot error:', err.message);
});

// ============================================================
// DATABASE INIT & HELPERS
// ============================================================

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS domains (
        id           SERIAL PRIMARY KEY,
        keyword      VARCHAR(255)  NOT NULL,
        domain       VARCHAR(255)  NOT NULL,
        current_rank INTEGER,
        previous_rank INTEGER,
        status       VARCHAR(50)   NOT NULL DEFAULT 'NOT_FOUND',
        change_type  VARCHAR(50),
        last_checked TIMESTAMPTZ,
        last_seen    TIMESTAMPTZ,
        created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (keyword, domain)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_domains_keyword ON domains (keyword);
    `);

    console.log('✅ Database tables ready');
  } finally {
    client.release();
  }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/**
 * Clean user-submitted domain:
 * - Strip https:// or http://
 * - Strip trailing slashes & paths
 * - Lowercase
 */
function cleanDomain(input) {
  let d = input.trim();
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/\/.*$/, '');
  d = d.toLowerCase();
  return d;
}

/**
 * Get keyword from Telegram message via topic ID
 */
function getKeywordFromMsg(msg) {
  const topicId = msg.message_thread_id;
  if (!topicId) return null;
  return TOPIC_KEYWORD_MAP[topicId] || null;
}

/**
 * Format current time in WIB (UTC+7)
 */
function getWIBTime() {
  const now = new Date();
  return now.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replace(',', '') + ' WIB';
}

/**
 * Format TIMESTAMPTZ from DB to WIB string
 */
function formatWIBFromDate(date) {
  if (!date) return 'Belum dicek';
  return new Date(date).toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).replace(',', '') + ' WIB';
}

/**
 * Extract clean hostname from a URL string.
 * Returns null if invalid or should be ignored.
 */
function extractHostname(rawUrl) {
  if (!rawUrl) return null;
  try {
    const urlStr = rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl;
    const parsed = new URL(urlStr);
    const host = parsed.hostname.toLowerCase();

    // Ignore Google infrastructure
    if (
      host.includes('googleusercontent.com') ||
      host.includes('translate.google') ||
      host.includes('webcache.googleusercontent') ||
      host.includes('google.com') ||
      host.includes('gstatic.com') ||
      host.includes('googleapis.com')
    ) {
      return null;
    }

    return host;
  } catch {
    return null;
  }
}

/**
 * Check if a SERP result URL matches a target domain.
 * Supports exact match or subdomain matching.
 */
function urlMatchesDomain(resultUrl, targetDomain) {
  const host = extractHostname(resultUrl);
  if (!host) return false;

  // Exact: domain.com === domain.com
  if (host === targetDomain) return true;

  // SERP result is subdomain of target: sub.domain.com ends with .domain.com
  if (host.endsWith('.' + targetDomain)) return true;

  // Target is subdomain of result (less common but handle it)
  if (targetDomain.endsWith('.' + host)) return true;

  return false;
}

/**
 * Promise-based sleep
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// SERPAPI - FETCH RANKING
// ============================================================

/**
 * Fetch keyword rank for a target domain from Google Mobile Indonesia SERP.
 * Returns rank (integer) or null if not found.
 */
async function fetchSERPRank(keyword, targetDomain) {
  const params = {
    engine: 'google',
    q: keyword,
    gl: 'id',
    hl: 'id',
    google_domain: 'google.co.id',
    device: 'mobile',
    location: 'Indonesia',
    num: 100,
    no_cache: true,
    api_key: SERPAPI_KEY,
  };

  const response = await axios.get('https://serpapi.com/search.json', {
    params,
    timeout: 35000,
  });

  const organicResults = response.data?.organic_results;
  if (!Array.isArray(organicResults) || organicResults.length === 0) {
    console.warn(`⚠️  No organic results for keyword: ${keyword}`);
    return null;
  }

  const seenUrls = new Set();

  for (const result of organicResults) {
    const resultUrl = result.link || result.url || '';
    if (!resultUrl || seenUrls.has(resultUrl)) continue;
    seenUrls.add(resultUrl);

    if (urlMatchesDomain(resultUrl, targetDomain)) {
      // Use SERPAPI's position field if present, otherwise derive from index
      const rank = result.position ?? (organicResults.indexOf(result) + 1);
      return rank;
    }
  }

  return null; // Not found in top 100
}

// ============================================================
// DATABASE OPERATIONS
// ============================================================

async function dbAddDomain(keyword, domain) {
  await pool.query(
    `INSERT INTO domains (keyword, domain, status, created_at)
     VALUES ($1, $2, 'NOT_FOUND', NOW())
     ON CONFLICT (keyword, domain) DO NOTHING`,
    [keyword, domain]
  );
}

async function dbRemoveDomain(keyword, domain) {
  const result = await pool.query(
    'DELETE FROM domains WHERE keyword = $1 AND domain = $2',
    [keyword, domain]
  );
  return result.rowCount > 0;
}

async function dbGetDomains(keyword) {
  const result = await pool.query(
    'SELECT * FROM domains WHERE keyword = $1 ORDER BY created_at ASC',
    [keyword]
  );
  return result.rows;
}

async function dbGetAllDomains() {
  const result = await pool.query(
    'SELECT * FROM domains ORDER BY keyword, created_at ASC'
  );
  return result.rows;
}

/**
 * Update domain rank in DB and return change info.
 * Returns: { domain, keyword, oldRank, newRank, oldStatus, newStatus, changeType }
 */
async function dbUpdateRank(keyword, domain, newRank) {
  const client = await pool.connect();
  try {
    // Fetch current state
    const res = await client.query(
      'SELECT * FROM domains WHERE keyword = $1 AND domain = $2',
      [keyword, domain]
    );

    if (res.rows.length === 0) {
      // Domain was deleted, skip
      return null;
    }

    const row = res.rows[0];
    const oldRank = row.current_rank;       // previous rank value
    const oldStatus = row.status;           // FOUND / NOT_FOUND

    const newStatus = newRank ? 'FOUND' : 'NOT_FOUND';

    let changeType;
    if (newRank && !oldRank && oldStatus === 'NOT_FOUND') {
      changeType = 'NEW';
    } else if (!newRank && oldStatus === 'FOUND') {
      changeType = 'LOST';
    } else if (newRank && oldRank && newRank < oldRank) {
      changeType = 'UP';
    } else if (newRank && oldRank && newRank > oldRank) {
      changeType = 'DOWN';
    } else {
      changeType = 'STABLE';
    }

    await client.query(
      `UPDATE domains SET
         previous_rank = current_rank,
         current_rank  = $3,
         status        = $4,
         change_type   = $5,
         last_checked  = NOW(),
         last_seen     = CASE WHEN $6 THEN NOW() ELSE last_seen END
       WHERE keyword = $1 AND domain = $2`,
      [keyword, domain, newRank ?? null, newStatus, changeType, !!newRank]
    );

    return { domain, keyword, oldRank, newRank, oldStatus, newStatus, changeType };
  } finally {
    client.release();
  }
}

// ============================================================
// TELEGRAM SEND HELPERS
// ============================================================

/**
 * Send message to a specific forum topic
 */
async function sendToTopic(topicId, text) {
  try {
    await bot.sendMessage(CHAT_ID, text, {
      message_thread_id: topicId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error(`❌ sendToTopic(${topicId}) failed:`, err.message);
    // Fallback: send without topic
    try {
      await bot.sendMessage(CHAT_ID, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (err2) {
      console.error('❌ sendToTopic fallback also failed:', err2.message);
    }
  }
}

/**
 * Reply to the message within its topic (thread)
 */
async function replyInTopic(msg, text) {
  try {
    const opts = {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (msg.message_thread_id) {
      opts.message_thread_id = msg.message_thread_id;
    }
    await bot.sendMessage(msg.chat.id, text, opts);
  } catch (err) {
    console.error('❌ replyInTopic failed:', err.message);
  }
}

// ============================================================
// RANK CHANGE NOTIFICATION BUILDER
// ============================================================

function buildChangeNotification(result) {
  const { domain, keyword, oldRank, newRank, changeType } = result;

  switch (changeType) {
    case 'NEW':
      return (
        `🔥 <b>DOMAIN MUNCUL</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Keyword: <b>${keyword}</b>\n` +
        `Rank: <b>#${newRank}</b>`
      );

    case 'LOST':
      return (
        `❌ <b>DOMAIN HILANG</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Keyword: <b>${keyword}</b>`
      );

    case 'UP':
      return (
        `📈 <b>RANK NAIK</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Keyword: <b>${keyword}</b>\n` +
        `<b>#${oldRank} ➜ #${newRank}</b>`
      );

    case 'DOWN':
      return (
        `📉 <b>RANK TURUN</b>\n\n` +
        `Domain: <code>${domain}</code>\n` +
        `Keyword: <b>${keyword}</b>\n` +
        `<b>#${oldRank} ➜ #${newRank}</b>`
      );

    case 'STABLE':
    default:
      return null; // Don't spam stable notifications
  }
}

// ============================================================
// SNAPSHOT UPDATE BUILDER
// ============================================================

function buildSnapshotMessage(keyword, domains) {
  const timeStr = getWIBTime();
  let msg =
    `📊 <b>UPDATE SERP ${keyword}</b>\n` +
    `🕒 ${timeStr}\n` +
    `🌎 Google Mobile Indonesia\n\n`;

  let foundCount = 0;

  domains.forEach((d, i) => {
    const n = i + 1;
    if (d.status === 'FOUND' && d.current_rank) {
      msg += `${n}. <code>${d.domain}</code>\n   🏆 Rank #${d.current_rank}\n\n`;
      foundCount++;
    } else {
      msg += `${n}. <code>${d.domain}</code>\n   ❌ Tidak ditemukan di Top 100\n\n`;
    }
  });

  msg += `━━━━━━━━━━\n📈 Total ditemukan: ${foundCount}/${domains.length}`;
  return msg;
}

// ============================================================
// CORE MONITORING FUNCTION
// ============================================================

async function runMonitoringCycle() {
  console.log(`\n🔄 [MONITOR] Cycle started — ${getWIBTime()}`);

  let allDomains;
  try {
    allDomains = await dbGetAllDomains();
  } catch (err) {
    console.error('❌ [MONITOR] Failed to load domains from DB:', err.message);
    return;
  }

  if (allDomains.length === 0) {
    console.log('ℹ️  [MONITOR] No domains to check. Skipping.');
    return;
  }

  // Group domains by keyword
  const grouped = {};
  for (const row of allDomains) {
    if (!grouped[row.keyword]) grouped[row.keyword] = [];
    grouped[row.keyword].push(row);
  }

  for (const [keyword, domains] of Object.entries(grouped)) {
    const topicId = KEYWORD_TOPIC_MAP[keyword];
    if (!topicId) {
      console.warn(`⚠️  [MONITOR] No topic ID found for keyword: ${keyword}`);
      continue;
    }

    console.log(`\n📌 [MONITOR] Keyword: ${keyword} (${domains.length} domains)`);

    const changeResults = [];

    for (const d of domains) {
      await sleep(SERPAPI_DELAY_MS);

      try {
        const rank = await fetchSERPRank(keyword, d.domain);
        const result = await dbUpdateRank(keyword, d.domain, rank);

        if (!result) continue;

        const rankStr = rank ? `#${rank}` : 'NOT FOUND';
        console.log(`  ${d.domain} → ${rankStr} [${result.changeType}]`);

        if (result.changeType !== 'STABLE') {
          changeResults.push(result);
        }
      } catch (err) {
        console.error(`  ❌ Error checking ${d.domain}:`, err.message);
        // Continue to next domain — don't crash the cycle
      }
    }

    // Send change notifications first (only if there are changes)
    for (const result of changeResults) {
      const notif = buildChangeNotification(result);
      if (notif) {
        await sendToTopic(topicId, notif);
        await sleep(500);
      }
    }

    // Always send snapshot regardless of changes
    try {
      const updatedDomains = await dbGetDomains(keyword);
      const snapshot = buildSnapshotMessage(keyword, updatedDomains);
      await sendToTopic(topicId, snapshot);
    } catch (err) {
      console.error(`❌ [MONITOR] Failed to send snapshot for ${keyword}:`, err.message);
    }

    // Delay between keywords to be polite to SERPAPI
    await sleep(3000);
  }

  console.log(`\n✅ [MONITOR] Cycle complete — ${getWIBTime()}\n`);
}

// ============================================================
// TELEGRAM BOT COMMANDS
// ============================================================

// ── /ping ─────────────────────────────────────────────────────
bot.onText(/^\/ping(@\w+)?$/, async (msg) => {
  await replyInTopic(msg, '🏓 <b>BOT ONLINE</b>');
});

// ── /add <domain> ─────────────────────────────────────────────
bot.onText(/^\/add(@\w+)?\s+(.+)$/i, async (msg, match) => {
  const keyword = getKeywordFromMsg(msg);

  if (!keyword) {
    await replyInTopic(
      msg,
      '⚠️ Command ini hanya bisa digunakan di dalam topic yang terdaftar.\n\n' +
      'Topic yang terdaftar:\n' +
      Object.entries(TOPIC_KEYWORD_MAP)
        .map(([id, kw]) => `  • Topic ID ${id} → ${kw}`)
        .join('\n')
    );
    return;
  }

  const rawInput = match[2]?.trim();
  if (!rawInput) {
    await replyInTopic(msg, '⚠️ Format: <code>/add domain.com</code>');
    return;
  }

  const domain = cleanDomain(rawInput);

  if (!domain || !domain.includes('.') || domain.length < 4) {
    await replyInTopic(msg, `⚠️ Domain tidak valid: <code>${rawInput}</code>\n\nContoh: <code>/add domain.com</code>`);
    return;
  }

  try {
    await dbAddDomain(keyword, domain);
    console.log(`✅ Added: ${domain} → ${keyword}`);
    await replyInTopic(
      msg,
      `✅ <b>DOMAIN DITAMBAHKAN</b>\n\n` +
      `Keyword: <b>${keyword}</b>\n` +
      `Domain: <code>${domain}</code>\n\n` +
      `Gunakan /check untuk cek ranking sekarang.`
    );
  } catch (err) {
    console.error('❌ /add error:', err.message);
    await replyInTopic(msg, '❌ Gagal menambahkan domain. Silakan coba lagi.');
  }
});

// ── /remove <domain> ──────────────────────────────────────────
bot.onText(/^\/remove(@\w+)?\s+(.+)$/i, async (msg, match) => {
  const keyword = getKeywordFromMsg(msg);

  if (!keyword) {
    await replyInTopic(msg, '⚠️ Command ini hanya bisa digunakan di dalam topic yang terdaftar.');
    return;
  }

  const rawInput = match[2]?.trim();
  if (!rawInput) {
    await replyInTopic(msg, '⚠️ Format: <code>/remove domain.com</code>');
    return;
  }

  const domain = cleanDomain(rawInput);

  try {
    const removed = await dbRemoveDomain(keyword, domain);
    if (removed) {
      console.log(`🗑️  Removed: ${domain} from ${keyword}`);
      await replyInTopic(
        msg,
        `❌ <b>DOMAIN DIHAPUS</b>\n\n` +
        `Keyword: <b>${keyword}</b>\n` +
        `Domain: <code>${domain}</code>`
      );
    } else {
      await replyInTopic(
        msg,
        `⚠️ Domain <code>${domain}</code> tidak ditemukan di keyword <b>${keyword}</b>.`
      );
    }
  } catch (err) {
    console.error('❌ /remove error:', err.message);
    await replyInTopic(msg, '❌ Gagal menghapus domain. Silakan coba lagi.');
  }
});

// ── /list ─────────────────────────────────────────────────────
bot.onText(/^\/list(@\w+)?$/, async (msg) => {
  const keyword = getKeywordFromMsg(msg);

  if (!keyword) {
    await replyInTopic(msg, '⚠️ Command ini hanya bisa digunakan di dalam topic yang terdaftar.');
    return;
  }

  try {
    const domains = await dbGetDomains(keyword);

    if (domains.length === 0) {
      await replyInTopic(
        msg,
        `📋 <b>LIST DOMAIN ${keyword}</b>\n\nBelum ada domain yang ditambahkan.\n\nGunakan: <code>/add domain.com</code>`
      );
      return;
    }

    let text = `📋 <b>LIST DOMAIN ${keyword}</b>\n\n`;

    domains.forEach((d, i) => {
      const n = i + 1;
      const rankLine =
        d.status === 'FOUND' && d.current_rank
          ? `   🏆 Rank #${d.current_rank}`
          : `   ❌ Tidak ditemukan`;

      const checkedLine = `   🕒 ${formatWIBFromDate(d.last_checked)}`;
      const statusLine = d.status === 'FOUND'
        ? `   ✅ Status: FOUND`
        : `   ❌ Status: NOT FOUND`;

      text += `${n}. <code>${d.domain}</code>\n${rankLine}\n${statusLine}\n${checkedLine}\n\n`;
    });

    await replyInTopic(msg, text);
  } catch (err) {
    console.error('❌ /list error:', err.message);
    await replyInTopic(msg, '❌ Gagal mengambil list domain. Silakan coba lagi.');
  }
});

// ── /check ────────────────────────────────────────────────────
bot.onText(/^\/check(@\w+)?$/, async (msg) => {
  const keyword = getKeywordFromMsg(msg);

  if (!keyword) {
    await replyInTopic(msg, '⚠️ Command ini hanya bisa digunakan di dalam topic yang terdaftar.');
    return;
  }

  let domains;
  try {
    domains = await dbGetDomains(keyword);
  } catch (err) {
    console.error('❌ /check DB error:', err.message);
    await replyInTopic(msg, '❌ Gagal mengambil data dari database.');
    return;
  }

  if (domains.length === 0) {
    await replyInTopic(
      msg,
      `⚠️ Belum ada domain yang ditambahkan untuk keyword <b>${keyword}</b>.\n\nGunakan: <code>/add domain.com</code>`
    );
    return;
  }

  await replyInTopic(
    msg,
    `🔍 <b>Mengecek ranking ${keyword}...</b>\n` +
    `📡 Menghubungi Google Mobile Indonesia\n` +
    `⏳ Mohon tunggu (${domains.length} domain)...`
  );

  const checkResults = [];
  const changeResults = [];

  for (const d of domains) {
    await sleep(SERPAPI_DELAY_MS);
    try {
      const rank = await fetchSERPRank(keyword, d.domain);
      const result = await dbUpdateRank(keyword, d.domain, rank);
      checkResults.push({ domain: d.domain, rank });

      if (result && result.changeType !== 'STABLE') {
        changeResults.push(result);
      }

      const rankStr = rank ? `#${rank}` : 'NOT FOUND';
      console.log(`  /check: ${d.domain} → ${rankStr}`);
    } catch (err) {
      console.error(`  ❌ /check error for ${d.domain}:`, err.message);
      checkResults.push({ domain: d.domain, rank: null, error: true });
    }
  }

  // Send change notifications
  for (const result of changeResults) {
    const notif = buildChangeNotification(result);
    if (notif) {
      await replyInTopic(msg, notif);
      await sleep(300);
    }
  }

  // Build result message
  const timeStr = getWIBTime();
  let text =
    `🏆 <b>STATUS KEYWORD ${keyword}</b>\n` +
    `🕒 ${timeStr}\n` +
    `🌎 Google Mobile Indonesia\n\n`;

  let foundCount = 0;

  checkResults.forEach((r, i) => {
    const n = i + 1;
    if (r.error) {
      text += `${n}. <code>${r.domain}</code>\n   ⚠️ Error saat pengecekan\n\n`;
    } else if (r.rank) {
      text += `${n}. <code>${r.domain}</code>\n   ✅ Rank #${r.rank}\n\n`;
      foundCount++;
    } else {
      text += `${n}. <code>${r.domain}</code>\n   ❌ Tidak ditemukan di Top 100\n\n`;
    }
  });

  text += `━━━━━━━━━━\n📈 Total ditemukan: ${foundCount}/${checkResults.length}`;

  await replyInTopic(msg, text);
});

// ── Catch unhandled commands gracefully ───────────────────────
bot.on('message', (msg) => {
  if (msg.text && msg.text.startsWith('/')) {
    const command = msg.text.split(' ')[0].replace(/@\w+/, '').toLowerCase();
    const known = ['/ping', '/add', '/remove', '/list', '/check'];
    if (!known.includes(command)) {
      replyInTopic(
        msg,
        '❓ Command tidak dikenal.\n\n' +
        '<b>Commands yang tersedia:</b>\n' +
        '• <code>/add domain.com</code> — Tambah domain\n' +
        '• <code>/remove domain.com</code> — Hapus domain\n' +
        '• <code>/list</code> — Lihat semua domain\n' +
        '• <code>/check</code> — Cek ranking sekarang\n' +
        '• <code>/ping</code> — Cek status bot'
      ).catch(() => {});
    }
  }
});

// ============================================================
// CRON SCHEDULER — EVERY 30 MINUTES
// ============================================================

cron.schedule('*/30 * * * *', async () => {
  console.log('⏰ [CRON] 30-minute monitoring triggered');
  try {
    await runMonitoringCycle();
  } catch (err) {
    console.error('❌ [CRON] Monitoring cycle failed:', err.message);
  }
});

// ============================================================
// STARTUP
// ============================================================

async function start() {
  console.log('\n======================================================');
  console.log('  🤖 Telegram SEO Rank Monitor Bot');
  console.log('  📍 Google Mobile Indonesia SERP');
  console.log('======================================================\n');

  try {
    // Test DB connection
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');

    // Init tables
    await initDB();

    // Start Express
    app.listen(PORT, () => {
      console.log(`✅ Express running on port ${PORT}`);
    });

    console.log('✅ Telegram bot polling started');
    console.log('✅ Cron scheduler active (every 30 minutes)\n');

    // Verify bot identity
    const me = await bot.getMe();
    console.log(`🤖 Bot: @${me.username} (${me.first_name})\n`);

    console.log('Topic → Keyword mapping:');
    for (const [id, kw] of Object.entries(TOPIC_KEYWORD_MAP)) {
      console.log(`  Topic ${id} → ${kw}`);
    }

    console.log('\n📌 Available commands:');
    console.log('  /add domain.com — Add a domain');
    console.log('  /remove domain.com — Remove a domain');
    console.log('  /list — List all domains');
    console.log('  /check — Force check now');
    console.log('  /ping — Check bot status\n');

    // Run initial monitoring after 15s startup delay
    setTimeout(async () => {
      console.log('🔄 Running initial monitoring cycle...');
      try {
        await runMonitoringCycle();
      } catch (err) {
        console.error('❌ Initial monitoring failed:', err.message);
      }
    }, 15000);

  } catch (err) {
    console.error('❌ Fatal startup error:', err.message);
    process.exit(1);
  }
}

// ============================================================
// PROCESS ERROR HANDLERS
// ============================================================

process.on('uncaughtException', (err) => {
  console.error('❌ [uncaughtException]', err.message, err.stack);
  // Don't exit — keep running
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ [unhandledRejection]', reason);
  // Don't exit — keep running
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received — shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received — shutting down...');
  await pool.end();
  process.exit(0);
});

// ============================================================
// GO!
// ============================================================

start();
