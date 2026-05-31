'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// notion.js — automated Notion email-OTP login/signup via a real browser.
//
// Notion's web app (app.notion.com/login) is a JS SPA protected against
// headless HTTP automation, so we drive a real browser (system Edge via
// playwright-core). Flow:
//   1. create a disposable address (mailbox.js / tempmail)
//   2. open the login page, type the email, submit
//   3. Notion emails a one-time code → mailbox.waitForCode() retrieves it
//   4. type the code, submit → grab the token_v2 session cookie
//   5. persist the account (token_v2 + email) to the manager DB
//
// Runs through the same proxy agent infrastructure when a proxy is provided.
// ─────────────────────────────────────────────────────────────────────────────

const { chromium } = require('playwright-core');
const mailbox = require('./mailbox');

const LOGIN_URL = 'https://www.notion.so/login';

// ─── Random identity ──────────────────────────────────────────────────────────
const FIRST_NAMES = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Sam', 'Drew',
  'Chris', 'Jamie', 'Quinn', 'Avery', 'Cameron', 'Reese', 'Skyler', 'Logan',
  'Parker', 'Devon', 'Blake', 'Hayden', 'Emerson', 'Finley', 'Rowan', 'Sage',
  'Liam', 'Noah', 'Ethan', 'Mason', 'Lucas', 'Oliver', 'Aiden', 'Daniel',
  'Emma', 'Olivia', 'Ava', 'Sophia', 'Mia', 'Isabella', 'Amelia', 'Harper',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Brown', 'Lee', 'Walker', 'Hall', 'Allen', 'Young',
  'Hill', 'Green', 'Adams', 'Baker', 'Carter', 'Mitchell', 'Roberts', 'Turner',
  'Phillips', 'Campbell', 'Parker', 'Evans', 'Morris', 'Cooper', 'Reed', 'Kim',
  'Garcia', 'Martinez', 'Lopez', 'Gonzalez', 'Perez', 'Rivera', 'Torres', 'Flores',
];
function randomName() {
  const f = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const l = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${f} ${l}`;
}

// Resolve a browser launch channel. Prefer system Edge/Chrome to avoid a large
// Chromium download.
function resolveChannel() {
  const fs = require('fs');
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
  for (const c of candidates) {
    if (c.probe.some(p => p && fs.existsSync(p))) return c.channel;
  }
  return null; // fall back to bundled chromium (must be installed)
}

// Build a Playwright proxy config from a manager proxy row.
function proxyToPlaywright(proxy) {
  if (!proxy) return undefined;
  const scheme = (proxy.type || 'http').replace('socks5h', 'socks5');
  const server = `${scheme}://${proxy.host}:${proxy.port}`;
  const cfg = { server };
  if (proxy.username) { cfg.username = proxy.username; cfg.password = proxy.password || ''; }
  return cfg;
}

// ─── Main: log in / sign up with email OTP ──────────────────────────────────────

