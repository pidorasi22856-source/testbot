'use strict';
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 50 }); // headful чтобы видеть
  const page = await browser.newPage();

  const allRequests = [];
  page.on('request', req => {
    const url = req.url();
    allRequests.push({ method: req.method(), url });
  });

  // Смотрим что происходит при логине в Kiro через Google
  console.log('Открываю kiro.dev/login...');
  await page.goto('https://kiro.dev', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const title = await page.title();
  const bodyText = await page.evaluate(() => document.body.innerText);
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a, button')).map(el => ({
      tag: el.tagName,
      text: (el.innerText || '').trim().slice(0, 80),
      href: el.href || el.getAttribute('href') || null,
    })).filter(l => l.text)
  );

  console.log('\n=== TITLE ===', title);
  console.log('\n=== ТЕКСТ ===\n', bodyText.slice(0, 2000));
  console.log('\n=== ССЫЛКИ/КНОПКИ ===');
  links.forEach(l => console.log(JSON.stringify(l)));

  await page.screenshot({ path: 'kiro_main.png', fullPage: false });

  // Ищем кнопку Sign in / Get started
  console.log('\nИщу кнопку входа...');
  try {
    // Попробуем перейти напрямую на страницу логина
    await page.goto('https://app.kiro.dev', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    const appTitle = await page.title();
    const appText = await page.evaluate(() => document.body.innerText);
    const appLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a, button')).map(el => ({
        text: (el.innerText || '').trim().slice(0, 80),
        href: el.href || null,
      })).filter(l => l.text)
    );
    console.log('\n=== app.kiro.dev title ===', appTitle);
    console.log('\n=== app.kiro.dev text ===\n', appText.slice(0, 2000));
    console.log('\n=== app.kiro.dev links ===');
    appLinks.forEach(l => console.log(JSON.stringify(l)));
    await page.screenshot({ path: 'kiro_app.png', fullPage: false });
  } catch(e) {
    console.log('app.kiro.dev:', e.message);
  }

  // Попробуем auth endpoint
  try {
    await page.goto('https://app.kiro.dev/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    console.log('\n=== /auth/login URL сейчас:', page.url());
    const authText = await page.evaluate(() => document.body.innerText);
    console.log(authText.slice(0, 1000));
    await page.screenshot({ path: 'kiro_auth.png', fullPage: false });
  } catch(e) {
    console.log('/auth/login:', e.message);
  }

  console.log('\n=== ВСЕ РЕКВЕСТЫ (фильтр auth/login/google) ===');
  allRequests
    .filter(r => /auth|login|google|oauth|signin|signup|register/i.test(r.url))
    .forEach(r => console.log(r.method, r.url));

  await browser.close();
})().catch(console.error);
