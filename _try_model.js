'use strict';
// Перебираем гипотезы о том, как нужно положить override в request body.
// На каждой запускаем запрос и читаем поле "model" в финальном usage —
// если совпадает с тем что мы запросили, значит формат правильный.
const fs = require('fs');
const out = [];
const log = (...a) => { out.push(a.join(' ')); fs.writeFileSync('_try_out.txt', out.join('\n')); };

(async () => {
  const db = require('./db'); await db.initDb();
  const np = require('./notion_profiles');
  const cur = db.getCurrentNotionAccount();
  log('account:', cur.email);

  const { chromium } = require('playwright-core');
  const launchOpts = { headless: true, channel: 'msedge' };
  if (cur.proxy_id) {
    const p = db.getProxyById(cur.proxy_id);
    if (p) {
      const sc = (p.type || 'http').replace('socks5h','socks5');
      launchOpts.proxy = { server: `${sc}://${p.host}:${p.port}` };
      if (p.username) { launchOpts.proxy.username = p.username; launchOpts.proxy.password = p.password || ''; }
    }
  }
  const browser = await chromium.launch(launchOpts);
  const ctx = await browser.newContext({ storageState: np.ensureProfile(cur), locale: 'en-US' });
  const cookies = await ctx.cookies('https://www.notion.so');
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  await browser.close();

  const tmpl = JSON.parse(fs.readFileSync('data/notion-recon/_run_inference_req_full.json','utf8'));
  const newId = () => require('crypto').randomUUID();
  const replaceAllStr = (obj) => {
    if (typeof obj === 'string') return obj.split(tmpl.spaceId).join(cur.space_id).split(tmpl.transcript[1].value.userId||'').join(cur.user_id||'');
    if (Array.isArray(obj)) return obj.map(replaceAllStr);
    if (obj && typeof obj === 'object') { const r={};for(const k of Object.keys(obj))r[k]=replaceAllStr(obj[k]);return r;}
    return obj;
  };
  function freshBody(prompt, configPatch, bodyPatch) {
    let b = replaceAllStr(tmpl);
    b.traceId = newId(); b.threadId = newId();
    for (const t of b.transcript) t.id = newId();
    b.transcript[1].value.userEmail = cur.email || '';
    b.transcript[1].value.userId = cur.user_id || '';
    b.transcript[1].value.spaceId = cur.space_id;
    b.transcript[1].value.currentDatetime = new Date().toISOString();
    b.transcript[2].userId = cur.user_id || '';
    b.transcript[2].createdAt = new Date().toISOString();
    b.transcript[2].value = [[prompt]];
    b.threadParentPointer.id = cur.space_id;
    b.threadParentPointer.spaceId = cur.space_id;
    if (configPatch) Object.assign(b.transcript[0].value, configPatch);
    if (bodyPatch) Object.assign(b, bodyPatch);
    return b;
  }

  let dispatcher = null;
  if (cur.proxy_id) {
    const px = db.getProxyById(cur.proxy_id);
    if (px && (px.type==='http'||px.type==='https')) {
      const { ProxyAgent } = require('undici');
      const auth = px.username ? `${encodeURIComponent(px.username)}:${encodeURIComponent(px.password||'')}@` : '';
      dispatcher = new ProxyAgent(`${px.type}://${auth}${px.host}:${px.port}`);
    }
  }

  async function run(label, body) {
    const fOpts = {
      method: 'POST',
      headers: {
        'accept':'application/x-ndjson','content-type':'application/json','cookie':cookieHeader,
        'notion-client-version':'23.13.20260530.1226','notion-audit-log-platform':'web',
        'origin':'https://www.notion.so','referer':'https://www.notion.so/chat',
        'x-notion-active-user-header': cur.user_id||'', 'x-notion-space-id': cur.space_id,
      }, body: JSON.stringify(body),
    };
    if (dispatcher) fOpts.dispatcher = dispatcher;
    const r = await fetch('https://www.notion.so/api/v3/runInferenceTranscript', fOpts);
    const text = await r.text();
    // model лежит в одном из patch'ей: "/s/<i>/model","v":"..."
    const m = /"\/s\/\d+\/model","v":"([^"]+)"/.exec(text);
    log('TRY', label, '=> http', r.status, 'len', text.length, 'model:', m ? m[1] : 'NOT FOUND');
  }

  const target = 'apricot-sorbet-high';   // Opus 4.7

  await run('baseline (no override)', freshBody('hi'));
  await run('config.modelOverride', freshBody('hi', { modelOverride: target }));
  await run('config.model', freshBody('hi', { model: target }));
  await run('config.modelFromUser=true + modelOverride', freshBody('hi', { modelFromUser: true, modelOverride: target }));
  await run('config.modelFromUser=true + model', freshBody('hi', { modelFromUser: true, model: target }));
  await run('config.userPickedModel', freshBody('hi', { userPickedModel: target }));
  await run('config.modelFromUser + userPickedModel', freshBody('hi', { modelFromUser: true, userPickedModel: target }));
  await run('config.selectedModel', freshBody('hi', { selectedModel: target }));
  await run('top-level body.model', freshBody('hi', null, { model: target }));
  await run('top-level body.modelOverride', freshBody('hi', null, { modelOverride: target }));
  await run('top-level body.userPickedModel', freshBody('hi', null, { userPickedModel: target }));
})().catch(e => log('FATAL', e.message));