// opts:
//   email     — use this address; if omitted, a tempmail address is created
//   provider  — tempmail provider for auto-created address ('tempmail'|'gmail')
//   proxy     — manager proxy row to route the browser through
//   headless  — default true
//   onStatus  — optional callback(stage, detail) for progress
//   timeoutMs — overall OTP wait window (default 60s)
// Returns { ok, email, token_v2, cookies, isNewAccount } or throws.
async function loginWithOtp(opts = {}) {
  const {
    provider = 'tempmail',
    proxy = null,
    headless = true,
    onStatus = () => {},
    timeoutMs = 60_000,
  } = opts;

  // Build a proxy agent for tempmail address CREATION (per-IP quota: creating
  // through the proxy uses that IP's own 3-address allowance). Reading the
  // inbox is done directly (token authorizes, far faster).
  let mailAgent = null;
  if (proxy) {
    try { mailAgent = require('./proxy').buildAgentForProxy(proxy); } catch { mailAgent = null; }
  }

  // 1) address — create through the proxy; if that IP's quota is full, fall
  // back to other active proxies, then to a direct attempt.
  let email = opts.email;
  let mailToken = opts.mailToken || null;
  let createdAddress = null;
  if (!email) {
    onStatus('creating_address', { provider });
    createdAddress = await createAddressWithFallback(provider, mailAgent, proxy);
    email = createdAddress.address;
    mailToken = createdAddress.token;
  }
  if (!mailToken) {
    throw new Error('Нужен mailToken для адреса (или дай создать адрес автоматически)');
  }

  const channel = resolveChannel();
  const launchOpts = { headless, args: ['--disable-blink-features=AutomationControlled'] };
  if (channel) launchOpts.channel = channel;
  const pxy = proxyToPlaywright(proxy);
  if (pxy) launchOpts.proxy = pxy;

  let browser;
  try {
    onStatus('launching_browser', { channel: channel || 'chromium' });
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });
    const page = await context.newPage();

    onStatus('opening_login', { url: LOGIN_URL });
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // 2) type email
    onStatus('entering_email', { email });
    const emailInput = await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 30_000 });
    await emailInput.click();
    await emailInput.fill(email);

    // Submit (Continue). Try a button, else press Enter.
    const continueBtn = await findButton(page, ['Continue', 'Continue with email', 'Продолжить']);
    if (continueBtn) await continueBtn.click();
    else await emailInput.press('Enter');

    // 3) wait for the OTP code input to appear AND the email to arrive (parallel)
    onStatus('waiting_for_code_field', {});
    const codeFieldP = page.waitForSelector(
      'input[name="notion-password"], input[placeholder*="code" i], input[autocomplete="one-time-code"], input[type="text"]',
      { timeout: 45_000 }
    ).catch(() => null);

    onStatus('waiting_for_email_code', { email });
    // Read the mailbox DIRECTLY (no proxy): the address token authorizes
    // regardless of IP, and mobile proxies make inbox polling extremely slow
    // (~20s/call). Only address CREATION goes through the proxy (for quota).
    //
    // We filter on the Notion sender so a stray newsletter can't be mistaken
    // for the login mail. waitForCode is clock-independent (it snapshots the
    // inbox at start and reacts to new mail), so no sinceTs is needed — that
    // old approach broke under FCE server/local clock skew.
    let code;
    try {
      const r = await mailbox.waitForCode(email, mailToken, {
        timeoutMs,
        intervalMs: 3000,
        from: 'notion',
        agent: null,
      });
      code = r.code;
      // Domain delivered — clear any prior strikes against it.
      if (createdAddress && createdAddress.domain) {
        try { mailbox.reportDomainOutcome(createdAddress.domain, true); } catch {}
      }
    } catch (e) {
      // Mail never arrived — likely Notion's anti-abuse silently dropped this
      // FCE domain. Penalize it so the next account skips this domain.
      if (createdAddress && createdAddress.domain) {
        try { mailbox.reportDomainOutcome(createdAddress.domain, false); } catch {}
        onStatus('domain_strike', { domain: createdAddress.domain });
      }
      throw e;
    }
    onStatus('got_code', { code });

    const codeField = await codeFieldP;
    if (!codeField) throw new Error('Поле ввода кода не появилось');

    // 4) enter the code
    await codeField.click();
    await codeField.fill(code);
    const verifyBtn = await findButton(page, ['Continue', 'Verify', 'Log in', 'Sign in', 'Продолжить', 'Войти']);
    if (verifyBtn) await verifyBtn.click();
    else await codeField.press('Enter');

    // 5) wait until logged in — token_v2 cookie appears
    onStatus('verifying', {});
    const tokenV2 = await waitForTokenCookie(context, 60_000);
    if (!tokenV2) throw new Error('Логин не завершился: cookie token_v2 не получен (возможно неверный код или капча)');

    // 5b) wait for the SPA to actually leave /login. Notion writes token_v2
    // before navigating, so completeOnboarding could otherwise spin against
    // a blank /login page and exit silently. We wait until either the URL
    // moves to /onboarding|workspace, OR a known onboarding heading appears.
    onStatus('waiting_onboarding', {});
    try {
      await page.waitForFunction(() => {
        const u = location.pathname;
        if (/onboarding/i.test(u)) return true;
        if (/^\/[0-9a-f]{20,}/i.test(u)) return true; // workspace UUID
        const t = (document.body.innerText || '').toLowerCase();
        return /customize your profile|how do you want|who else|choose your plan|invite your team|free trial/.test(t);
      }, { timeout: 30_000 });
      onStatus('onboarding_ready', { url: page.url() });
    } catch {
      // Fall through — the loop below will log every iteration so we still
      // see what's on screen even if Notion never reached onboarding.
      onStatus('warn', { step: 'pre_onboarding', reason: 'onboarding screen never loaded in 30s; continuing anyway' });
    }

    // 6) walk through the onboarding wizard. Notion forces a multi-step flow
    //    after first login (profile name → use case → invite teammates → plan
    //    → optional card on Business trial). We complete each screen with
    //    sensible defaults so the workspace is actually ready when we return.
    const card = opts.card || readSavedCard();
    try {
      await completeOnboarding(page, { email, onStatus, card });
    } catch (e) {
      // Onboarding shape changes often — never fail the whole registration
      // because of a UI tweak. The token_v2 cookie is already in hand.
      onStatus('onboarding_skipped', { error: e.message });
    }

    const cookies = await context.cookies();
    onStatus('logged_in', { email });

    return {
      ok: true,
      email,
      token_v2: tokenV2,
      cookies,
      address: createdAddress ? { address: createdAddress.address, token: createdAddress.token } : null,
    };
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────────

