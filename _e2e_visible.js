'use strict';
// Видимый E2E-прогон production-функции notion.loginWithOtp:
//   • запускает Edge с прокси (видимо, не headless),
//   • регистрирует ящик и проходит весь онбординг (профиль → for work → invite → free),
//   • выводит каждый stage в консоль и пишет лог в _e2e_visible.txt,
//   • держит окно открытым 90 секунд после завершения, чтобы было видно итог.
const fs = require('fs');
const out = [];
const log = (...a) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + a.join(' ');
  out.push(line);
  console.log(line);
  fs.writeFileSync('_e2e_visible.txt', out.join('\n'));
};

(async () => {
  try {
    const db = require('./db'); await db.initDb();
    const notion = require('./notion');
    const proxy = db.getAllProxies().find(p => p.active) || null;
    log('proxy:', proxy ? `${proxy.host}:${proxy.port}` : 'none');

    const result = await notion.loginWithOtp({
      proxy, headless: false, timeoutMs: 150_000,
      onStatus: (stage, detail) => log('stage:', stage, detail ? JSON.stringify(detail).slice(0, 200) : ''),
    });
    log('OK email=', result.email, 'token_v2 len=', (result.token_v2 || '').length);

    // Сохраним в БД, чтобы попал в список Notion-аккаунтов в дашборде.
    const id = db.insertNotionAccount({
      email: result.email,
      token_v2: result.token_v2,
      cookies_json: JSON.stringify(result.cookies || []),
      proxy_id: proxy ? proxy.id : null,
      status: 'active',
      notes: 'auto-registered (visible debug)',
    });
    log('saved as notion_accounts id =', id);
  } catch (e) {
    log('ERR', e.message);
  }
})();
