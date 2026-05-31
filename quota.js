'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Kiro quota tracker — talks to AWS CodeWhisperer backend, mirroring what the
// Kiro IDE does internally. Logic adapted from the OmniRoute project:
//   - AmazonCodeWhispererService.ListAvailableProfiles  -> profileArn
//   - AmazonCodeWhispererService.GetUsageLimits         -> usage breakdown
// Verified against the live endpoint (operations recognized; 403 only on
// expired token).
// ─────────────────────────────────────────────────────────────────────────────

const { getProxyById } = require('./db');
const fetch = require('node-fetch');

const CODEWHISPERER_BASE_URL = 'https://codewhisperer.us-east-1.amazonaws.com/';

// AWS JSON-1.0 RPC headers for CodeWhisperer service operations
function cwHeaders(accessToken, target) {
  return {
    'Authorization':   `Bearer ${accessToken}`,
    'Content-Type':    'application/x-amz-json-1.0',
    'Accept':          'application/json',
    'x-amz-target':    target,
    'User-Agent':      'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
    'X-Amz-User-Agent':'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
  };
}

// ─── token extraction ─────────────────────────────────────────────────────────

function extractAccessToken(account) {
  let token;
  try {
    token = JSON.parse(account.token_json);
  } catch {
    return null;
  }
  if (typeof token.accessToken === 'string') return token.accessToken;
  if (token.accessToken && typeof token.accessToken.token === 'string') return token.accessToken.token;
  return null;
}

// ─── low-level RPC call ───────────────────────────────────────────────────────

async function cwCall(target, accessToken, body, { timeoutMs = 15000, agent = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(CODEWHISPERER_BASE_URL, {
      method:  'POST',
      headers: cwHeaders(accessToken, target),
      body:    JSON.stringify(body || {}),
      signal:  controller.signal,
      agent:   agent || undefined,
    });

    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json error */ }

    if (!resp.ok) {
      const type = json && (json.__type || json.code) || '';
      const msg  = (json && json.message) || text || `HTTP ${resp.status}`;
      const err  = new Error(msg);
      err.status = resp.status;
      err.awsType = type;
      err.expired = resp.status === 401 || resp.status === 403;
      throw err;
    }
    return json || {};
  } finally {
    clearTimeout(timer);
  }
}

// ─── operations ───────────────────────────────────────────────────────────────

// Returns the first available profileArn for this token (or null).
async function listProfiles(accessToken, agent = null) {
  const data = await cwCall('AmazonCodeWhispererService.ListAvailableProfiles', accessToken, { maxResults: 10 }, { agent });
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  if (!profiles.length) return null;
  const p = profiles[0];
  return p.arn || p.profileArn || null;
}

// Raw GetUsageLimits call. profileArn may be required for some account types.
async function getUsageLimits(accessToken, profileArn, agent = null) {
  const body = { origin: 'AI_EDITOR', resourceType: 'AGENTIC_REQUEST' };
  if (profileArn) body.profileArn = profileArn;
  return await cwCall('AmazonCodeWhispererService.GetUsageLimits', accessToken, body, { agent });
}

