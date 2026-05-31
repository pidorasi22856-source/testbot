'use strict';
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const apiCalls = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('/api/') || url.includes('/login') || url.includes('/auth') || url.includes('/github')) {
      apiCalls.push({ method: req.method(), url, postData: req.postData() || null });
    }
  });
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('/api/') && !url.includes('google-analytics') && !url.includes('gtag')) {
      try {
        const body = await resp.text().catch(() => '');
        if (body) apiCalls.push({ RESPONSE: true, url, status: resp.status(), body: body.slice(0, 800) });
      } catch {}
    }
  });

  await page.goto('https://geekai.co/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Кликнуть на вкладку "邮箱登录" (Email login)
  await page.click('a[href="https://geekai.co/login#"]:has-text("邮箱登录")');
  await page.waitForTimeout(2000);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, textarea'))
      .map(el => ({
        type: el.type, name: el.name, placeholder: el.placeholder, id: el.id,
        autocomplete: el.autocomplete,
      }));
  });
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button'))
      .map(el => ({ text: (el.innerText || '').trim(), type: el.type, cls: (el.className || '').slice(0, 100) }));
  });
  const forms = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form'))
      .map(f => ({ action: f.action, method: f.method, inputs: Array.from(f.querySelectorAll('input')).map(i => ({name:i.name,type:i.type,placeholder:i.placeholder})) }));
  });

  console.log('\n=== ВИДИМЫЙ ТЕКСТ ПОСЛЕ КЛИКА "邮箱登录" ===');
  console.log(bodyText.slice(0, 2000));

  console.log('\n=== ПОЛЯ ВВОДА ===');
  console.log(JSON.stringify(inputs, null, 2));

  console.log('\n=== КНОПКИ ===');
  console.log(JSON.stringify(buttons, null, 2));

  console.log('\n=== ФОРМЫ ===');
  console.log(JSON.stringify(forms, null, 2));

  await page.screenshot({ path: 'geekai_email_login.png', fullPage: true });

  // Теперь попробуем вкладку "手机登录" (Phone)
  await page.click('a[href="https://geekai.co/login#"]:has-text("手机登录")');
  await page.waitForTimeout(1500);
  const phoneText = await page.evaluate(() => document.body.innerText);
  const phoneInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(el => ({
      type: el.type, name: el.name, placeholder: el.placeholder, id: el.id
    }));
  });
  console.log('\n=== ВКЛАДКА "手机登录" (Телефон) — поля ===');
  console.log(JSON.stringify(phoneInputs, null, 2));
  console.log(phoneText.slice(0, 1000));

  await page.screenshot({ path: 'geekai_phone_login.png', fullPage: true });

  console.log('\n=== ВСЕ API ВЫЗОВЫ ===');
  apiCalls.forEach(c => console.log(JSON.stringify(c)));

  // Попробуем найти endpoint для отправки формы (изучаем JS бандл)
  console.log('\n=== Ищем в JS бандле эндпоинты /api/ ===');
  const jsSrc = 'https://static.geekai.co/build/assets/app-2f7fa776.js';
  const jsResp = await page.evaluate(async (url) => {
    const r = await fetch(url);
    const t = await r.text();
    // Найти все /api/ endpoints
    const matches = [...t.matchAll(/["'`](\/api\/[^"'`\s]{2,60})["'`]/g)].map(m => m[1]);
    return [...new Set(matches)].sort();
  }, jsSrc);

  console.log('\n=== API ENDPOINTS В JS БАНДЛЕ ===');
  jsSrc && jsSrc.length && console.log('Бандл:', jsSrc);
  jsSrc && console.log(JSON.stringify(jsSrc, null, 2));
  console.log(JSON.stringify(jsResp, null, 2));

  await browser.close();
  console.log('\nСкриншоты: geekai_email_login.png, geekai_phone_login.png');
})().catch(console.error);