// ─── Onboarding wizard ────────────────────────────────────────────────────────
//
// After the OTP login, Notion redirects new accounts to /onboarding with a
// multi-step wizard. We resolve each known step by its on-screen text rather
// than DOM positions so the flow survives minor UI shuffles. Steps observed:
//
//   1. "Customize your profile"    → fill `Your name`, click Continue
//   2. "How do you want to use…"   → click "For work" tile, click Continue
//   3. "Who else is on your team?" → fill up to 10 random invite emails, send
//   4. "Choose your Plan"          → if a card is configured, pick Business
//                                    free trial; otherwise pick Free.
//   5. "Enter card details"        → only if a trial was picked: fill the
//                                    Stripe iframe with the saved card
//
// Anything we can't recognize is treated as "press Continue / Skip" so a
// surprise step doesn't stall the run. Every action emits onStatus('warn',
// {...}) on failure so the manager log is actionable.
async function completeOnboarding(page, { email, onStatus, card }) {
  const steps = [
    { name: 'join_or_create', fn: stepJoinOrCreate },
    { name: 'profile',        fn: stepCustomizeProfile },
    { name: 'use_case',       fn: stepHowToUse },
    { name: 'invite',         fn: stepInviteTeam },
    { name: 'plan',           fn: stepChoosePlan },
    { name: 'plan_confirm',   fn: stepConfirmTrial },
    { name: 'card',           fn: stepEnterCard },
    // Generic "skip-it" promo handler — runs LAST so it never short-circuits
    // a real screen above. Catches any onboarding page that exposes a
    // "Skip for now" / "Maybe later" CTA: Desktop App, Setup Session,
    // mobile-app, integrations, etc.
    { name: 'skip_promo',     fn: stepSkipPromo },
  ];

  let consecutiveBlank = 0;
  // Stuck-step guard: if the SAME step is "handled" but the screen never
  // moves on (e.g. we found the screen but couldn't click the right CTA),
  // bail after a few iterations so we don't loop forever.
  let lastStep = null;
  let stuckCount = 0;
  const STUCK_LIMIT = 3;

  for (let i = 0; i < 24; i++) {
    const txt = await pageText(page);

    // Reached the workspace? The cleanest signal: the URL has left the
    // /onboarding subtree. This catches every workspace landing variant —
    //   notion.so/<workspace-uuid>
    //   notion.so/chat?t=<workspace-uuid>
    //   app.notion.com/...
    // — without us having to guess Notion's URL layout. We also keep the
    // text-marker check so we never declare success on a non-workspace
    // intermediate (login, error, etc.).
    if (!/\/onboarding/i.test(page.url()) && !/\/login/i.test(page.url())) {
      const looksWorkspace = /getting started|quick note|search|new page|teamspaces|inbox|trash|library|new chat|add new/i.test(txt);
      if (looksWorkspace) {
        onStatus('onboarding_done', { url: page.url() });
        return;
      }
    }

    // ALWAYS log a heartbeat each iteration so the user can see what was on
    // screen even when no step matched. (Previous version went silent on
    // blank pages, masking the "left on /login" bug.)
    const snap = await uiSnapshot(page);
    onStatus('onboarding_tick', {
      iter: i + 1, url: snap.url,
      snippet: snap.snippet, buttons: snap.buttons,
    });

    let handled = null;
    for (const s of steps) {
      if (await s.fn(page, { email, onStatus, card })) { handled = s.name; break; }
    }

    if (handled) {
      onStatus('onboarding_step', { name: handled });
      consecutiveBlank = 0;
      // skip_promo is a generic catch-all that may legitimately fire several
      // times in a row when Notion stacks promos (Desktop App → Setup Session
      // → Mobile App). Don't let the stuck-guard kill the loop in that case.
      if (handled === 'skip_promo') {
        stuckCount = 0;
        lastStep = handled;
      } else if (handled === lastStep) {
        stuckCount++;
        if (stuckCount >= STUCK_LIMIT) {
          // Same step keeps "handling" but we never escape it. Hard stop —
          // the manager log already shows the warn for the missing CTA.
          onStatus('onboarding_stuck', { step: handled, iter: i + 1, ...(await uiSnapshot(page)) });
          return;
        }
      } else {
        stuckCount = 0;
        lastStep = handled;
      }
    } else {
      // Unknown step → try any forward-progress button. If it's truly blank
      // (e.g. SPA still loading), give it more time before bailing.
      const isBlank = !snap.buttons.length && (!snap.snippet || snap.snippet.length < 30);
      if (isBlank) {
        consecutiveBlank++;
        // Allow up to ~10 blank iterations (~25s) for the SPA to render.
        if (consecutiveBlank > 10) {
          onStatus('onboarding_blank_giveup', { iter: i + 1, url: snap.url });
          return;
        }
      } else {
        const clicked = await clickByText(page, /^(continue|next|skip|got it|maybe later|done|take me to notion)$/i);
        if (!clicked) {
          // Something IS on screen but no step recognised it → log richer detail.
          onStatus('onboarding_step_unknown', { url: snap.url, snippet: snap.snippet, buttons: snap.buttons });
          return;
        }
      }
    }
    await page.waitForTimeout(2500);
  }
  onStatus('onboarding_loop_exhausted', {});
}

