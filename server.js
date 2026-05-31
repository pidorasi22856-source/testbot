'use strict';

const express = require('express');
const path    = require('path');
const os      = require('os');

const db = require('./db');
const accountsMgr = require('./accounts');
const patcher     = require('./patcher');
const proxyMgr    = require('./proxy');
const rotator     = require('./rotator');
const quota       = require('./quota');
const mailbox     = require('./mailbox');
const kiroApiRoutes = require('./kiro_routes');
const notionApiRoutes = require('./notion_routes');
const notionProfiles = require('./notion_profiles');

const app  = express();

app.use(express.json({ limit: '10mb' }));

// OpenAI- & Anthropic-compatible API surface (/v1/*). Mounted before static so
// external SDKs (openai, anthropic) can point their baseURL here.
app.use('/', kiroApiRoutes);

// Notion-AI gateway: /notion/v1/chat/completions, /notion/v1/messages,
// /notion/v1/models. Same OpenAI/Anthropic shape as Kiro's, but powered by
// Notion AI internal API (runInferenceTranscript). External tools just point
// their baseURL at /notion/v1.
app.use('/', notionApiRoutes);

// Serve the dashboard UI. Disable caching so updated app.js/index.html/style.css
// are always picked up on reload (avoids stale-cache "settings don't save" bugs).
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(res, data)       { res.json({ ok: true, ...data }); }
function fail(res, msg, code = 400) { res.status(code).json({ ok: false, error: msg }); }
function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (e) { fail(res, e.message, 500); }
  };
}

// ─── Accounts ────────────────────────────────────────────────────────────────

app.get('/api/accounts', wrap((req, res) => {
  ok(res, { accounts: db.getAllAccounts() });
}));

app.post('/api/accounts', wrap((req, res) => {
  const { label, token_json, proxy_id, priority, notes } = req.body;
  if (!label || !token_json) return fail(res, 'label and token_json required');
  const result = accountsMgr.addAccount({ label, tokenJson: token_json, proxyId: proxy_id, priority, notes });
  ok(res, { id: result.id });
}));

app.put('/api/accounts/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  accountsMgr.editAccount(id, req.body);
  ok(res, {});
}));

app.delete('/api/accounts/:id', wrap((req, res) => {
  accountsMgr.removeAccount(parseInt(req.params.id));
  ok(res, {});
}));

app.post('/api/accounts/:id/activate', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const token = accountsMgr.activateAccount(id);

  const mode = db.getSetting('switch_mode') || 'hot';
  if (mode === 'restart' && rotator.isKiroRunning()) {
    await rotator.killKiro();
    await new Promise(r => setTimeout(r, 400));
    const acc = db.getAccountById(id);
    rotator.spawnKiro(acc ? acc.proxy_id : null);
  }

  db.logEvent(id, 'manual_activate', null);
  rotator.broadcast('switch', { to: { id }, reason: 'manual', mode });
  ok(res, { token });
}));

app.post('/api/accounts/import', wrap((req, res) => {
  const { json } = req.body;
  if (!json) return fail(res, 'json field required');
  const results = accountsMgr.importAccountsFromJson(json);
  ok(res, { imported: results.length });
}));

// Bulk paste — accepts a JSON array OR many concatenated token objects
app.post('/api/accounts/import-bulk', wrap((req, res) => {
  const { text, proxy_id } = req.body;
  if (!text || !text.trim()) return fail(res, 'text field required');
  const result = accountsMgr.importBulk(text, { defaultProxyId: proxy_id || null });
  ok(res, result);
}));

// Scan a folder for kiro-auth-token.json files
app.post('/api/accounts/import-folder', wrap((req, res) => {
  const { folder, proxy_id, recursive } = req.body;
  if (!folder || !folder.trim()) return fail(res, 'folder field required');
  const result = accountsMgr.importFromFolder(folder.trim(), {
    defaultProxyId: proxy_id || null,
    recursive: recursive !== false,
  });
  ok(res, result);
}));