// ─── parsing ──────────────────────────────────────────────────────────────────

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function parseReset(data) {
  const raw = data.nextDateReset || data.resetDate || data.nextResetDate || null;
  if (!raw) return null;
  // Could be ISO string or epoch seconds/millis
  if (typeof raw === 'number') {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function parseUsage(data) {
  const list = Array.isArray(data.usageBreakdownList) ? data.usageBreakdownList : [];
  const resetAt = parseReset(data);
  const quotas = {};

  list.forEach((b) => {
    const rt = typeof b.resourceType === 'string' ? b.resourceType.toLowerCase() : 'unknown';
    const used  = num(b.currentUsageWithPrecision, num(b.currentUsage, 0));
    const total = num(b.usageLimitWithPrecision,  num(b.usageLimit, 0));
    quotas[rt] = {
      used,
      total,
      remaining: Math.max(0, total - used),
      unlimited: total === 0,
      resetAt,
    };

    // free trial bucket, if present
    const ft = b.freeTrialInfo;
    if (ft && typeof ft === 'object') {
      const fUsed  = num(ft.currentUsageWithPrecision, 0);
      const fTotal = num(ft.usageLimitWithPrecision, 0);
      if (fTotal > 0) {
        quotas[`${rt}_freetrial`] = {
          used: fUsed, total: fTotal,
          remaining: Math.max(0, fTotal - fUsed),
          unlimited: false, resetAt,
        };
      }
    }
  });

  const plan =
    (data.subscriptionInfo && String(data.subscriptionInfo.subscriptionTitle || '').trim()) ||
    data.subscriptionType || data.planType || 'Kiro';

  // Primary bucket for quick display (prefer agentic_request)
  const primary =
    quotas['agentic_request'] ||
    quotas[Object.keys(quotas)[0]] ||
    null;

  return {
    plan,
    primary,           // {used,total,remaining,resetAt,unlimited} | null
    quotas,            // all resource types
    resetAt,
    fetchedAt: new Date().toISOString(),
  };
}

// ─── high-level: fetch quota for an account row ───────────────────────────────

// Returns { ok, quota?, profileArn?, error?, expired?, refreshed? }.
// If the token is expired, attempts an automatic refresh (using stored client
// creds) and retries once.
async function fetchQuotaForAccount(account, { allowRefresh = true } = {}) {
  let accessToken = extractAccessToken(account);
  if (!accessToken) {
    return { ok: false, error: 'Не удалось извлечь accessToken из токена' };
  }

  let profileArn = account.profile_arn || null;
  let refreshed = false;

  // Route this account's quota calls through its assigned proxy (if any).
  let agent = null;
  if (account.proxy_id) {
    try { agent = require('./proxy').buildAgent(account.proxy_id); } catch { agent = null; }
  }

  const attempt = async (token, arn) => {
    let resolvedArn = arn;
    if (!resolvedArn) {
      // ListAvailableProfiles is only valid for IdC / Identity Center accounts.
      // AWS Builder ID returns 403 AccessDeniedException ("AWS Builder ID is not
      // supported for this operation") — that is NOT an expired token. We must
      // NOT treat it as expiry (doing so triggers a pointless token refresh).
      // Swallow ALL listProfiles errors and let GetUsageLimits below be the
      // single source of truth for token validity. Builder ID accounts fetch
      // usage just fine with profileArn = null.
      try {
        resolvedArn = await listProfiles(token, agent);
      } catch {
        resolvedArn = null;
      }
    }
    const data  = await getUsageLimits(token, resolvedArn, agent);
    return { quota: parseUsage(data), profileArn: resolvedArn || null };
  };

  try {
    const r = await attempt(accessToken, profileArn);
    return { ok: true, ...r };
  } catch (e) {
    if (!e.expired || !allowRefresh) {
      if (e.expired) return { ok: false, expired: true, error: 'Токен истёк или недействителен (переавторизуйтесь в Kiro)' };
      return { ok: false, error: e.message, awsType: e.awsType, status: e.status };
    }

    // ── token expired → try auto-refresh ──
    try {
      const tokens = require('./tokens');
      const tokObj = JSON.parse(account.token_json);
      const refreshTok = tokObj.refreshToken;

      const result = await tokens.refreshKiroToken({
        refreshToken: refreshTok,
        clientId:     account.client_id || tokObj.clientId || null,
        clientSecret: account.client_secret || null,
        authMethod:   account.auth_method || tokObj.authMethod || null,
        region:       account.region || tokObj.region || 'us-east-1',
        agent,
      });

      if (!result.accessToken) throw new Error('refresh не вернул accessToken');

      // Build the new token JSON, preserving structure
      const newTok = {
        ...tokObj,
        accessToken:  result.accessToken,
        refreshToken: result.refreshToken || tokObj.refreshToken,
        expiresAt:    new Date(Date.now() + (result.expiresIn || 3600) * 1000).toISOString(),
      };

      // Persist refreshed token (+ rotated client creds if any) to disk-account
      const db = require('./db');
      const extra = {};
      if (result._newClientId)     extra.client_id     = result._newClientId;
      if (result._newClientSecret) extra.client_secret = result._newClientSecret;
      if (result.profileArn)       extra.profile_arn   = result.profileArn;
      db.setAccountToken(account.id, JSON.stringify(newTok, null, 2), extra);

      accessToken = result.accessToken;
      profileArn  = result.profileArn || profileArn;
      refreshed   = true;

      const r2 = await attempt(accessToken, profileArn);
      return { ok: true, refreshed, ...r2 };
    } catch (re) {
      return { ok: false, expired: true, refreshFailed: true,
               error: `Токен истёк, авто-обновление не удалось: ${re.message}` };
    }
  }
}

module.exports = {
  CODEWHISPERER_BASE_URL,
  cwHeaders,
  extractAccessToken,
  listProfiles,
  getUsageLimits,
  parseUsage,
  fetchQuotaForAccount,
};