// ── Step 0 — Join existing or create new workspace ───────────────────────────
//
// When previous batch accounts invite each other, Notion surfaces a screen
// titled "Join teammates or create a workspace" listing pending invites with
// a Join button per workspace + a separate "Create new workspace" button.
// Per the operator's preference: if there's an invite — join the FIRST one.
// (Joining piggybacks on the existing workspace; the original Notion account
// reaches its limit faster, but onboarding is short and the manager will
// auto-swap when credits run low anyway.)
async function stepJoinOrCreate(page, { onStatus }) {
  const txt = await pageText(page);
  if (!/join teammates or create a workspace|you'?ve been invited|create new workspace/i.test(txt)) return false;

  onStatus('join_or_create_screen', {});

  // Try to click any "Join" button first. If there are several, the FIRST
  // visible one (top of the list) wins — fine for this use case.
  if (await waitAndClick(page, /^\s*join\s*$/i, 4000)) return true;

  // No Join available → fall back to creating a fresh workspace.
  if (await waitAndClick(page, /^\s*(create new workspace|create a workspace|create workspace)\s*$/i, 4000)) return true;

  // As a last resort: any forward-progress button.
  if (await waitAndClick(page, /^\s*(continue|skip|next)\s*$/i, 3000)) return true;

  onStatus('warn', { step: 'join_or_create', reason: 'neither Join nor Create button found', ...(await uiSnapshot(page)) });
  return true;
}

// ── Step 1 — Customize profile ────────────────────────────────────────────────
async function stepCustomizeProfile(page, { onStatus }) {
  const txt = await pageText(page);
  if (!/customize your profile|this is how you will appear|your name/i.test(txt)) return false;

  const name = randomName();
  const input = await firstVisible(page, [
    'input[type="text"]:not([readonly])',
    'input:not([type])',
    'input[placeholder*="name" i]',
  ]);
  if (input) {
    await safeFill(input, name);
  } else {
    onStatus('warn', { step: 'profile', reason: 'name input not found' });
  }
  if (!await waitAndClick(page, /^\s*(continue|next)\s*$/i, 6000)) {
    onStatus('warn', { step: 'profile', reason: 'continue not clicked', ...(await uiSnapshot(page)) });
  } else {
    onStatus('profile_set', { name });
  }
  return true;
}

// ── Step 2 — How do you want to use Notion? → For work ────────────────────────
async function stepHowToUse(page, { onStatus }) {
  const txt = await pageText(page);
  if (!/how do you want to use notion|for work|for personal life|for school/i.test(txt)) return false;

  const ok = await clickElementByText(page, /^\s*for work\b/i,
    ['button', '[role="button"]', '[role="radio"]', 'label', 'div[tabindex]']);
  if (!ok) {
    onStatus('warn', { step: 'use_case', reason: '"For work" tile not found', ...(await uiSnapshot(page)) });
  }
  await page.waitForTimeout(700);
  await waitAndClick(page, /^\s*(continue|next)\s*$/i, 6000);
  return true;
}

// ── Step 3 — Invite teammates ────────────────────────────────────────────────
async function stepInviteTeam(page, { email, onStatus }) {
  const txt = await pageText(page);
  if (!/who else is on your team|invite your team|add your team members|anyone with .* can join/i.test(txt)) return false;

  const peers = pickRandomInviteEmails(email, 10);
  if (peers.length) {
    let input = await firstVisible(page, [
      'input[placeholder*="email" i]',
      'input[type="email"]',
      'textarea',
      '[contenteditable="true"]',
    ]);

    // Newer UI hides the email field behind an "Add more or bulk invite" button.
    // Click it to reveal the input, then try again.
    if (!input) {
      const expanded = await clickByText(page, /^\s*(add more or bulk invite|invite by email|add email)\s*$/i);
      if (expanded) {
        await page.waitForTimeout(700);
        input = await firstVisible(page, [
          'input[placeholder*="email" i]',
          'input[type="email"]',
          'textarea',
          '[contenteditable="true"]',
        ]);
      }
    }

    if (input) {
      await input.click({ delay: 30 }).catch(() => {});
      for (const p of peers) {
        await page.keyboard.type(p, { delay: 15 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
      }
      onStatus('invites_typed', { count: peers.length });
    } else {
      onStatus('warn', { step: 'invite', reason: 'no email input', ...(await uiSnapshot(page)) });
    }
  } else {
    onStatus('invites_skipped', { reason: 'no peers in DB' });
  }

  const ok = await waitAndClick(page, /^\s*(invite and continue|invite|send invites|continue|skip|take me to notion|done|next)\s*$/i, 8000);
  if (!ok) {
    onStatus('warn', { step: 'invite', reason: 'no forward CTA', ...(await uiSnapshot(page)) });
    await waitAndClick(page, /skip/i, 2000);
  }
  return true;
}

// ── Step 3.5 — Generic "skip" promo screens ──────────────────────────────────
//
// Notion injects assorted promo / onboarding-extra screens between invite and
// plan: Desktop App, "Free Setup Session", mobile-app push, integrations,
// "What do you want to build first?", etc. The shape is consistent — they
// always offer a `Skip for now` (or `Maybe later` / `Not now`) escape hatch.
// We detect them by the presence of that escape CTA AND the absence of any
// plan/profile/invite signal (so we don't accidentally swallow real steps),
// then click Skip. Cheap, future-proof, and avoids whack-a-mole on each new
// promo Notion adds.
async function stepSkipPromo(page, { onStatus }) {
  const txt = await pageText(page);

  // Bail out if this is actually one of the named steps in disguise.
  if (/customize your profile|how do you want to use|who else is on your team|choose your plan|join teammates or create|card number|payment method/i.test(txt)) {
    return false;
  }

  // Quick scan: is there a Skip-style button visible?
  const hasSkip = await clickElementByText(
    page,
    /^\s*(skip for now|maybe later|skip|not now|continue without|i'?ll do this later|do this later)\s*$/i,
    ['button', '[role="button"]', 'a']
  );
  if (!hasSkip) return false;

  onStatus('skip_promo_screen', { snippet: txt.slice(0, 160) });
  return true;
}

// ── Step 4 — Choose plan ─────────────────────────────────────────────────────
//
// If we have a card, we pick the Business *free trial* (the dashboard's whole
// reason for asking the user for a card). If we don't, we pick the Free plan.
// Several tile/CTA layouts have been seen — try each before giving up.
async function stepChoosePlan(page, { onStatus, card }) {
  const txt = await pageText(page);
  if (!/choose your plan|select the best notion experience|free trial|per\s*month/i.test(txt)) return false;

  const wantTrial = !!(card && card.number);
  onStatus('plan_screen', { wantTrial });

  if (wantTrial) {
    // Notion's wording shifts often. Observed in the wild:
    //   "Try free for 30 days"     ← latest as of 2026-05
    //   "Start free trial" / "Start your free trial"
    //   "Try for free" / "Start trial"
    //   "Try Business free"
    //   "Get started" / "Continue with Business"
    const ctas = [
      /^\s*try\s+free\s+for\s+\d+\s*days?\s*$/i,                 // ← new wording
      /^\s*(start (your )?free trial|try for free|start trial|try business free|start free trial)\s*$/i,
      /^\s*(get started|continue with business|choose business)\s*$/i,
    ];
    for (const re of ctas) {
      if (await waitAndClick(page, re, 3000)) return true;
    }
    if (await clickElementByText(page, /^\s*business\s*$/i, ['button', '[role="button"]', '[role="radio"]', 'div[tabindex]'])) {
      await page.waitForTimeout(600);
      // After picking the Business tile the CTA may simply be Continue.
      const after = [
        /^\s*try\s+free\s+for\s+\d+\s*days?\s*$/i,
        /^\s*(continue|next|start free trial|try for free|start trial)\s*$/i,
      ];
      for (const re of after) {
        if (await waitAndClick(page, re, 4000)) return true;
      }
    }
    onStatus('warn', { step: 'plan', reason: 'trial CTA not found', ...(await uiSnapshot(page)) });
    return true;
  }

  const freeCtas = [
    /^\s*(get started for free|continue with free|start free|use free|stay on free)\s*$/i,
    /^\s*free\s*$/i,
  ];
  for (const re of freeCtas) {
    if (await waitAndClick(page, re, 3000)) {
      await page.waitForTimeout(500);
      await waitAndClick(page, /^\s*(continue|next)\s*$/i, 3000);
      return true;
    }
  }
  onStatus('warn', { step: 'plan', reason: 'free CTA not found', ...(await uiSnapshot(page)) });
  return true;
}

// ── Step 4b — Confirm Business trial ─────────────────────────────────────────
//
// After clicking "Try free for 30 days" on the plan screen, Notion shows a
// confirmation screen titled "Try Business for Free" with two CTAs:
//   - Start Notion Business trial   ← we want this
//   - Stay on Free plan
// This is where Notion sometimes asks for the cardholder name (Name /
// Business name fields). The actual Stripe card number form appears AFTER
// clicking "Start Notion Business trial" — handled by stepEnterCard.
async function stepConfirmTrial(page, { onStatus, card }) {
  const txt = await pageText(page);
  if (!/try business for free|start notion business trial|stay on free plan/i.test(txt)) return false;
  if (!card || !card.number) {
    // No card configured — bail to free plan to avoid a dead-end Stripe form.
    onStatus('plan_fallback_free', { reason: 'no card on confirmation screen' });
    if (await waitAndClick(page, /^\s*stay on free plan\s*$/i, 4000)) return true;
  }

  onStatus('plan_confirm_screen', {});

  // The confirmation card sometimes shows a "Name" input (cardholder full
  // name) and a "Business name (optional)" input. Fill the visible Name
  // input with the cardholder name; leave business name blank.
  if (card && card.name) {
    const nameInp = await firstVisible(page, [
      'input[placeholder*="name" i]:not([placeholder*="business" i])',
      'input[name*="name" i]:not([name*="business" i])',
      'input[type="text"]:not([readonly])',
    ]);
    if (nameInp) await safeFill(nameInp, card.name);
  }

  if (!await waitAndClick(page, /^\s*start notion business trial\s*$/i, 6000)) {
    onStatus('warn', { step: 'plan_confirm', reason: 'Start Business trial CTA not found', ...(await uiSnapshot(page)) });
  }
  return true;
}

// ── Step 5 — Enter card details ──────────────────────────────────────────────
//
// Notion's billing UI uses Stripe Elements: the inputs live inside cross-origin
// iframes (one each for number / expiry / CVC, sometimes one for ZIP). Plain
// `page.fill('input[name=cardnumber]')` won't work because the input isn't in
// the main frame. We enumerate every frame, grab the first visible matching
// input per slot, and type into it.
async function stepEnterCard(page, { onStatus, card }) {
  const txt = await pageText(page);
  if (!/card number|expiration|expiry|cvc|cvv|billing|payment method|add (a )?payment/i.test(txt)) return false;

  if (!card || !card.number) {
    onStatus('warn', { step: 'card', reason: 'card screen reached but no card configured' });
    await waitAndClick(page, /^\s*(skip|skip for now|maybe later)\s*$/i, 3000);
    return true;
  }

  // Cardholder name (in main frame).
  if (card.name) {
    const nameInput = await firstVisibleAnyFrame(page, [
      'input[name*="cardholder" i]',
      'input[placeholder*="name on card" i]',
      'input[placeholder*="cardholder" i]',
      'input[autocomplete="cc-name"]',
    ]);
    if (nameInput) await safeFill(nameInput, card.name);
  }

  const ok = await fillStripeFields(page, card, onStatus);
  if (!ok) {
    onStatus('warn', { step: 'card', reason: 'failed to fill Stripe fields', ...(await uiSnapshot(page)) });
    return true;
  }

  if (card.zip) {
    const zip = await firstVisibleAnyFrame(page, [
      'input[name*="postal" i]',
      'input[name*="zip" i]',
      'input[placeholder*="zip" i]',
      'input[placeholder*="postal" i]',
      'input[autocomplete="postal-code"]',
    ]);
    if (zip) await safeFill(zip, card.zip);
  }
  if (card.country) {
    const countrySel = await firstVisible(page, ['select[name*="country" i]', 'select[autocomplete="country"]']);
    if (countrySel) {
      try { await countrySel.selectOption({ label: card.country }).catch(() => countrySel.selectOption(card.country)); } catch {}
    }
  }

  onStatus('card_filled', {});
  await page.waitForTimeout(800);
  if (!await waitAndClick(page, /^\s*(start (free )?trial|subscribe|continue|confirm|pay|submit|save card|add card|next)\s*$/i, 10000)) {
    onStatus('warn', { step: 'card', reason: 'submit CTA not found', ...(await uiSnapshot(page)) });
  }
  return true;
}

// Walk every frame and fill the three Stripe slots. Returns true if at least
// the card-number field was filled successfully.
async function fillStripeFields(page, card, onStatus) {
  const slots = [
    { key: 'number', val: String(card.number || '').replace(/\s+/g, ''),
      sels: ['input[name="cardnumber"]', 'input[autocomplete="cc-number"]', 'input[placeholder*="card number" i]', 'input[placeholder*="1234" i]'] },
    { key: 'expiry', val: card.expiry,
      sels: ['input[name="exp-date"]', 'input[autocomplete="cc-exp"]', 'input[placeholder*="MM" i]', 'input[placeholder*="expiry" i]'] },
    { key: 'cvc',    val: card.cvv,
      sels: ['input[name="cvc"]', 'input[autocomplete="cc-csc"]', 'input[placeholder*="cvc" i]', 'input[placeholder*="cvv" i]'] },
  ];

  let numFilled = false;
  for (const slot of slots) {
    if (!slot.val) continue;
    let found = null;
    for (const frame of page.frames()) {
      for (const sel of slot.sels) {
        try {
          const el = await frame.$(sel);
          if (el && await el.isVisible().catch(() => false)) { found = el; break; }
        } catch { /* frame may have detached */ }
      }
      if (found) break;
    }
    if (!found) {
      onStatus('warn', { step: 'card', reason: `${slot.key} field not found in any frame` });
      continue;
    }
    await safeFill(found, slot.val);
    if (slot.key === 'number') numFilled = true;
  }
  return numFilled;
}

// Helpers --------------------------------------------------------------------

async function pageText(page) {
  return ((await page.evaluate(() => document.body.innerText).catch(() => '')) || '').toLowerCase();
}

// Snapshot the page in a structured way for failure logs. Cheap to call.
async function uiSnapshot(page) {
  try {
    return await page.evaluate(() => ({
      url: location.href,
      snippet: document.body.innerText.replace(/\s+/g, ' ').slice(0, 240),
      buttons: [...new Set(Array.from(document.querySelectorAll('button, [role="button"], a'))
        .map(b => (b.innerText || b.getAttribute('aria-label') || '').trim())
        .filter(t => t && t.length < 60))].slice(0, 20),
    }));
  } catch { return { url: '', snippet: '', buttons: [] }; }
}

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    for (const h of await page.$$(sel)) {
      if (await h.isVisible().catch(() => false)) return h;
    }
  }
  return null;
}

// Like firstVisible but searches every frame (Stripe is cross-origin).
async function firstVisibleAnyFrame(page, selectors) {
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      try {
        for (const h of await frame.$$(sel)) {
          if (await h.isVisible().catch(() => false)) return h;
        }
      } catch { /* frame detached */ }
    }
  }
  return null;
}

