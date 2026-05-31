'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// mailbox.js — disposable email for automated signups / OTP retrieval.
//
// Provider: FCE (freecustom.email, api2.freecustom.email/v1). Chosen because:
//   • one API key → UNLIMITED inboxes (no 3-per-IP cap like tempmail)
//   • 19 domains, all accepted by Notion (mail.tm's domain is blocklisted)
//   • built-in OTP extraction endpoint + a /wait long-poll
//
// API key is read from the DB setting `fce_api_key` (or env FCE_API_KEY) — never
// hardcoded. Each "address" is just an inbox we register; the returned `token`
// field is the address itself (FCE auth is the global API key, not per-inbox).
// ─────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const BASE = 'https://api2.freecustom.email/v1';

function getApiKey() {
  try {
    const db = require('./db');
    return db.getSetting('fce_api_key') || process.env.FCE_API_KEY || null;
  } catch {
    return process.env.FCE_API_KEY || null;
  }
}

function headers() {
  const key = getApiKey();
  if (!key) throw new Error('FCE API ключ не задан (настройка fce_api_key)');
  return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

async function fce(path, { method = 'GET', body = null, timeoutMs = 20000, agent = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method, headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      agent: agent || undefined,
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json (html error) */ }
    // Throw ONLY on transport-level errors (non-2xx). HTTP 200 with
    // `success:false` is a valid business response (e.g. /wait timeout,
    // /otp "no code yet") — callers handle it. Throwing here would turn
    // every /wait long-poll timeout into an exception.
    if (!resp.ok) {
      const msg = (json && (json.message || json.error)) || text.slice(0, 200) || `HTTP ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.retryAfter = Number(resp.headers.get('retry-after')) || null;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Domains ──────────────────────────────────────────────────────────────────

let _domainCache = { value: null, ts: 0 };
async function getDomains() {
  if (_domainCache.value && Date.now() - _domainCache.ts < 300_000) return _domainCache.value;
  const j = await fce('/domains');
  const domains = (j.data || []).map(d => d.domain).filter(Boolean);
  if (!domains.length) throw new Error('FCE: нет доменов');
  _domainCache = { value: domains, ts: Date.now() };
  return domains;
}

// Track domains that recently failed to receive expected mail (e.g. Notion
// silently drops some FCE domains as disposable). After 1 strike the domain
// is benched for 30 minutes — `createAddress` will pick a different one.
const _domainStrikes = new Map();   // domain → { count, until }
const STRIKE_THRESHOLD = 1;
const STRIKE_BENCH_MS  = 30 * 60_000;

function reportDomainOutcome(domain, ok) {
  if (!domain) return;
  if (ok) { _domainStrikes.delete(domain); return; }
  const cur = _domainStrikes.get(domain) || { count: 0, until: 0 };
  cur.count++;
  if (cur.count >= STRIKE_THRESHOLD) cur.until = Date.now() + STRIKE_BENCH_MS;
  _domainStrikes.set(domain, cur);
}

function isDomainBenched(domain) {
  const s = _domainStrikes.get(domain);
  return !!(s && s.until && s.until > Date.now());
}

function rand(n = 10) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += c[(Math.random() * c.length) | 0];
  return s;
}

// ─── Address lifecycle ─────────────────────────────────────────────────────────

// Create (register) a disposable inbox.
//   provider — ignored (FCE only); kept for interface compatibility.
//   agent    — optional proxy agent (rarely needed; FCE auth is the key).
//   domain   — optional preferred domain; otherwise picked from the pool.
// Returns { address, token, provider, created_at }.
// NOTE: `token` mirrors `address` — FCE reads use the global API key, so callers
// that pass the token around still work (we accept either in read calls).
async function createAddress(provider = 'fce', agent = null, domain = null) {
  const all = await getDomains();

  // Optional whitelist from settings ("notion_domain_whitelist", comma-sep).
  // When set, we ONLY pick domains from the whitelist that the API returns.
  // This is the operator's escape hatch when Notion silently drops most
  // FCE domains as disposable but reliably accepts a known-good few.
  let whitelist = null;
  try {
    const db = require('./db');
    const raw = (db.getSetting && db.getSetting('notion_domain_whitelist')) || '';
    const arr = String(raw).split(/[,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (arr.length) whitelist = arr;
  } catch { /* db optional */ }

  let pool = whitelist ? all.filter(d => whitelist.includes(d.toLowerCase())) : all;
  // Prefer non-benched; fall back to all (or whitelist) if everything's benched.
  const usable = pool.filter(d => !isDomainBenched(d));
  if (usable.length) pool = usable;
  if (!pool.length) pool = all; // safety net — never deadlock

  const dom = domain && pool.includes(domain) ? domain : pool[Math.floor(Math.random() * pool.length)];
  const address = `${rand(12)}@${dom}`;
  await fce('/inboxes', { method: 'POST', body: { inbox: address, isTesting: false }, agent });
  return { address, token: address, provider: 'fce', created_at: new Date().toISOString(), domain: dom };
}

async function getAddressInfo(address /*, token, agent */) {
  // FCE has no per-inbox metadata endpoint we rely on; return basic info.
  return { address };
}

async function deleteAddress(address, _token, agent = null) {
  // Best-effort: FCE inboxes expire on their own; delete if supported.
  try { await fce(`/inboxes/${encodeURIComponent(address)}`, { method: 'DELETE', agent }); }
  catch { /* ignore — not all plans/inboxes support delete */ }
}

// ─── Emails ──────────────────────────────────────────────────────────────────

// `address` is the inbox; `token` is accepted but unused (auth = API key).
async function listEmails(address, _token, agent = null) {
  const j = await fce(`/inboxes/${encodeURIComponent(address)}/messages`, { agent });
  // FCE's live API returns `data` as a bare array (`{success,data:[...],count}`),
  // while the OpenAPI spec documents `data.messages`. Accept both so a future
  // server-side alignment to the spec doesn't silently break parsing.
  const d = j && j.data;
  const list = Array.isArray(d) ? d : (d && Array.isArray(d.messages) ? d.messages : []);
  return list.map(m => ({
    id: m.id || m.message_id,
    from_address: m.from || m.from_address || '',
    subject: m.subject || '',
    created_at: m.date || m.received_at || m.created_at || null,
    otp: (m.otp && m.otp !== '__DETECTED__') ? m.otp : null,
  }));
}

async function getEmail(id, _token, agent = null, address = null) {
  // FCE message fetch is by message id (and sometimes scoped to inbox).
  const path = address
    ? `/inboxes/${encodeURIComponent(address)}/messages/${encodeURIComponent(id)}`
    : `/messages/${encodeURIComponent(id)}`;
  const j = await fce(path, { agent });
  const m = (j && j.data) || j || {};
  const otp = (m.otp && m.otp !== '__DETECTED__') ? m.otp : null;
  return {
    id: m.id || id,
    from: m.from || '',
    to: m.to || '',
    subject: m.subject || '',
    body_text: m.text || m.body_text || m.body || '',
    body_html: m.html || m.body_html || '',
    otp,                                                   // FCE-extracted code, if any
    verification_link: m.verificationLink || m.verification_link || null,
    created_at: m.date || m.received_at || m.created_at || null,
  };
}

async function deleteEmail(/* id, token, agent */) { /* no-op for FCE */ }

// ─── OTP extraction (FCE built-in) ──────────────────────────────────────────────

const DEFAULT_CODE_RE = /\b(\d{4,8})\b/;

function extractCode(email, codeRe = DEFAULT_CODE_RE) {
  if (!email) return null;
  let text = email.body_text || '';
  if (!text && email.body_html) text = String(email.body_html).replace(/<[^>]+>/g, ' ');
  if (!text && email.subject) text = email.subject;
  if (!text) return null;
  const m = text.match(codeRe);
  return m ? (m[1] !== undefined ? m[1] : m[0]) : null;
}

// Ask FCE's OTP endpoint directly. Returns code string or null.
// On the Free plan FCE returns "__DETECTED__" (upsell) — we treat that as "found
// but value hidden" and fall back to parsing the message body ourselves.
async function fetchOtp(address, agent = null) {
  try {
    const j = await fce(`/inboxes/${encodeURIComponent(address)}/otp`, { agent });
    const code = (j && (j.otp || j.code)) || (j && j.data && (j.data.otp || j.data.code)) || null;
    if (code && code !== '__DETECTED__') return code;
    if (code === '__DETECTED__') return '__DETECTED__';
    return null;
  } catch { return null; }
}

// Poll an inbox until an OTP arrives, then return the code.
// opts: timeoutMs, intervalMs, codeRe, from, subject, agent
//
// Strategy (fast-first):
//   1) FCE long-poll `/wait` — server pushes the new message within ~ms of
//      arrival. One call covers up to 60s, no per-second polling needed.
//   2) `/otp` — FCE-extracted OTP (when the inbox started empty).
//   3) `/messages` cycle — fallback if /wait can't be used or got disconnected.
//
// IMPORTANT — clock-independence: we deliberately do NOT filter messages by
// comparing their timestamp against a local `Date.now()` baseline. FCE stamps
// each message with its own SERVER clock, which can differ from the local
// machine's clock by hours (observed ~3h skew). Instead we snapshot the
// message IDs that already exist when the wait begins and only act on IDs
// that appear AFTER — a baseline that needs no synchronized clocks.
async function waitForCode(address, token, opts = {}) {
  const {
    timeoutMs = 60_000,
    intervalMs = 3_000,
    codeRe = DEFAULT_CODE_RE,
    from = null,
    subject = null,
    agent = null,
  } = opts;

  const matchField = (val, filter) => {
    if (!filter) return true;
    if (filter instanceof RegExp) return filter.test(val || '');
    return String(val || '').toLowerCase().includes(String(filter).toLowerCase());
  };

  // Snapshot pre-existing messages so we only react to genuinely new mail.
  // Also remember the most-recent ID — `/wait?since=<id>` returns immediately
  // if anything newer already exists, which is the cheapest happy path.
  const preExisting = new Set();
  let lastSeenId = null;
  try {
    const initial = await listEmails(address, token, agent);
    for (const m of initial) if (m.id) { preExisting.add(m.id); lastSeenId = lastSeenId || m.id; }
  } catch { /* first poll below will populate */ }

  const startedEmpty = preExisting.size === 0;
  const start = Date.now();

  // Inspect a candidate message and return a {code, email} hit, or null.
  const tryExtract = async (meta) => {
    if (!meta || !meta.id || preExisting.has(meta.id)) return null;
    if (!matchField(meta.from_address || meta.from, from)) return null;
    if (!matchField(meta.subject, subject)) return null;
    if (meta.otp) return { code: meta.otp, email: meta };
    try {
      const full = await getEmail(meta.id, token, agent, address);
      if (full.otp) return { code: full.otp, email: full };
      const code = extractCode(full, codeRe);
      if (code) return { code, email: full };
    } catch { /* ignore */ }
    preExisting.add(meta.id);
    return null;
  };

  while (Date.now() - start < timeoutMs) {
    const remainMs = timeoutMs - (Date.now() - start);

    // 1) Long-poll. Cap per-call timeout at the protocol max (60s) and at
    //    what's left of our overall budget. `since=<id>` makes /wait return
    //    instantly when a newer message already exists.
    const waitSec = Math.min(60, Math.max(10, Math.ceil(remainMs / 1000)));
    let waited = null;
    try { waited = await waitForNewMessage(address, lastSeenId, waitSec, agent); }
    catch (e) {
      // /wait may not be available (plan, rate-limit) — fall through.
      if (e.status === 403 || e.status === 429) {
        // try /otp + /messages once before sleeping
      } else if (e.retryAfter) {
        await sleep(e.retryAfter * 1000);
      }
    }
    if (waited) {
      const meta = {
        id: waited.id, from_address: waited.from || '',
        subject: waited.subject || '',
        otp: (waited.otp && waited.otp !== '__DETECTED__') ? waited.otp : null,
      };
      const hit = await tryExtract(meta);
      if (hit) return hit;
      lastSeenId = meta.id || lastSeenId;
    }

    // 2) FCE built-in OTP endpoint (only when inbox started empty — otherwise
    //    we could pick up a stale code from a previous test on a reused inbox).
    if (startedEmpty) {
      const otp = await fetchOtp(address, agent);
      if (otp && otp !== '__DETECTED__') return { code: otp, email: null };
    }

    // 3) /messages list fallback — covers the case where /wait timed out, was
    //    blocked, or returned data we couldn't decode.
    let list = [];
    try { list = await listEmails(address, token, agent); }
    catch (e) { await sleep(e.retryAfter ? e.retryAfter * 1000 : intervalMs); continue; }
    for (const meta of list) {
      const hit = await tryExtract(meta);
      if (hit) return hit;
      lastSeenId = meta.id || lastSeenId;
    }

    // If /wait actually consumed time (real long-poll), don't sleep again.
    // If it errored fast, take a short nap to avoid hammering the API.
    if (!waited) await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - start))));
  }
  throw new Error(`waitForCode: код не пришёл за ${Math.round(timeoutMs / 1000)}с`);
}

// Long-poll a single new message via FCE's /wait endpoint.
//   sinceId — last-seen message id; /wait returns immediately if newer exists
//   timeoutSec — server-side wait budget (10..60 per docs)
// Resolves with the message metadata or null on timeout. Throws on auth/quota.
async function waitForNewMessage(address, sinceId, timeoutSec, agent = null) {
  const t = Math.max(10, Math.min(60, parseInt(timeoutSec, 10) || 30));
  let path = `/inboxes/${encodeURIComponent(address)}/wait?timeout=${t}`;
  if (sinceId) path += `&since=${encodeURIComponent(sinceId)}`;
  try {
    const j = await fce(path, { agent, timeoutMs: (t + 10) * 1000 });
    // 200 with success:true means a new message; success:false means timeout.
    if (j && j.success && j.data) {
      const m = j.data;
      return {
        id: m.id || m.message_id,
        from: m.from || '',
        subject: m.subject || '',
        date: m.date || m.received_at || null,
        otp: m.otp || null,
        verification_link: m.verification_link || null,
      };
    }
    return null;
  } catch (e) {
    // The fce() helper throws for !ok responses. /wait timeout is a 200 with
    // success:false (already handled above), so any thrown error here is real.
    throw e;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  BASE,
  getDomains,
  createAddress, getAddressInfo, deleteAddress,
  listEmails, getEmail, deleteEmail,
  extractCode, fetchOtp, waitForCode, waitForNewMessage,
  reportDomainOutcome, isDomainBenched,
};
