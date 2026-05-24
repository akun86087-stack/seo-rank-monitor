/**
 * ============================================================
 *  SEO Rank Monitor Bot — Telegram + PostgreSQL + Node.js
 *  Railway-ready | Mobile SERP Indonesia | Forum Topic Support
 * ============================================================
 */

require('dotenv').config();

const express    = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool }   = require('pg');
const axios      = require('axios');
const cheerio    = require('cheerio');
const cron       = require('node-cron');

// ─────────────────────────────────────────────────────────────
// ENV VALIDATION
// ─────────────────────────────────────────────────────────────
const REQUIRED_ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required env: ${key}`);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ─────────────────────────────────────────────────────────────
// TOPIC CONFIG  (topicId → keyword)
// ─────────────────────────────────────────────────────────────
const TOPICS = {
  4: 'SATSET138',
  3: 'MAHJONG138',
  2: 'DOLAR138',
};

const TOPIC_IDS = Object.fromEntries(
  Object.entries(TOPICS).map(([id, kw]) => [kw, Number(id)])
);

// ─────────────────────────────────────────────────────────────
// EXPRESS — keep-alive server (Railway needs open port)
// ─────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ status: 'online', service: 'SEO Rank Monitor', uptime: process.uptime() });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});

// ─────────────────────────────────────────────────────────────
// POSTGRESQL CONNECTION POOL
// ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false'
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL error:', err.message);
});

// ─────────────────────────────────────────────────────────────
// TELEGRAM BOT INIT
// ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
});

bot.on('polling_error', (err) => {
  console.error('❌ Polling error:', err.message);
});

// ─────────────────────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────────────────────

/** Non-blocking sleep */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip protocol + trailing slash from domain input */
function cleanDomain(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .split('/')[0]
    .replace(/^www\./, '');
}

/** WIB timestamp string */
function wibNow() {
  return new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** Resolve topic from a Telegram message */
function resolveTopic(msg) {
  const threadId = msg.message_thread_id;
  if (threadId && TOPICS[threadId]) {
    return { keyword: TOPICS[threadId], topicId: threadId };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// SEND MESSAGE TO TOPIC
// ─────────────────────────────────────────────────────────────
async function sendToTopic(topicId, text, extra = {}) {
  try {
    await bot.sendMessage(CHAT_ID, text, {
      message_thread_id: topicId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    console.error(`❌ sendToTopic(${topicId}) error:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// DATABASE INIT
