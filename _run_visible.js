'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(new Date().toISOString().slice(11,19) + ' ' + a.join(' ')); fs.writeFileSync('_visible_out.txt', out.join('\n')); };

async function snapshot(page, label) {
  await page.waitForTimeout(2500);
  const d = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText.replace(/\n{2,}/g,'\n').slice(0,1500),
    buttons: [...new Set(Array.from(document.querySelectorAll('button,[role="button"],a')).map(b=>(b.innerText||b.getAttribute('aria-label')||'').trim()).filter(t=>t&&t.length<70))],
    inputs: Array.from(document.querySelectorAll('input,textarea')).map(i=>({type:i.type,name:i.name,ph:i.placeholder})),
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
    const els = await page.$$(sel);
    for (const el of els) {
      const t = ((await el.innerText().catch(()=>'')) || '').trim();
      if (re.test(t) && await el.isVisible().catch(()=>false)) { await el.click().catch(()=>{}); return t; }
    }
  }
  return null;
}

(async () => {
  let browser;
  try {
    const db = require('./db'); await db.initDb();
    const proxyMod = require('./proxy'); const mailbox = require('./mailbox');
    const proxy = db.getAllProxies().find(p => p.active);

    const addr = await mailbox.createAddress('fce');
    log('inbox: ' + addr.address);

    const pxy = proxy ? { server: `http://${proxy.host}:${proxy.port}`, username: proxy.username, password: proxy.password } : undefined;
    browser = await chromium.launch({ headless: false, channel: 'msedge', proxy: pxy, args: ['--disable-blink-features=AutomationControlled','--start-maximized'] });
    const ctx = await browser.newContext({ locale: 'en-US', viewport: null, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();

    await page.goto('https://www.notion.so/login', { waitUntil:'domcontentloaded', timeout:60000 });
    await (await page.waitForSelector('input[type="email"]',{timeout:30000})).fill(addr.address);
    await page.getByRole('button',{name:/continue/i}).first().click();
    log('email submitted');
    await page.waitForTimeout(6000);

    let code=null; const t0=Date.now();
    while (Date.now()-t0 < 90000) {
      const r = await mailbox.waitForCode(addr.address, addr.token, { timeoutMs: 8000 }).catch(()=>null);
      if (r && r.code) { code=r.code; break; }
    }
    if (!code) { log('NO CODE'); return; }
    log('code=' + code);
    const cf = await page.$('input[placeholder*="code" i],input[name="notion-password"],input[autocomplete="one-time-code"]');
    await cf.fill(code);
    await page.getByRole('button',{name:/continue|verify|sign|log/i}).first().click();
    log('code submitted');

    // Walk onboarding: name → continue → ... → find plan/trial screen
    for (let step=1; step<=10; step++) {
      const d = await snapshot(page, 'onboard-' + step);
      const txt = d.text.toLowerCase();
      // detect plan/trial screen
      if (txt.includes('trial') || txt.includes('plus') || txt.includes('business') || txt.includes('per month') || txt.includes('upgrade')) {
        log('>>> LIKELY PLAN/TRIAL SCREEN at step ' + step);
      }
      if (d.url.match(/notion\.so\/[0-9a-f]{20,}/i) || txt.includes('getting started') || txt.includes('quick note')) {
        log('Reached workspace.'); break;
      }
      // fill name if present
      for (const inp of await page.$$('input[type="text"],input:not([type])')) {
        const ph = (await inp.getAttribute('placeholder'))||'';
        if (await inp.isVisible().catch(()=>false) && /name/i.test(ph)) { await inp.fill('Alex Morgan'); log('filled name'); }
      }
      const clicked = await clickByText(page, /^(continue|next|get started|create|skip|take me)/i);
      if (!clicked) { log('no forward btn at step ' + step); break; }
      log('clicked: ' + clicked);
      await page.waitForTimeout(4000);
    }
    log('FINAL URL: ' + page.url());
    log('browser stays open 90s — watch & note the trial button');
    await page.waitForTimeout(90000);
  } catch (e) { log('ERR ' + e.message + '\n' + (e.stack||'')); }
  finally { if (browser) await browser.close().catch(()=>{}); }
})();
