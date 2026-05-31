'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// notion_profiles.js — Notion account manager.
//
// Responsibilities:
//   • Persist a full Playwright `storageState` per Notion account on disk
//     (data/notion-profiles/<id>.json). This survives token_v2 rotations and
//     gives us a clean room to refresh credentials without touching the
//     dashboard's process.
//   • Periodically poll each account in a headless browser to read its live
//     AI-credit balance, plan and trial expiry, then write back to the DB.
//   • Auto-swap the "current" account when its remaining credits drop to or
//     below `notion_credit_threshold` (default 10). Picks the active account
//     with the most remaining credits as the next current.
//   • Expose a tiny API to (a) launch a visible Notion window using the
//     current account's profile, (b) request an immediate poll/swap.
//
// Notion's plan/usage data is not formally documented; we read it from the
// internal /api/v3/getSpaces (always available) plus a best-effort scrape of
// /settings/plans for the AI-credit number. Both code paths log a structured
// snapshot on failure so the operator can adjust the parser when Notion
// shuffles the UI.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const db = require('./db');

const PROFILE_DIR = path.join(__dirname, 'data', 'notion-profiles');
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

// Module state ----------------------------------------------------------------

let pollTimer    = null;       // setInterval handle for the poller loop
let pollBusy     = false;      // re-entrancy guard
let visibleHandle = null;      // { browser, context, page, accountId }
let listeners    = new Set();  // SSE-like listeners (cb(event, data))

function broadcast(event, data) {
  for (const cb of listeners) {
    try { cb(event, data); } catch { /* listener errors don't break peers */ }
  }
}