// Fill an input robustly: clear then human-type so React's onChange fires
// (Stripe Elements ignore programmatic value mutation).
async function safeFill(handle, value) {
  try {
    await handle.click({ delay: 30 }).catch(() => {});
    await handle.fill('').catch(async () => {
      await handle.evaluate(el => { if ('value' in el) el.value = ''; el.focus && el.focus(); });
    });
    await handle.type(String(value), { delay: 25 });
  } catch { /* swallow — caller logs if it mattered */ }
}

// Click any element matching one of `kinds` whose innerText matches the regex.
async function clickElementByText(page, re, kinds) {
  for (const k of kinds) {
    for (const el of await page.$$(k)) {
      const t = ((await el.innerText().catch(() => '')) || '').trim();
      if (re.test(t) && await el.isVisible().catch(() => false)) {
        await el.click().catch(() => {});
        return true;
      }
    }
  }
  return false;
}

// Click the first visible button/role=button matching the regex. waitMs gives
// a short polling window for slightly delayed UIs.
async function waitAndClick(page, re, waitMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    if (await clickElementByText(page, re, ['button', '[role="button"]', 'a'])) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function clickByText(page, re) {
  return waitAndClick(page, re, 800);
}

// Pick up to `max` random Notion-account emails from the manager DB, excluding
// the one we're currently registering.
function pickRandomInviteEmails(selfEmail, max = 10) {
  let pool = [];
  try {
    const db = require('./db');
    pool = db.getAllNotionAccounts()
      .map(a => a && a.email)
      .filter(Boolean)
      .filter(e => e && e.toLowerCase() !== String(selfEmail || '').toLowerCase());
  } catch { /* DB optional */ }
  if (!pool.length) return [];

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, max);
}

