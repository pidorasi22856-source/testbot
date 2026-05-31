'use strict';

// ═══════════════════════════════════════════════════════════════════
//  Geekai Auto-Registrar
//  1. Редим токены api009.com → email + password
//  2. Запрашиваем vcode на geekai.co (email login tab)
//  3. Читаем vcode через emailfake.com (с cookie embx)
//  4. Вводим код → сохраняем сессию + API key
// ═══════════════════════════════════════════════════════════════════

const { chromium } = require('playwright');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

// ── Настройки ─────────────────────────────────────────────────────
const RESULTS_FILE   = path.join(__dirname, 'geekai_results.json');
const CONCURRENCY    = 2;    // параллельных регистраций
const VCODE_WAIT_SEC = 90;   // максимум ждём vcode
const VCODE_POLL_SEC = 8;    // интервал опроса почты

// ── Токены ────────────────────────────────────────────────────────
const TOKENS = `jyyp-1-uyUSLMYqGiKU9bZU3LSMW
a62Z-1-Vkz432Ct484Ui6RveTFgh
YSaE-1-KCkGGzZCrTMiQhAQvbswi
9TAf-1-SLN2VSP4EytLmEbysbk8L
nfdi-1-xjR4jPSd5R2wireRPTh4F
Apwa-1-i8GPRaHHdHQZpnMqTuEzE
3PZe-1-B6LKyrpjeAZgEQATRizyH
iLi2-1-STSU6tzsjFLqtbMe5XaMZ
CyQA-1-E4uWiunhFfTsHKUNFiyeJ
yyoF-1-CEZjpj5ziFBKR4Lh9Aug3
oBuk-1-scqciCf4TyKK6446fTJC4
9gUF-1-VhiDDjfDUVKowdKw37zjg
BcMp-1-FRzocpr5DTPakFuLmAtgA
n6kd-1-4PvfRmbSih5nUDVZH54Ke
dRRW-1-ob6Byd2fPXiLAJ3hGinUw
TSvX-1-C6vYLaca3uhbY2gjQ9hSF
sfHh-1-XWQumC9355SsYz3dVHixR
EtMG-1-eFLPWbQFP3WAHZ2YPMzgB
rWnx-1-dS5QG2CjHcCnJBfY9JASw
HkZW-1-k8grVXzuZRrdEvvCti4BK
p5ff-1-jjSWSw8wq4S5JqxfTA2rt
Ep88-1-kAE79pfrEySWSEE8QCu7G
ffAd-1-Twdi7Q3XwCCxQeZnShHTB
M6NA-1-8LsJ6i4pPnuzDLze4dvrH
xETZ-1-TBD6BBLxLAgh3EBxJXRbN
xohU-1-GhbLVazwBWJD7A55BD4tx
Xzj5-1-omo2mqRDyJCiacPvzukS9
86zK-1-26SgYsQMnSfnTn4Pbr3gc
t54w-1-s2mxgSvN28wQxJwx2hb7G
d6WU-1-r4qzNDTzSoCYtQPEdAGeD`.trim().split('\n').map(s => s.trim()).filter(Boolean);

// ── Утилиты ───────────────────────────────────────────────────────
const log   = (tag, msg) => console.log(`[${new Date().toISOString().slice(11,19)}] [${tag}] ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpsPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST', port: 443,
      headers: { 'Content-Length': buf.length, ...extraHeaders },
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(buf); req.end();
  });
}

function httpsPostJson(url, obj) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST', port: 443,
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
    });
    req.on('error', reject);
    req.write(buf); req.end();
  });
}

// ── Шаг 1: Редим токен ────────────────────────────────────────────
async function redeemToken(token) {
  const r = await httpsPostJson('https://api009.com/api/redeem-v2-24h-nongmail', { token });
  if (!r.success || !r.account) throw new Error(r.message || 'no account');
  return r.account; // { email, password }
}

// ── Шаг 2: emailfake — читаем письма через Playwright с cookie ───
// embx cookie = JSON.stringify([email]) — именно по ней сайт знает чей ящик

async function getEmailfakeVcode(email, browser) {
  const [usr, dmn] = email.split('@');

  const ctx  = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0' });
  const page = await ctx.newPage();

  let vcode = null;
  try {
    // Открываем emailfake и переключаемся на нужный ящик
    await page.goto('https://emailfake.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    // Устанавливаем cookie embx — так emailfake знает чей ящик
    const embxVal = encodeURIComponent(JSON.stringify([email]));
    const surlVal = `${dmn}/${usr}`;
    await ctx.addCookies([
      { name: 'embx', value: embxVal,  domain: 'emailfake.com', path: '/' },
      { name: 'surl', value: surlVal,  domain: 'emailfake.com', path: '/' },
    ]);

    // Переходим к ящику
    await page.goto(`https://emailfake.com/${dmn}/${usr}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const text = await page.evaluate(() => document.body.innerText);

    // Ищем 6-значный код (не год)
    const matches = text.match(/\b(\d{6})\b/g);
    if (matches) {
      vcode = matches.find(c => {
        const n = parseInt(c);
        return n >= 100000 && n <= 999999 && !c.startsWith('202') && !c.startsWith('201');
      }) || null;
    }
  } catch { /* ignore */ } finally {
    await ctx.close();
  }
  return vcode;
}

// Ждём vcode с поллингом
async function waitForVcode(email, browser, tag) {
  const deadline = Date.now() + VCODE_WAIT_SEC * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    await sleep(VCODE_POLL_SEC * 1000);
    log(tag, `Проверяю почту (попытка ${attempt})...`);
    const code = await getEmailfakeVcode(email, browser).catch(() => null);
    if (code) { log(tag, `Код найден: ${code}`); return code; }
  }
  return null;
}

