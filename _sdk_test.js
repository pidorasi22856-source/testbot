'use strict';
const { chromium } = require('playwright-core');
const { FreecustomEmailClient } = require('freecustom-email');
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(new Date().toISOString().slice(11,19)+' '+a.join(' ')); fs.writeFileSync('_sdk_out.txt', out.join('\n')); };

(async () => {
  let browser;
  try {
    const db = require('./db'); await db.initDb();
    const KEY = db.getSetting('fce_api_key');
    const proxy = db.getAllProxies().find(p=>p.active);
    const client = new FreecustomEmailClient({ apiKey: KEY });

    const inbox = Math.random().toString(36).slice(2,14) + '@ditube.info';
    const reg = await client.inboxes.register(inbox, true); // isTesting=true → zero-latency
    log('registered:', inbox, JSON.stringify(reg).slice(0,120));

    // start the OTP wait IN PARALLEL before firing Notion
    const otpPromise = client.otp.waitFor(inbox).then(v=>({ok:true,v})).catch(e=>({ok:false,e:e.message}));

    const pxy = { server:`http://${proxy.host}:${proxy.port}`, username:proxy.username, password:proxy.password };
    browser = await chromium.launch({ headless:true, channel:'msedge', proxy:pxy, args:['--disable-blink-features=AutomationControlled'] });
    const page = await (await browser.newContext({ locale:'en-US', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' })).newPage();
    await page.goto('https://www.notion.so/login',{waitUntil:'domcontentloaded',timeout:60000});
    await (await page.waitForSelector('input[type="email"]',{timeout:30000})).fill(inbox);
    await page.getByRole('button',{name:/continue/i}).first().click();
    await page.waitForTimeout(4000);
    const st = await page.evaluate(()=>/sent a code/i.test(document.body.innerText)?'CODE_SENT':'OTHER');
    log('notion:', st);
    await browser.close(); browser=null;

    log('waiting for OTP via SDK...');
    const r = await otpPromise;
    log('OTP RESULT: ' + JSON.stringify(r));
  } catch(e){ log('ERR '+e.message+'\n'+(e.stack||'')); }
  finally { if(browser) await browser.close().catch(()=>{}); }
})();
