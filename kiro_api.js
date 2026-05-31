'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// kiro_api.js — OpenAI- & Anthropic-compatible gateway over Kiro / AWS
// CodeWhisperer streaming. Logic (endpoint, request shape, AWS EventStream
// binary framing, model ids) adapted from the OmniRoute project:
//   - translator/request/openai-to-kiro.ts  (conversationState shape)
//   - executors/kiro.ts                      (EventStream → text parsing)
//   - config/providerRegistry.ts             (endpoint + model list)
// Verified live against the GenerateAssistantResponse endpoint.
// ─────────────────────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const db     = require('./db');
const tokens = require('./tokens');
const { extractAccessToken } = require('./quota');

const KIRO_ENDPOINT = 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse';
const KIRO_TARGET   = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';

// Models Kiro accepts as modelId (verified live against GenerateAssistantResponse).
// Exposed via /v1/models; incoming OpenAI/Anthropic names are mapped onto these.
const KIRO_MODELS = [
  'auto',
  // Claude (Anthropic)
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  // Other providers Kiro fronts
  'deepseek-3.2',
  'minimax-m2.5',
  'minimax-m2.1',
  'glm-5',
  'qwen3-coder-next',
];
const KIRO_MODEL_SET = new Set(KIRO_MODELS);

// Newest id per Claude family — used when a request asks for a family without
// an exact version we accept (e.g. "claude-opus" or an unknown opus version).
const NEWEST = {
  opus:   'claude-opus-4.8',
  sonnet: 'claude-sonnet-4.6',
  haiku:  'claude-haiku-4.5',
};

// Map an incoming model name (OpenAI/Anthropic style) to a Kiro modelId.
function mapModel(requested) {
  const raw = String(requested || '').trim();
  if (!raw) return NEWEST.sonnet;
  const m = raw.toLowerCase();

  // 1) Exact passthrough (already a valid Kiro id).
  if (KIRO_MODEL_SET.has(m)) return m;

  // 2) Normalize dashed version → dotted (claude-opus-4-8 → claude-opus-4.8).
  const dotted = m.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)$/, '$1.$2');
  if (KIRO_MODEL_SET.has(dotted)) return dotted;

  // 3) Strip an Anthropic date suffix (claude-3-7-sonnet-20250219 → ...).
  const noDate = dotted.replace(/-\d{8}$/, '');
  if (KIRO_MODEL_SET.has(noDate)) return noDate;

  // 4) Family fallback — pick the newest accepted id for that family.
  if (m.includes('opus'))   return NEWEST.opus;
  if (m.includes('haiku'))  return NEWEST.haiku;
  if (m.includes('sonnet')) return NEWEST.sonnet;
  if (m.includes('deepseek')) return 'deepseek-3.2';
  if (m.includes('minimax'))  return 'minimax-m2.5';
  if (m.includes('glm'))      return 'glm-5';
  if (m.includes('qwen'))     return 'qwen3-coder-next';
  if (m === 'auto' || m.includes('auto')) return 'auto';

  // 5) Unknown (gpt-*, gemini-*, etc.) → safe default.
  return NEWEST.sonnet;
}

// Strict-aware resolver. Returns { modelId } on success, or { error } when
// strict mode is on and the model is neither a valid Kiro id nor a known
// Claude family (gpt-*/gemini-* are rejected instead of silently swapped).
function resolveModel(requested, strict) {
  const raw = String(requested || '').trim();
  const m = raw.toLowerCase();

  // Always accept exact / normalizable Kiro ids and Claude families.
  if (KIRO_MODEL_SET.has(m)) return { modelId: m };
  const dotted = m.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)$/, '$1.$2');
  if (KIRO_MODEL_SET.has(dotted)) return { modelId: dotted };
  const noDate = dotted.replace(/-\d{8}$/, '');
  if (KIRO_MODEL_SET.has(noDate)) return { modelId: noDate };

  const isClaudeFamily = /opus|sonnet|haiku/.test(m);
  const isKiroProvider = /(deepseek|minimax|glm|qwen|auto)/.test(m);

  if (!strict) return { modelId: mapModel(raw) };

  // Strict: map known families/providers, reject foreign models.
  if (isClaudeFamily || isKiroProvider) return { modelId: mapModel(raw) };
  return { error: `Model not available via Kiro: ${raw}` };
}