// Read the saved Notion card from settings. Returns null if not configured.
function readSavedCard() {
  try {
    const db = require('./db');
    const raw = db.getSetting('notion_card');
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || !c.number) return null;
    return c;
  } catch { return null; }
}

// Create a tempmail address, working around the 3-per-IP free limit:
// try the given proxy first; if its IP quota is full, rotate through other
// active proxies; finally try a direct (no-proxy) attempt.
async function createAddressWithFallback(provider, primaryAgent, primaryProxy) {
  const attempts = [];
  if (primaryAgent) attempts.push(primaryAgent);

  // other active proxies as fallbacks
  try {
    const db = require('./db');
    const proxyMod = require('./proxy');
    const others = db.getAllProxies().filter(p => p.active && (!primaryProxy || p.id !== primaryProxy.id));
    for (const p of others) {
      const a = proxyMod.buildAgentForProxy(p);
      if (a) attempts.push(a);
    }
  } catch { /* ignore */ }

  attempts.push(null); // final: direct

  let lastErr = null;
  for (const agent of attempts) {
    try {
      return await mailbox.createAddress(provider, agent);
    } catch (e) {
      lastErr = e;
      // quota-full → try next IP; other errors also fall through to next
    }
  }
  throw lastErr || new Error('Не удалось создать адрес (все IP исчерпали лимит)');
}

