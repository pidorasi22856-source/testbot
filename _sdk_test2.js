'use strict';
const { chromium } = require('playwright-core');
const { FreecustomEmailClient } = require('freecustom-email');
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(new Date().toISOString().slice(11,19)+' '+a.join(' ')); fs.writeFileSync('_sdk2_out.txt', out.join('\n')); };

(async () => {
  let browser;
  try {
    const db = require('./db'); await db.initDb();
    const KEY = db.getSetting('fce_api_key');
    const client = new FreecustomEmailClient({ apiKey: KEY });

    const inbox = Math.random().toString(36).slice(2,14) + '@ditube.info';
    await client.inboxes.register(inbox, false); // REAL delivery, not testing buffer
    log('registered (real):', inbox);

    // Fire Notion WITHOUT proxy (fast) so code is sent ASAP
    browser = await chromium.launch({ headless:true, channel:'msedge', args:['--disable-blink-features=AutomationControlled'] });
    const page = await (await browser.newContext({ locale:'en-US', userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' })).newPage();
    await page.goto('https://www.notion.so/login',{waitUntil:'domcontentloaded',timeout:60000});
    await (await page.waitForSelector('input[type="email"]',{timeout:30000})).fill(inbox);
    await page.getByRole('button',{name:/continue/i}).first().click();
    await page.waitForTimeout(4000);
    const st = await page.evaluate(()=>/sent a code/i.test(document.body.innerText)?'CODE_SENT':'OTHER');
    log('notion:', st);
    await browser.close(); browser=null;

    // Poll raw messages for 90s, log count each time
    const http = require('node-fetch');
    const BASE='https://api2.freecustom.email/v1';
    const H={Authorization:'Bearer '+KEY};
    const start=Date.now(); let got=false;
    while (Date.now()-start<90000) {
      const m = await http(BASE+'/inboxes/'+encodeURIComponent(inbox)+'/messages',{headers:H}).then(r=>r.json());
      log('+'+Math.round((Date.now()-start)/1000)+'s count='+(m.data?m.data.length:'?'));
      if (m.data&&m.data.length){ log('MSG: '+JSON.stringify(m.data[0]).slice(0,300)); got=true; break; }
      await new Promise(r=>setTimeout(r,5000));
    }
    if(!got) log('NO DELIVERY 90s');
  } catch(e){ log('ERR '+e.message); }
  finally { if(browser) await browser.close().catch(()=>{}); }
})();
