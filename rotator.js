'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { spawn, exec } = require('child_process');
const chokidar = require('chokidar');
const {
  getSetting, getActiveAccount, getNextAccount, getAccountById,
  markExhausted, logEvent, resetExhaustedAccounts, setAccountQuota,
} = require('./db');
const { activateAccount, getCurrentActiveAccountId } = require('./accounts');
const { buildProxyEnv }   = require('./proxy');

// Kiro writes its real logs under %APPDATA%\Kiro\logs\<session>\... (deeply
// nested, session folder changes every launch). The old ~/.kiro/logs path is
// effectively empty, which is why auto-rotation never fired. We watch every
// known log root recursively and filter *.log files in the handler.
const KIRO_LOG_DIRS = [];
if (process.env.APPDATA) KIRO_LOG_DIRS.push(path.join(process.env.APPDATA, 'Kiro', 'logs'));
if (process.env.LOCALAPPDATA) KIRO_LOG_DIRS.push(path.join(process.env.LOCALAPPDATA, 'Kiro', 'logs'));
KIRO_LOG_DIRS.push(path.join(os.homedir(), '.kiro', 'logs')); // legacy / fallback
const KIRO_TOKEN_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache');

// ─── State ────────────────────────────────────────────────────────────────────

let kiroProcess   = null;
let logWatcher    = null;
let tokenWatcher  = null;
let autoResetTimer = null;
let quotaTimer    = null;
let rotating      = false;
let sseClients    = []; // SSE connections from server.js

const LIMIT_PATTERNS = [
  { re: /HOURLY_REQUEST_COUNT/,            type: 'HOURLY_REQUEST_COUNT' },
  { re: /DAILY_REQUEST_COUNT/,             type: 'DAILY_REQUEST_COUNT' },
  { re: /MONTHLY_REQUEST_COUNT/,           type: 'MONTHLY_REQUEST_COUNT' },
  { re: /USAGE_LIMIT_REACHED/,             type: 'USAGE_LIMIT_REACHED' },
  { re: /OVERAGE_REQUEST_LIMIT_EXCEEDED/,  type: 'OVERAGE_REQUEST_LIMIT_EXCEEDED' },
  { re: /ServiceQuotaExceededException/,   type: 'DAILY_REQUEST_COUNT' },
  { re: /ThrottlingException.*HOURLY/i,    type: 'HOURLY_REQUEST_COUNT' },
  { re: /ThrottlingException/,             type: 'THROTTLE' },
  { re: /temporarilySuspended/,            type: 'SUSPENDED' },
];

// ─── SSE broadcast ────────────────────────────────────────────────────────────

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; }
    catch { return false; }
  });
}

function registerSseClient(res) {
  sseClients.push(res);
}

// ─── Kiro process management ──────────────────────────────────────────────────

function getKiroExe() {
  return getSetting('kiro_exe') ||
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Kiro', 'Kiro.exe');
}

function getKiroImageName() {
  // Image name for taskkill /IM — e.g. "Kiro.exe"
  return path.basename(getKiroExe());
}

// Check real Kiro state by image name (we no longer own the PID, since the
// user may launch Kiro manually). Returns a Promise<boolean>.
function isKiroRunningAsync() {
  const image = getKiroImageName();
  return new Promise((resolve) => {
    exec(`tasklist /FI "IMAGENAME eq ${image}" /NH`, (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.toLowerCase().includes(image.toLowerCase()));
    });
  });
}

// Synchronous best-effort (tracked spawn only) — kept for callers that
// can't await. Prefer isKiroRunningAsync for accuracy.
function isKiroRunning() {
  return kiroProcess !== null && !kiroProcess.killed;
}

function getKiroPid() {
  return kiroProcess ? kiroProcess.pid : null;
}

// Kill ALL Kiro processes by image name — not just the one we spawned.
// The user may have launched Kiro manually, so we can't rely on our own PID.
async function killKiro() {
  const image = getKiroImageName();

  // Drop any tracked process reference/listeners first
  if (kiroProcess) {
    try { kiroProcess.removeAllListeners(); } catch { /* ignore */ }
    kiroProcess = null;
  }

  return new Promise((resolve) => {
    // /T kills child processes too (Electron spawns several helpers)
    exec(`taskkill /F /IM "${image}" /T`, (err, stdout, stderr) => {
      // exit code 128 = "process not found" — fine, nothing to kill
      broadcast('kiro_killed', { image, ok: !err });
      resolve();
    });
  });
}