// ── Шаг 3: Регистрация на geekai.co ──────────────────────────────
async function registerOnGeekai(browser, email, tag) {
  const ctx  = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();

  try {
    log(tag, `Открываю geekai.co/login...`);
    await page.goto('https://geekai.co/login', { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(1000);

    // Вкладка 邮箱登录
    await page.locator('text=邮箱登录').first().click();
    await page.waitForTimeout(800);

    // Ждём появления поля email
    await page.waitForSelector('input[name="email"]', { timeout: 8000 });

    // Вводим email через click + type (надёжнее чем fill на некоторых фреймворках)
    await page.click('input[name="email"]');
    await page.type('input[name="email"]', email, { delay: 50 });
    await page.waitForTimeout(400);

    // Нажимаем "获取验证码" (Получить код)
    log(tag, 'Запрашиваю vcode...');
    await page.locator('button', { hasText: '获取验证码' }).first().click();
    await page.waitForTimeout(1000);

    // Ждём код из почты
    const vcode = await waitForVcode(email, browser, tag);
    if (!vcode) throw new Error(`vcode не получен за ${VCODE_WAIT_SEC}с`);

    // Вводим код
    await page.click('input[name="vcode"]');
    await page.type('input[name="vcode"]', vcode, { delay: 50 });
    await page.waitForTimeout(300);

    // Логинимся
    log(tag, 'Логинюсь...');
    await page.screenshot({ path: `debug_${tag.replace('#','')}_before_login.png` });
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => null),
      page.locator('button', { hasText: '立即登录' }).first().click(),
    ]);
    await page.waitForTimeout(2500);

    const finalUrl = page.url();
    const success  = finalUrl.includes('/user') || finalUrl.includes('/chat') || finalUrl.includes('/dashboard');
    log(tag, `URL: ${finalUrl} | success=${success}`);

    const cookies = await ctx.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Получаем API ключ
    let apiKey = null;
    if (success) {
      try {
        await page.goto('https://geekai.co/user/api_keys', { waitUntil: 'networkidle', timeout: 12000 });
        await page.waitForTimeout(1500);

        let pageText  = await page.evaluate(() => document.body.innerText);
        let keyMatch  = pageText.match(/sk-[a-zA-Z0-9\-]{20,}/);

        if (!keyMatch) {
          // Жмём кнопку создания ключа
          const btn = page.locator('button').filter({ hasText: /创建|新建|添加|新增|Create|Add/i }).first();
          if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await btn.click();
            await page.waitForTimeout(2000);
            pageText = await page.evaluate(() => document.body.innerText);
            keyMatch = pageText.match(/sk-[a-zA-Z0-9\-]{20,}/);
          }
        }

        if (keyMatch) { apiKey = keyMatch[0]; log(tag, `API key: ${apiKey.slice(0, 24)}...`); }
      } catch (e) {
        log(tag, `API key ошибка: ${e.message.slice(0, 60)}`);
      }
    }

    return { success, email, finalUrl, cookieStr, apiKey };

  } catch (e) {
    return { success: false, email, error: e.message };
  } finally {
    await ctx.close();
  }
}

// ── Очередь с параллельностью ─────────────────────────────────────
async function runPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  log('MAIN', `Старт. Токенов: ${TOKENS.length}`);

  // Шаг 1: Редимим все токены
  log('MAIN', '=== Редимим токены ===');
  const accounts = [];
  for (const token of TOKENS) {
    try {
      const acc = await redeemToken(token);
      log('REDEEM', `✅ ${token.slice(0, 12)}... → ${acc.email}`);
      accounts.push({ token, ...acc });
    } catch (e) {
      log('REDEEM', `❌ ${token.slice(0, 12)}... → ${e.message}`);
    }
    await sleep(250);
  }

  const valid = accounts.filter(a => a.email);
  log('MAIN', `\nПолучено аккаунтов: ${valid.length}`);
  valid.forEach(a => log('ACC', `  📧 ${a.email}  🔑 ${a.password}`));

  if (!valid.length) { log('MAIN', 'Нет аккаунтов'); return; }

  // Шаг 2: Регаем на geekai
  log('MAIN', `\n=== Регаем на geekai.co (x${CONCURRENCY}) ===`);
  const browser = await chromium.launch({ headless: true });

  const partialResults = [];
  const gResults = await runPool(valid, async (acc, i) => {
    const tag = `#${String(i + 1).padStart(2, '0')}`;
    const res = await registerOnGeekai(browser, acc.email, tag);
    const row = { ...acc, geekai: res };
    partialResults.push(row);
    // Сохраняем после каждого
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(
      { updated: new Date().toISOString(), accounts: valid, results: partialResults }, null, 2
    ));
    return row;
  }, CONCURRENCY);

  await browser.close();

  // Итог
  const ok   = gResults.filter(r => r?.geekai?.success);
  const fail = gResults.filter(r => !r?.geekai?.success);
  log('MAIN', '\n═══ ИТОГ ═══');
  log('MAIN', `✅ Успешно: ${ok.length}/${valid.length}`);
  ok.forEach(r => {
    const k = r.geekai.apiKey ? ` | key: ${r.geekai.apiKey.slice(0,24)}...` : '';
    log('MAIN', `  ✅ ${r.email}${k}`);
  });
  if (fail.length) {
    log('MAIN', `❌ Неудачно: ${fail.length}`);
    fail.forEach(r => log('MAIN', `  ❌ ${r?.email}: ${r?.geekai?.error || '?'}`));
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(
    { updated: new Date().toISOString(), total: valid.length, success: ok.length, failed: fail.length, results: gResults }, null, 2
  ));
  log('MAIN', `\nРезультаты: ${RESULTS_FILE}`);
})().catch(console.error);