// ─────────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS domains (
        id              SERIAL PRIMARY KEY,
        keyword         VARCHAR(100)  NOT NULL,
        domain          VARCHAR(255)  NOT NULL,
        last_status     BOOLEAN       DEFAULT NULL,
        disappear_count INTEGER       DEFAULT 0,
        last_rank       INTEGER       DEFAULT NULL,
        created_at      TIMESTAMPTZ   DEFAULT NOW(),
        UNIQUE(keyword, domain)
      );

      CREATE INDEX IF NOT EXISTS idx_domains_keyword ON domains(keyword);
    `);
    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ initDB error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// DATABASE OPERATIONS
// ─────────────────────────────────────────────────────────────
async function dbAddDomain(keyword, domain) {
  const res = await pool.query(
    `INSERT INTO domains (keyword, domain)
     VALUES ($1, $2)
     ON CONFLICT (keyword, domain) DO NOTHING
     RETURNING id`,
    [keyword, domain]
  );
  return res.rowCount > 0;
}

async function dbRemoveDomain(keyword, domain) {
  const res = await pool.query(
    `DELETE FROM domains WHERE keyword = $1 AND domain = $2 RETURNING id`,
    [keyword, domain]
  );
  return res.rowCount > 0;
}

async function dbGetByKeyword(keyword) {
  const res = await pool.query(
    `SELECT * FROM domains WHERE keyword = $1 ORDER BY created_at ASC`,
    [keyword]
  );
  return res.rows;
}

async function dbGetAll() {
  const res = await pool.query(
    `SELECT * FROM domains ORDER BY keyword, created_at ASC`
  );
  return res.rows;
}

async function dbUpdateStatus(id, found, rank, disappearCount) {
  await pool.query(
    `UPDATE domains
     SET last_status = $1, last_rank = $2, disappear_count = $3
     WHERE id = $4`,
    [found, rank, disappearCount, id]
  );
}

async function dbDeleteById(id) {
  await pool.query(`DELETE FROM domains WHERE id = $1`, [id]);
}

// ─────────────────────────────────────────────────────────────
// GOOGLE SERP SCRAPER — Mobile Indonesia
// ─────────────────────────────────────────────────────────────

/** Realistic Android mobile user-agents */
const USER_AGENTS = [
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.5615.136 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 11; vivo V21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.5563.116 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; OPPO Reno8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.5481.177 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; M2101K6G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.61 Mobile Safari/537.36',
];

const getUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

/** Extract hostname from URL, strip www */
function extractHostname(href) {
  try {
    return new URL(href).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Score a parsed link to decide if it's a real organic result */
function isOrganicLink(href) {
  if (!href || !href.startsWith('http')) return false;
  const BLOCKED = [
    'google.com', 'google.co.id', 'googleapis.com', 'gstatic.com',
    'youtube.com', 'accounts.google', 'support.google', 'maps.google',
    'play.google', 'chrome.google',
  ];
  return !BLOCKED.some((b) => href.includes(b));
}

/**
 * Scrape up to 10 pages of Google SERP (100 results) for a keyword.
 * Returns ordered array of hostnames.
 */
async function scrapeGoogleSERP(keyword) {
  const seen     = new Set();
  const results  = [];
  const maxPages = 10; // pages of 10 → top 100

  for (let page = 0; page < maxPages; page++) {
    const start = page * 10;

    // Randomised delay: 3–8 s between pages
    if (page > 0) await sleep(3000 + Math.random() * 5000);

    const url = new URL('https://www.google.com/search');
    url.searchParams.set('q',     keyword);
    url.searchParams.set('start', start);
    url.searchParams.set('num',   '10');
    url.searchParams.set('gl',    'id');
    url.searchParams.set('hl',    'id');
    url.searchParams.set('pws',   '0');
    url.searchParams.set('nfpr',  '1');
    url.searchParams.set('safe',  'off');
    url.searchParams.set('filter','0');

    try {
      const resp = await axios.get(url.toString(), {
        headers: {
          'User-Agent':       getUA(),
          'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language':  'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding':  'gzip, deflate, br',
          'Referer':          'https://www.google.co.id/',
          'Cache-Control':    'no-cache',
          'Pragma':           'no-cache',
          'Sec-Fetch-Dest':   'document',
          'Sec-Fetch-Mode':   'navigate',
          'Sec-Fetch-Site':   'same-origin',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 20000,
        maxRedirects: 5,
      });

      const $ = cheerio.load(resp.data);

      // ── Primary selectors (standard Google result containers) ──
      const primarySelectors = [
        'div.g',
        '.tF2Cxc',
        '.yuRUbf',
        'div[jscontroller][data-hveid]',
        '.rc',
      ];

      let foundOnPage = 0;
      for (const sel of primarySelectors) {
        $(sel).each((_i, el) => {
          const anchor = $(el).find('a[href]').first();
          const href   = anchor.attr('href');
          if (href && isOrganicLink(href)) {
            const host = extractHostname(href);
            if (host && !seen.has(host)) {
              seen.add(host);
              results.push(host);
              foundOnPage++;
            }
          }
        });
        if (foundOnPage > 0) break;
      }

      // ── Fallback: scan ALL anchors in #search ──
      if (foundOnPage === 0) {
        $('#search a[href], #rso a[href]').each((_i, el) => {
          const href = $(el).attr('href');
          if (href && isOrganicLink(href)) {
            const host = extractHostname(href);
            if (host && !seen.has(host)) {
              seen.add(host);
              results.push(host);
              foundOnPage++;
            }
          }
        });
      }

      // ── Deep fallback: scan every anchor ──
      if (foundOnPage === 0) {
        $('a[href]').each((_i, el) => {
          const href = $(el).attr('href');
          if (href && isOrganicLink(href)) {
            const host = extractHostname(href);
            if (host && !seen.has(host)) {
              seen.add(host);
              results.push(host);
              foundOnPage++;
            }
          }
        });
      }

      console.log(`  Page ${page + 1}: +${foundOnPage} results (total ${results.length})`);

      // If CAPTCHA / no results, stop
      if (foundOnPage === 0) {
        console.warn(`  ⚠️ No results on page ${page + 1} — stopping scrape`);
        break;
      }

    } catch (err) {
      console.error(`  ❌ Scrape page ${page + 1} failed: ${err.message}`);
      if (err.response?.status === 429) {
        console.warn('  🔴 Rate-limited by Google, stopping this keyword');
        break;
      }
      // Non-429 error: skip page, continue
    }
  }

  return results;
}

/**
 * Find position of a domain in the SERP results array.
 * Returns 1-based rank, or null if not found.
 */
function findRank(domain, results) {
  const clean = domain.toLowerCase().replace(/^www\./, '');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r === clean || r.endsWith(`.${clean}`) || clean.endsWith(`.${r}`)) {
      return i + 1;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// TELEGRAM COMMANDS
// ─────────────────────────────────────────────────────────────

// /ping — health check
bot.onText(/^\/ping(@\S+)?$/, async (msg) => {
  const opts = {};
  if (msg.message_thread_id) opts.message_thread_id = msg.message_thread_id;
  await bot.sendMessage(
    msg.chat.id,
    `🤖 <b>Pong!</b> Bot online.\n⏱ Uptime: ${Math.floor(process.uptime())}s`,
    { parse_mode: 'HTML', ...opts }
  );
});

// /add domain.com — tambah domain ke topic ini
bot.onText(/^\/add(@\S+)?\s+(\S+)$/i, async (msg, match) => {
  const topic = resolveTopic(msg);
  if (!topic) {
    return bot.sendMessage(
      msg.chat.id,
      '❌ Kirim command ini di dalam topic yang terdaftar (SATSET138 / MAHJONG138 / DOLAR138).',
      msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}
    );
  }

  const domain = cleanDomain(match[2]);
  if (!domain || domain.length < 3) {
    return sendToTopic(topic.topicId, '❌ Format domain tidak valid. Contoh: <code>/add satset138.com</code>');
  }

  const added = await dbAddDomain(topic.keyword, domain);

  if (added) {
    await sendToTopic(
      topic.topicId,
      `✅ <b>Domain ditambahkan!</b>\n` +
      `🌐 Domain : <code>${domain}</code>\n` +
      `🔑 Keyword: <b>${topic.keyword}</b>\n` +
      `💡 Gunakan /check untuk cek ranking sekarang.`
    );
  } else {
    await sendToTopic(
      topic.topicId,
      `⚠️ Domain <code>${domain}</code> sudah ada di keyword <b>${topic.keyword}</b>.`
    );
  }
});

// /remove domain.com — hapus domain dari topic ini
bot.onText(/^\/remove(@\S+)?\s+(\S+)$/i, async (msg, match) => {
  const topic = resolveTopic(msg);
  if (!topic) {
    return bot.sendMessage(
      msg.chat.id,
      '❌ Kirim command ini di dalam topic yang terdaftar.',
      msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}
    );
  }

  const domain = cleanDomain(match[2]);
  const removed = await dbRemoveDomain(topic.keyword, domain);

  if (removed) {
    await sendToTopic(
      topic.topicId,
      `🗑️ <b>Domain dihapus.</b>\n` +
      `🌐 Domain : <code>${domain}</code>\n` +
      `🔑 Keyword: <b>${topic.keyword}</b>`
    );
  } else {
    await sendToTopic(
      topic.topicId,
      `❌ Domain <code>${domain}</code> tidak ditemukan di keyword <b>${topic.keyword}</b>.`
    );
  }
});

// /list — tampilkan semua domain di topic ini
bot.onText(/^\/list(@\S+)?$/, async (msg) => {
  const topic = resolveTopic(msg);
  if (!topic) {
    return bot.sendMessage(
      msg.chat.id,
      '❌ Kirim command ini di dalam topic yang terdaftar.',
      msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}
    );
  }

  const rows = await dbGetByKeyword(topic.keyword);

  if (rows.length === 0) {
    return sendToTopic(
      topic.topicId,
      `📋 Belum ada domain di keyword <b>${topic.keyword}</b>.\nGunakan: <code>/add domain.com</code>`
    );
  }

  let text = `📋 <b>DAFTAR DOMAIN — ${topic.keyword}</b>\n`;
  text += `🕐 ${wibNow()} WIB\n`;
  text += `${'─'.repeat(30)}\n`;

  rows.forEach((row, i) => {
    const icon =
      row.last_status === null  ? '⏳' :
      row.last_status === true  ? '✅' : '❌';
    const rank = row.last_rank  ? `Rank ${row.last_rank}` : 'Belum dicek';
    text += `${i + 1}. ${icon} <code>${row.domain}</code> — ${rank}\n`;
  });

  text += `${'─'.repeat(30)}\n`;
  text += `Total: <b>${rows.length}</b> domain`;

  await sendToTopic(topic.topicId, text);
});

// /check — manual check semua domain di topic ini
bot.onText(/^\/check(@\S+)?$/, async (msg) => {
  const topic = resolveTopic(msg);
  if (!topic) {
    return bot.sendMessage(
      msg.chat.id,
      '❌ Kirim command ini di dalam topic yang terdaftar.',
      msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}
    );
  }

  const rows = await dbGetByKeyword(topic.keyword);

  if (rows.length === 0) {
    return sendToTopic(
      topic.topicId,
      `📋 Belum ada domain untuk keyword <b>${topic.keyword}</b>.\nTambahkan: <code>/add domain.com</code>`
    );
  }

  await sendToTopic(
    topic.topicId,
    `🔍 <b>Mengecek ranking keyword: ${topic.keyword}</b>\n` +
    `📱 Google Mobile SERP Indonesia (top 100)\n` +
    `⏳ Mohon tunggu, proses ini membutuhkan ~2 menit...`
  );

  console.log(`[/check] Keyword: ${topic.keyword}, domains: ${rows.length}`);

  let serpResults = [];
  let scrapeOk    = true;

  try {
    serpResults = await scrapeGoogleSERP(topic.keyword);
    console.log(`[/check] Got ${serpResults.length} SERP results`);
  } catch (err) {
    console.error('[/check] Scrape failed:', err.message);
    scrapeOk = false;
  }

  if (!scrapeOk || serpResults.length === 0) {
    return sendToTopic(
      topic.topicId,
      `❌ <b>Gagal mengambil data SERP Google.</b>\n` +
      `Kemungkinan Google memblokir sementara. Coba lagi dalam beberapa menit.`
    );
  }

  let report = `📊 <b>STATUS KEYWORD ${topic.keyword}</b>\n`;
  report += `📱 Google Mobile Indonesia\n`;
  report += `🕐 ${wibNow()} WIB\n`;
  report += `${'─'.repeat(30)}\n\n`;

  for (const row of rows) {
    const rank = findRank(row.domain, serpResults);
    if (rank) {
      report += `✅ <b>${row.domain}</b>\n`;
      report += `   📌 Rank Mobile Indonesia: <b>${rank}</b>\n\n`;
      await dbUpdateStatus(row.id, true, rank, 0);
    } else {
      report += `❌ <b>${row.domain}</b>\n`;
      report += `   📌 NOT FOUND (Top 100)\n\n`;
      await dbUpdateStatus(row.id, false, null, row.disappear_count);
    }
  }

  report += `${'─'.repeat(30)}\n`;
  report += `📡 Data SERP: ${serpResults.length} hasil ditemukan`;

  await sendToTopic(topic.topicId, report);
});

// ─────────────────────────────────────────────────────────────
// AUTO MONITORING — every 30 minutes
// ─────────────────────────────────────────────────────────────
async function runMonitoring() {
  console.log(`\n[MONITOR] ⏰ ${wibNow()} WIB — Starting auto monitoring...`);

  let allDomains;
  try {
    allDomains = await dbGetAll();
  } catch (err) {
    console.error('[MONITOR] DB fetch error:', err.message);
    return;
  }

  if (allDomains.length === 0) {
    console.log('[MONITOR] No domains registered, skipping.');
    return;
  }

  // Group domains by keyword
  const groups = {};
  for (const row of allDomains) {
    if (!groups[row.keyword]) groups[row.keyword] = [];
    groups[row.keyword].push(row);
  }

  for (const [keyword, domains] of Object.entries(groups)) {
    const topicId = TOPIC_IDS[keyword];
    console.log(`[MONITOR] Keyword: ${keyword} (${domains.length} domains)`);

    let serpResults = [];

    try {
      serpResults = await scrapeGoogleSERP(keyword);
      console.log(`[MONITOR] ${keyword}: ${serpResults.length} SERP results`);
    } catch (err) {
      console.error(`[MONITOR] Scrape failed for ${keyword}:`, err.message);
      // Don't update DB if scrape failed — skip this keyword
      await sleep(5000);
      continue;
    }

    if (serpResults.length === 0) {
      console.warn(`[MONITOR] ${keyword}: Empty SERP, likely blocked — skipping`);
      await sleep(5000);
      continue;
    }

    for (const row of domains) {
      try {
        const rank    = findRank(row.domain, serpResults);
        const isFound = rank !== null;

        let newDisappearCount = row.disappear_count;

        // ── Status transition: HIDDEN → FOUND ──
        if (isFound && row.last_status === false) {
          newDisappearCount = 0;
          await sendToTopic(
            topicId,
            `🚀 <b>DOMAIN MUNCUL!</b>\n` +
            `🌐 Domain : <b>${row.domain}</b>\n` +
            `🔑 Keyword: <b>${keyword}</b>\n` +
            `📌 Rank   : <b>${rank}</b>\n` +
            `🕐 ${wibNow()} WIB`
          );
        }

        // ── Status transition: FOUND → HIDDEN ──
        if (!isFound && row.last_status === true) {
          newDisappearCount = 1;
          await sendToTopic(
            topicId,
            `⚠️ <b>DOMAIN HILANG!</b>\n` +
            `🌐 Domain : <b>${row.domain}</b>\n` +
            `🔑 Keyword: <b>${keyword}</b>\n` +
            `🕐 ${wibNow()} WIB\n` +
            `🔄 Akan auto-remove jika hilang 1x lagi.`
          );
        }

        // ── Still hidden (consecutive) ──
        if (!isFound && row.last_status === false) {
          newDisappearCount = row.disappear_count + 1;
        }

        // ── Auto-remove after 2 consecutive disappearances ──
        if (!isFound && newDisappearCount >= 2) {
          await dbDeleteById(row.id);
          await sendToTopic(
            topicId,
            `🗑️ <b>AUTO REMOVED</b>\n` +
            `🌐 Domain : <b>${row.domain}</b>\n` +
            `🔑 Keyword: <b>${keyword}</b>\n` +
            `❌ Tidak ditemukan 2x berturut-turut.\n` +
            `🕐 ${wibNow()} WIB`
          );
          console.log(`[MONITOR] Auto-removed: ${row.domain} from ${keyword}`);
        } else {
          await dbUpdateStatus(row.id, isFound, isFound ? rank : null, newDisappearCount);
        }

      } catch (err) {
        console.error(`[MONITOR] Error processing ${row.domain}:`, err.message);
      }

      // Small delay between domains to avoid DB hammering
      await sleep(500);
    }

    console.log(`[MONITOR] Keyword ${keyword} done.`);
    // Delay between keywords to avoid rapid Google requests
    await sleep(8000 + Math.random() * 7000);
  }

  console.log(`[MONITOR] ✅ Monitoring cycle complete.\n`);
}

// Schedule: every 30 minutes
cron.schedule('*/30 * * * *', () => {
  runMonitoring().catch((err) => {
    console.error('[MONITOR] Unhandled error in runMonitoring:', err.message);
  });
});

// ─────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────
async function startup() {
  console.log('\n🚀 Starting SEO Rank Monitor Bot...\n');

  // Init DB
  await initDB();

  // Send startup message to each topic
  for (const [topicId, keyword] of Object.entries(TOPICS)) {
    await sendToTopic(
      Number(topicId),
      `🤖 <b>SEO Rank Monitor Online!</b>\n` +
      `📡 Keyword : <b>${keyword}</b>\n` +
      `⏰ Auto-check: Setiap 30 menit\n` +
      `📱 SERP    : Google Mobile Indonesia\n` +
      `✅ Status  : Ready\n` +
      `🕐 ${wibNow()} WIB\n\n` +
      `Commands:\n` +
      `<code>/add domain.com</code> — Tambah domain\n` +
      `<code>/remove domain.com</code> — Hapus domain\n` +
      `<code>/list</code> — Lihat semua domain\n` +
      `<code>/check</code> — Cek ranking sekarang\n` +
      `<code>/ping</code> — Test bot`
    );
    await sleep(1500);
  }

  console.log('✅ Bot started successfully!');
  console.log('📡 Polling Telegram...');
}

startup().catch((err) => {
  console.error('❌ Fatal startup error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down...');
  bot.stopPolling();
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, shutting down...');
  bot.stopPolling();
  await pool.end();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
});