// Auto-capture: read the live kiro-auth-token.json from disk and add it
app.post('/api/accounts/capture', wrap((req, res) => {
  const { label, proxy_id } = req.body || {};
  const result = accountsMgr.captureCurrentToken({
    label:   label || null,
    proxyId: proxy_id || null,
  });
  ok(res, result);
}));

// Preview/parse a pasted token without saving (for the form)
app.post('/api/accounts/preview-token', wrap((req, res) => {
  const { token_json } = req.body || {};
  if (!token_json) return fail(res, 'token_json required');
  const info = accountsMgr.describeToken(token_json);
  ok(res, { info });
}));

// ─── Quota tracking ─────────────────────────────────────────────────────────

// Manually refresh an account's access token via its refresh token
app.post('/api/accounts/:id/refresh-token', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const account = db.getAccountById(id);
  if (!account) return fail(res, 'Account not found', 404);

  const tokens = require('./tokens');
  let tokObj;
  try { tokObj = JSON.parse(account.token_json); } catch { return fail(res, 'Битый token_json'); }

  try {
    const result = await tokens.refreshKiroToken({
      refreshToken: tokObj.refreshToken,
      clientId:     account.client_id || tokObj.clientId || null,
      clientSecret: account.client_secret || null,
      authMethod:   account.auth_method || tokObj.authMethod || null,
      region:       account.region || tokObj.region || 'us-east-1',
    });
    if (!result.accessToken) return fail(res, 'Обновление не вернуло accessToken');

    const newTok = {
      ...tokObj,
      accessToken:  result.accessToken,
      refreshToken: result.refreshToken || tokObj.refreshToken,
      expiresAt:    new Date(Date.now() + (result.expiresIn || 3600) * 1000).toISOString(),
    };
    const extra = {};
    if (result._newClientId)     extra.client_id     = result._newClientId;
    if (result._newClientSecret) extra.client_secret = result._newClientSecret;
    if (result.profileArn)       extra.profile_arn   = result.profileArn;
    db.setAccountToken(id, JSON.stringify(newTok, null, 2), extra);
    db.logEvent(id, 'token_refresh', { ok: true });

    ok(res, { refreshed: true, expiresAt: newTok.expiresAt });
  } catch (e) {
    db.logEvent(id, 'token_refresh', { ok: false, error: e.message });
    fail(res, e.message, 502);
  }
}));

// Fetch live quota for one account from Kiro/CodeWhisperer
app.post('/api/accounts/:id/quota', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const account = db.getAccountById(id);
  if (!account) return fail(res, 'Account not found', 404);

  const result = await quota.fetchQuotaForAccount(account);
  if (result.ok) {
    db.setAccountQuota(id, result.quota, result.profileArn);
    db.logEvent(id, 'quota_check', { plan: result.quota.plan, primary: result.quota.primary });
    return ok(res, { quota: result.quota, profileArn: result.profileArn });
  }

  // mark expired tokens visibly
  if (result.expired) {
    db.logEvent(id, 'quota_check', { error: 'expired' });
  }
  fail(res, result.error || 'Не удалось получить квоту', result.expired ? 401 : 502);
}));

// Refresh quota for ALL accounts (sequential, tolerant of failures)
app.post('/api/quota/refresh-all', wrap(async (req, res) => {
  const accounts = db.getAllAccounts();
  const results = [];
  for (const a of accounts) {
    try {
      const r = await quota.fetchQuotaForAccount(a);
      if (r.ok) {
        db.setAccountQuota(a.id, r.quota, r.profileArn);
        results.push({ id: a.id, ok: true, plan: r.quota.plan, primary: r.quota.primary });
      } else {
        results.push({ id: a.id, ok: false, expired: !!r.expired, error: r.error });
      }
    } catch (e) {
      results.push({ id: a.id, ok: false, error: e.message });
    }
  }
  ok(res, { results });
}));