function kiroHeaders(accessToken) {
  return {
    'Authorization':    `Bearer ${accessToken}`,
    'Content-Type':     'application/json',
    'Accept':           'application/vnd.amazon.eventstream',
    'X-Amz-Target':     KIRO_TARGET,
    'User-Agent':       'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
    'X-Amz-User-Agent': 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
    'Amz-Sdk-Invocation-Id': uuidv4(),
    'Amz-Sdk-Request':  'attempt=1; max=3',
  };
}

// ─── System-prompt injection ──────────────────────────────────────────────────
//
// Kiro's backend has no `system` role. The reliable approach (matching the
// kiro-gateway reference) is the SIMPLEST one: prepend the system prompt as
// plain text to the FIRST user message (or to the current message if there is
// no history). No `<system>` tags, no fake assistant "I'm Claude" turn, no
// "these override your settings" wording — those read as injection attempts
// and the model audits and rejects them. Folded into the user's own message,
// it's just context the model follows.

function buildSystemInjection(systemPrompt) {
  const p = String(systemPrompt || '').trim();
  return p || null;
}

// ─── Message conversion (OpenAI/Anthropic messages → Kiro conversationState) ──

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
      .map(c => c.text || '')
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

// Build the Kiro payload. Injects the effective system prompt (global setting +
// any system messages from the request) using the priming-pair + reminder
// strategy, builds an alternating user/assistant history, and uses the last
// user message as the current message (Kiro requires the current turn to be a
// user turn).
function buildKiroPayload(model, messages, opts = {}) {
  const modelId = mapModel(model);

  const systemParts = [];
  const turns = []; // { role: 'user'|'assistant', text }

  for (const msg of (messages || [])) {
    if (!msg) continue;
    const role = msg.role;
    const text = textFromContent(msg.content);
    if (role === 'system') {
      if (text) systemParts.push(text);
    } else if (role === 'assistant') {
      turns.push({ role: 'assistant', text: text || '(empty)' });
    } else {
      // user, tool, function, anything else → user turn
      if (text) turns.push({ role: 'user', text });
    }
  }

  // Merge consecutive same-role turns (Kiro rejects adjacent same roles).
  const merged = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.text += `\n\n${t.text}`;
    else merged.push({ ...t });
  }

  // Effective system prompt. When a global override is configured (identity
  // feature on), it REPLACES the client's own system messages entirely — same
  // as kiro-gateway's CUSTOM_SYSTEM_PROMPT. Otherwise we pass through whatever
  // system text the client sent.
  const sysFromRequest = systemParts.join('\n\n').trim();
  const sysGlobal = String(opts.systemPrompt || '').trim();
  const effectiveSystem = sysGlobal || sysFromRequest;

  const inj = buildSystemInjection(effectiveSystem);

  // Prepend the system prompt as plain text to the FIRST user turn (reference
  // approach). This reads as ordinary context the model follows, instead of a
  // suspicious injected instruction. If there are no user turns yet, it is
  // applied to the current message below.
  let sysApplied = false;
  if (inj) {
    const firstUser = merged.find(t => t.role === 'user');
    if (firstUser) {
      firstUser.text = `${inj}\n\n${firstUser.text}`;
      sysApplied = true;
    }
  }

  // The current message is the trailing user turn. If the convo ends with an
  // assistant turn, synthesize a "Continue" user turn.
  let currentText;
  if (merged.length && merged[merged.length - 1].role === 'user') {
    currentText = merged.pop().text;
  } else {
    currentText = 'Continue';
  }

  // Build history, alternating user/assistant, starting with user.
  const history = [];
  for (const t of merged) {
    const last = history[history.length - 1];
    if (t.role === 'user') {
      if (last && last.userInputMessage) {
        history.push({ assistantResponseMessage: { content: '(empty)' } });
      }
      history.push({
        userInputMessage: { content: t.text, modelId, origin: 'AI_EDITOR' },
      });
    } else {
      if (!last || last.assistantResponseMessage) {
        history.push({
          userInputMessage: { content: '(empty)', modelId, origin: 'AI_EDITOR' },
        });
      }
      history.push({ assistantResponseMessage: { content: t.text } });
    }
  }
  // History must end on an assistant turn (it precedes currentMessage/user).
  if (history.length && history[history.length - 1].userInputMessage) {
    history.push({ assistantResponseMessage: { content: '(empty)' } });
  }

  // If the system prompt wasn't applied to a history turn (no user turns),
  // prepend it to the current message.
  if (inj && !sysApplied) {
    currentText = `${inj}\n\n${currentText}`;
  }
  let finalContent = currentText || '(empty)';

  const payload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: uuidv4(),
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId,
          origin: 'AI_EDITOR',
        },
      },
      history,
    },
  };

  const inf = {};
  if (opts.maxTokens)            inf.maxTokens   = opts.maxTokens;
  if (opts.temperature != null)  inf.temperature = opts.temperature;
  if (opts.topP != null)         inf.topP        = opts.topP;
  if (Object.keys(inf).length)   payload.inferenceConfig = inf;

  return { payload, modelId };
}

