'use strict';
const { chromium } = require('playwright');
const https = require('https');

// Скачать JS бандл и вытащить все /api/ эндпоинты
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  // === Часть 1: вытащить эндпоинты из JS бандла ===
  console.log('Качаю JS бандл...');
  try {
    const js = await fetchText('https://static.geekai.co/build/assets/app-2f7fa776.js');
    const matches = [...js.matchAll(/["'`](\/api\/[^"'`\s\)]{3,80})["'`]/g)].map(m => m[1]);
    const uniq = [...new Set(matches)].sort();
    console.log('\n=== API ENDPOINTS из JS бандла ===');
    uniq.forEach(e => console.log(e));

    // Ищем также шаблоны авторизации
    const authMatches = [...js.matchAll(/["'`]([^"'`\s]{0,30}(?:login|register|auth|email|password|token|captcha|code|verify)[^"'`\s]{0,30})["'`]/gi)].map(m => m[1]);
    const authUniq = [...new Set(authMatches)].filter(s => s.startsWith('/') || s.includes('geekai')).slice(0, 50);
    console.log('\n=== AUTH-СВЯЗАННЫЕ пути/ключи ===');
    authUniq.forEach(e => console.log(e));
  } catch(e) {
    console.error('Бандл не загрузился:', e.message);
  }

  // === Часть 2: Playwright — кликаем по вкладкам ===
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/api/') && !url.includes('google') && !url.includes('weixin') && !url.includes('gtag')) {
      apiCalls.push({ '→ REQ': req.method() + ' ' + url, body: req.postData() || null });
    }
  });
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('geekai.co/api/') && !url.includes('google')) {
      try {
        const body = await resp.text().catch(() => '');
        apiCalls.push({ '← RESP': resp.status() + ' ' + url, body: body.slice(0, 600) });
      } catch {}
    }
  });

  await page.goto('https://geekai.co/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Найдём все вкладки — берём по тексту через getByText
  console.log('\n=== Все ссылки на странице login ===');
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.innerText.trim(), href: a.href, cls: a.className.slice(0,60)
    })).filter(a => a.text)
  );
  links.forEach(l => console.log(JSON.stringify(l)));

  // Кликаем邮箱登录 по тексту
  console.log('\nКликаю 邮箱登录...');
  try {
    await page.getByText('邮箱登录', { exact: true }).first().click();
    await page.waitForTimeout(2000);
  } catch(e) {
    console.log('Клик по тексту не удался:', e.message);
  }

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(el => ({
      type: el.type, name: el.name, placeholder: el.placeholder, id: el.id, autocomplete: el.autocomplete
    }))
  );
  console.log('\n=== ПОЛЯ после клика邮箱登录 ===');
  console.log(JSON.stringify(inputs, null, 2));

  const btns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(el => ({
      text: el.innerText.trim(), type: el.type, cls: el.className.slice(0,80)
    }))
  );
  console.log('\n=== КНОПКИ ===');
  console.log(JSON.stringify(btns, null, 2));

  await page.screenshot({ path: 'geekai_email.png', fullPage: true });

  // Весь innerText блока логина
  const loginText = await page.evaluate(() => {
    const main = document.querySelector('main') || document.querySelector('.login') || document.body;
    return main.innerText;
  });
  console.log('\n=== ТЕКСТ СТРАНИЦЫ ===');
  console.log(loginText.slice(0, 3000));

  console.log('\n=== API ВЫЗОВЫ PLAYWRIGHT ===');
  apiCalls.forEach(c => console.log(JSON.stringify(c)));

  await browser.close();
  console.log('\nГотово. Скриншот: geekai_email.png');
})().catch(console.error);
