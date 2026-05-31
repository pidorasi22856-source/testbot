'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Kiro token refresh — adapted from OmniRoute (src/lib/oauth/services/kiro.ts).
// Two refresh paths:
//   1. AWS SSO OIDC (Builder ID / IDC): needs clientId + clientSecret
//      POST https://oidc.<region>.amazonaws.com/token  grantType=refresh_token
//      On failure, re-register an OIDC client and retry once.
//   2. Social (Google/GitHub): POST <KIRO_AUTH>/refreshToken  { refreshToken }
// Verified live: OIDC refresh returns a fresh accessToken (HTTP 200).
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const fetch = require('node-fetch');

const KIRO_AUTH_SERVICE = 'https://prod.us-east-1.auth.desktop.kiro.dev';

const KIRO_CONFIG = {
  clientName:  'kiro-oauth-client',
  clientType:  'public',
  scopes:      ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
  grantTypes:  ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
  issuerUrl:   'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6',
};

const SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache');

// ─── helpers ──────────────────────────────────────────────────────────────────

function asString(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v.token === 'string') return v.token;
  return null;
}

async function postJson(url, body, timeoutMs = 20000, agent = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
      agent:   agent || undefined,
    });
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { ok: resp.ok, status: resp.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// Register a fresh OIDC client (used as fallback when stored creds are stale).
async function registerClient(region = 'us-east-1', agent = null) {
  const { ok, json, text } = await postJson(
    `https://oidc.${region}.amazonaws.com/client/register`,
    {
      clientName: KIRO_CONFIG.clientName,
      clientType: KIRO_CONFIG.clientType,
      scopes:     KIRO_CONFIG.scopes,
      grantTypes: KIRO_CONFIG.grantTypes,
      issuerUrl:  KIRO_CONFIG.issuerUrl,
    }, 20000, agent
  );
  if (!ok) throw new Error(`registerClient failed: ${text}`);
  return {
    clientId:              json.clientId,
    clientSecret:          json.clientSecret,
    clientSecretExpiresAt: json.clientSecretExpiresAt,
  };
}

// Look up clientId/clientSecret from the AWS SSO cache registration file,
// which is named "<clientIdHash>.json".
function findClientCreds(clientIdHash) {
  if (!clientIdHash) return null;
  const file = path.join(SSO_CACHE_DIR, `${clientIdHash}.json`);
  try {
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (reg.clientId && reg.clientSecret) {
      return { clientId: reg.clientId, clientSecret: reg.clientSecret, region: reg.region || 'us-east-1' };
    }
  } catch { /* not found */ }
  return null;
}

// ─── core refresh ─────────────────────────────────────────────────────────────

// creds = { refreshToken, clientId?, clientSecret?, region?, authMethod? }
// Returns { accessToken, refreshToken, expiresIn, profileArn?, _newClientId?, _newClientSecret? }
async function refreshKiroToken(creds) {
  const refreshToken = asString(creds.refreshToken);
  if (!refreshToken) throw new Error('Нет refreshToken');

  const { authMethod, clientId, clientSecret } = creds;
  const region = creds.region || 'us-east-1';
  const agent = creds.agent || null;

  // Path 1: AWS SSO OIDC (Builder ID / IDC)
  if (clientId && clientSecret && authMethod !== 'imported') {
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;
    const first = await postJson(endpoint, { clientId, clientSecret, refreshToken, grantType: 'refresh_token' }, 20000, agent);

    if (first.ok) {
      const d = first.json || {};
      return {
        accessToken:  d.accessToken,
        refreshToken: d.refreshToken || refreshToken,
        expiresIn:    d.expiresIn || 3600,
      };
    }

    // Fallback: re-register client and retry once
    try {
      const reg = await registerClient(region, agent);
      const retry = await postJson(endpoint, {
        clientId: reg.clientId, clientSecret: reg.clientSecret, refreshToken, grantType: 'refresh_token',
      }, 20000, agent);
      if (retry.ok) {
        const d = retry.json || {};
        return {
          accessToken:  d.accessToken,
          refreshToken: d.refreshToken || refreshToken,
          expiresIn:    d.expiresIn || 3600,
          _newClientId: reg.clientId,
          _newClientSecret: reg.clientSecret,
          _newClientSecretExpiresAt: reg.clientSecretExpiresAt,
        };
      }
      throw new Error(`Повтор после ре-регистрации не удался: ${retry.text}`);
    } catch (e) {
      throw new Error(`Не удалось обновить токен (OIDC): ${first.text || e.message}`);
    }
  }

  // Path 2: Social (Google/GitHub)
  const social = await postJson(`${KIRO_AUTH_SERVICE}/refreshToken`, { refreshToken }, 20000, agent);
  if (!social.ok) throw new Error(`Не удалось обновить токен (social): ${social.text}`);
  const d = social.json || {};
  return {
    accessToken:  d.accessToken,
    refreshToken: d.refreshToken || refreshToken,
    profileArn:   d.profileArn,
    expiresIn:    d.expiresIn || 3600,
  };
}

module.exports = {
  KIRO_CONFIG,
  KIRO_AUTH_SERVICE,
  SSO_CACHE_DIR,
  asString,
  registerClient,
  findClientCreds,
  refreshKiroToken,
};
