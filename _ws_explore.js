'use strict';
// Видимый прогон: регистрируем Notion, доходим до экрана ПОСЛЕ ввода кода,
// снимаем снапшоты (выбор workspace / онбординг) и держим браузер открытым,
// чтобы пользователь посмотрел и описал нужный экран.
const { chromium } = require('playwright-core');
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(new Date().toISOString().slice(11, 19) + ' ' + a.join(' ')); fs.writeFileSync('_ws_out.txt', out.join('\n')); };

async function snapshot(page, label) {
  await page.waitForTimeout(2000);
  const d = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1800),
    buttons: [...new Set(Array.from(document.querySelectorAll('button,[role="button"],a,[role="option"],[role="radio"]'))
      .map(b => (b.innerText || b.getAttribute('aria-label') || '').trim()).filter(t => t && t.length < 80))],
    inputs: Array.from(document.querySelectorAll('input,textarea')).map(i => ({ type: i.type, name: i.name, ph: i.placeholder })),
  }));
  log('===== ' + label + ' =====');
  log('URL: ' + d.url);
  log('BUTTONS: ' + JSON.stringify(d.buttons));
  log('INPUTS: ' + JSON.stringify(d.inputs));
  log('TEXT:\n' + d.text + '\n');
  return d;
}

async function clickByText(page, re) {
  for (const sel of ['button', '[role="button"]', 'a']) {
    for (const el of await page.$$(sel)) {
      const t = ((await el.innerText().catch(() => '')) || '').trim();
      if (re.test(t) && await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); return t; }
    }
  }
  return null;
}

(async () => {
  let browser;
  try {
    const db = require('./db'); await db.initDb();
    const mailbox = require('./mailbox');
    const proxy = db.getAllProxies().find(p => p.active);

    const addr = await mailbox.createAddress('fce');
    log('inbox: ' + addr.address);

    const pxy = proxy ? { server: `http://${proxy.host}:${proxy.port}`, username: proxy.username, password: proxy.password } : undefined;
    log('proxy: ' + (proxy ? `${proxy.host}:${proxy.port}` : 'none'));

    browser = await chromium.launch({
      headless: false, channel: 'msedge', proxy: pxy,
      args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
    });
    const ctx = await browser.newContext({
      locale: 'en-US', viewport: null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    await page.goto('https://www.notion.so/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await (await page.waitForSelector('input[type="email"]', { timeout: 30000 })).fill(addr.address);
    await page.getByRole('button', { name: /continue/i }).first().click();
    log('email submitted');

    // wait for code
    let code = null; const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const r = await mailbox.waitForCode(addr.address, addr.token, { timeoutMs: 8000, from: 'notion' }).catch(() => null);
      if (r && r.code) { code = r.code; break; }
    }
    if (!code) { log('NO CODE — браузер оставляю открытым для осмотра'); await page.waitForTimeout(180000); return; }
    log('code=' + code);

    const cf = await page.waitForSelector('input[placeholder*="code" i],input[name="notion-password"],input[autocomplete="one-time-code"],input[type="text"]', { timeout: 30000 });
    await cf.fill(code);
    await clickByText(page, /continue|verify|sign|log/i);
    log('code submitted — наблюдаем экраны после входа');

    // Снимаем серию снапшотов БЕЗ кликов по выбору — просто фиксируем экраны,
    // чтобы пользователь увидел экран выбора workspace и описал его.
    for (let step = 1; step <= 8; step++) {
      const d = await snapshot(page, 'post-login-' + step);
      const txt = d.text.toLowerCase();
      if (/workspace|team|join|for my team|for personal|how are you planning/.test(txt)) {
        log('>>> ПОХОЖЕ НА ЭКРАН ВЫБORA WORKSPACE на шаге ' + step);
      }
      await page.waitForTimeout(3000);
    }

    log('Браузер открыт 5 минут — посмотри экран и опиши, что нажимать.');
    await page.waitForTimeout(300000);
  } catch (e) { log('ERR ' + e.message + '\n' + (e.stack || '')); }
  finally { if (browser) await browser.close().catch(() => {}); }
})();
