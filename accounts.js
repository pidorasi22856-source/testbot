'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  insertAccount, updateAccount, deleteAccount,
  getAllAccounts, getAccountById, getAccountByHash, logEvent,
} = require('./db');

const KIRO_TOKEN_PATH = path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
const KIRO_TOKEN_DIR  = path.dirname(KIRO_TOKEN_PATH);

// ─── Token parsing ────────────────────────────────────────────────────────────

function parseToken(tokenJson) {
  let token;
  try {
    token = typeof tokenJson === 'string' ? JSON.parse(tokenJson) : tokenJson;
  } catch {
    throw new Error('Invalid token JSON');
  }

  // Support both token formats:
  // 1. kiro-auth-token.json format: { accessToken, refreshToken, expiresAt, clientIdHash, provider, region }
  // 2. AWS login cache format:      { accessToken: { accessKeyId, ... }, clientId, refreshToken, ... }
  const required = token.accessToken && (token.refreshToken || token.clientId);
  if (!required) {
    throw new Error('Token missing required fields (accessToken, refreshToken/clientId)');
  }

  return {
    accessToken:   token.accessToken,
    refreshToken:  token.refreshToken || null,
    expiresAt:     token.expiresAt || null,
    clientIdHash:  token.clientIdHash || token.clientId || null,
    authMethod:    token.authMethod || null,
    provider:      token.provider || null,
    region:        token.region || 'us-east-1',
  };
}

// ─── JWT decode (no verification — just read claims) ───────────────────────────

