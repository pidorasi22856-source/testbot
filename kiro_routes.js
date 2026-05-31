'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// kiro_routes.js — OpenAI- & Anthropic-compatible HTTP surface backed by Kiro.
//
// Endpoints:
//   GET  /v1/models                 (OpenAI)
//   POST /v1/chat/completions       (OpenAI, stream + non-stream)
//   POST /v1/messages               (Anthropic, stream + non-stream)
//
// Auth: optional bearer key. If setting `api_key` is set, requests must send
// `Authorization: Bearer <key>` (OpenAI) or `x-api-key: <key>` (Anthropic).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db  = require('./db');
const api = require('./kiro_api');

const router = express.Router();

// ─── Auth guard ────────────────────────────────────────────────────────────────

function extractKey(req) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const xkey = req.headers['x-api-key'] || null;
  return bearer || xkey || null;
}

function checkAuth(req, res) {
  // Auth is opt-in. When api_auth_enabled=1, a valid key from the api_keys
  // table is required. Otherwise the endpoint is open (localhost dev use).
  const enabled = db.getSetting('api_auth_enabled') === '1';
  if (!enabled) return true;

  const key = extractKey(req);
  const row = key ? db.getApiKeyByValue(key) : null;
  if (row) {
    try { db.touchApiKey(row.id); } catch {}
    return true;
  }

  res.status(401).json({
    error: { message: 'Invalid or missing API key', type: 'authentication_error', code: 'invalid_api_key' },
  });
  return false;
}

// ─── Models ────────────────────────────────────────────────────────────────────

router.get('/v1/models', (req, res) => {
  if (!checkAuth(req, res)) return;
  const now = Math.floor(Date.now() / 1000);
  res.json({
    object: 'list',
    data: api.KIRO_MODELS.map(id => ({
      id, object: 'model', created: now, owned_by: 'kiro',
    })),
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setSseHeaders(res) {
  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
}

// Map a streamKiro error to an HTTP status + payload, and trigger rotation on limits.
function handleUpstreamError(e) {
  if (e.code === 'LIMIT') {
    try { require('./rotator').rotate('API_LIMIT', 'api'); } catch {}
    return { status: 429, message: e.message };
  }
  if (e.code === 'AUTH')        return { status: 401, message: e.message };
  if (e.code === 'NO_ACCOUNTS') return { status: 503, message: 'No active Kiro accounts available' };
  return { status: 502, message: e.message || 'Upstream error' };
}

// Resolve the requested model honoring the model_strict setting. Returns the
// modelId string, or writes an error response and returns null.
function resolveModelOrFail(requested, res, format) {
  const strict = db.getSetting('model_strict') === '1';
  const r = api.resolveModel(requested, strict);
  if (r.error) {
    if (format === 'anthropic') {
      res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: r.error } });
    } else {
      res.status(400).json({ error: { message: r.error, type: 'invalid_request_error', code: 'model_not_found' } });
    }
    return null;
  }
  return r.modelId;
}

// ─── OpenAI: /v1/chat/completions ──────────────────────────────────────────────

router.post('/v1/chat/completions', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const body = req.body || {};
  const model = body.model || 'claude-sonnet-4.5';
  const messages = body.messages || [];
  const stream = body.stream === true;
  const id = `chatcmpl-${uuidv4()}`;
  const created = Math.floor(Date.now() / 1000);

  if (resolveModelOrFail(model, res, 'openai') === null) return;

  const opts = {
    model, messages,
    maxTokens:   body.max_tokens ?? body.max_completion_tokens,
    temperature: body.temperature,
    topP:        body.top_p,
  };

  if (stream) {
    setSseHeaders(res);
    let sentRole = false;
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      const result = await api.streamKiro({
        ...opts,
        onDelta: (text) => {
          if (!sentRole) {
            sentRole = true;
            send({ id, object: 'chat.completion.chunk', created, model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        },
      });
      // final chunk with usage
      send({ id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: result.usage });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      const { status, message } = handleUpstreamError(e);
      if (!res.headersSent) {
        res.status(status).json({ error: { message, type: 'upstream_error' } });
      } else {
        send({ error: { message, type: 'upstream_error', status } });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
    return;
  }

  // Non-streaming
  try {
    const result = await api.streamKiro(opts);
    res.json({
      id, object: 'chat.completion', created, model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: 'stop',
      }],
      usage: result.usage,
    });
  } catch (e) {
    const { status, message } = handleUpstreamError(e);
    res.status(status).json({ error: { message, type: 'upstream_error' } });
  }
});

// ─── Anthropic: /v1/messages ───────────────────────────────────────────────────

router.post('/v1/messages', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const body = req.body || {};
  const model = body.model || 'claude-sonnet-4.5';
  const stream = body.stream === true;
  const id = `msg_${uuidv4().replace(/-/g, '')}`;

  if (resolveModelOrFail(model, res, 'anthropic') === null) return;

  // Anthropic carries `system` separately; prepend it as a system message.
  const messages = [];
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(b => (b && b.text) || '').join('\n')
        : '';
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  for (const m of (body.messages || [])) messages.push(m);

  const opts = {
    model, messages,
    maxTokens:   body.max_tokens,
    temperature: body.temperature,
    topP:        body.top_p,
  };

  if (stream) {
    setSseHeaders(res);
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    let started = false;
    try {
      event('message_start', {
        type: 'message_start',
        message: {
          id, type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      event('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' },
      });
      started = true;
      event('ping', { type: 'ping' });

      const result = await api.streamKiro({
        ...opts,
        onDelta: (text) => {
          event('content_block_delta', {
            type: 'content_block_delta', index: 0,
            delta: { type: 'text_delta', text },
          });
        },
      });

      event('content_block_stop', { type: 'content_block_stop', index: 0 });
      event('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: result.usage.completion_tokens },
      });
      event('message_stop', { type: 'message_stop' });
      res.end();
    } catch (e) {
      const { status, message } = handleUpstreamError(e);
      if (!res.headersSent) {
        res.status(status).json({ type: 'error', error: { type: 'upstream_error', message } });
      } else {
        if (!started) { /* nothing emitted */ }
        event('error', { type: 'error', error: { type: 'upstream_error', message } });
        res.end();
      }
    }
    return;
  }

  // Non-streaming
  try {
    const result = await api.streamKiro(opts);
    res.json({
      id, type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: result.text }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: {
        input_tokens:  result.usage.prompt_tokens,
        output_tokens: result.usage.completion_tokens,
      },
    });
  } catch (e) {
    const { status, message } = handleUpstreamError(e);
    res.status(status).json({ type: 'error', error: { type: 'upstream_error', message } });
  }
});

module.exports = router;