async function findButton(page, labels) {
  for (const label of labels) {
    try {
      const btn = page.getByRole('button', { name: new RegExp(`^\\s*${escapeRe(label)}\\s*$`, 'i') });
      if (await btn.count()) {
        const first = btn.first();
        if (await first.isVisible().catch(() => false)) return first;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function waitForTokenCookie(context, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cookies = await context.cookies();
    const tok = cookies.find(c => c.name === 'token_v2');
    if (tok && tok.value) return tok.value;
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { loginWithOtp, registerAndSave, LOGIN_URL };

// ─── High-level: register + persist to the manager DB ──────────────────────────

// Picks a proxy (explicit id, or round-robin among active), runs the OTP login,
// and stores the resulting Notion account (email + token_v2 + cookies).
// Returns { id, email, ok }.
async function registerAndSave(opts = {}) {
  const db = require('./db');

  // Resolve a proxy: explicit proxyId, else first active proxy, else none.
  let proxy = null;
  if (opts.proxyId) proxy = db.getProxyById(opts.proxyId);
  if (!proxy) {
    const active = db.getAllProxies().filter(p => p.active);
    if (active.length) proxy = active[(Date.now() >>> 0) % active.length];
  }

  const result = await loginWithOtp({
    provider: opts.provider || 'tempmail',
    proxy,
    headless: opts.headless !== false,
    timeoutMs: opts.timeoutMs || 60_000,
    onStatus: opts.onStatus || (() => {}),
    card: opts.card || undefined,
  });

  const id = db.insertNotionAccount({
    email: result.email,
    token_v2: result.token_v2,
    cookies_json: JSON.stringify(result.cookies || []),
    proxy_id: proxy ? proxy.id : null,
    status: 'active',
    notes: 'auto-registered',
  });

  // Persist a full Playwright storageState so the profile manager can poll
  // / swap this account without touching the registration flow again.
  try {
    const np = require('./notion_profiles');
    np.writeProfile({ id }, {
      cookies: (result.cookies || []).map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        expires: typeof c.expires === 'number' ? c.expires : -1,
        httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax',
      })),
      origins: [],
    });
  } catch { /* best-effort — the manager will lazily bootstrap on first poll */ }

  // If no account is current yet, make this one current so the dashboard has
  // something to point at without manual intervention.
  if (!db.getCurrentNotionAccount()) db.setNotionCurrent(id);

  return { id, email: result.email, ok: true };
}