function spawnKiro(accountId) {
  const exe = getKiroExe();
  if (!fs.existsSync(exe)) {
    broadcast('error', { message: `Kiro executable not found: ${exe}` });
    return null;
  }

  // Build env with proxy if account has one
  let proxyEnv = {};
  if (accountId) {
    const { getAccountById } = require('./db');
    const acc = getAccountById(accountId);
    if (acc && acc.proxy_id) {
      proxyEnv = buildProxyEnv(acc.proxy_id);
    }
  }

  // Launch Kiro HIDDEN via PowerShell Start-Process -WindowStyle Hidden.
  // Electron has no real headless mode, so we hide the window instead.
  // We spawn powershell as the child so env (proxy) is inherited.
  const psCmd =
    `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -WindowStyle Hidden`;

  kiroProcess = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    {
      detached: false,
      stdio:    'ignore',
      windowsHide: true,
      env:      { ...process.env, ...proxyEnv },
    }
  );

  kiroProcess.on('exit', (code) => {
    // Note: this is the powershell launcher exiting, not Kiro itself.
    // Kiro keeps running detached. We null our ref since we track by image now.
    broadcast('kiro_spawned', { code });
  });

  kiroProcess.on('error', (err) => {
    broadcast('error', { message: `Kiro spawn error: ${err.message}` });
  });

  broadcast('kiro_start', { hidden: true });
  return kiroProcess;
}

// ─── Rotation logic ───────────────────────────────────────────────────────────

async function rotate(reason, triggeredBy = 'auto') {
  if (rotating) return; // prevent concurrent rotations
  rotating = true;

  try {
    // Determine the CURRENT account from what is actually written to disk
    // (the token file), not just "highest-priority active". After a manual
    // "Use" the on-disk account may differ from the priority winner — using
    // the disk identity ensures we exhaust the right one.
    let current = null;
    try {
      const diskId = getCurrentActiveAccountId();
      if (diskId) current = getAccountById(diskId);
    } catch { /* fall back below */ }
    if (!current) current = getActiveAccount();

    const next = getNextAccount(current ? current.id : null);

    // If there is nowhere to switch, do NOT exhaust the current account —
    // disabling your only working account is worse than staying put. Just warn.
    if (!next) {
      if (current) logEvent(current.id, 'limit_hit', { reason, triggeredBy, note: 'no_alternative' });
      broadcast('no_accounts', { message: 'Лимит сработал, но нет другого активного аккаунта для переключения.' });
      return;
    }

    if (current) {
      markExhausted(current.id, reason);
      logEvent(current.id, 'limit_hit', { reason, triggeredBy });
      broadcast('limit_hit', { accountId: current.id, reason });
    }

    const mode = getSetting('switch_mode') || 'hot';

    if (mode === 'restart') {
      await killKiro();
      activateAccount(next.id);
      await sleep(500);
      spawnKiro(next.id);
    } else {
      // Hot swap — just replace the file, Kiro's watchFile will pick it up
      activateAccount(next.id);
    }

    logEvent(next.id, 'switch', { from: current ? current.id : null, reason, mode });
    broadcast('switch', {
      from:   current ? { id: current.id, label: current.label } : null,
      to:     { id: next.id, label: next.label },
      reason,
      mode,
    });
  } finally {
    rotating = false;
  }
}

// ─── Log watcher ─────────────────────────────────────────────────────────────

function startLogWatcher() {
  if (logWatcher) return;

  // Watch every known Kiro log root recursively. Kiro's logs live in
  // session-stamped subfolders that change each launch, so we cannot target a
  // fixed glob — we watch the roots and filter *.log in the change handler.
  const roots = KIRO_LOG_DIRS.filter(Boolean);
  for (const d of roots) {
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  }

  // Track file positions to only read new content
  const positions = {};

  logWatcher = chokidar.watch(roots, {
    persistent:    true,
    usePolling:    true,   // Electron log writes are often missed by fs events
    interval:      1500,
    ignoreInitial: true,
    depth:         8,      // session/window/exthost/<ext>/file.log
  });

  const onTouch = (filePath) => {
    if (!filePath.toLowerCase().endsWith('.log')) return;
    try {
      const stat = fs.statSync(filePath);
      let pos = positions[filePath] || 0;
      // File rotated/truncated — restart from 0
      if (stat.size < pos) pos = 0;
      if (stat.size <= pos) { positions[filePath] = stat.size; return; }

      const buf  = Buffer.alloc(stat.size - pos);
      const fd   = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      positions[filePath] = stat.size;

      checkLogChunk(buf.toString('utf8'));
    } catch { /* ignore read errors */ }
  };

  logWatcher.on('change', onTouch);
  logWatcher.on('add', (filePath) => {
    // Start new files at their current end so we only react to NEW limit
    // errors, not historical ones from previous sessions.
    try { positions[filePath] = fs.statSync(filePath).size; } catch { positions[filePath] = 0; }
  });
}