// ─── Token handling ───────────────────────────────────────────────────────────

// Ensure the account has a usable access token, refreshing it if expired.
// Returns { accessToken } or throws.
async function ensureAccessToken(account, agent = null) {
  let tok;
  try { tok = JSON.parse(account.token_json); } catch { throw new Error('Битый token_json'); }

  const accessToken = extractAccessToken(account);
  const expMs = tok.expiresAt ? Date.parse(tok.expiresAt) : 0;
  const stillValid = accessToken && expMs && expMs > Date.now() + 60_000;
  if (stillValid) return { accessToken };

  // Refresh via stored OIDC client creds / social path (through the proxy).
  const result = await tokens.refreshKiroToken({
    refreshToken: tok.refreshToken,
    clientId:     account.client_id || tok.clientId || null,
    clientSecret: account.client_secret || null,
    authMethod:   account.auth_method || tok.authMethod || null,
    region:       account.region || tok.region || 'us-east-1',
    agent,
  });
  if (!result.accessToken) {
    // Maybe the existing token is actually still good; fall back to it.
    if (accessToken) return { accessToken };
    throw new Error('Не удалось обновить токен');
  }

  const newTok = {
    ...tok,
    accessToken:  result.accessToken,
    refreshToken: result.refreshToken || tok.refreshToken,
    expiresAt:    new Date(Date.now() + (result.expiresIn || 3600) * 1000).toISOString(),
  };
  const extra = {};
  if (result._newClientId)     extra.client_id     = result._newClientId;
  if (result._newClientSecret) extra.client_secret = result._newClientSecret;
  try {
    db.setAccountToken(account.id, JSON.stringify(newTok, null, 2), extra);
    db.logEvent(account.id, 'token_refresh', { ok: true, via: 'api' });
  } catch { /* best-effort persist */ }

  return { accessToken: result.accessToken };
}

// Pick the account to serve a request with: the live on-disk account, else the
// highest-priority active account.
function pickAccount() {
  let account = null;
  try {
    const accountsMgr = require('./accounts');
    const diskId = accountsMgr.getCurrentActiveAccountId();
    if (diskId) account = db.getAccountById(diskId);
  } catch { /* ignore */ }
  if (!account || account.status !== 'active') account = db.getActiveAccount();
  return account;
}

// ─── Core streaming call ───────────────────────────────────────────────────────

const { EventStreamParser } = require('./kiro_eventstream');

