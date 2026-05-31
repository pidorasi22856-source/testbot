'use strict';
// Открываем chat на пульте, перехватываем тело каждого runInferenceTranscript.
// Делаем это headless, тыкаем на picker и шлём 2 сообщения с разной моделью.
const fs = require('fs');
(async () => {
  const db = require('./db'); await db.initDb();
  const np = require('./notion_profiles');
  const cur = db.getCurrentNotionAccount();
  const { chromium } = require('playwright-core');
  const launchOpts = { headless: false, channel: 'msedge', args: ['--start-maximized'] };
  if (cur.proxy_id) {
    const p = db.getProxyById(cur.proxy_id);
    if (p) {
      const sc = (p.type || 'http').replace('socks5h','socks5');
      launchOpts.proxy = { server: `${sc}://${p.host}:${p.port}` };
      if (p.username) { launchOpts.proxy.username = p.username; launchOpts.proxy.password = p.password || ''; }
    }
  }
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ storageState: np.ensureProfile(cur), viewport: null, locale: 'en-US' });
  const page = await ctx.newPage();

  const captures = [];
  page.on('request', req => {
    if (/runInferenceTranscript/.test(req.url())) {
      try {
        const body = req.postData();
        captures.push({ ts: new Date().toISOString(), body });
      } catch {}
    }
  });

  await page.goto('https://www.notion.so/chat', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('opened. Manually pick a model in the picker, then send a short message ("hi"). After 2 messages with different models — close window.');
  // Ждём долго пока пользователь не закроет окно или не пройдёт 5 минут.
  await page.waitForTimeout(5 * 60_000).catch(() => {});
  await browser.close().catch(() => {});

  console.log('captures:', captures.length);
  fs.writeFileSync('_captures.json', JSON.stringify(captures, null, 2));
})();