app.get('/api/accounts/export', (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const data   = accountsMgr.exportAccounts(format);
  const mime   = format === 'csv' ? 'text/csv' : 'application/json';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="kiro-accounts.${format}"`);
  res.send(data);
});

// ─── Stats ────────────────────────────────────────────────────────────────────

app.get('/api/stats/overview', wrap((req, res) => {
  ok(res, db.getOverviewStats());
}));

app.get('/api/stats/timeline', wrap((req, res) => {
  const hours = parseInt(req.query.hours || '24');
  ok(res, { timeline: db.getTimelineStats(hours) });
}));

app.get('/api/stats/account/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  ok(res, db.getAccountStats(id));
}));

app.get('/api/stats/events', wrap((req, res) => {
  const limit = parseInt(req.query.limit || '50');
  ok(res, { events: db.getRecentEvents(limit) });
}));

// ─── Proxies ──────────────────────────────────────────────────────────────────

app.get('/api/proxies', wrap((req, res) => {
  ok(res, { proxies: db.getAllProxies() });
}));

app.post('/api/proxies', wrap((req, res) => {
  const { label, type, host, port, username, password } = req.body;
  if (!host || !port) return fail(res, 'host and port required');
  const id = db.insertProxy({ label: label || '', type: type || 'socks5', host, port, username: username || null, password: password || null });
  ok(res, { id });
}));

// Bulk import proxies from a clipboard paste (auto-detects format, up to 100).
app.post('/api/proxies/import-bulk', wrap((req, res) => {
  const { text, type, assign } = req.body || {};
  if (!text || !text.trim()) return fail(res, 'text field required');
  const { proxies, errors } = proxyMgr.parseProxyBulk(text, { defaultType: type || 'socks5', max: 100 });

  // De-dupe against existing proxies by full identity (host:port:user:pass) so
  // rotating session-proxies sharing host:port are all kept.
  const idOf = p => `${p.type}://${p.username || ''}:${p.password || ''}@${p.host}:${p.port}`;
  const existing = new Set(db.getAllProxies().map(idOf));
  const insertedIds = [];
  let skipped = 0;
  for (const p of proxies) {
    const key = idOf(p);
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    const id = db.insertProxy({
      label: '', type: p.type, host: p.host, port: p.port,
      username: p.username, password: p.password,
    });
    insertedIds.push(id);
  }

  // Optionally auto-assign the new proxies across accounts (round-robin),
  // giving each account a distinct proxy.
  let assigned = 0;
  if (assign && insertedIds.length) {
    const accounts = db.getAllAccounts();
    accounts.forEach((a, i) => {
      const pid = insertedIds[i % insertedIds.length];
      db.updateAccount(a.id, { proxy_id: pid });
      assigned++;
    });
  }

  ok(res, { added: insertedIds.length, skipped, errors: errors.length, assigned });
}));

// Distribute existing proxies across accounts (round-robin, one per account).
app.post('/api/proxies/assign-all', wrap((req, res) => {
  const proxies = db.getAllProxies().filter(p => p.active);
  if (!proxies.length) return fail(res, 'Нет активных прокси для распределения');
  const accounts = db.getAllAccounts();
  let assigned = 0;
  accounts.forEach((a, i) => {
    db.updateAccount(a.id, { proxy_id: proxies[i % proxies.length].id });
    assigned++;
  });
  ok(res, { assigned, proxies: proxies.length });
}));

// Test ALL proxies (in parallel batches, tolerant). Returns per-proxy result.
app.post('/api/proxies/test-all', wrap(async (req, res) => {
  const proxies = db.getAllProxies();
  const results = [];
  const BATCH = 5; // limit concurrency so we don't open hundreds of sockets
  for (let i = 0; i < proxies.length; i += BATCH) {
    const slice = proxies.slice(i, i + BATCH);
    const batch = await Promise.all(slice.map(async (p) => {
      try {
        const r = await proxyMgr.testProxyById(p.id);
        try { db.setProxyTestResult(p.id, r); } catch {}
        return { id: p.id, ok: !!r.ok, ms: r.ms, ip: r.ip, error: r.error };
      } catch (e) {
        try { db.setProxyTestResult(p.id, { ok: false, error: e.message }); } catch {}
        return { id: p.id, ok: false, error: e.message };
      }
    }));
    results.push(...batch);
  }
  ok(res, { results });
}));