function onEvent(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Storage state ---------------------------------------------------------------

function profilePathFor(id) {
  return path.join(PROFILE_DIR, `${id}.json`);
}

// Build a Playwright storageState object from the cookies_json column we
// captured during registration. We don't have localStorage from that path, so
// the first poll will populate and rewrite the profile fully.
function bootstrapStorageStateFromCookies(account) {
  let cookies = [];
  try { cookies = JSON.parse(account.cookies_json || '[]'); } catch {}
  return {
    cookies: cookies.map(c => ({
      name:    c.name,
      value:   c.value,
      domain:  c.domain,
      path:    c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure:   !!c.secure,
      sameSite: c.sameSite || 'Lax',
    })),
    origins: [],
  };
}

// Load a Notion account's profile state, creating it on first use from the
// registration cookies. Returns the absolute file path.
function ensureProfile(account) {
  const p = profilePathFor(account.id);
  if (!fs.existsSync(p)) {
    const state = bootstrapStorageStateFromCookies(account);
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  }
  if (account.profile_path !== p) {
    db.setNotionAccountLive(account.id, { profile_path: p });
  }
  return p;
}

function readProfile(account) {
  const p = ensureProfile(account);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeProfile(account, state) {
  const p = profilePathFor(account.id);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  if (account.profile_path !== p) {
    db.setNotionAccountLive(account.id, { profile_path: p });
  }
}

// Browser helpers -------------------------------------------------------------

function resolveChannel() {
  const candidates = [
    { channel: 'msedge', probe: [
      `${process.env['ProgramFiles(x86)'] || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ]},
    { channel: 'chrome', probe: [
      `${process.env.ProgramFiles || ''}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['ProgramFiles(x86)'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    ]},
  ];
  for (const c of candidates) if (c.probe.some(p => p && fs.existsSync(p))) return c.channel;
  return null;
}

// Build the launch options once — proxy is read fresh each call so a row
// update in the dashboard takes effect on the next poll.
function buildLaunchOpts({ account, headless }) {
  const opts = { headless: headless !== false, args: ['--disable-blink-features=AutomationControlled'] };
  const ch = resolveChannel();
  if (ch) opts.channel = ch;
  if (account && account.proxy_id) {
    const p = db.getProxyById(account.proxy_id);
    if (p) {
      const scheme = (p.type || 'http').replace('socks5h', 'socks5');
      opts.proxy = { server: `${scheme}://${p.host}:${p.port}` };
      if (p.username) { opts.proxy.username = p.username; opts.proxy.password = p.password || ''; }
    }
  }
  return opts;
}

async function withProfile(account, headless, cb) {
  const launchOpts = buildLaunchOpts({ account, headless });
  const browser = await chromium.launch(launchOpts);
  let result;
  try {
    const context = await browser.newContext({
      storageState: ensureProfile(account),
      locale: 'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    result = await cb(context);
    // Always persist the latest cookies/localStorage — Notion rotates token_v2
    // periodically and sets new origin storage on /settings.
    try {
      const fresh = await context.storageState();
      writeProfile(account, fresh);
    } catch { /* persistence is best-effort */ }
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
}

// Live data fetch -------------------------------------------------------------

// Pull AI-credit / plan / trial info for a single account. Returns:
//   { ok, ai_credits, ai_credits_total, plan_type, trial_ends_at, user_id,
//     space_id, status, error }
// `status` is set to 'expired' when the session is no longer valid.
//
// Implementation note: we hit Notion's INTERNAL JSON APIs directly instead of
// scraping the settings UI. The earlier DOM-scrape approach was fragile (every
// Notion redesign broke our regex) and slow (5–10s per account). The /api/v3
// endpoints below were captured live from the official web app and are stable
// enough that the dashboard itself relies on them on every page load:
//
//   • getSpaces                  — session liveness + user_id + space_id
//   • getAIUsageEligibilityV2    — REMAINING + TOTAL Notion-AI credits
//   • getSubscriptionData        — plan tier + trial expiry date
//
// One headless browser per poll, three POSTs, ~1s total.
async function fetchAccountState(account) {
  return withProfile(account, true, async (context) => {
    const page = await context.newPage();

    const post = async (name, body = {}) => {
      try {
        const r = await page.request.post(`https://www.notion.so/api/v3/${name}`, {
          data: body,
          headers: { 'content-type': 'application/json' },
        });
        return { status: r.status(), json: r.ok() ? await r.json().catch(() => null) : null };
      } catch (e) {
        return { status: 0, error: e.message };
      }
    };

    // 1) Session liveness + identity
    const spaces = await post('getSpaces');
    if (spaces.status === 401 || spaces.status === 403) {
      return { ok: false, error: 'session_invalid', status: 'expired' };
    }
    if (spaces.status !== 200 || !spaces.json) {
      return { ok: false, error: `getSpaces ${spaces.status || 'network'}` };
    }

    let userId = null, spaceId = null;
    try {
      const root = Object.values(spaces.json)[0] || {};
      const u = root.notion_user && Object.values(root.notion_user)[0];
      if (u && u.value && u.value.value) userId = u.value.value.id || null;
      const sp = root.space && Object.values(root.space)[0];
      if (sp && sp.value && sp.value.value) spaceId = sp.value.value.id || null;
      // Some new accounts have multiple spaces — grab the first space_view
      // from user_root if the top-level `space` slot is empty.
      if (!spaceId && root.user_root) {
        const ur = Object.values(root.user_root)[0];
        const sv = ur && ur.value && ur.value.value && ur.value.value.space_views;
        if (Array.isArray(sv) && sv.length) {
          // space_views are SPACE_VIEW UUIDs, not space UUIDs — try getSpaces
          // again with the user's spaceId from `space` collection if any.
        }
      }
    } catch { /* tolerate shape changes */ }

    // Without a spaceId we can't query the AI/subscription endpoints — they
    // require it as a body parameter. Bail with what we have so the manager
    // at least knows the session is alive.
    if (!spaceId) {
      return {
        ok: true,
        ai_credits: null, ai_credits_total: null,
        plan_type: null, trial_ends_at: null,
        user_id: userId, space_id: null,
        status: 'active',
        error: 'no_space',
      };
    }

    // 2) AI credits (the whole point of this feature). The API has two
    //    independent buckets:
    //      • purchased — credits paid for or trial-granted (Business trial=200)
    //      • free      — basic free-tier AI allowance (≈75 messages on Free)
    //    For monitoring we always prefer `purchased` (that's the trial bucket
    //    that actually expires); if it's zero we fall back to the free bucket
    //    so the dashboard can show meaningful "75 left" on free accounts too.
    let credits = null, creditsTotal = null;
    const usage = await post('getAIUsageEligibilityV2', { spaceId });
    if (usage.status === 200 && usage.json) {
      const j = usage.json;
      const limits = j.limits || {};
      const purchasedTotal = Number(limits.purchased && limits.purchased.totalLimit);
      const purchasedRem   = Number(j.totalCreditBalance);

      if (Number.isFinite(purchasedTotal) && purchasedTotal > 0) {
        credits      = Number.isFinite(purchasedRem) ? purchasedRem : purchasedTotal;
        creditsTotal = purchasedTotal;
      } else {
        // Free-tier fallback. spaceUsage = how many free AI calls already
        // used; spaceLimit = total monthly free allowance.
        const freeTotal = Number(limits.free && limits.free.spaceLimit);
        const freeUsed  = Number(j.usage && j.usage.currentServicePeriod && j.usage.currentServicePeriod.spaceUsage);
        if (Number.isFinite(freeTotal) && freeTotal > 0) {
          creditsTotal = freeTotal;
          credits      = Math.max(0, freeTotal - (Number.isFinite(freeUsed) ? freeUsed : 0));
        } else {
          credits = 0; creditsTotal = 0;
        }
      }
    }

    // 3) Plan + trial expiry. getSubscriptionData includes the trial end date
    //    (when a trial is active) and several plan fields. We prefer
    //    `subscriptionTier` (free|business|enterprise) over the operational
    //    `type` (unsubscribed_admin|admin|member) which doesn't tell the
    //    operator what plan the workspace is actually on.
    let planType = null, trialEnds = null;
    const sub = await post('getSubscriptionData', { spaceId });
    if (sub.status === 200 && sub.json) {
      const j = sub.json;
      planType = j.subscriptionTier || j.type || null;
      // Trial end can live under several shapes depending on subscription
      // backend (Stripe vs RevenueCat). Check the common ones.
      const trialFields = [
        j.trialEndDate, j.trial_end_date,
        j.customerData && j.customerData.stripe && j.customerData.stripe.trialEndDate,
        j.subscription && j.subscription.trialEndDate,
      ].filter(Boolean);
      if (trialFields.length) {
        const t = trialFields[0];
        const ms = typeof t === 'number' ? (t > 1e12 ? t : t * 1000) : Date.parse(t);
        if (Number.isFinite(ms)) trialEnds = new Date(ms).toISOString();
      }
    }

    return {
      ok: true,
      ai_credits:        credits,
      ai_credits_total:  creditsTotal,
      plan_type:         planType,
      trial_ends_at:     trialEnds,
      user_id:           userId,
      space_id:          spaceId,
      status:            'active',
    };
  });
}

// Poll one account, persist results, return the updated row.
async function pollAccount(accountId) {
  const acc = db.getNotionAccountById(accountId);
  if (!acc) throw new Error('account not found');
  broadcast('np_poll_start', { id: accountId, email: acc.email });
  let info;
  try {
    info = await fetchAccountState(acc);
  } catch (e) {
    info = { ok: false, error: e.message };
  }
  // Map the result to a DB-friendly object. status is only changed on a
  // confident verdict — never overwrite 'active' just because a single poll
  // network-failed.
  const update = { error: info.error || null };
  if (info.ok) {
    Object.assign(update, {
      ai_credits:       info.ai_credits ?? null,
      ai_credits_total: info.ai_credits_total ?? null,
      plan_type:        info.plan_type ?? null,
      trial_ends_at:    info.trial_ends_at ?? null,
      user_id:          info.user_id ?? null,
      space_id:         info.space_id ?? null,
      status:           'active',
    });
  } else if (info.status === 'expired') {
    update.status = 'expired';
  }
  db.setNotionAccountLive(accountId, update);
  broadcast('np_poll_done', { id: accountId, ok: !!info.ok, info: update });
  return db.getNotionAccountById(accountId);
}

// Auto-swap -------------------------------------------------------------------

function readAutoSettings() {
  return {
    enabled:   db.getSetting('notion_auto_swap_enabled') !== '0',
    threshold: parseInt(db.getSetting('notion_credit_threshold') || '10', 10),
    intervalMin: Math.max(1, parseInt(db.getSetting('notion_poll_interval_min') || '15', 10)),
  };
}

// Swap to the best alternative account. Optional `reason` for the audit log.
// Returns the new current account row, or null if there was no alternative.
async function swap(reason = 'manual') {
  const cur = db.getCurrentNotionAccount();
  const next = db.pickBestNotionAccount(cur ? cur.id : null);
  if (!next) {
    broadcast('np_swap_failed', { reason: 'no_candidate', from: cur && cur.id });
    return null;
  }
  db.setNotionCurrent(next.id);
  broadcast('np_swap', { reason, from: cur && cur.id, to: next.id, email: next.email });
  // If we have a visible browser open, reload it with the new profile.
  if (visibleHandle) {
    try { await switchVisibleTo(next.id); } catch (e) { broadcast('np_visible_error', { error: e.message }); }
  }
  return next;
}

// Decide whether the current account should be swapped right now.
async function maybeAutoSwap() {
  const s = readAutoSettings();
  if (!s.enabled) return;
  const cur = db.getCurrentNotionAccount();
  if (!cur) {
    // Bootstrap: pick something so the dashboard always has a current account.
    const next = db.pickBestNotionAccount(-1);
    if (next) { db.setNotionCurrent(next.id); broadcast('np_swap', { reason: 'bootstrap', to: next.id, email: next.email }); }
    return;
  }
  if (cur.status !== 'active') {
    await swap('current_inactive');
    return;
  }
  if (cur.ai_credits != null && cur.ai_credits <= s.threshold) {
    await swap(`credits_low(${cur.ai_credits})`);
  }
}

// Poller loop -----------------------------------------------------------------

async function pollAll() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const accounts = db.getAllNotionAccounts().filter(a => a.status !== 'deleted');
    for (const a of accounts) {
      // Skip permanently expired ones unless the operator manually re-enables.
      if (a.status === 'expired') continue;
      try { await pollAccount(a.id); }
      catch (e) { broadcast('np_poll_error', { id: a.id, error: e.message }); }
    }
    await maybeAutoSwap();
  } finally {
    pollBusy = false;
  }
}

function start() {
  if (pollTimer) return;
  const s = readAutoSettings();
  // Run a poll shortly after start so the UI has fresh data quickly,
  // then on the configured cadence.
  setTimeout(() => { pollAll().catch(() => {}); }, 5_000);
  pollTimer = setInterval(() => { pollAll().catch(() => {}); }, s.intervalMin * 60_000);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Visible browser -------------------------------------------------------------

// Open (or focus) a real Notion window using the current account's profile.
// Subsequent calls without an account id reuse the existing handle.
async function openVisible(accountId) {
  if (visibleHandle && !accountId) {
    try { await visibleHandle.page.bringToFront(); return { reused: true, accountId: visibleHandle.accountId }; }
    catch { /* window was closed manually — fall through to relaunch */ visibleHandle = null; }
  }
  const id = accountId || (db.getCurrentNotionAccount() || {}).id;
  const account = id ? db.getNotionAccountById(id) : null;
  if (!account) throw new Error('Нет текущего Notion-аккаунта (создай или выбери)');

  if (visibleHandle) { await closeVisible().catch(() => {}); }

  const browser = await chromium.launch(buildLaunchOpts({ account, headless: false }));
  const context = await browser.newContext({
    storageState: ensureProfile(account),
    viewport: null,
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto('https://www.notion.so', { waitUntil: 'domcontentloaded' }).catch(() => {});

  visibleHandle = { browser, context, page, accountId: account.id };
  // Keep the profile up to date when the user closes the window normally.
  page.on('close', async () => {
    try { writeProfile(account, await context.storageState()); } catch {}
    visibleHandle = null;
    broadcast('np_visible_closed', { id: account.id });
  });
  broadcast('np_visible_open', { id: account.id, email: account.email });
  return { reused: false, accountId: account.id };
}

async function closeVisible() {
  if (!visibleHandle) return;
  const { browser } = visibleHandle;
  visibleHandle = null;
  try { await browser.close(); } catch {}
}

// Hot-swap the visible browser to a different account: persist current state,
// swap cookies in-place, then navigate. No new window — the user stays in the
// same tab they were working in.
async function switchVisibleTo(accountId) {
  if (!visibleHandle) return;
  const { context, page } = visibleHandle;
  // Persist whatever the user did with the previous account first.
  try {
    const oldAcc = db.getNotionAccountById(visibleHandle.accountId);
    if (oldAcc) writeProfile(oldAcc, await context.storageState());
  } catch {}

  const newAcc = db.getNotionAccountById(accountId);
  if (!newAcc) throw new Error('account not found');
  const state = readProfile(newAcc) || { cookies: [], origins: [] };

  // Wipe Notion cookies cleanly, then load the new ones.
  await context.clearCookies();
  if (state.cookies && state.cookies.length) await context.addCookies(state.cookies);
  visibleHandle.accountId = accountId;
  await page.goto('https://www.notion.so', { waitUntil: 'domcontentloaded' }).catch(() => {});
  broadcast('np_visible_swapped', { id: accountId, email: newAcc.email });
}

module.exports = {
  start, stop,
  pollAll, pollAccount,
  swap, maybeAutoSwap,
  openVisible, closeVisible, switchVisibleTo,
  ensureProfile, readProfile, writeProfile, profilePathFor,
  onEvent,
  PROFILE_DIR,
};
