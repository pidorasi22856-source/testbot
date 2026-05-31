'use strict';
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Перехватываем все сетевые запросы
  const requests = [];
  page.on('request', req => {
    const url = req.url();
    if (!url.includes('chunk') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.svg') && !url.includes('.ico') && !url.includes('.woff')) {
      requests.push({ method: req.method(), url });
    }
  });

  const responses = [];
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('/api/') || url.includes('auth') || url.includes('login') || url.includes('token')) {
      try {
        const body = await resp.text().catch(() => '');
        responses.push({ url, status: resp.status(), body: body.slice(0, 500) });
      } catch {}
    }
  });

  console.log('Загружаю https://geekai.co/login ...');
  await page.goto('https://geekai.co/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  const title = await page.title();

  // Все кнопки и ссылки
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="button"], a'))
      .map(el => ({
        tag: el.tagName,
        text: (el.innerText || el.textContent || '').trim().slice(0, 80),
        href: el.href || el.getAttribute('href') || null,
        onclick: el.getAttribute('onclick') || null,
        cls: (el.className || '').toString().slice(0, 80),
        id: el.id || null,
      }))
      .filter(b => b.text.length > 0);
  });

  // Все input поля
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, textarea, select'))
      .map(el => ({
        type: el.type,
        name: el.name,
        placeholder: el.placeholder,
        id: el.id,
        value: el.value ? '[HAS VALUE]' : '',
      }));
  });

  // Формы
  const forms = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form'))
      .map(el => ({ action: el.action, method: el.method, id: el.id }));
  });

  // Весь видимый текст на странице
  const bodyText = await page.evaluate(() => document.body.innerText);

  // Все script src
  const scripts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
  });

  console.log('\n=== TITLE ===');
  console.log(title);

  console.log('\n=== ВИДИМЫЙ ТЕКСТ ===');
  console.log(bodyText.slice(0, 3000));

  console.log('\n=== КНОПКИ И ССЫЛКИ ===');
  buttons.forEach(b => console.log(JSON.stringify(b)));

  console.log('\n=== ПОЛЯ ВВОДА ===');
  inputs.forEach(i => console.log(JSON.stringify(i)));

  console.log('\n=== ФОРМЫ ===');
  forms.forEach(f => console.log(JSON.stringify(f)));

  console.log('\n=== СКРИПТЫ ===');
  scripts.slice(0, 20).forEach(s => console.log(s));

  console.log('\n=== СЕТЕВЫЕ ЗАПРОСЫ ===');
  requests.forEach(r => console.log(`${r.method} ${r.url}`));

  console.log('\n=== API ОТВЕТЫ ===');
  responses.forEach(r => console.log(JSON.stringify(r)));

  // Скриним для визуала
  await page.screenshot({ path: 'geekai_login.png', fullPage: true });
  console.log('\nСкриншот сохранён: geekai_login.png');

  await browser.close();
})().catch(console.error);
