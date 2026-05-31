'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// notion_routes.js — OpenAI- and Anthropic-compatible HTTP gateway backed by
// Notion AI. Mounted under /notion (so the existing /v1/* gateway for Kiro
// stays untouched). External tools can switch to Notion by simply changing
// their baseURL:
//
//   OpenAI SDK:    baseURL = http://127.0.0.1:7842/notion/v1
//   Anthropic SDK: baseURL = http://127.0.0.1:7842/notion
//
// Auth follows the same opt-in scheme as the Kiro gateway: when
// settings.api_auth_enabled === '1', requests must carry a valid api_keys row
// (Bearer or x-api-key). Otherwise the endpoint is open (localhost dev).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const chat = require('./notion_chat');

const router = express.Router();

// ─── Auth ────────────────────────────────────────────────────────────────────

function extractKey(req) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const xkey = req.headers['x-api-key'] || null;
  return bearer || xkey || null;
}
function checkAuth(req, res) {
  if (db.getSetting('api_auth_enabled') !== '1') return true;
  const row = extractKey(req) ? db.getApiKeyByValue(extractKey(req)) : null;
  if (row) { try { db.touchApiKey(row.id); } catch {} return true; }
  res.status(401).json({ error: { message: 'Invalid or missing API key', type: 'authentication_error' } });
  return false;
}

// ─── Tool-bridge ─────────────────────────────────────────────────────────────
//
// Notion AI is a closed-tool system: it has its own internal toolset (page
// edit / database search / Slack / GDrive …) and cannot accept third-party
// tool definitions through the wire format. So when a client like OpenCode /
// Cline / Cursor sends tools[] in /chat/completions or /messages, plumbing
// them through verbatim does nothing — the model gets no signal that those
// tools exist and just chats.
//
// We bridge by INJECTING the tool definitions as plain-text instructions in a
// system message, asking the model to emit a structured marker when it wants
// to call one. The marker is parsed out of the reply and converted back to
// proper tool_calls / tool_use blocks so the client can dispatch normally.
//
// Marker format (chosen for being unlikely to appear in regular prose):
//   <tool_call name="<tool_name>">{...JSON args...}</tool_call>
//
// For multi-tool turns the model can emit several blocks back-to-back; the
// parser collects them all.

// Render a tool spec into Markdown the model can read. Accepts both the
// OpenAI (`{type:"function", function:{name,description,parameters}}`) and
// Anthropic (`{name, description, input_schema}`) shapes.
function renderToolSpec(spec) {
  let name, description, schema;
  if (spec && spec.type === 'function' && spec.function) {
    name = spec.function.name;
    description = spec.function.description || '';
    schema = spec.function.parameters || {};
  } else if (spec && spec.name) {
    name = spec.name;
    description = spec.description || '';
    schema = spec.input_schema || spec.parameters || {};
  } else {
    return '';
  }
  if (!name) return '';
  const lines = [`- **${name}** — ${description.trim() || '(no description)'}`];
  try {
    lines.push(`  Args (JSON Schema): \`${JSON.stringify(schema)}\``);
  } catch {
    lines.push(`  Args: (unavailable)`);
  }
  return lines.join('\n');
}

// Build a system-message string that lists the tools and explains the marker
// protocol the model is expected to follow.
function buildToolBridgeSystem(tools, toolChoice) {
  const lines = [];
  lines.push('You have access to the following tools the user can dispatch on your behalf:');
  lines.push('');
  for (const t of tools) {
    const r = renderToolSpec(t);
    if (r) lines.push(r);
  }
  lines.push('');
  lines.push('To call a tool, output one or more lines using EXACTLY this format and nothing else on those lines:');
  lines.push('  <tool_call name="<tool_name>">{"arg":"value", ...}</tool_call>');
  lines.push('Rules for tool calls:');
  lines.push('- The args MUST be valid JSON matching the tool\'s schema.');
  lines.push('- You may emit multiple <tool_call> blocks in a single turn — they will run in order.');
  lines.push('- Mix tool calls with plain prose if you want — the prose stays as the assistant\'s text reply.');
  lines.push('- Do NOT wrap the marker in backticks or code blocks. Emit it raw.');
  lines.push('- Once you have made the calls, stop. The user runs them and replies with results in a follow-up turn.');
  if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'tool' && toolChoice.name) {
    lines.push(`- For this turn you MUST call: \`${toolChoice.name}\`.`);
  } else if (toolChoice === 'required' || (toolChoice && toolChoice.type === 'any')) {
    lines.push('- For this turn you MUST call at least one tool. Do not reply without a <tool_call> block.');
  } else if (toolChoice === 'none') {
    lines.push('- For this turn DO NOT call any tool. Reply in plain text only.');
  }
  return lines.join('\n');
}

