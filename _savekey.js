(async () => {
  const db = require('./db');
  await db.initDb();
  db.setSetting('fce_api_key', 'fce_29bd1f78a8ea5a96005fb71c938db3ac43e15bf0811d944c841031dc069141cf');
  db.setSetting('mail_provider', 'fce');
  // read back in same process
  console.log('saved, readback=', (db.getSetting('fce_api_key') || 'MISSING').slice(0, 14));
})();
