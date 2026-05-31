'use strict';

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fetch = require('node-fetch');
const { getAllProxies, getProxyById } = require('./db');

// ─── Build proxy URL string ───────────────────────────────────────────────────

function buildProxyUrl(proxy) {
  if (!proxy) return null;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

// ─── Build an http(s) agent for node-fetch from a proxy row ───────────────────
// This is what makes OUR requests (quota, token refresh, streaming) actually
// travel through the account's proxy — previously proxies only affected the
// spawned Kiro.exe via env vars.
function buildAgentForProxy(proxy) {
  if (!proxy || !proxy.active) return null;
  const url = buildProxyUrl(proxy);
  if (!url) return null;
  try {
    if (proxy.type === 'socks5' || proxy.type === 'socks4') {
      return new SocksProxyAgent(url);
    }
    // http / https proxy → HttpsProxyAgent handles CONNECT tunneling for https targets
    return new HttpsProxyAgent(url);
  } catch {
    return null;
  }
}

// Resolve an agent from a proxyId (convenience for callers holding only the id).
function buildAgent(proxyId) {
  if (!proxyId) return null;
  const proxy = getProxyById(proxyId);
  return buildAgentForProxy(proxy);
}

// Resolve a working agent for an account WITH FAILOVER.
// Order of preference:
//   1. The account's assigned proxy (if active and not known-failed).
//   2. The assigned proxy even if last test failed (give it one more chance).
//   3. Any other active proxy whose last test was OK (or untested), round-robin
//      seeded by account id so different accounts pick different fallbacks.
// Returns { agent, proxyId, proxy } or { agent: null } when no proxy applies.
function resolveAccountProxy(account) {
  if (!account) return { agent: null, proxyId: null };

  const all = getAllProxies().filter(p => p.active);
  if (!all.length) return { agent: null, proxyId: null };

  const assigned = account.proxy_id ? all.find(p => p.id === account.proxy_id) : null;

  // Candidate ordering.
  const candidates = [];
  if (assigned) candidates.push(assigned);
  // Healthy others (last_status ok or never tested), excluding the assigned one.
  const others = all.filter(p => p.id !== (assigned && assigned.id));
  const healthy = others.filter(p => p.last_status !== 'fail');
  const failed  = others.filter(p => p.last_status === 'fail');
  // Round-robin seed by account id for spread.
  const seed = (account.id || 0) % (healthy.length || 1);
  const rotated = healthy.slice(seed).concat(healthy.slice(0, seed));
  candidates.push(...rotated, ...failed);

  for (const p of candidates) {
    const agent = buildAgentForProxy(p);
    if (agent) return { agent, proxyId: p.id, proxy: p, fallback: assigned ? p.id !== assigned.id : false };
  }
  return { agent: null, proxyId: null };
}

// ─── Build env vars for Kiro spawn ───────────────────────────────────────────

function buildProxyEnv(proxyId) {
  if (!proxyId) return {};
  const proxy = getProxyById(proxyId);
  if (!proxy || !proxy.active) return {};

  const url = buildProxyUrl(proxy);
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY:  url,
    NO_PROXY:    'localhost,127.0.0.1,::1',
  };
}

// ─── Test proxy connectivity ──────────────────────────────────────────────────

async function testProxy(proxyId) {
  const proxy = getProxyById(proxyId);
  if (!proxy) throw new Error(`Proxy ${proxyId} not found`);

  const start = Date.now();

  if (proxy.type === 'socks5' || proxy.type === 'socks4') {
    return await testSocks(proxy, start);
  } else {
    return await testHttpProxy(proxy, start);
  }
}

