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

const PORT        = process.env.PORT || 3000;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;

// Debug mode: set DEBUG_RANK=true in .env to enable verbose SERP logging
const DEBUG_RANK  = process.env.DEBUG_RANK === 'true';

// Topic ID → Keyword mapping (edit to match your Telegram forum topics)
const TOPIC_KEYWORD_MAP = {
  4: 'SATSET138',
  3: 'MAHJONG138',
  2: 'DOLAR138',
};

// Reverse map keyword → topicId
const KEYWORD_TOPIC_MAP = Object.fromEntries(
  Object.entries(TOPIC_KEYWORD_MAP).map(([id, kw]) => [kw, parseInt(id)])
);

// Delay between SERPAPI calls (ms) to avoid rate limiting
const SERPAPI_DELAY_MS = 2500;

// Google infrastructure hostnames to skip (exact or suffix match after normalization)
const GOOGLE_INFRA_SUFFIXES = [
  'google.com',
  'google.co.id',
  'googleusercontent.com',
  'translate.googleapis.com',
  'gstatic.com',
  'googleapis.com',
  'amp.google.com',
];

// ============================================================
// EXPRESS SERVER (Railway keepalive)
// ============================================================

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({
    bot: 'Telegram SEO Rank Monitor',
    version: '1.1.0',
    status: 'running',
    uptime_seconds: Math.floor(process.uptime()),
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
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
// DATABASE INIT
// ============================================================

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS domains (
        id            SERIAL PRIMARY KEY,
        keyword       VARCHAR(255)  NOT NULL,
        domain        VARCHAR(255)  NOT NULL,
        current_rank  INTEGER,
        previous_rank INTEGER,
        status        VARCHAR(50)   NOT NULL DEFAULT 'NOT_FOUND',
        change_type   VARCHAR(50),
        last_checked  TIMESTAMPTZ,
        last_seen     TIMESTAMPTZ,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
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
// ███████╗ ██████╗  ██████╗     ███████╗██╗██╗  ██╗
// ██╔════╝██╔════╝ ██╔═══██╗    ██╔════╝██║╚██╗██╔╝
// ███████╗█████╗   ██║   ██║    █████╗  ██║ ╚███╔╝
// ╚════██║██╔══╝   ██║   ██║    ██╔══╝  ██║ ██╔██╗
// ███████║███████╗ ╚██████╔╝    ██║     ██║██╔╝ ██╗
// ╚══════╝╚══════╝  ╚═════╝     ╚═╝     ╚═╝╚═╝  ╚═╝
//
// DOMAIN NORMALIZATION & RANK DETECTION ENGINE
// ============================================================

/**
 * normalizeDomain(input)
 *
 * Converts any URL or domain string into a clean, comparable hostname.
 *
 * Rules applied (in order):
 *  1. Trim whitespace
 *  2. Lowercase
 *  3. Prepend https:// if no protocol present (required for URL parser)
 *  4. Parse with Node's URL class — extracts hostname reliably
 *  5. Strip leading "www." prefix so www.domain.com === domain.com
 *
 * Handles:
 *  ✅ https://www.satset138asia.com/         → satset138asia.com
 *  ✅ http://satset138asia.com/              → satset138asia.com
 *  ✅ satset138asia.com                      → satset138asia.com
 *  ✅ www.satset138asia.com                  → satset138asia.com
 *  ✅ https://satset138asia.com/?amp         → satset138asia.com
 *  ✅ https://satset138asia.com/page?q=test  → satset138asia.com
 *  ✅ https://amp.satset138asia.com/         → amp.satset138asia.com
 *  ✅ https://blog.satset138asia.com/post/1  → blog.satset138asia.com
 *
 * Returns: normalized hostname string, or null if unparseable.
 */
function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;

  let str = input.trim().toLowerCase();
  if (!str) return null;

  // Ensure protocol for URL parser
  if (!str.startsWith('http://') && !str.startsWith('https://')) {
    str = 'https://' + str;
  }

  let hostname;
  try {
    hostname = new URL(str).hostname;
  } catch {
    // URL parsing failed — try stripping to bare domain manually
    // e.g. "satset138asia.com/page" without protocol still fails URL()
    // so strip everything after first slash and retry
    const stripped = str.replace(/^https?:\/\//, '').split('/')[0];
    try {
      hostname = new URL('https://' + stripped).hostname;
    } catch {
      return null;
    }
  }

  if (!hostname) return null;

  // Strip leading www. — treat www.domain.com identical to domain.com
  if (hostname.startsWith('www.')) {
    hostname = hostname.slice(4);
  }

  return hostname;
}

/**
 * isGoogleInfrastructure(normalizedHostname)
 *
 * Returns true if the hostname belongs to Google's own infrastructure
 * and should be skipped during SERP parsing.
 *
 * Uses exact suffix matching — NOT includes() — to avoid false positives
 * like "mygoogle.com" being incorrectly excluded.
 */
function isGoogleInfrastructure(host) {
  if (!host) return false;
  for (const suffix of GOOGLE_INFRA_SUFFIXES) {
    if (host === suffix) return true;
    if (host.endsWith('.' + suffix)) return true;
  }
  return false;
}

/**
 * findDomainRank(organicResults, targetDomain)
 *
 * Searches SERPAPI organic_results array for a matching domain.
 * Returns the rank (1-indexed integer) or null if not found.
 *
 * Matching logic:
 *  1. Normalize targetDomain (strip www, parse hostname)
 *  2. For each result, normalize result.link the same way
 *  3. Compare with THREE strategies (no includes() anywhere):
 *     a. Exact match:    result === target
 *        e.g. satset138asia.com === satset138asia.com  ✅
 *     b. Result is subdomain of target:
 *        result.endsWith('.' + target)
 *        e.g. blog.satset138asia.com ends with .satset138asia.com  ✅
 *     c. Target is subdomain of result:
 *        target.endsWith('.' + result)
 *        e.g. user added "satset138asia.com", SERP returns "m.satset138asia.com"
 *        — treated as match since same root domain  ✅
 *  4. Skip Google infrastructure URLs
 *  5. Skip duplicate normalized hostnames
 *  6. Debug-log every comparison when DEBUG_RANK=true
 *
 * @param {Array}  organicResults  - SERPAPI organic_results array
 * @param {string} targetDomain    - Domain stored in DB (e.g. "satset138asia.com")
 * @returns {number|null}          - Rank position, or null
 */
function findDomainRank(organicResults, targetDomain) {
  const normalizedTarget = normalizeDomain(targetDomain);

  if (!normalizedTarget) {
    console.warn(`[RANK] ⚠️  Cannot normalize target: "${targetDomain}"`);
    return null;
  }

  console.log(`[RANK] Target: "${targetDomain}" → normalized: "${normalizedTarget}"`);

  const seenNormalized = new Set();
  let position = 0;

  for (const result of organicResults) {
    const rawUrl = result.link || result.url || '';
    if (!rawUrl) continue;

    // Use SERPAPI's own position field if present, otherwise count manually
    const serpPosition = typeof result.position === 'number'
      ? result.position
      : ++position;

    const normalizedResult = normalizeDomain(rawUrl);

    if (DEBUG_RANK) {
      console.log(
        `[RANK] #${String(serpPosition).padStart(3)} | ` +
        `raw="${rawUrl.substring(0, 70)}" | ` +
        `normalized="${normalizedResult}" | ` +
        `target="${normalizedTarget}"`
      );
    }

    // Skip unparseable URLs
    if (!normalizedResult) {
      if (DEBUG_RANK) console.log(`[RANK]          ↳ SKIP: unparseable URL`);
      continue;
    }

    // Skip Google infrastructure (cache, translate, amp proxy, etc.)
    if (isGoogleInfrastructure(normalizedResult)) {
      if (DEBUG_RANK) console.log(`[RANK]          ↳ SKIP: Google infrastructure`);
      continue;
    }

    // Skip duplicate normalized hostnames (dedup within SERP)
    if (seenNormalized.has(normalizedResult)) {
      if (DEBUG_RANK) console.log(`[RANK]          ↳ SKIP: duplicate hostname`);
      continue;
    }
    seenNormalized.add(normalizedResult);

    // ── MATCHING STRATEGIES ──────────────────────────────────

    // Strategy A: Exact match (www stripped from both sides already)
    // "satset138asia.com" === "satset138asia.com"
    if (normalizedResult === normalizedTarget) {
      console.log(`[RANK] ✅ MATCH (exact) at position #${serpPosition}: "${normalizedResult}"`);
      return serpPosition;
    }

    // Strategy B: Result is subdomain of target
    // "blog.satset138asia.com".endsWith(".satset138asia.com") → true
    if (normalizedResult.endsWith('.' + normalizedTarget)) {
      console.log(`[RANK] ✅ MATCH (result is subdomain) at #${serpPosition}: "${normalizedResult}" ⊂ "${normalizedTarget}"`);
      return serpPosition;
    }

    // Strategy C: Target is subdomain of result
    // target="satset138asia.com", result="satset138asia.com" → already caught by A
    // target="sub.satset138asia.com", result="satset138asia.com" → catch here
    if (normalizedTarget.endsWith('.' + normalizedResult)) {
      console.log(`[RANK] ✅ MATCH (target is subdomain) at #${serpPosition}: "${normalizedTarget}" ⊂ "${normalizedResult}"`);
      return serpPosition;
    }
  }

  console.log(`[RANK] ❌ NOT FOUND in ${organicResults.length} results — target: "${normalizedTarget}"`);
  return null;
}

// ============================================================
// CLEAN DOMAIN (USER INPUT)
// ============================================================

/**
 * cleanDomain(input)
 *
 * Sanitize domain submitted by user via /add command.
 * Stores normalized form (no www, no protocol, no path) in DB.
 * This ensures stored domain matches how findDomainRank normalizes it.
 */
function cleanDomain(input) {
  const normalized = normalizeDomain(input.trim());
  if (!normalized) {
    // Fallback: manual strip if URL parser fails
    let d = input.trim().toLowerCase();
    d = d.replace(/^https?:\/\//i, '');
    d = d.replace(/^www\./i, '');
    d = d.replace(/\/.*$/, '');
    d = d.replace(/\?.*$/, '');
    d = d.replace(/#.*$/, '');
    return d;
  }
  return normalized;
}

// ============================================================
// GENERAL UTILITY FUNCTIONS
// ============================================================

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
  return new Date().toLocaleString('id-ID', {
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
 * Format a TIMESTAMPTZ value from DB to WIB-formatted string
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
 * Promise-based sleep helper
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// SERPAPI — FETCH GOOGLE MOBILE INDONESIA SERP
// ============================================================

/**
 * fetchSERPRank(keyword, targetDomain)
 *
 * Hits SERPAPI with full Google Mobile Indonesia parameters.
 * Passes raw organic_results to findDomainRank() for accurate matching.
 *
 * @param {string} keyword      - Search keyword
 * @param {string} targetDomain - Domain to find (stored form, e.g. "satset138asia.com")
 * @returns {number|null}       - Rank position or null
 */
async function fetchSERPRank(keyword, targetDomain) {
  const params = {
    engine:        'google',
    q:             keyword,
    gl:            'id',              // Geolocation: Indonesia
    hl:            'id',              // Language: Indonesian
    google_domain: 'google.co.id',   // Use google.co.id
    device:        'mobile',          // Mobile SERP
    location:      'Indonesia',       // Simulate Indonesian user
    num:           100,               // Fetch top 100 results
    no_cache:      true,              // Always fresh — bypass SERPAPI cache
    api_key:       SERPAPI_KEY,
  };

  console.log(`[SERP] Fetching: keyword="${keyword}" target="${targetDomain}"`);

  const response = await axios.get('https://serpapi.com/search.json', {
    params,
    timeout: 35000,
  });

  const data           = response.data;
  const organicResults = data?.organic_results;

  if (!Array.isArray(organicResults) || organicResults.length === 0) {
    console.warn(`[SERP] ⚠️  No organic results returned for keyword: "${keyword}"`);
    return null;
  }

  console.log(`[SERP] Got ${organicResults.length} organic results for "${keyword}"`);

  // Delegate matching to the fixed rank detection engine
  const rank = findDomainRank(organicResults, targetDomain);

  return rank;
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
 * dbUpdateRank(keyword, domain, newRank)
 *
 * Reads current DB state, computes change_type, then writes updated rank.
 *
 * change_type logic:
 *   NEW    — was NOT_FOUND, now FOUND
 *   LOST   — was FOUND, now NOT_FOUND
 *   UP     — rank number decreased (improved, e.g. #10 → #5)
 *   DOWN   — rank number increased (worsened, e.g. #5 → #10)
 *   STABLE — no change
 *
 * Returns change info object or null if domain no longer exists in DB.
 */
async function dbUpdateRank(keyword, domain, newRank) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      'SELECT * FROM domains WHERE keyword = $1 AND domain = $2',
      [keyword, domain]
    );

    if (res.rows.length === 0) return null;

    const row       = res.rows[0];
    const oldRank   = row.current_rank;   // INTEGER or null
    const oldStatus = row.status;         // 'FOUND' | 'NOT_FOUND'
    const newStatus = newRank ? 'FOUND' : 'NOT_FOUND';

    let changeType;
    if (newRank && oldStatus === 'NOT_FOUND') {
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

async function sendToTopic(topicId, text) {
  try {
    await bot.sendMessage(CHAT_ID, text, {
      message_thread_id:       topicId,
      parse_mode:              'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error(`❌ sendToTopic(${topicId}) failed:`, err.message);
    // Fallback without topic thread
    try {
      await bot.sendMessage(CHAT_ID, text, {
        parse_mode:              'HTML',
        disable_web_page_preview: true,
      });
    } catch (err2) {
      console.error('❌ sendToTopic fallback also failed:', err2.message);
    }
  }
}

async function replyInTopic(msg, text) {
  try {
    const opts = {
      parse_mode:              'HTML',
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

    default:
      return null; // STABLE — no notification
  }
}

// ============================================================
// SNAPSHOT MESSAGE BUILDER
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
// CORE MONITORING CYCLE
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
      console.warn(`⚠️  [MONITOR] No topic ID for keyword: ${keyword}`);
      continue;
    }

    console.log(`\n📌 [MONITOR] Keyword: ${keyword} (${domains.length} domains)`);

    const changeResults = [];

    for (const d of domains) {
      await sleep(SERPAPI_DELAY_MS);
      try {
        const rank   = await fetchSERPRank(keyword, d.domain);
        const result = await dbUpdateRank(keyword, d.domain, rank);

        if (!result) continue;

        const rankStr = rank ? `#${rank}` : 'NOT FOUND';
        console.log(`  ${d.domain} → ${rankStr} [${result.changeType}]`);

        if (result.changeType !== 'STABLE') {
          changeResults.push(result);
        }
      } catch (err) {
        console.error(`  ❌ Error checking ${d.domain}:`, err.message);
        // Continue — don't let 1 domain crash the whole cycle
      }
    }

    // Send change notifications first
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

    // Delay between keywords
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
    await replyInTopic(
      msg,
      `⚠️ Domain tidak valid: <code>${rawInput}</code>\n\nContoh: <code>/add domain.com</code>`
    );
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
        `📋 <b>LIST DOMAIN ${keyword}</b>\n\n` +
        `Belum ada domain yang ditambahkan.\n\nGunakan: <code>/add domain.com</code>`
      );
      return;
    }

    let text = `📋 <b>LIST DOMAIN ${keyword}</b>\n\n`;

    domains.forEach((d, i) => {
      const n        = i + 1;
      const rankLine = d.status === 'FOUND' && d.current_rank
        ? `   🏆 Rank #${d.current_rank}`
        : `   ❌ Tidak ditemukan`;
      const statusLine = d.status === 'FOUND'
        ? `   ✅ Status: FOUND`
        : `   ❌ Status: NOT FOUND`;
      const checkedLine = `   🕒 ${formatWIBFromDate(d.last_checked)}`;

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
      `⚠️ Belum ada domain untuk keyword <b>${keyword}</b>.\n\n` +
      `Gunakan: <code>/add domain.com</code>`
    );
    return;
  }

  await replyInTopic(
    msg,
    `🔍 <b>Mengecek ranking ${keyword}...</b>\n` +
    `📡 Google Mobile Indonesia (google.co.id)\n` +
    `⏳ Mohon tunggu (${domains.length} domain)...`
  );

  const checkResults  = [];
  const changeResults = [];

  for (const d of domains) {
    await sleep(SERPAPI_DELAY_MS);
    try {
      const rank   = await fetchSERPRank(keyword, d.domain);
      const result = await dbUpdateRank(keyword, d.domain, rank);
      checkResults.push({ domain: d.domain, rank });

      if (result && result.changeType !== 'STABLE') {
        changeResults.push(result);
      }

      console.log(`  /check: ${d.domain} → ${rank ? '#' + rank : 'NOT FOUND'}`);
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

  // Build and send result message
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

// ── /debug <domain> — prints normalization result ─────────────
bot.onText(/^\/debug(@\w+)?\s+(.+)$/i, async (msg, match) => {
  const rawInput = match[2]?.trim();
  if (!rawInput) {
    await replyInTopic(msg, '⚠️ Format: <code>/debug https://www.domain.com/page</code>');
    return;
  }
  const normalized = normalizeDomain(rawInput);
  await replyInTopic(
    msg,
    `🔧 <b>DEBUG NORMALIZATION</b>\n\n` +
    `Input: <code>${rawInput}</code>\n` +
    `Output: <code>${normalized ?? 'null (parse failed)'}</code>`
  );
});

// ── Catch unknown commands gracefully ─────────────────────────
bot.on('message', (msg) => {
  if (msg.text && msg.text.startsWith('/')) {
    const command = msg.text.split(' ')[0].replace(/@\w+/, '').toLowerCase();
    const known   = ['/ping', '/add', '/remove', '/list', '/check', '/debug'];
    if (!known.includes(command)) {
      replyInTopic(
        msg,
        '❓ Command tidak dikenal.\n\n' +
        '<b>Commands yang tersedia:</b>\n' +
        '• <code>/add domain.com</code> — Tambah domain\n' +
        '• <code>/remove domain.com</code> — Hapus domain\n' +
        '• <code>/list</code> — Lihat semua domain + rank\n' +
        '• <code>/check</code> — Force check ranking sekarang\n' +
        '• <code>/ping</code> — Cek status bot\n' +
        '• <code>/debug url</code> — Debug normalisasi URL'
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
  console.log('  🤖 Telegram SEO Rank Monitor Bot  v1.1.0');
  console.log('  📍 Google Mobile Indonesia SERP');
  console.log('  🔧 Fixed: normalizeDomain + findDomainRank');
  console.log('======================================================\n');

  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');

    await initDB();

    app.listen(PORT, () => {
      console.log(`✅ Express running on port ${PORT}`);
    });

    const me = await bot.getMe();
    console.log(`✅ Telegram bot: @${me.username} (${me.first_name})`);
    console.log('✅ Cron scheduler active (every 30 minutes)');

    console.log('\nTopic → Keyword mapping:');
    for (const [id, kw] of Object.entries(TOPIC_KEYWORD_MAP)) {
      console.log(`  Topic ${id} → ${kw}`);
    }

    console.log(`\nDebug mode: ${DEBUG_RANK ? 'ON (verbose SERP logging)' : 'OFF (set DEBUG_RANK=true to enable)'}`);

    console.log('\n📌 Available commands:');
    console.log('  /add domain.com    — Add domain');
    console.log('  /remove domain.com — Remove domain');
    console.log('  /list              — List domains + ranks');
    console.log('  /check             — Force check now');
    console.log('  /ping              — Bot status');
    console.log('  /debug <url>       — Test URL normalization\n');

    // Run initial monitoring 15s after startup
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
  console.error('❌ [uncaughtException]', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ [unhandledRejection]', reason);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM — shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT — shutting down...');
  await pool.end();
  process.exit(0);
});

// ============================================================
// GO!
// ============================================================

start();
