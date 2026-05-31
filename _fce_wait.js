'use strict';
const fetch = require('node-fetch');
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(new Date().toISOString().slice(11,19)+' '+a.join(' ')); fs.writeFileSync('_wait_out.txt', out.join('\n')); };

(async () => {
  const db = require('./db'); await db.initDb();
  const KEY = db.getSetting('fce_api_key');
  const BASE = 'https://api2.freecustom.email/v1';
  const H = { Authorization:'Bearer '+KEY, 'Content-Type':'application/json' };

  const inbox = Math.random().toString(36).slice(2,14) + '@ditube.info';
  await fetch(BASE+'/inboxes',{method:'POST',headers:H,body:JSON.stringify({inbox})}).then(r=>r.json());
  log('inbox:', inbox);

  // fire a Notion code at it (separate browser, no proxy for speed)
  const { chromium } = require('playwright-core');
  let browser;
  try {
    browser = await chromium.launch({ headless:true, channel:'msedge', args:['--disable-blink-features=AutomationControlled'] });
    const page = await (await browser.newContext({ locale:'en-US' })).newPage();
    await page.goto('https://www.notion.so/login',{waitUntil:'domcontentloaded',timeout:60000});
    await (await page.waitForSelector('input[type="email"]',{timeout:30000})).fill(inbox);
    await page.getByRole('button',{name:/continue/i}).first().click();
    await page.waitForTimeout(4000);
    const st = await page.evaluate(()=>/sent a code/i.test(document.body.innerText)?'CODE_SENT':'OTHER');
    log('notion fired:', st);
    await browser.close(); browser=null;
  } catch(e){ log('notion err '+e.message); } finally { if(browser) await browser.close().catch(()=>{}); }

  log('polling 120s...');

  const start=Date.now(); let done=false;
  while (Date.now()-start<120000 && !done) {
    const msgs = await fetch(BASE+'/inboxes/'+encodeURIComponent(inbox)+'/messages',{headers:H}).then(r=>r.json());
    const wait = await fetch(BASE+'/inboxes/'+encodeURIComponent(inbox)+'/wait',{headers:H}).then(r=>r.text()).catch(()=>'(wait err)');
    log('+'+Math.round((Date.now()-start)/1000)+'s msgs='+(msgs.data?msgs.data.length:'?')+' wait='+wait.slice(0,120));
    if (msgs.data && msgs.data.length) {
      log('GOT: '+JSON.stringify(msgs.data[0]).slice(0,400));
      done=true;
    }
    await new Promise(r=>setTimeout(r,5000));
  }
  if(!done) log('NOTHING in 120s');
})();