// Parse <tool_call name="...">{...}</tool_call> blocks out of a reply.
// Returns { textOnly, calls: [{name, args}] }. The text returned has the
// markers removed so the client doesn't see protocol noise.
const TOOL_CALL_RE = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/g;
function parseToolCalls(text) {
  if (!text || !/<tool_call\b/i.test(text)) return { textOnly: text || '', calls: [] };
  const calls = [];
  let m;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(text)) !== null) {
    const name = m[1];
    const raw  = m[2].trim();
    let args;
    try { args = raw ? JSON.parse(raw) : {}; }
    catch { args = { _raw: raw }; }
    calls.push({ name, args });
  }
  // Remove the markers from the visible text and clean up whitespace.
  const textOnly = text.replace(TOOL_CALL_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { textOnly, calls };
}

// Render a tool-result message (the user's follow-up that says "here's what
// the tool returned") back into prose the model can read on subsequent
// turns. Both OpenAI and Anthropic represent these differently; we collapse
// to a uniform "Tool result for <name>: <content>" line.
function flattenToolResult(content, toolName) {
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content.map(b => {
      if (typeof b === 'string') return b;
      if (b && typeof b.text === 'string') return b.text;
      try { return JSON.stringify(b); } catch { return String(b); }
    }).join('\n');
  } else { try { text = JSON.stringify(content); } catch { text = String(content); } }
  return `Tool result${toolName ? ` for ${toolName}` : ''}: ${text}`;
}

// Walk the incoming messages[] and rewrite tool-message shapes into plain
// user/assistant text the model can follow. OpenAI sends role:"tool" with
// tool_call_id; Anthropic sends content blocks of type "tool_use" /
// "tool_result". We translate both, preserving order.
function flattenWireMessagesForTools(messages) {
  const out = [];
  for (const msg of messages) {
    if (!msg) continue;
    // OpenAI tool result message.
    if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      out.push({ role: 'user', content: flattenToolResult(msg.content, name) });
      continue;
    }
    // Anthropic-style content blocks.
    if (Array.isArray(msg.content)) {
      const textParts = [];
      for (const b of msg.content) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text);
        else if (b.type === 'tool_use') {
          let argsStr;
          try { argsStr = JSON.stringify(b.input || {}); } catch { argsStr = '{}'; }
          textParts.push(`<tool_call name="${b.name}">${argsStr}</tool_call>`);
        } else if (b.type === 'tool_result') {
          textParts.push(flattenToolResult(b.content, b.tool_use_id || ''));
        } else if (typeof b.text === 'string') textParts.push(b.text);
      }
      out.push({ role: msg.role, content: textParts.join('\n') });
      continue;
    }
    // OpenAI assistant message with tool_calls.
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const parts = [];
      if (typeof msg.content === 'string' && msg.content.trim()) parts.push(msg.content);
      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        let args = fn.arguments;
        if (typeof args === 'string') {
          // OpenAI arguments come as a JSON string.
          try { args = JSON.stringify(JSON.parse(args)); } catch { /* leave as-is */ }
        } else { try { args = JSON.stringify(args || {}); } catch { args = '{}'; } }
        parts.push(`<tool_call name="${fn.name}">${args}</tool_call>`);
      }
      out.push({ role: 'assistant', content: parts.join('\n') });
      continue;
    }
    out.push(msg);
  }
  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();
}

// Map an internal error to an HTTP status + payload, and trigger an auto-swap
// when the current account is depleted.
function handleErr(e) {
  if (e.code === 'LIMIT') {
    try { require('./notion_profiles').swap('credits_exhausted_api'); } catch {}
    return { status: 429, message: e.message };
  }
  if (e.code === 'AUTH') return { status: 401, message: e.message };
  return { status: 502, message: e.message || 'Notion upstream error' };
}

// ─── /notion/v1/models — OpenAI list ────────────────────────────────────────
//
// Aliases: same handler is exposed at three paths so external SDKs can pick
// any reasonable baseURL.
//
//   baseURL=http://host/notion        → SDK posts /v1/...        (auto-prefix)
//   baseURL=http://host/notion/v1     → SDK posts /v1/v1/...     ← double v1
//   baseURL=http://host/notion/v1/v1  → SDK posts ...            (sloppy paste)
//
// We register every reasonable combination, so users can paste whichever
// shape Notion's docs / our toast suggest without producing 404s.
const MODELS_PATHS  = ['/notion/v1/models',           '/notion/v1/v1/models'];
const CHAT_PATHS    = ['/notion/v1/chat/completions', '/notion/v1/v1/chat/completions'];
const MSG_PATHS     = ['/notion/v1/messages',         '/notion/v1/v1/messages'];

