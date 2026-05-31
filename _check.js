'use strict';
const fs = require('fs');
const cp = require('child_process');

// 1) Syntax check each file.
for (const f of ['server.js', 'public/app.js', 'notion.js', 'mailbox.js']) {
  try { cp.execSync(`node --check ${f}`); console.log('SYNTAX OK:', f); }
  catch (e) { console.log('SYNTAX FAIL:', f, e.message); }
}

// 2) Cross-check: every getElementById('x') in the Notion code must exist in HTML.
const html = fs.readFileSync('public/index.html', 'utf8');
const ids = ['notion-count', 'notion-proxy', 'notion-provider', 'btn-notion-start',
  'btn-notion-stop', 'btn-refresh-notion', 'notion-progress-card', 'notion-progress-bar',
  'notion-progress-counts', 'notion-progress-label', 'notion-stat-ok', 'notion-stat-failed',
  'notion-stat-stage', 'notion-log', 'notion-tbody', 'nav-notion-count', 'page-notion'];
for (const id of ids) {
  const has = html.includes(`id="${id}"`);
  console.log(has ? 'HTML id OK:' : 'HTML id MISSING:', id);
}

// 3) nav item present
console.log('nav data-page=notion:', html.includes('data-page="notion"') ? 'OK' : 'MISSING');