app.put('/api/proxies/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  const { label, type, host, port, username, password, active } = req.body;
  db.updateProxy(id, { label, type, host, port, username, password, active });
  ok(res, {});
}));

app.delete('/api/proxies/:id', wrap((req, res) => {
  db.deleteProxy(parseInt(req.params.id));
  ok(res, {});
}));

app.post('/api/proxies/:id/test', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const result = await proxyMgr.testProxyById(id);
  try { db.setProxyTestResult(id, result); } catch {}
  ok(res, result);
}));

// ─── Patches ──────────────────────────────────────────────────────────────────

app.get('/api/patches', wrap((req, res) => {
  ok(res, { patches: patcher.getPatchesStatus() });
}));

app.post('/api/patches/:id/apply', wrap((req, res) => {
  const result = patcher.applyPatch(req.params.id);
  ok(res, result);
}));

app.post('/api/patches/:id/revert', wrap((req, res) => {
  const result = patcher.revertPatch(req.params.id);
  ok(res, result);
}));

// ─── Kiro process ─────────────────────────────────────────────────────────────

app.get('/api/kiro/status', wrap(async (req, res) => {
  const active  = db.getActiveAccount();
  const running = await rotator.isKiroRunningAsync();
  ok(res, {
    running,
    pid:     rotator.getKiroPid(),
    currentAccount: active ? { id: active.id, label: active.label, email: active.email } : null,
  });
}));

app.post('/api/kiro/start', wrap((req, res) => {
  const active = db.getActiveAccount();
  if (!active) return fail(res, 'No active account to use');
  accountsMgr.activateAccount(active.id);
  rotator.spawnKiro(active.id);
  ok(res, { started: true, hidden: true });
}));

app.post('/api/kiro/stop', wrap(async (req, res) => {
  await rotator.killKiro();
  ok(res, {});
}));

app.post('/api/kiro/kill', wrap(async (req, res) => {
  // Hard kill all Kiro processes by image name
  await rotator.killKiro();
  ok(res, { killed: true });
}));

app.post('/api/kiro/restart', wrap(async (req, res) => {
  await rotator.killKiro();
  await new Promise(r => setTimeout(r, 400));
  const active = db.getActiveAccount();
  if (active) {
    accountsMgr.activateAccount(active.id);
    rotator.spawnKiro(active.id);
  }
  ok(res, { pid: rotator.getKiroPid() });
}));

app.post('/api/kiro/rotate', wrap(async (req, res) => {
  const { reason } = req.body;
  await rotator.rotate(reason || 'MANUAL', 'manual');
  ok(res, {});
}));

// ─── Settings ─────────────────────────────────────────────────────────────────

app.get('/api/settings', wrap((req, res) => {
  ok(res, { settings: db.getAllSettings() });
}));

app.put('/api/settings', wrap((req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    db.setSetting(k, v);
  }
  ok(res, {});
}));

// Return the built-in default Claude identity prompt (for the reset button).
app.get('/api/system-prompt/default', wrap((req, res) => {
  ok(res, { prompt: db.DEFAULT_CLAUDE_PROMPT });
}));

// ─── Disposable mailbox (tempmail) ────────────────────────────────────────────

// Create a disposable address. body: { provider?: 'tempmail'|'gmail' }
app.post('/api/mail/address', wrap(async (req, res) => {
  const provider = (req.body && req.body.provider) || 'tempmail';
  const data = await mailbox.createAddress(provider);
  ok(res, { address: data.address, token: data.token, provider: data.provider, expires_at: data.expires_at || null });
}));

// List emails for an address. Requires the address token (query or header).
app.get('/api/mail/:address/emails', wrap(async (req, res) => {
  const token = extractMailToken(req);
  const emails = await mailbox.listEmails(req.params.address, token);
  ok(res, { emails });
}));