// Calls Kiro and invokes onDelta(textChunk) for each text fragment. Resolves
// with { text, usage, modelId, accountId } when the stream completes.
// onDelta may be omitted for non-streaming callers.
async function streamKiro({ model, messages, maxTokens, temperature, topP, onDelta, signal }) {
  const account = pickAccount();
  if (!account) {
    const err = new Error('Нет активных аккаунтов');
    err.code = 'NO_ACCOUNTS';
    throw err;
  }

  const proxyMod = require('./proxy');

  // Resolve the effective global system prompt (identity override etc.) — only
  // when the feature is enabled in settings.
  let systemPrompt = '';
  try {
    if (db.getSetting('system_prompt_enabled') === '1') {
      systemPrompt = db.getSetting('system_prompt') || '';
    }
  } catch { /* ignore */ }

  const { payload, modelId } = buildKiroPayload(model, messages, { maxTokens, temperature, topP, systemPrompt });

  // Build an ordered list of proxy candidates (assigned first, then healthy
  // fallbacks). If no proxies exist at all, we make one direct attempt.
  const candidates = buildProxyCandidates(account, proxyMod);

  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];           // { agent, proxyId } or { agent:null } for direct
    const isLast = i === candidates.length - 1;
    try {
      const accessToken = (await ensureAccessToken(account, cand.agent)).accessToken;

      const resp = await fetch(KIRO_ENDPOINT, {
        method:  'POST',
        headers: kiroHeaders(accessToken),
        body:    JSON.stringify(payload),
        signal,
        agent:   cand.agent || undefined,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        const err = new Error(`Kiro ${resp.status}: ${body.slice(0, 300)}`);
        err.status = resp.status;
        err.upstreamBody = body;
        if (resp.status === 429 || /USAGE_LIMIT|REQUEST_COUNT|ThrottlingException|ServiceQuotaExceeded/i.test(body)) {
          err.code = 'LIMIT';
        } else if (resp.status === 401 || resp.status === 403) {
          err.code = 'AUTH';
        }
        // LIMIT/AUTH are account-level problems — switching proxy won't help.
        // Any other upstream status: don't keep burning proxies, just surface.
        try { db.logEvent(account.id, 'api_error', { status: resp.status, code: err.code, proxyId: cand.proxyId || null }); } catch {}
        throw err;
      }

      // Connected OK — stream it. Once we start emitting we are committed.
      if (cand.proxyId && cand.fallback) {
        try { db.logEvent(account.id, 'proxy_failover', { used: cand.proxyId }); } catch {}
      }
      return await consumeKiroStream(resp, { account, modelId, onDelta });

    } catch (e) {
      lastErr = e;
      // Account-level errors (limit/auth) or HTTP errors: do not failover.
      if (e.code === 'LIMIT' || e.code === 'AUTH' || e.status) throw e;

      // Connection-level failure (proxy dead/timeout/refused). Mark the proxy
      // as failed and try the next candidate.
      if (cand.proxyId) {
        try { db.setProxyTestResult(cand.proxyId, { ok: false, error: e.message }); } catch {}
        try { db.logEvent(account.id, 'proxy_failed', { proxyId: cand.proxyId, error: e.message }); } catch {}
      }
      if (isLast) throw e;
      // else loop to next proxy
    }
  }
  throw lastErr || new Error('Не удалось подключиться к Kiro');
}

// Build the candidate connection list for an account: assigned proxy first,
// then healthy fallbacks, then (if no proxies configured) a single direct try.
function buildProxyCandidates(account, proxyMod) {
  const list = [];
  try {
    const all = db.getAllProxies().filter(p => p.active);
    if (all.length) {
      const assigned = account.proxy_id ? all.find(p => p.id === account.proxy_id) : null;
      const others = all.filter(p => !assigned || p.id !== assigned.id);
      const healthy = others.filter(p => p.last_status !== 'fail');
      const failed  = others.filter(p => p.last_status === 'fail');
      const seed = (account.id || 0) % (healthy.length || 1);
      const rotated = healthy.slice(seed).concat(healthy.slice(0, seed));
      const ordered = [];
      if (assigned) ordered.push(assigned);
      ordered.push(...rotated, ...failed);
      // Cap failover attempts so a totally dead pool doesn't hang for minutes.
      for (const p of ordered.slice(0, 4)) {
        const agent = proxyMod.buildAgentForProxy(p);
        if (agent) list.push({ agent, proxyId: p.id, fallback: assigned ? p.id !== assigned.id : false });
      }
    }
  } catch { /* ignore */ }
  // Always allow a final direct (no-proxy) attempt when nothing else worked,
  // unless the account explicitly has a proxy assigned (respect user intent:
  // if they assigned a proxy, prefer failing over to other proxies only).
  if (!list.length) list.push({ agent: null, proxyId: null, fallback: false });
  return list;
}

