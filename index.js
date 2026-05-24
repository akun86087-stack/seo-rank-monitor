const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');

const token = process.env.BOT_TOKEN;

const bot = new TelegramBot(token, {
  polling: true
});

// =======================
// GROUP ID TELEGRAM
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
// STATUS DOMAIN
// =======================

let previousStatus = {};

let disappearCount = {};

// =======================
// CEK RANK GOOGLE
// MOBILE INDONESIA
// =======================

async function checkRank(keyword, domain) {

  try {

    const query = encodeURIComponent(keyword);

    const url =
      `https://www.google.com/search?q=${query}&gl=id&hl=id&num=100&pws=0`;

    const response = await axios.get(url, {

      headers: {

        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile Safari/604.1",

        "Accept-Language":
          "id-ID,id;q=0.9",

        "Cache-Control":
          "no-cache"

      },

      timeout: 15000

    });

    const html = response.data;

    const matches = [
      ...html.matchAll(/<a href="\/url\?q=(.*?)&amp;/g)
    ];

    let rank = 1;

    for (const match of matches) {

      const resultUrl =
        decodeURIComponent(match[1]);

      if (
        resultUrl.includes(domain)
      ) {

        return {
          found: true,
          rank: rank
        };

      }

      rank++;

    }

    return {
      found: false,
      rank: null
    };

  } catch (err) {

    console.log(err.message);

    return {
      found: false,
      rank: null
    };

  }

}

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

  if (
    !domains[keyword].includes(domain)
  ) {

    domains[keyword].push(domain);

  }

  bot.sendMessage(
    GROUP_ID,
    `✅ DOMAIN DITAMBAHKAN

Keyword: ${keyword}
Domain: ${domain}`,
    {
      message_thread_id:
        TOPICS[keyword]
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

  domains[keyword] =
    domains[keyword].filter(
      d => d !== domain
    );

  bot.sendMessage(
    GROUP_ID,
    `❌ DOMAIN DIHAPUS

Keyword: ${keyword}
Domain: ${domain}`,
    {
      message_thread_id:
        TOPICS[keyword]
    }
  );

});

// =======================
// CHECK MANUAL
// =======================

bot.onText(/\/check/, async (msg) => {

  const topicId =
    msg.message_thread_id;

  let selectedKeyword = null;

  for (const keyword in TOPICS) {

    if (
      TOPICS[keyword] === topicId
    ) {

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

  let report =
`📊 STATUS KEYWORD ${selectedKeyword}

`;

  for (
    const domain of
    domains[selectedKeyword]
  ) {

    report +=
`🔎 Checking ${domain}...

`;

    const result =
      await checkRank(
        selectedKeyword,
        domain
      );

    if (result.found) {

      report +=
`✅ DOMAIN TERDETEKSI
🌍 ${domain}
📌 Rank Mobile Indonesia: ${result.rank}

`;

    } else {

      report +=
`❌ DOMAIN TIDAK MASUK 100 BESAR
🌍 ${domain}

`;

    }

  }

  bot.sendMessage(
    GROUP_ID,
    report,
    {
      message_thread_id:
        topicId
    }
  );

});

// =======================
// MONITOR AUTO
// =======================

async function monitor() {

  for (const keyword in domains) {

    for (
      const domain of domains[keyword]
    ) {

      const result =
        await checkRank(
          keyword,
          domain
        );

      const found =
        result.found;

      const rank =
        result.rank;

      const key =
        `${keyword}_${domain}`;

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
📌 Rank Mobile Indonesia: ${rank}`,
          {
            message_thread_id:
              TOPICS[keyword]
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
❌ Hilang Ke: ${disappearCount[key]}/2`,
          {
            message_thread_id:
              TOPICS[keyword]
          }
        );

        // AUTO DELETE

        if (
          disappearCount[key] >= 2
        ) {

          domains[keyword] =
            domains[keyword].filter(
              d => d !== domain
            );

          bot.sendMessage(
            GROUP_ID,
            `🗑 DOMAIN AUTO DIHAPUS

Keyword: ${keyword}
Domain: ${domain}`,
            {
              message_thread_id:
                TOPICS[keyword]
            }
          );

        }

      }

    }

  }

}

// =======================
// AUTO CHECK 30 MENIT
// =======================

cron.schedule(
  '*/30 * * * *',
  async () => {

    console.log(
      'AUTO CHECK RUNNING...'
    );

    await monitor();

  }
);

// =======================
// BOT AKTIF
// =======================

bot.sendMessage(
  GROUP_ID,
  '🤖 BOT SEO RANK MONITOR AKTIF',
  {
    message_thread_id:
      TOPICS.SATSET138
  }
);