async function testSocks(proxy, start) {
  // Route a real HTTPS request to api.ipify.org through the SOCKS proxy so we
  // verify auth + actual data flow (not just the handshake) and read exit IP.
  const agent = buildAgentForProxy(proxy);
  if (!agent) return { ok: false, error: 'Не удалось построить прокси-агент', ms: Date.now() - start };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch('https://api.ipify.org?format=json', {
      agent,
      signal: controller.signal,
      headers: { 'User-Agent': 'kiro-manager-proxytest' },
    });
    const ms = Date.now() - start;
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, ms, type: proxy.type, host: proxy.host, port: proxy.port };
    }
    let ip = null;
    try { ip = (await resp.json()).ip; } catch { /* ignore */ }
    return { ok: true, ms, ip, type: proxy.type, host: proxy.host, port: proxy.port };
  } catch (e) {
    const ms = Date.now() - start;
    const msg = e.name === 'AbortError' ? 'Timeout (12s)' : e.message;
    return { ok: false, error: msg, ms };
  } finally {
    clearTimeout(timer);
  }
}

async function testHttpProxy(proxy, start) {
  // Real end-to-end check: tunnel an HTTPS request to api.ipify.org THROUGH the
  // proxy (sending credentials), and read back the exit IP. A bare TCP connect
  // would only prove the port is open — not that auth works or traffic flows.
  const agent = buildAgentForProxy(proxy);
  if (!agent) return { ok: false, error: 'Не удалось построить прокси-агент', ms: Date.now() - start };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch('https://api.ipify.org?format=json', {
      agent,
      signal: controller.signal,
      headers: { 'User-Agent': 'kiro-manager-proxytest' },
    });
    const ms = Date.now() - start;
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, ms, type: proxy.type, host: proxy.host, port: proxy.port };
    }
    let ip = null;
    try { ip = (await resp.json()).ip; } catch { /* ignore */ }
    return { ok: true, ms, ip, type: proxy.type, host: proxy.host, port: proxy.port };
  } catch (e) {
    const ms = Date.now() - start;
    const msg = e.name === 'AbortError' ? 'Timeout (12s)' : e.message;
    return { ok: false, error: msg, ms };
  } finally {
    clearTimeout(timer);
  }
}

async function testProxyById(id) {
  return await testProxy(id);
}