function checkLogChunk(chunk) {
  if (getSetting('rotation_enabled') !== '1') return;

  // Only inspect lines that look like genuine error output, not informational
  // log lines that merely mention a limit keyword (e.g. a terminal command
  // echo containing "USAGE_LIMIT_REACHED" as text). This avoids false
  // rotations triggered by the manager's own activity appearing in Kiro logs.
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const looksLikeError = /\b(error|exception|failed|throttl|quota|limit reached|statusCode\s*[:=]\s*4\d\d)\b/i.test(line);
    if (!looksLikeError) continue;
    // Skip our own terminal-command echoes that Kiro logs verbatim.
    if (/\[Terminal\]|Executing command|commandLine/i.test(line)) continue;

    for (const { re, type } of LIMIT_PATTERNS) {
      if (re.test(line)) {
        rotate(type, 'log_watcher');
        return; // one rotation per chunk
      }
    }
  }
}

// ─── Token watcher ────────────────────────────────────────────────────────────

function startTokenWatcher() {
  if (tokenWatcher) return;

  tokenWatcher = chokidar.watch(path.join(KIRO_TOKEN_DIR, 'kiro-auth-token.json'), {
    persistent:    true,
    usePolling:    false,
    ignoreInitial: true,
  });

  tokenWatcher.on('change', () => {
    broadcast('token_changed', { ts: new Date().toISOString() });
  });
}

// ─── Auto-reset exhausted accounts (every 60s) ───────────────────────────────

function startAutoReset() {
  if (autoResetTimer) return;
  autoResetTimer = setInterval(() => {
    const n = resetExhaustedAccounts();
    if (n > 0) {
      broadcast('accounts_reset', { count: n });
    }
  }, 60_000);
}

// ─── Proactive quota monitor ─────────────────────────────────────────────────
//
// The most reliable swap trigger. GetUsageLimits returns metadata only and
// does NOT consume credits, so we can poll it safely. Every interval we check
// the quota of the account currently written to disk; if its primary bucket is
// depleted (remaining <= 0) we rotate to the next account proactively — before
// Kiro even hits the wall.
const QUOTA_POLL_MS = 120_000; // 2 minutes

async function checkActiveQuota() {
  if (getSetting('rotation_enabled') !== '1') return;

  // Resolve the account that is actually live on disk.
  let account = null;
  try {
    const diskId = getCurrentActiveAccountId();
    if (diskId) account = getAccountById(diskId);
  } catch { /* ignore */ }
  if (!account) account = getActiveAccount();
  if (!account) return;

  let quota;
  try {
    const quotaMod = require('./quota');
    const r = await quotaMod.fetchQuotaForAccount(account);
    if (!r.ok) {
      // Expired token after failed auto-refresh → treat as exhausted and move on.
      if (r.expired) rotate('TOKEN_EXPIRED', 'quota_monitor');
      return;
    }
    quota = r.quota;
    setAccountQuota(account.id, r.quota, r.profileArn);
    broadcast('quota_updated', { accountId: account.id, plan: r.quota.plan });
  } catch { return; }

  const p = quota && quota.primary;
  if (p && !p.unlimited && p.total > 0 && p.remaining <= 0) {
    logEvent(account.id, 'quota_depleted', { plan: quota.plan, used: p.used, total: p.total });
    rotate('QUOTA_DEPLETED', 'quota_monitor');
  }
}

function startQuotaMonitor() {
  if (quotaTimer) return;
  quotaTimer = setInterval(() => { checkActiveQuota().catch(() => {}); }, QUOTA_POLL_MS);
  // Run one check shortly after startup too (don't block init).
  setTimeout(() => { checkActiveQuota().catch(() => {}); }, 8000);
}

// ─── Init / teardown ─────────────────────────────────────────────────────────

function init() {
  startLogWatcher();
  startTokenWatcher();
  startAutoReset();
  startQuotaMonitor();

  if (getSetting('auto_start_kiro') === '1') {
    const active = getActiveAccount();
    if (active) {
      activateAccount(active.id);
      spawnKiro(active.id);
    }
  }
}

function shutdown() {
  if (logWatcher)   { logWatcher.close();   logWatcher   = null; }
  if (tokenWatcher) { tokenWatcher.close();  tokenWatcher = null; }
  if (autoResetTimer) { clearInterval(autoResetTimer); autoResetTimer = null; }
  if (quotaTimer)   { clearInterval(quotaTimer); quotaTimer = null; }
}

// Kill Kiro on manager shutdown (fire-and-forget, synchronous taskkill).
function shutdownAndKill() {
  shutdown();
  try {
    require('child_process').execSync(`taskkill /F /IM "${getKiroImageName()}" /T`, { stdio: 'ignore' });
  } catch { /* not running — fine */ }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  init, shutdown, shutdownAndKill,
  isKiroRunning, isKiroRunningAsync, getKiroPid,
  killKiro, spawnKiro,
  rotate,
  registerSseClient,
  broadcast,
};