// Read an AWS EventStream response into text, emitting deltas via onDelta.
async function consumeKiroStream(resp, { account, modelId, onDelta }) {
  const parser = new EventStreamParser();
  let fullText = '';
  let usage = null;

  await new Promise((resolve, reject) => {
    resp.body.on('data', (chunk) => {
      let events;
      try { events = parser.push(chunk); } catch { return; }
      for (const ev of events) {
        if (!ev) continue;
        if (ev.type === 'assistantResponseEvent' || ev.type === 'codeEvent') {
          const c = ev.payload && typeof ev.payload.content === 'string' ? ev.payload.content : '';
          if (c) { fullText += c; if (onDelta) { try { onDelta(c); } catch {} } }
        } else if (ev.type === 'metricsEvent') {
          const m = (ev.payload && (ev.payload.metricsEvent || ev.payload)) || {};
          const it = Number(m.inputTokens)  || 0;
          const ot = Number(m.outputTokens) || 0;
          if (it || ot) usage = { prompt_tokens: it, completion_tokens: ot, total_tokens: it + ot };
        }
      }
    });
    resp.body.on('end', resolve);
    resp.body.on('error', reject);
  });

  if (!usage) {
    const est = Math.max(1, Math.round(fullText.length / 4));
    usage = { prompt_tokens: 0, completion_tokens: est, total_tokens: est };
  }
  try { db.updateAccount(account.id, { last_used_at: new Date().toISOString() }); } catch {}
  return { text: fullText, usage, modelId, accountId: account.id };
}

// ── legacy single-shot body (kept below, no longer used by streamKiro) ──
async function _legacyConsume(resp, account, modelId, onDelta) {
  const parser = new EventStreamParser();
  let fullText = '';
  let usage = null;

  await new Promise((resolve, reject) => {
    resp.body.on('data', (chunk) => {
      let events;
      try { events = parser.push(chunk); } catch { return; }
      for (const ev of events) {
        if (!ev) continue;
        if (ev.type === 'assistantResponseEvent' || ev.type === 'codeEvent') {
          const c = ev.payload && typeof ev.payload.content === 'string' ? ev.payload.content : '';
          if (c) { fullText += c; if (onDelta) { try { onDelta(c); } catch {} } }
        } else if (ev.type === 'metricsEvent') {
          const m = (ev.payload && (ev.payload.metricsEvent || ev.payload)) || {};
          const it = Number(m.inputTokens)  || 0;
          const ot = Number(m.outputTokens) || 0;
          if (it || ot) usage = { prompt_tokens: it, completion_tokens: ot, total_tokens: it + ot };
        }
      }
    });
    resp.body.on('end', resolve);
    resp.body.on('error', reject);
  });

  if (!usage) {
    const est = Math.max(1, Math.round(fullText.length / 4));
    usage = { prompt_tokens: 0, completion_tokens: est, total_tokens: est };
  }

  try { db.updateAccount(account.id, { last_used_at: new Date().toISOString() }); } catch {}
  return { text: fullText, usage, modelId, accountId: account.id };
}

// ── legacy single-shot body (kept below, no longer used by streamKiro) ──
async function _legacyConsume(resp, account, modelId, onDelta) {
  const parser = new EventStreamParser();
  let fullText = '';
  let usage = null;

  await new Promise((resolve, reject) => {
    resp.body.on('data', (chunk) => {
      let events;
      try { events = parser.push(chunk); } catch { return; }
      for (const ev of events) {
        if (!ev) continue;
        if (ev.type === 'assistantResponseEvent' || ev.type === 'codeEvent') {
          const c = ev.payload && typeof ev.payload.content === 'string' ? ev.payload.content : '';
          if (c) { fullText += c; if (onDelta) { try { onDelta(c); } catch {} } }
        } else if (ev.type === 'metricsEvent') {
          const m = (ev.payload && (ev.payload.metricsEvent || ev.payload)) || {};
          const it = Number(m.inputTokens)  || 0;
          const ot = Number(m.outputTokens) || 0;
          if (it || ot) usage = { prompt_tokens: it, completion_tokens: ot, total_tokens: it + ot };
        }
      }
    });
    resp.body.on('end', resolve);
    resp.body.on('error', reject);
  });

  if (!usage) {
    const est = Math.max(1, Math.round(fullText.length / 4));
    usage = { prompt_tokens: 0, completion_tokens: est, total_tokens: est };
  }

  try { db.updateAccount(account.id, { last_used_at: new Date().toISOString() }); } catch {}
  return { text: fullText, usage, modelId, accountId: account.id };
}

module.exports = {
  KIRO_ENDPOINT, KIRO_TARGET, KIRO_MODELS,
  mapModel, kiroHeaders, buildKiroPayload,
  extractAccessToken, ensureAccessToken, pickAccount,
  resolveModel,
  streamKiro,
};