router.get(MODELS_PATHS, (req, res) => {
  if (!checkAuth(req, res)) return;
  const now = Math.floor(Date.now() / 1000);
  // Expose every aliased name + the canonical Notion id, so SDKs that hard-
  // code "claude-3-opus" and curious operators using "apricot-sorbet-high"
  // both work.
  const data = [];
  const seen = new Set();
  for (const m of chat.listModels()) {
    const ids = [m.id, m.display, ...(m.aliases || [])];
    for (const id of ids) {
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      data.push({
        id, object: 'model', created: now, owned_by: 'notion-' + m.family,
        // Non-standard but useful — UI dropdowns can group on these.
        category: m.category, family: m.family, display: m.display,
      });
    }
  }
  res.json({ object: 'list', data });
});

// ─── /notion/v1/chat/completions — OpenAI-compatible ────────────────────────

router.post(CHAT_PATHS, async (req, res) => {
  if (!checkAuth(req, res)) return;
  const body = req.body || {};
  const stream = body.stream === true;
  const id = `chatcmpl-${uuidv4()}`;
  const created = Math.floor(Date.now() / 1000);
  const reqModel = body.model || 'claude-opus-4';

  // Diagnostic — surface what the outer client (OpenCode/Cline/etc.) sends.
  console.log(`[oai] ▶ model=${reqModel} stream=${stream} msgs=${(body.messages||[]).length} tools=${Array.isArray(body.tools)?body.tools.length:0} tool_choice=${body.tool_choice ? JSON.stringify(body.tool_choice) : '(none)'}`);
  if (Array.isArray(body.tools) && body.tools.length) {
    const names = body.tools.map(t => (t && t.function && t.function.name) || (t && t.name) || '?').slice(0, 10);
    console.log(`[oai] tools: ${names.join(', ')}${body.tools.length > 10 ? ` +${body.tools.length - 10}` : ''}`);
  }

  // Tool-bridge: if the client sent tools[] (OpenCode/Cline/Cursor/etc.),
  // inject them as a system message so the model knows they exist, and
  // translate any prior tool messages in the history into prose.
  const toolDefs = Array.isArray(body.tools) ? body.tools.filter(t =>
    (t && t.type === 'function' && t.function && t.function.name) || (t && t.name)
  ) : [];
  let messages = body.messages || [];
  if (toolDefs.length) {
    messages = flattenWireMessagesForTools(messages);
    const sys = buildToolBridgeSystem(toolDefs, body.tool_choice);
    messages = [{ role: 'system', content: sys }, ...messages];
  }

  const opts = {
    model: reqModel,
    messages,
    threadId: body.thread_id || body.threadId || null,
  };

  if (stream) {
    setSseHeaders(res);
    let sentRole = false;
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      // For tool-enabled streams we BUFFER deltas and parse at the end —
      // emitting tool_calls as proper OpenAI chunks. Streaming text deltas
      // would leak the <tool_call> markers to the client. Without tools
      // the existing live-typing path is preserved exactly.
      let fullText = '';
      const result = await chat.runChat({
        ...opts,
        onDelta: (text) => {
          if (toolDefs.length) {
            fullText += text;
            return;
          }
          if (!sentRole) {
            sentRole = true;
            send({ id, object: 'chat.completion.chunk', created, model: reqModel,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          }
          send({ id, object: 'chat.completion.chunk', created, model: reqModel,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        },
      });

      if (toolDefs.length) {
        const { textOnly, calls } = parseToolCalls(fullText);
        console.log(`[oai] ◀ stream tools=${toolDefs.length} parsedCalls=${calls.length} textLen=${(textOnly||'').length} sample="${(fullText||'').slice(0, 200).replace(/\n/g,' ')}"`);
        // Initial role chunk.
        send({ id, object: 'chat.completion.chunk', created, model: reqModel,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        if (textOnly) {
          send({ id, object: 'chat.completion.chunk', created, model: reqModel,
            choices: [{ index: 0, delta: { content: textOnly }, finish_reason: null }] });
        }
        if (calls.length) {
          // Emit tool_calls chunks. OpenAI streams them with index per call.
          calls.forEach((c, i) => {
            send({ id, object: 'chat.completion.chunk', created, model: reqModel,
              choices: [{ index: 0,
                delta: { tool_calls: [{ index: i, id: `call_${uuidv4().replace(/-/g,'').slice(0,24)}`,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) } }] },
                finish_reason: null }] });
          });
        }
        send({ id, object: 'chat.completion.chunk', created, model: reqModel,
          choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
          usage: {
            prompt_tokens:     result.usage.inputTokens || 0,
            completion_tokens: result.usage.outputTokens || 0,
            total_tokens:     (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0),
          },
        });
      } else {
        send({ id, object: 'chat.completion.chunk', created, model: reqModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens:     result.usage.inputTokens || 0,
            completion_tokens: result.usage.outputTokens || 0,
            total_tokens:     (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0),
          },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      const { status, message } = handleErr(e);
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

  // Non-stream
  try {
    const r = await chat.runChat(opts);
    const message = { role: 'assistant', content: r.text };
    let finishReason = 'stop';
    if (toolDefs.length) {
      const { textOnly, calls } = parseToolCalls(r.text);
      message.content = textOnly || null;
      if (calls.length) {
        message.tool_calls = calls.map(c => ({
          id: `call_${uuidv4().replace(/-/g,'').slice(0,24)}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
        finishReason = 'tool_calls';
      }
    }
    res.json({
      id, object: 'chat.completion', created, model: reqModel,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens:     r.usage.inputTokens || 0,
        completion_tokens: r.usage.outputTokens || 0,
        total_tokens:     (r.usage.inputTokens || 0) + (r.usage.outputTokens || 0),
      },
    });
  } catch (e) {
    const { status, message } = handleErr(e);
    res.status(status).json({ error: { message, type: 'upstream_error' } });
  }
});

// ─── /notion/v1/messages — Anthropic-compatible ─────────────────────────────

router.post(MSG_PATHS, async (req, res) => {
  if (!checkAuth(req, res)) return;
  const body = req.body || {};
  const stream = body.stream === true;
  const reqModel = body.model || 'claude-opus-4';
  const msgId = `msg_${uuidv4().replace(/-/g, '')}`;

  // Diagnostic — surface tool plumbing on the Anthropic endpoint.
  console.log(`[anth] ▶ model=${reqModel} stream=${stream} msgs=${(body.messages||[]).length} tools=${Array.isArray(body.tools)?body.tools.length:0} tool_choice=${body.tool_choice ? JSON.stringify(body.tool_choice) : '(none)'}`);
  if (Array.isArray(body.tools) && body.tools.length) {
    const names = body.tools.map(t => (t && t.name) || '?').slice(0, 10);
    console.log(`[anth] tools: ${names.join(', ')}${body.tools.length > 10 ? ` +${body.tools.length - 10}` : ''}`);
  }

  const messages = [];
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system) ? body.system.map(b => (b && b.text) || '').join('\n') : '';
    if (sysText) messages.push({ role: 'system', content: sysText });
  }

  // Tool-bridge for Anthropic /messages.
  const toolDefs = Array.isArray(body.tools) ? body.tools.filter(t => t && t.name) : [];
  let userMessages = body.messages || [];
  if (toolDefs.length) {
    userMessages = flattenWireMessagesForTools(userMessages);
    messages.push({ role: 'system',
      content: buildToolBridgeSystem(toolDefs, body.tool_choice) });
  }
  for (const m of userMessages) messages.push(m);

  const opts = { model: reqModel, messages, threadId: body.thread_id || null };

  if (stream) {
    setSseHeaders(res);
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      event('message_start', {
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: reqModel,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 } },
      });
      event('ping', { type: 'ping' });

      let fullText = '';
      let textBlockOpen = false;
      const r = await chat.runChat({
        ...opts,
        onDelta: (text) => {
          if (toolDefs.length) {
            // Buffer when tools are in play — we parse + emit tool_use blocks
            // at the end. Streaming raw text would leak <tool_call> markers.
            fullText += text;
            return;
          }
          if (!textBlockOpen) {
            event('content_block_start', { type: 'content_block_start', index: 0,
              content_block: { type: 'text', text: '' } });
            textBlockOpen = true;
          }
          event('content_block_delta', { type: 'content_block_delta', index: 0,
            delta: { type: 'text_delta', text } });
        },
      });

      let stopReason = 'end_turn';
      if (toolDefs.length) {
        const { textOnly, calls } = parseToolCalls(fullText);
        let blockIdx = 0;
        if (textOnly) {
          event('content_block_start', { type: 'content_block_start', index: blockIdx,
            content_block: { type: 'text', text: '' } });
          // Emit the text in a single chunk — no need to retroactively split.
          event('content_block_delta', { type: 'content_block_delta', index: blockIdx,
            delta: { type: 'text_delta', text: textOnly } });
          event('content_block_stop', { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
        }
        for (const c of calls) {
          const id = `toolu_${uuidv4().replace(/-/g,'').slice(0,22)}`;
          event('content_block_start', { type: 'content_block_start', index: blockIdx,
            content_block: { type: 'tool_use', id, name: c.name, input: {} } });
          // Anthropic streams tool args as input_json_delta partial JSON.
          event('content_block_delta', { type: 'content_block_delta', index: blockIdx,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.args) } });
          event('content_block_stop', { type: 'content_block_stop', index: blockIdx });
          blockIdx++;
        }
        if (calls.length) stopReason = 'tool_use';
      } else if (textBlockOpen) {
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
      }

      event('message_delta', { type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: r.usage.outputTokens || 0 } });
      event('message_stop', { type: 'message_stop' });
      res.end();
    } catch (e) {
      const { status, message } = handleErr(e);
      if (!res.headersSent) {
        res.status(status).json({ type: 'error', error: { type: 'upstream_error', message } });
      } else {
        event('error', { type: 'error', error: { type: 'upstream_error', message } });
        res.end();
      }
    }
    return;
  }

  try {
    const r = await chat.runChat(opts);
    let content = [{ type: 'text', text: r.text }];
    let stopReason = 'end_turn';
    if (toolDefs.length) {
      const { textOnly, calls } = parseToolCalls(r.text);
      content = [];
      if (textOnly) content.push({ type: 'text', text: textOnly });
      for (const c of calls) {
        content.push({ type: 'tool_use',
          id: `toolu_${uuidv4().replace(/-/g,'').slice(0,22)}`,
          name: c.name, input: c.args });
      }
      if (calls.length) stopReason = 'tool_use';
      if (!content.length) content.push({ type: 'text', text: '' });
    }
    res.json({
      id: msgId, type: 'message', role: 'assistant', model: reqModel,
      content,
      stop_reason: stopReason, stop_sequence: null,
      usage: {
        input_tokens:  r.usage.inputTokens || 0,
        output_tokens: r.usage.outputTokens || 0,
      },
    });
  } catch (e) {
    const { status, message } = handleErr(e);
    res.status(status).json({ type: 'error', error: { type: 'upstream_error', message } });
  }
});

// ─── /api/notion/models — internal: feeds the dashboard model picker ────────

router.get('/api/notion/models', (req, res) => {
  // Return models grouped by category for easy rendering.
  const groups = {};
  for (const m of chat.listModels()) {
    if (!groups[m.category]) groups[m.category] = [];
    groups[m.category].push({ id: m.id, display: m.display, family: m.family, aliases: m.aliases });
  }
  res.json({ ok: true, groups });
});

// ─── /api/notion/chat — internal: dashboard chat playground ─────────────────
//
// Streams text deltas via SSE so the playground can show typing without using
// the OpenAI compatibility shim. Body: { model, messages, thread_id? }.
router.post('/api/notion/chat', async (req, res) => {
  const body = req.body || {};
  setSseHeaders(res);
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  // Debug logging — surfaces silent stream failures that previously left
  // the dashboard chat hanging with no server-side trace.
  const t0 = Date.now();
  console.log(`[chat] ▶ model=${body.model || '(default)'} msgs=${(body.messages || []).length} thread=${body.thread_id || '(new)'}`);
  let deltaCount = 0;
  let totalChars = 0;
  try {
    const r = await chat.runChat({
      model: body.model || null,
      messages: body.messages || [],
      threadId: body.thread_id || null,
      onDelta: (t) => {
        deltaCount++;
        totalChars += t.length;
        send('delta', { text: t });
      },
    });
    console.log(`[chat] ✓ ${Date.now() - t0}ms deltas=${deltaCount} chars=${totalChars} finalLen=${r.text.length} model=${r.model}`);
    send('done', { text: r.text, usage: r.usage, model: r.model, threadId: r.threadId, accountId: r.accountId });
    res.end();
  } catch (e) {
    console.error(`[chat] ✗ ${Date.now() - t0}ms error: ${e.message} code=${e.code || '-'}`);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
    send('error', { message: e.message, code: e.code || null });
    res.end();
  }
});

module.exports = router;