// ─── Bulk proxy parsing (clipboard paste, auto-detect format) ─────────────────
//
// Accepts a wide range of proxy line shapes, one per line:
//
//   scheme://user:pass@host:port           (canonical URL)
//   scheme://host:port
//   scheme://user:pass:host:port           ← bpproxy / Bright Data style, no '@'
//   user:pass@host:port
//   host:port:user:pass                    ← classic IPv4 list
//   user:pass:host:port
//   host:port
//
// Detection is positional but content-aware: we find the part that LOOKS like
// a hostname (contains '.' or is "localhost") followed by a valid port (1..65535).
// Whatever sits around that pair is treated as credentials. This survives
// session-proxy passwords that themselves contain ':' (e.g. the bpproxy.at
// "...:KFpzY0SP...:hardsession-ZxF63o3V:host:port" pattern), because ':' inside
// the password just falls into the "before host" prefix.
//
// Scheme defaults to socks5 when absent (most residential/rotating proxies).
function parseProxyLine(line, defaultType = 'socks5') {
  let s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;

  let type = defaultType;

  // Pull explicit scheme prefix if present.
  const schemeMatch = s.match(/^(socks5h?|socks4|https?):\/\//i);
  if (schemeMatch) {
    let sc = schemeMatch[1].toLowerCase();
    if (sc === 'socks5h') sc = 'socks5';
    type = sc;
    s = s.slice(schemeMatch[0].length);
  }

  let username = null, password = null, host = null, port = null;

  // ── Path 1: explicit '@' — RFC-style URL "user:pass@host:port[/...]"
  if (s.includes('@')) {
    // Trim any trailing path/query so "user:pass@host:port/foo" still works.
    s = s.split(/[\/?#]/, 1)[0];
    // Last '@' wins (lets a literal '@' in the password slip through).
    const at = s.lastIndexOf('@');
    const cred = s.slice(0, at);
    const hostPart = s.slice(at + 1);
    const cParts = cred.split(':');
    username = cParts[0] || null;
    password = cParts.slice(1).join(':') || null;
    const hParts = hostPart.split(':');
    if (hParts.length < 2) return null;
    host = hParts[0];
    port = parseInt(hParts[1], 10);
  } else {
    // ── Path 2: positional, ':' only. Find the host:port pair by content.
    s = s.split(/[\/?#]/, 1)[0]; // strip path/query if pasted (rare)
    const parts = s.split(':').map(p => p.trim()).filter(Boolean);

    // First pass: prefer a host that LOOKS like a hostname (has '.' or
    // is "localhost"). Scan left-to-right so "host:port:user:pass" is
    // matched at i=1, NOT at the user side later.
    let split = -1;
    for (let i = 1; i < parts.length; i++) {
      const h = parts[i - 1];
      const p = parseInt(parts[i], 10);
      const looksHost = h.includes('.') || h === 'localhost' || /^\[[\da-f:]+\]$/i.test(h); // IPv6 literal
      if (looksHost && Number.isFinite(p) && p >= 1 && p <= 65535) { split = i; break; }
    }

    // Fallback: any valid port position, even without '.' in host (single-
    // label hostnames or container DNS).
    if (split === -1) {
      for (let i = 1; i < parts.length; i++) {
        const p = parseInt(parts[i], 10);
        if (Number.isFinite(p) && p >= 1 && p <= 65535) { split = i; break; }
      }
    }
    if (split === -1) return null;

    host = parts[split - 1];
    port = parseInt(parts[split], 10);

    // Credentials live in whatever's NOT the host:port pair. If parts surround
    // it on both sides we prefer the "after" suffix (the classic IPv4 list
    // format `host:port:user:pass`).
    const before = parts.slice(0, split - 1);
    const after  = parts.slice(split + 1);

    if (after.length >= 2) {
      username = after[0] || null;
      password = after.slice(1).join(':') || null;
    } else if (after.length === 1 && before.length === 0) {
      username = after[0] || null;
    } else if (before.length >= 2) {
      username = before[0] || null;
      password = before.slice(1).join(':') || null;
    } else if (before.length === 1) {
      username = before[0] || null;
    }
  }

  if (!host || !Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { type, host, port, username, password };
}

// Parse a whole clipboard blob into proxy objects. De-dupes by FULL identity
// (host:port:user:pass) so rotating session-proxies that share host:port but
// differ by session credentials are all kept. Also splits proxies that were
// pasted back-to-back on a single line (no newlines between scheme:// URLs).
// Caps at `max` (default 100). Returns { proxies, errors, total }.
function parseProxyBulk(text, { defaultType = 'socks5', max = 100 } = {}) {
  let raw = String(text || '');
  // Insert a newline before every embedded scheme so concatenated URLs split.
  // We can't rely on \b here (e.g. "3000http" has no word boundary between
  // "0" and "h"), so we match the scheme literally and split before it,
  // except at the very start of the string.
  raw = raw.replace(/(socks5h?|socks4|https?):\/\//gi, '\n$1://');

  const lines = raw.split(/[\r\n]+/);
  const seen = new Set();
  const proxies = [];
  const errors = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const p = parseProxyLine(t, defaultType);
    if (!p) { errors.push({ line: i + 1, text: t.slice(0, 40) }); return; }
    // Full identity — keeps distinct sessions on the same host:port.
    const key = `${p.type}://${p.username || ''}:${p.password || ''}@${p.host}:${p.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (proxies.length < max) proxies.push(p);
  });
  return { proxies, errors, total: proxies.length };
}

module.exports = {
  buildProxyUrl, buildProxyEnv, buildAgent, buildAgentForProxy, resolveAccountProxy,
  testProxyById, parseProxyLine, parseProxyBulk,
};