// Read one email by id.
app.get('/api/mail/email/:id', wrap(async (req, res) => {
  const token = extractMailToken(req);
  const email = await mailbox.getEmail(req.params.id, token);
  ok(res, { email });
}));

// Wait for a verification code (long-poll). body/query: { from?, subject?, timeoutMs?, pattern? }
app.post('/api/mail/:address/wait-code', wrap(async (req, res) => {
  const token = extractMailToken(req);
  const b = req.body || {};
  const opts = {
    timeoutMs:  Math.min(parseInt(b.timeoutMs || '90000', 10), 180000),
    intervalMs: Math.max(parseInt(b.intervalMs || '3000', 10), 1000),
    from:    b.from || null,
    subject: b.subject || null,
  };
  if (b.pattern) { try { opts.codeRe = new RegExp(b.pattern); } catch { /* keep default */ } }
  try {
    const { code, email } = await mailbox.waitForCode(req.params.address, token, opts);
    ok(res, { code, email: { id: email.id, from: email.from, subject: email.subject } });
  } catch (e) {
    fail(res, e.message, 408);
  }
}));

// Delete an address (and its mail).
app.delete('/api/mail/:address', wrap(async (req, res) => {
  const token = extractMailToken(req);
  await mailbox.deleteAddress(req.params.address, token);
  ok(res, {});
}));

function extractMailToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.query.token || (req.body && req.body.token) || null;
}

// ─── Notion accounts (auto-registration) ──────────────────────────────────────

const notion = require('./notion');

app.get('/api/notion/accounts', wrap((req, res) => {
  const accounts = db.getAllNotionAccounts().map(a => ({
    id: a.id, email: a.email, status: a.status,
    proxy: a.proxy_host ? `${a.proxy_type} ${a.proxy_host}:${a.proxy_port}` : null,
    has_token: !!a.token_v2, created_at: a.created_at, last_used_at: a.last_used_at, notes: a.notes,
    // Live state (populated by the notion_profiles poller).
    ai_credits:        a.ai_credits,
    ai_credits_total:  a.ai_credits_total,
    plan_type:         a.plan_type,
    trial_ends_at:     a.trial_ends_at,
    last_check_at:     a.last_check_at,
    last_check_error:  a.last_check_error,
    is_current:        !!a.is_current,
  }));
  ok(res, { accounts });
}));

// Register a brand-new Notion account via email OTP (proxy + tempmail + browser).
// body: { proxy_id?, provider? }. Long-running — streams progress via SSE channel.
app.post('/api/notion/register', wrap(async (req, res) => {
  const { proxy_id, provider } = req.body || {};
  try {
    const r = await notion.registerAndSave({
      proxyId: proxy_id || null,
      provider: provider || 'tempmail',
      onStatus: (stage, detail) => { rotator.broadcast('notion_progress', { stage, detail }); },
    });
    rotator.broadcast('notion_registered', { id: r.id, email: r.email });
    ok(res, r);
  } catch (e) {
    rotator.broadcast('notion_error', { error: e.message });
    fail(res, e.message, 502);
  }
}));

app.delete('/api/notion/accounts/:id', wrap((req, res) => {
  db.deleteNotionAccount(parseInt(req.params.id));
  ok(res, {});
}));

// Export a Notion account's token_v2 (for use elsewhere).
app.get('/api/notion/accounts/:id/token', wrap((req, res) => {
  const a = db.getNotionAccountById(parseInt(req.params.id));
  if (!a) return fail(res, 'not found', 404);
  ok(res, { email: a.email, token_v2: a.token_v2 });
}));

// ─── Notion batch auto-registration ────────────────────────────────────────────
// In-memory job tracker so the UI can reconnect (via SSE or GET /api/notion/job)
// and see live progress. Only one batch runs at a time.
let notionJob = {
  running: false, total: 0, done: 0, ok: 0, failed: 0,
  current: 0, stage: null, email: null, cancel: false,
  startedAt: null, finishedAt: null, lastError: null,
};

