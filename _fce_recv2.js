'use strict';
const { chromium } = require('playwright-core');
const fetch = require('node-fetch');
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(new Date().toISOString().slice(11,19)+' '+a.join(' ')); fs.writeFileSync('_recv2_out.txt', out.join('\n')); };

(async () => {
  let browser;
  try {
    const db = require('./db'); await db.initDb();
    const KEY = db.getSetting('fce_api_key');
    const BASE = 'https://api2.freecustom.email/v1';
    const H = { Authorization:'Bearer '+KEY, 'Content-Type':'application/json' };
    const proxy = db.getAllProxies().find(p=>p.active);

    const inbox = Math.random().toString(36).slice(2,14) + '@ditube.info';
    // register WITHOUT isTesting (real delivery)
    const reg = await fetch(BASE+'/inboxes',{method:'POST',headers:H,body:JSON.stringify({inbox})}).then(r=>r.json());
    log('register:', JSON.stringify(reg), 'inbox:', inbox);

    // Open Notion FAST (no proxy this time, to isolate delivery vs proxy latency)
    browser = await chromium.launch({ headless:true, channel:'msedge', args:['--disable-blink-features=AutomationControlled'] });
    const ctx = await browser.newContext({ locale:'en-US', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    await page.goto('https://www.notion.so/login',{waitUntil:'domcontentloaded',timeout:60000});
    await (await page.waitForSelector('input[type="email"]',{timeout:30000})).fill(inbox);
    const tSubmit = Date.now();
    await page.getByRole('button',{name:/continue/i}).first().click();
    log('submitted at t0');
    await page.waitForTimeout(4000);
    const status = await page.evaluate(()=>/sent a code/i.test(document.body.innerText)?'CODE_SENT':(/invalid/i.test(document.body.innerText)?'INVALID':'OTHER'));
    log('notion:', status);
    await browser.close(); browser=null;

    // Poll messages + try /wait. 70s.
    const start=Date.now(); let done=false;
    while (Date.now()-start<70000 && !done) {
      const msgs = await fetch(BASE+'/inboxes/'+encodeURIComponent(inbox)+'/messages',{headers:H}).then(r=>r.json());
      log('+'+Math.round((Date.now()-tSubmit)/1000)+'s count='+(msgs.data?msgs.data.length:'?'));
      if (msgs.data && msgs.data.length) {
        log('  FIRST_MSG: '+JSON.stringify(msgs.data[0]).slice(0,400));
        const id = msgs.data[0].id || msgs.data[0].message_id;
        const full = await fetch(BASE+'/inboxes/'+encodeURIComponent(inbox)+'/messages/'+encodeURIComponent(id),{headers:H}).then(r=>r.text());
        log('  FULL: '+full.slice(0,700));
        done=true;
      }
      await new Promise(r=>setTimeout(r,4000));
    }
    if(!done) log('NO MAIL in 70s (delivery issue, not parsing)');
  } catch(e){ log('ERR '+e.message); }
  finally { if(browser) await browser.close().catch(()=>{}); }
})();
