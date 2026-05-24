const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// TOPIC ID TELEGRAM
const TOPICS = {
  SATSET138: 4,
  MAHJONG138: 3,
  DOLAR138: 2
};

// DOMAIN DATABASE
let domains = {
  SATSET138: [],
  MAHJONG138: [],
  DOLAR138: []
};

// STATUS SEBELUMNYA
let previousStatus = {};

// CHAT ID GROUP
let GROUP_ID = -1003954107367;

// =======================
// COMMAND TAMBAH DOMAIN
// =======================

bot.onText(/\/add (.+)/, (msg, match) => {
  const text = match[1];

  // format:
  // /add SATSET138 https://domain.com
  const split = text.split(" ");

  const keyword = split[0];
  const domain = split[1];

  if (!domains[keyword]) {
    bot.sendMessage(msg.chat.id, "Keyword tidak ditemukan.");
    return;
  }

  domains[keyword].push(domain);

  bot.sendMessage(
    GROUP_ID,
    `✅ DOMAIN DITAMBAHKAN\n\nKeyword: ${keyword}\nDomain: ${domain}`,
    {
      message_thread_id: TOPICS[keyword]
    }
  );
});

// =======================
// COMMAND HAPUS DOMAIN
// =======================

bot.onText(/\/remove (.+)/, (msg, match) => {
  const text = match[1];

  const split = text.split(" ");

  const keyword = split[0];
  const domain = split[1];

  if (!domains[keyword]) return;

  domains[keyword] = domains[keyword].filter(d => d !== domain);

  bot.sendMessage(
    GROUP_ID,
    `❌ DOMAIN DIHAPUS\n\nKeyword: ${keyword}\nDomain: ${domain}`,
    {
      message_thread_id: TOPICS[keyword]
    }
  );
});

// =======================
// CEK GOOGLE RANK
// =======================

async function checkRank(keyword, domain) {
  try {
    const query = encodeURIComponent(keyword);

    const url = `https://www.google.com/search?q=${query}&gl=id&hl=id&num=100`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const html = response.data;

    return html.includes(domain);

  } catch (e) {
    return false;
  }
}

// =======================
// MONITOR
// =======================

async function monitor() {

  for (const keyword in domains) {

    for (const domain of domains[keyword]) {

      const found = await checkRank(keyword, domain);

      const key = `${keyword}_${domain}`;

      // MUNCUL
      if (found && previousStatus[key] !== true) {

        previousStatus[key] = true;

        bot.sendMessage(
          GROUP_ID,
          `🚀 DOMAIN MUNCUL DI GOOGLE\n\nKeyword: ${keyword}\nDomain: ${domain}`,
          {
            message_thread_id: TOPICS[keyword]
          }
        );
      }

      // HILANG
      if (!found && previousStatus[key] === true) {

        previousStatus[key] = false;

        bot.sendMessage(
          GROUP_ID,
          `⚠️ DOMAIN HILANG DARI GOOGLE\n\nKeyword: ${keyword}\nDomain: ${domain}`,
          {
            message_thread_id: TOPICS[keyword]
          }
        );
      }
    }
  }
}

// =======================
// CEK SETIAP 30 MENIT
// =======================

cron.schedule('*/30 * * * *', () => {
  monitor();
});

bot.sendMessage(
  GROUP_ID,
  '🤖 BOT SEO RANK MONITOR AKTIF',
  {
    message_thread_id: TOPICS.SATSET138
  }
);

// =======================
// FORCE CHECK MANUAL
// =======================

bot.onText(/\/check/, async (msg) => {

  bot.sendMessage(
    msg.chat.id,
    '🔎 Checking ranking manual...'
  );

  await monitor();

  bot.sendMessage(
    msg.chat.id,
    '✅ Check selesai.'
  );

});