function decodeJwt(jwt) {
  try {
    if (typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    // A real JWT has exactly 3 dot-separated parts. AWS SSO Builder ID / IdC
    // access tokens are OPAQUE strings (e.g. "aoaAAAAAG...") with no dots —
    // they carry no decodable claims, so bail out cleanly.
    if (parts.length !== 3) return null;
    // base64url -> base64
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// AWS SSO tokens have recognizable prefixes:
//   accessToken  → "aoa..."  (opaque, NOT a JWT)
//   refreshToken → "aor..."
// Social-login (Google/GitHub) accessTokens are real JWTs instead.
function isOpaqueAwsToken(str) {
  return typeof str === 'string' && /^aoa[A-Za-z0-9]/.test(str);
}

// Build a human-friendly summary of a token: email, provider, region, expiry,
// validity. Used for the form preview AND the disk-capture flow.
function describeToken(tokenJson) {
  const parsed = parseToken(tokenJson); // throws if invalid
  const accessStr = typeof parsed.accessToken === 'string'
    ? parsed.accessToken
    : (parsed.accessToken && parsed.accessToken.token) || '';

  const claims = decodeJwt(accessStr) || {};

  // expiry: prefer explicit expiresAt, fall back to JWT exp
  let expiresAt = parsed.expiresAt || null;
  if (!expiresAt && claims.exp) expiresAt = new Date(claims.exp * 1000).toISOString();

  let expired = null;
  if (expiresAt) {
    const t = Date.parse(expiresAt);
    if (!Number.isNaN(t)) expired = t <= Date.now();
  }

  // Email only exists for social-login (Google/GitHub) tokens, whose
  // accessToken is a JWT. Builder ID / IdC tokens are opaque (aoa...) and
  // simply do not carry an email — that is expected, not an error.
  const email = claims.email || claims['cognito:username'] || claims.sub || null;
  const opaque = isOpaqueAwsToken(accessStr);

  return {
    email,
    provider:     parsed.provider || claims.iss || null,
    region:       parsed.region || null,
    authMethod:   parsed.authMethod || null,
    clientIdHash: parsed.clientIdHash || null,
    expiresAt,
    expired,
    // 'idc' | 'builder' | 'social' — helps the UI label accounts sensibly
    tokenKind:    opaque ? (parsed.authMethod === 'IdC' ? 'idc' : 'builder') : 'social',
    valid:        true,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function addAccount({ label, tokenJson, proxyId = null, priority = 0, notes = null }) {
  const parsed = parseToken(tokenJson);
  const raw    = typeof tokenJson === 'string' ? tokenJson : JSON.stringify(tokenJson, null, 2);

  // describeToken handles BOTH formats correctly: it decodes JWT claims for
  // social tokens and returns email=null for opaque Builder ID / IdC tokens
  // instead of producing garbage from a non-JWT accessToken.
  let info = {};
  try { info = describeToken(raw); } catch { /* parseToken already validated */ }
  const email = info.email || null;

  // If no explicit label was given, build a sensible one. Email is best;
  // otherwise fall back to provider/region + short clientIdHash so the row is
  // still identifiable for Builder ID/IdC accounts that have no email.
  let finalLabel = label;
  if (!finalLabel) {
    if (email) {
      finalLabel = email;
    } else {
      const shortId = parsed.clientIdHash ? parsed.clientIdHash.slice(0, 8) : null;
      const bits = [parsed.provider || info.tokenKind || 'Kiro', parsed.region, shortId]
        .filter(Boolean);
      finalLabel = bits.join(' · ');
    }
  }

  const id = insertAccount({
    label:          finalLabel,
    email,
    token_json:     raw,
    client_id_hash: parsed.clientIdHash,
    provider:       parsed.provider,
    region:         parsed.region,
    proxy_id:       proxyId || null,
    priority:       priority || 0,
    notes:          notes || null,
  });

  logEvent(id, 'add', { label: finalLabel, provider: parsed.provider });
  return { id, email, parsed };
}

function editAccount(id, fields) {
  const allowed = ['label', 'email', 'token_json', 'proxy_id', 'priority', 'status', 'notes'];
  const data = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) data[k] = fields[k];
  }
  if (fields.token_json) {
    const parsed = parseToken(fields.token_json);
    data.client_id_hash = parsed.clientIdHash;
    data.provider       = parsed.provider;
    data.region         = parsed.region;
    // Refresh derived identity fields when the token changes.
    if (parsed.authMethod) data.auth_method = parsed.authMethod;
    try {
      const info = describeToken(fields.token_json);
      if (info.email) data.email = info.email;
    } catch { /* validation already happened above */ }
  }
  updateAccount(id, data);
}

function removeAccount(id) {
  deleteAccount(id);
}

// ─── Activate — write token to Kiro token file ───────────────────────────────

function activateAccount(id) {
  const account = getAccountById(id);
  if (!account) throw new Error(`Account ${id} not found`);

  const token = JSON.parse(account.token_json);

  // Ensure directory exists
  if (!fs.existsSync(KIRO_TOKEN_DIR)) {
    fs.mkdirSync(KIRO_TOKEN_DIR, { recursive: true });
  }

  // Remove symlink if exists (security: prevent CWE-59 in reverse)
  try {
    const stat = fs.lstatSync(KIRO_TOKEN_PATH);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(KIRO_TOKEN_PATH);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Write token — use kiro-auth-token format if not already
  let tokenToWrite;
  if (token.clientIdHash !== undefined || (token.authMethod !== undefined)) {
    // Already in kiro-auth-token format
    tokenToWrite = token;
  } else {
    // Convert from AWS login cache format
    tokenToWrite = {
      accessToken:  token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt:    token.expiresAt || token.accessToken?.expiresAt,
      clientIdHash: token.clientId || null,
      authMethod:   'IdC',
      provider:     token.provider || 'BuilderId',
      region:       token.region || 'us-east-1',
    };
  }

  fs.writeFileSync(KIRO_TOKEN_PATH, JSON.stringify(tokenToWrite, null, 2), 'utf8');

  // Update last_used_at
  updateAccount(id, { last_used_at: new Date().toISOString() });
  logEvent(id, 'activate', null);

  return tokenToWrite;
}

// ─── Read current active token from disk ─────────────────────────────────────

function readCurrentToken() {
  try {
    const raw = fs.readFileSync(KIRO_TOKEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Read the live kiro-auth-token.json from disk, parse it, and add it as an
// account automatically. Returns { added, account|null, info, duplicate }.
function captureCurrentToken({ label = null, proxyId = null } = {}) {
  if (!fs.existsSync(KIRO_TOKEN_PATH)) {
    throw new Error(
      `Файл токена Kiro не найден:\n${KIRO_TOKEN_PATH}\n` +
      `Залогиньтесь в Kiro, затем повторите.`
    );
  }

  const raw = fs.readFileSync(KIRO_TOKEN_PATH, 'utf8');

  // Validate / describe (throws if not a valid token)
  let info;
  try {
    info = describeToken(raw);
  } catch (e) {
    throw new Error(`Файл найден, но это не похоже на токен Kiro: ${e.message}`);
  }

  // Skip if we already have this account (by clientIdHash)
  if (info.clientIdHash) {
    const existing = getAccountByHash(info.clientIdHash);
    if (existing) {
      return { added: false, duplicate: true, account: existing, info };
    }
  }

  // Let addAccount build a sensible label (email, or provider · region · id)
  // when the user didn't supply one explicitly.
  const result = addAccount({
    label:    label || null,
    tokenJson: raw,
    proxyId:  proxyId || null,
    priority: 0,
    notes:    'captured from disk',
  });

  // Persist auth_method + OIDC client credentials (needed for token refresh).
  // client creds come from the AWS SSO cache registration file "<clientIdHash>.json".
  try {
    const tokens = require('./tokens');
    const db = require('./db');
    const parsedTok = JSON.parse(raw);
    const creds = tokens.findClientCreds(info.clientIdHash);
    const upd = {};
    if (parsedTok.authMethod) upd.auth_method = parsedTok.authMethod;
    if (creds) {
      upd.client_id     = creds.clientId;
      upd.client_secret = creds.clientSecret;
      if (!upd.auth_method) upd.auth_method = 'IdC';
    }
    if (Object.keys(upd).length) db.updateAccount(result.id, upd);
  } catch { /* best-effort */ }

  logEvent(result.id, 'capture', { source: KIRO_TOKEN_PATH, email: info.email });

  return { added: true, duplicate: false, account: getAccountById(result.id), info };
}

function getCurrentActiveAccountId() {
  const token = readCurrentToken();
  if (!token) return null;
  const hash = token.clientIdHash || token.clientId || null;
  if (!hash) return null;
  const row = getAccountByHash(hash);
  return row ? row.id : null;
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportAccounts(format = 'json') {
  const accounts = getAllAccounts();
  // Strip sensitive token data from export — only include metadata
  const safe = accounts.map(a => ({
    id:         a.id,
    label:      a.label,
    email:      a.email,
    provider:   a.provider,
    region:     a.region,
    priority:   a.priority,
    status:     a.status,
    added_at:   a.added_at,
    last_used_at: a.last_used_at,
    notes:      a.notes,
  }));

  if (format === 'csv') {
    if (!safe.length) return '';
    const headers = Object.keys(safe[0]);
    const rows = safe.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','));
    return [headers.join(','), ...rows].join('\n');
  }

  return JSON.stringify(safe, null, 2);
}

function importAccountsFromJson(jsonStr) {
  const items = JSON.parse(jsonStr);
  if (!Array.isArray(items)) throw new Error('Expected array of accounts');
  const results = [];
  for (const item of items) {
    if (!item.token_json && !item.accessToken) continue;
    const tokenJson = item.token_json || JSON.stringify(item);
    const result = addAccount({
      label:    item.label || item.email || 'Imported',
      tokenJson,
      proxyId:  item.proxy_id || null,
      priority: item.priority || 0,
      notes:    item.notes || null,
    });
    results.push(result);
  }
  return results;
}

// ─── Bulk import (flexible) ───────────────────────────────────────────────────

// Extract one-or-more JSON objects from arbitrary text:
//  - a JSON array of objects
//  - several JSON objects separated by whitespace/newlines/commas
//  - a single object
function extractJsonObjects(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  // Try strict array / single object first
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch { /* fall through to brace-scanning */ }

  // Brace-depth scanner: pull out each balanced {...} block
  const objects = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const block = trimmed.slice(start, i + 1);
        try { objects.push(JSON.parse(block)); } catch { /* skip bad block */ }
        start = -1;
      }
    }
  }
  return objects;
}

// Import many accounts at once. Each item may be either an account-meta object
// ({ label, token_json, ... }) or a raw token object ({ accessToken, ... }).
// Skips duplicates by clientIdHash. Returns { added, skipped, errors }.
function importBulk(text, { defaultProxyId = null } = {}) {
  const items = extractJsonObjects(text);
  if (!items.length) throw new Error('Не найдено ни одного JSON-объекта');

  const existing = new Set(
    getAllAccounts().map(a => a.client_id_hash).filter(Boolean)
  );

  let added = 0, skipped = 0;
  const errors = [];

  items.forEach((item, idx) => {
    try {
      // Determine the token JSON: explicit token_json field, or the item itself
      const tokenSource = item.token_json
        ? (typeof item.token_json === 'string' ? item.token_json : JSON.stringify(item.token_json))
        : JSON.stringify(item);

      const parsed = parseToken(tokenSource);

      if (parsed.clientIdHash && existing.has(parsed.clientIdHash)) {
        skipped++;
        return;
      }

      // Prefer explicit label/email; otherwise pass null so addAccount builds
      // a unique "provider · region · shortId" label (Builder ID has no email).
      const label = item.label || item.email || null;
      addAccount({
        label,
        tokenJson: tokenSource,
        proxyId:   item.proxy_id || defaultProxyId || null,
        priority:  item.priority || 0,
        notes:     item.notes || null,
      });

      if (parsed.clientIdHash) existing.add(parsed.clientIdHash);
      added++;
    } catch (e) {
      errors.push({ index: idx + 1, error: e.message });
    }
  });

  return { added, skipped, errors, total: items.length };
}

// ─── Import by scanning a folder ───────────────────────────────────────────────

// Recursively scan a directory for token JSON files. Matches files that either
// are named like *token*.json OR parse as a valid Kiro token. Returns the same
// shape as importBulk.
function importFromFolder(dirPath, { defaultProxyId = null, recursive = true } = {}) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    throw new Error(`Папка не найдена: ${dirPath}`);
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) throw new Error(`Не папка: ${dirPath}`);

  const jsonFiles = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive && depth < 6) walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) {
        jsonFiles.push(full);
      }
    }
  };
  walk(dirPath, 0);

  const existing = new Set(
    getAllAccounts().map(a => a.client_id_hash).filter(Boolean)
  );

  let added = 0, skipped = 0;
  const errors = [];

  for (const file of jsonFiles) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      // Each file may itself contain one or many token objects
      const objs = extractJsonObjects(raw);
      for (const obj of objs) {
        let parsed;
        try {
          const src = obj.token_json
            ? (typeof obj.token_json === 'string' ? obj.token_json : JSON.stringify(obj.token_json))
            : JSON.stringify(obj);
          parsed = parseToken(src);

          if (parsed.clientIdHash && existing.has(parsed.clientIdHash)) { skipped++; continue; }

          const label = obj.label || obj.email || null;
          addAccount({
            label,
            tokenJson: src,
            proxyId:   defaultProxyId || null,
            priority:  0,
            notes:     `imported from ${file}`,
          });
          if (parsed.clientIdHash) existing.add(parsed.clientIdHash);
          added++;
        } catch {
          // not a token object — silently skip this object
        }
      }
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }

  return { added, skipped, errors, scanned: jsonFiles.length };
}

module.exports = {
  parseToken,
  decodeJwt,
  describeToken,
  captureCurrentToken,
  addAccount,
  editAccount,
  removeAccount,
  activateAccount,
  readCurrentToken,
  getCurrentActiveAccountId,
  exportAccounts,
  importAccountsFromJson,
  importBulk,
  importFromFolder,
  extractJsonObjects,
  KIRO_TOKEN_PATH,
};
