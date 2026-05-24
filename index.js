const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, {
  polling: true
});

// =======================
// GROUP TELEGRAM
// =======================

const GROUP_ID = -1003954107367;

// =======================
// TOPIC ID
// =======================

const TOPICS = {
  SATSET138: 4,
  MAHJONG138: 3,
  DOLAR138: 2
};

// =======================
// DATABASE DOMAIN
// =======================

let domains = {
  SATSET138: [],
  MAHJONG138: [],
  DOLAR138: []
};

// =======================
// STATUS SEBELUMNYA
// =======================

let previousStatus = {};

// =======================
// HITUNG HILANG
// =======================

let disappearCount = {};

// =======================
// TAMBAH DOMAIN
// =======================

bot.onText(/\/add (.+)/, async (msg, match) => {

  const text = match[1];

  const split = text.split(" ");

  const keyword = split[0];
  const domain = split[1];

  if (!domains[keyword]) {

    bot.sendMessage(
      msg.chat.id,
      '❌ Keyword tidak ditemukan.'
    );

    return;
  }

  if (!domains[keyword].includes(domain)) {

    domains[keyword].push(domain);

  }

  bot.sendMessage(
    GROUP_ID,
    `✅ DOMAIN DITAMBAHKAN

Keyword: ${keyword}
Domain: ${domain}`,
    {
      message_thread_id: TOPICS[keyword]
    }
  );

});

// =======================
// HAPUS DOMAIN
// =======================

bot.onText(/\/remove (.+)/, async (msg, match) => {

  const text = match[1];

  const split = text.split(" ");

  const keyword = split[0];
  const domain = split[1];

  if (!domains[keyword]) return;

  domains[keyword] = domains[keyword].filter(
    d => d !== domain
  );

  bot.sendMessage(
    GROUP_ID,
    `❌ DOMAIN DIHAPUS

Keyword: ${keyword}
Domain: ${domain}`,
    {
      message_thread_id: TOPICS[keyword]
    }
  );

});

// =======================
// CEK RANK GOOGLE
// MOBILE + INDONESIA
// =======================

async function checkRank(keyword, domain) {

  try {

    const query = encodeURIComponent(keyword);

    const url =
      `https://www.google.com/search?q=${query}&gl=id&hl=id&num=100&pws=0`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36'
      }
    });

    const html = response.data;

    const regex = /<a href="\/url\?q=(.*?)&/g;

    let match;

    let rank = 0;

    while ((match = regex.exec(html)) !== null) {

      const resultUrl = decodeURIComponent(match[1]);

      if (resultUrl.includes(domain)) {

        return {
          found: true,
          rank: rank + 1
        };

      }

      rank++;

    }

    return {
      found: false,
      rank: null
    };

  } catch (e) {

    return {
      found: false,
      rank: null
    };

  }

}

// =======================
// MONITOR AUTO
// =======================

async function monitor() {

  for (const keyword in domains) {

    for (const domain of domains[keyword]) {

      const result = await checkRank(
        keyword,
        domain
      );

      const found = result.found;

      const rank = result.rank;

      const key = `${keyword}_${domain}`;

      // =======================
      // DOMAIN MUNCUL
      // =======================

      if (
        found &&
        previousStatus[key] !== true
      ) {

        previousStatus[key] = true;

        disappearCount[key] = 0;

        bot.sendMessage(
          GROUP_ID,
          `🚀 DOMAIN MUNCUL DI GOOGLE

Keyword: ${keyword}
Domain: ${domain}
Rank Mobile ID: ${rank}`,
          {
            message_thread_id: TOPICS[keyword]
          }
        );

      }

      // =======================
      // DOMAIN HILANG
      // =======================

      if (
        !found &&
        previousStatus[key] === true
      ) {

        previousStatus[key] = false;

        disappearCount[key] =
          (disappearCount[key] || 0) + 1;

        bot.sendMessage(
          GROUP_ID,
          `⚠️ DOMAIN HILANG DARI GOOGLE

Keyword: ${keyword}
Domain: ${domain}
Jumlah Hilang: ${disappearCount[key]}/2`,
          {
            message_thread_id: TOPICS[keyword]
          }
        );

        // AUTO HAPUS JIKA HILANG 2X

        if (disappearCount[key] >= 2) {

          domains[key] = domains[key].filter(
            d => d !== domain
          );

          bot.sendMessage(
            GROUP_ID,
            `🗑 DOMAIN AUTO DIHAPUS

Keyword: ${keyword}
Domain: ${domain}`,
            {
              message_thread_id: TOPICS[keyword]
            }
          );

        }

      }

    }

  }

}

// =======================
// CEK SETIAP 30 MENIT
// =======================

cron.schedule('*/30 * * * *', async () => {

  await monitor();

});

// =======================
// CHECK MANUAL
// SESUAI TOPIC
// =======================

bot.onText(/\/check/, async (msg) => {

  const topicId = msg.message_thread_id;

  let selectedKeyword = null;

  for (const keyword in TOPICS) {

    if (TOPICS[keyword] === topicId) {

      selectedKeyword = keyword;

    }

  }

  if (!selectedKeyword) {

    bot.sendMessage(
      msg.chat.id,
      '❌ Gunakan command di dalam topic.'
    );

    return;
  }

  bot.sendMessage(
    GROUP_ID,
    `📊 STATUS KEYWORD ${selectedKeyword}

🔎 Checking ranking ${selectedKeyword}...`,
    {
      message_thread_id: topicId
    }
  );

  let report = `📊 STATUS KEYWORD ${selectedKeyword}\n\n`;

  for (const domain of domains[selectedKeyword]) {

    const result = await checkRank(
      selectedKeyword,
      domain
    );

    report += `${result.found ? '✅' : '❌'} ${domain}\n`;

    report += `📌 Rank Mobile ID: ${result.rank || 'NOT FOUND'}\n\n`;

  }

  bot.sendMessage(
    GROUP_ID,
    report,
    {
      message_thread_id: topicId
    }
  );

});

// =======================
// BOT ONLINE
// =======================

bot.sendMessage(
  GROUP_ID,
  '🤖 BOT SEO RANK MONITOR AKTIF',
  {
    message_thread_id: TOPICS.SATSET138
  }
);
