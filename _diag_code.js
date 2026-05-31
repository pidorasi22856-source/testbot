'use strict';
// Видимый прогон: ВВОДИТ email, ждёт экран кода, и снимает ВСЕ inputs со
// всеми атрибутами — чтобы увидеть, как сейчас выглядит поле(я) кода.
const { chromium } = require('playwright-core');
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(new Date().toISOString().slice(11,19)+' '+a.join(' ')); fs.writeFileSync('_diag_code.txt', out.join('\n')); };

(async () => {
  let browser;
  try {
    const db = require('./db'); await db.initDb();
    const mailbox = require('./mailbox');
    const proxy = db.getAllProxies().find(p => p.active);

    const addr = await mailbox.createAddress('fce');
    log('inbox:', addr.address);

    const pxy = proxy ? { server: `http://${proxy.host}:${proxy.port}`, username: proxy.username, password: proxy.password } : undefined;
    browser = await chromium.launch({ headless: false, channel: 'msedge', proxy: pxy, args: ['--disable-blink-features=AutomationControlled', '--start-maximized'] });
    const ctx = await browser.newContext({ locale: 'en-US', viewport: null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();

    await page.goto('https://www.notion.so/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await (await page.waitForSelector('input[type="email"]', { timeout: 30000 })).fill(addr.address);
    await page.getByRole('button', { name: /continue/i }).first().click();
    log('email submitted, waiting 8s for code screen…');
    await page.waitForTimeout(8000);

    // Снимаем АБСОЛЮТНО ВСЁ про инпуты на текущей странице.
    const dump = await page.evaluate(() => {
      const inps = Array.from(document.querySelectorAll('input,textarea,[contenteditable="true"]'));
      return {
        url: location.href,
        text: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1500),
        inputs: inps.map(i => {
          const r = i.getBoundingClientRect();
          const attrs = {};
          for (const a of i.attributes) attrs[a.name] = a.value;
          return {
            tag: i.tagName,
            visible: r.width > 0 && r.height > 0 && getComputedStyle(i).visibility !== 'hidden',
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
            attrs,
          };
        }),
      };
    });
    log('URL:', dump.url);
    log('TEXT:\n' + dump.text);
    log('INPUTS:');
    for (const i of dump.inputs) log('  ', JSON.stringify(i));

    log('\nоставляю окно на 60с — посмотри сам');
    await page.waitForTimeout(60000);
  } catch (e) { log('ERR ' + e.message); }
  finally { if (browser) await browser.close().catch(() => {}); }
})();