// Public view of the job (hide the internal cancel flag).
function notionJobSnapshot() {
  const { cancel, ...pub } = notionJob;
  return pub;
}
function emitNotionJob() { rotator.broadcast('notion_job', notionJobSnapshot()); }

// Current job state — for initial page load / polling fallback.
app.get('/api/notion/job', wrap((req, res) => {
  ok(res, { job: notionJobSnapshot() });
}));

// Start a batch of N registrations. Runs sequentially in the background and
// streams progress over SSE; responds immediately so the request never blocks
// for the (potentially many-minute) duration.
app.post('/api/notion/register-batch', wrap((req, res) => {
  if (notionJob.running) return fail(res, 'Регистрация уже идёт', 409);

  const count    = Math.max(1, Math.min(parseInt((req.body && req.body.count) || '1', 10) || 1, 100));
  const proxyId  = (req.body && req.body.proxy_id) || null;
  const provider = (req.body && req.body.provider) || 'tempmail';

  notionJob = {
    running: true, total: count, done: 0, ok: 0, failed: 0,
    current: 0, stage: 'starting', email: null, cancel: false,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  };
  emitNotionJob();

  (async () => {
    for (let i = 0; i < count; i++) {
      if (notionJob.cancel) break;
      notionJob.current = i + 1;
      notionJob.stage   = 'registering';
      notionJob.email   = null;
      emitNotionJob();
      try {
        const r = await notion.registerAndSave({
          proxyId:  proxyId || null,
          provider,
          onStatus: (stage, detail) => {
            notionJob.stage = stage;
            if (detail && detail.email) notionJob.email = detail.email;
            rotator.broadcast('notion_progress', { index: i + 1, stage, detail });
          },
        });
        notionJob.ok++;
        notionJob.email = r.email;
        rotator.broadcast('notion_registered', { id: r.id, email: r.email, index: i + 1 });
      } catch (e) {
        notionJob.failed++;
        notionJob.lastError = e.message;
        rotator.broadcast('notion_error', { error: e.message, index: i + 1 });
      }
      notionJob.done++;
      emitNotionJob();
    }
    notionJob.running    = false;
    notionJob.stage      = notionJob.cancel ? 'cancelled' : 'done';
    notionJob.finishedAt = new Date().toISOString();
    emitNotionJob();
    rotator.broadcast('notion_job_done', notionJobSnapshot());
  })().catch((e) => {
    notionJob.running    = false;
    notionJob.stage      = 'error';
    notionJob.lastError  = e.message;
    notionJob.finishedAt = new Date().toISOString();
    emitNotionJob();
    rotator.broadcast('notion_job_done', notionJobSnapshot());
  });

  ok(res, { started: true, count });
}));

// Request cancellation — the loop stops after the current account finishes.
app.post('/api/notion/stop-batch', wrap((req, res) => {
  if (!notionJob.running) return ok(res, { stopped: false });
  notionJob.cancel = true;
  notionJob.stage  = 'cancelling';
  emitNotionJob();
  ok(res, { stopped: true });
}));

// ─── Notion: account management (use / poll / swap / open visible) ───────────

// Make this account the "current" one. If a visible browser is open, hot-swap
// the cookies in-place so the user stays on the same tab.
app.post('/api/notion/accounts/:id/use', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const acc = db.getNotionAccountById(id);
  if (!acc) return fail(res, 'not found', 404);
  db.setNotionCurrent(id);
  rotator.broadcast('np_swap', { reason: 'manual', to: id, email: acc.email });
  try { await notionProfiles.switchVisibleTo(id); } catch { /* no visible window — fine */ }
  ok(res, { id });
}));

// Re-poll one account on demand.
app.post('/api/notion/accounts/:id/poll', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  const updated = await notionProfiles.pollAccount(id);
  ok(res, { account: updated });
}));

// Re-poll EVERY account, then run the auto-swap rule once.
app.post('/api/notion/poll-all', wrap(async (req, res) => {
  await notionProfiles.pollAll();
  ok(res, {});
}));

