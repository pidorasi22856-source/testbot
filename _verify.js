'use strict';
delete require.cache[require.resolve('./notion_chat')];
const fs = require('fs');
(async () => {
  const db = require('./db'); await db.initDb();
  const { runChat } = require('./notion_chat');
  const out = [];
  const log = (...a) => { out.push(a.join(' ')); fs.writeFileSync('_verify_out.txt', out.join('\n')); };

  for (const m of ['claude-opus-4.7', 'claude-opus-4.8', 'gemini-3.1-pro', 'gpt-5.5', null]) {
    try {
      const r = await runChat({
        model: m,
        messages: [{ role: 'user', content: 'one word: ok' }],
      });
      log('requested:', m || '(default)', '→ used:', r.model, 'usage.model:', r.usage && r.usage.model);
    } catch (e) { log('ERR', m, e.message); }
  }
  process.exit(0);
})();
