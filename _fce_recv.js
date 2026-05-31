'use strict';
const { chromium } = require('playwright-core');
const fetch = require('node-fetch');
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(new Date().toISOString().slice(11,19)+' '+a.join(' ')); fs.writeFileSync('_recv_out.txt', out.join('\n')); };

(async () => {
  let browser;
  try {
    const db = require('./db'); await db.initDb();
    const KEY = db.getSetting('fce_api_key');
    const BASE = 'https://api2.freecustom.email/v1';
    const H = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    const proxy = db.getAllProxies().find(p=>p.active);

    // register inbox on ditube.info (fast delivery per user)
    const inbox = Math.random().toString(36).slice(2,14) + '@ditube.info';
    const reg = await fetch(BASE+'/inboxes',{method:'POST',headers:H,body:JSON.stringify({inbox,isTesting:false})}).then(r=>r.json());
    log('register:', JSON.stringify(reg));
    log('inbox:', inbox);

    const pxy = { server:`http://${proxy.host}:${proxy.port}`, username:proxy.username, password:proxy.password };
    browser = await chromium.launch({ headless:true, channel:'msedge', proxy:pxy, args:['--disable-blink-features=AutomationControlled'] });
    const ctx = await browser.newContext({ locale:'en-US', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
    const page = await ctx.newPage();
    await page.goto('https://www.notion.so/login',{waitUntil:'domcontentloaded',timeout:60000});
    await (await page.waitForSelector('input[type="email"]',{timeout:30000})).fill(inbox);
    await page.getByRole('button',{name:/continue/i}).first().click();
    await page.waitForTimeout(5000);
    const status = await page.evaluate(()=>/sent a code/i.test(document.body.innerText)?'CODE_SENT':(/invalid/i.test(document.body.innerText)?'INVALID':'OTHER'));
    log('notion:', status);
    await browser.close(); browser=null;

    // RAW dump of FCE responses every 4s
    const start=Date.now();
    let done=false;
    while (Date.now()-start<60000 && !done) {
      const msgs = await fetch(BASE+'/inboxes/'+encodeURIComponent(inbox)+'/messages',{headers:H}).then(r=>r.text());
      const otp  = await fetch(BASE+'/inboxes/'+encodeURIComponent(inbox)+'/otp',{headers:H}).then(r=>r.text());
      log('+'+Math.round((Date.now()-start)/1000)+'s');
      log('  MESSAGES_RAW: ' + msgs.slice(0,500));
      log('  OTP_RAW: ' + otp.slice(0,300));
      // if a message exists, fetch its full content to learn the shape
      try {
        const mj = JSON.parse(msgs);
        if (mj.data && mj.data.length) {
          const id = mj.data[0].id || mj.data[0].message_id;
          const full = await fetch(BASE+'/inboxes/'+encodeURIComponent(inbox)+'/messages/'+encodeURIComponent(id),{headers:H}).then(r=>r.text());
          log('  FULL_MSG_RAW: ' + full.slice(0,600));
          done = true;
        }
      } catch {}
      await new Promise(r=>setTimeout(r,4000));
    }
  } catch(e){ log('ERR '+e.message); }
  finally { if(browser) await browser.close().catch(()=>{}); }
})();