// Force a swap to the next-best account, even if the current one isn't low.
app.post('/api/notion/swap', wrap(async (req, res) => {
  const next = await notionProfiles.swap('manual');
  if (!next) return fail(res, 'Нет другого активного аккаунта для свапа', 409);
  ok(res, { id: next.id, email: next.email });
}));

// Open a visible Notion window using the current account (or a specified id).
// Returns immediately — the window opens in the background; SSE will emit
// np_visible_open / np_visible_swapped / np_visible_closed.
app.post('/api/notion/open', wrap(async (req, res) => {
  const id = req.body && req.body.id ? parseInt(req.body.id) : null;
  const r = await notionProfiles.openVisible(id);
  ok(res, r);
}));

app.post('/api/notion/close', wrap(async (req, res) => {
  await notionProfiles.closeVisible();
  ok(res, {});
}));

// ─── API keys (for the OpenAI/Anthropic gateway) ──────────────────────────────

const crypto = require('crypto');

app.get('/api/keys', wrap((req, res) => {
  // Mask the key for listing; only show a prefix + suffix.
  const keys = db.getAllApiKeys().map(k => ({
    id: k.id,
    label: k.label,
    active: k.active,
    request_count: k.request_count,
    last_used_at: k.last_used_at,
    created_at: k.created_at,
    key_masked: k.key.length > 12 ? `${k.key.slice(0, 8)}…${k.key.slice(-4)}` : k.key,
  }));
  ok(res, { keys });
}));

app.post('/api/keys', wrap((req, res) => {
  const { label } = req.body || {};
  // Generate an sk-style key. Returned in FULL exactly once here.
  const key = 'sk-kiro-' + crypto.randomBytes(24).toString('hex');
  const id = db.insertApiKey(label || null, key);
  ok(res, { id, key });
}));

app.put('/api/keys/:id', wrap((req, res) => {
  const id = parseInt(req.params.id);
  if (req.body && req.body.active !== undefined) db.setApiKeyActive(id, !!req.body.active);
  ok(res, {});
}));

app.delete('/api/keys/:id', wrap((req, res) => {
  db.deleteApiKey(parseInt(req.params.id));
  ok(res, {});
}));

// ─── SSE event stream ─────────────────────────────────────────────────────────

app.get('/api/events/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial state
  const overview = db.getOverviewStats();
  res.write(`event: init\ndata: ${JSON.stringify(overview)}\n\n`);

  rotator.registerSseClient(res);

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 15_000);

  req.on('close', () => clearInterval(heartbeat));
});

// ─── Start ────────────────────────────────────────────────────────────────────

(async () => {
  await db.initDb();

  const PORT = parseInt(db.getSetting('server_port') || '7842', 10);
  const HOST = db.getSetting('server_host') || '127.0.0.1';
  const isPublic = HOST === '0.0.0.0' || (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1');
  const authOn = db.getSetting('api_auth_enabled') === '1';

  rotator.init();

  // Forward Notion-profile events to the existing SSE channel so the dashboard
  // updates in real time without a second connection.
  notionProfiles.onEvent((evt, data) => rotator.broadcast(evt, data));
  notionProfiles.start();

  app.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : HOST;
    console.log(`Kiro Manager running at http://${shownHost}:${PORT}`);
    console.log(`  OpenAI base URL:    http://${HOST}:${PORT}/v1`);
    console.log(`  Anthropic base URL: http://${HOST}:${PORT}`);

    if (isPublic && !authOn) {
      console.warn('  ⚠  SECURITY: bound to a non-localhost address with API auth DISABLED.');
      console.warn('     Anyone who can reach this port can use your Kiro accounts.');
      console.warn('     Enable API auth and create a key in Settings → API & Hosting.');
    }

    // Open the dashboard in a browser only for local binds.
    if (!isPublic) {
      const { exec } = require('child_process');
      exec(`start http://127.0.0.1:${PORT}`);
    }
  });
})().catch((e) => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});

process.on('SIGINT',  () => { rotator.shutdownAndKill(); process.exit(0); });
process.on('SIGTERM', () => { rotator.shutdownAndKill(); process.exit(0); });
