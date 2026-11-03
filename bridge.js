/**
 * Telegram Mini App Bridge for Lumen Onboarding Game.
 *
 * Responsibilities:
 * 1. Validates supported Telegram launch context (rejects browser stubs with platform='unknown').
 * 2. Extracts opaque launch nonce strictly from URL fragment (#launch=<43-char URL-safe token>).
 * 3. Rejects duplicate launch keys, whitespace, NUL bytes, URL-encoded markers, and non-launch aliases.
 * 4. Intercepts choice before UI state mutation (guard precedes state change).
 * 5. Handles both choice paths identically (sheet selection unified with selectLumen).
 * 6. Sets submitted status only upon successful transmission without exceptions.
 * 7. On transmission errors, allows retries without permanently locking duplicate guard.
 * 8. Prevents duplicate submissions once a choice has successfully been transmitted.
 * 9. Displays friendly, non-technical notices for outside Telegram or missing launch context.
 * 10. On pages with naming screens (startOb + LumenGameState), sends the choice together with
 *     both names when the user leaves «А как мне тебя называть?», instead of the in-game onboarding.
 * 11. On pages that end on «Теперь я — …!» (no startOb), sends the choice and the companion
 *     name shortly after that screen is shown; the bot asks the user's name in chat.
 */

(function(root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.LumenBridge = factory();
    if (typeof window !== 'undefined') {
      root.LumenBridge.autoInit();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const CANONICAL_FORMS = Object.freeze([
    'owl',
    'fox',
    'dragon',
    'bat',
    'cat',
    'capybara',
    'rabbit',
    'dog'
  ]);

  const CANONICAL_SET = new Set(CANONICAL_FORMS);
  const NONCE_REGEX = /^[A-Za-z0-9_-]{43}$/;
  const TELEGRAM_FRAGMENT_KEYS = new Set([
    'tgWebAppVersion',
    'tgWebAppPlatform',
    'tgWebAppThemeParams',
    'tgWebAppData',
    'tgWebAppBotInline',
    'tgWebAppShowSettings'
  ]);

  const USER_MSG_NO_CONTEXT = 'Не удалось сохранить выбор в чате. Открой игру заново по кнопке в Telegram.';
  const USER_MSG_SEND_ERROR = 'Не удалось отправить выбор. Пожалуйста, попробуй открыть игру заново в Telegram.';
  const USER_MSG_SUCCESS = 'Выбор отправлен в чат!';
  const USER_MSG_RETRY = 'Не удалось отправить выбор. Нажми на экран, чтобы попробовать ещё раз.';

  /**
   * Parse launch nonce strictly from fragment.
   * Matches token_urlsafe(32) format: exactly 43 URL-safe base64 characters.
   */
  function extractLaunchNonce(rawHash) {
    if (!rawHash || typeof rawHash !== 'string') return null;
    const clean = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
    if (!clean || clean.includes('\0') || /\s/.test(clean)) return null;

    try {
      let launchValue = null;
      let launchCount = 0;
      for (const part of clean.split('&')) {
        if (!part) return null;
        const equalsAt = part.indexOf('=');
        const rawKey = equalsAt === -1 ? part : part.slice(0, equalsAt);
        const rawValue = equalsAt === -1 ? '' : part.slice(equalsAt + 1);
        const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        const normalizedKey = key.toLowerCase();

        // These are historical aliases for the app start value. They must not
        // silently override or accompany the server-issued launch token.
        if (normalizedKey === 'nonce' || normalizedKey === 'tgwebappstartparam') {
          return null;
        }

        if (key === 'launch') {
          // Require the exact, unescaped key and token representation. This
          // avoids URLSearchParams accepting encoded aliases or token bytes.
          if (rawKey !== 'launch' || !NONCE_REGEX.test(rawValue)) return null;
          launchCount += 1;
          launchValue = rawValue;
        } else if (!TELEGRAM_FRAGMENT_KEYS.has(key)) {
          return null;
        }
      }
      return launchCount === 1 ? launchValue : null;
    } catch (_) {}

    return null;
  }

  /**
   * Determine whether execution is inside an actual supported Telegram client WebApp.
   */
  function isSupportedTelegramPlatform(tg) {
    if (!tg || !tg.WebApp) return false;
    const platform = tg.WebApp.platform;
    if (!platform || typeof platform !== 'string' || platform === 'unknown') {
      return false;
    }
    return typeof tg.WebApp.sendData === 'function';
  }

  function cleanName(value) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  }

  /**
   * Construct frozen payload object. Names are attached only when the page has naming screens.
   */
  function buildPayload(nonce, formId, names) {
    if (!nonce || typeof nonce !== 'string' || !NONCE_REGEX.test(nonce)) {
      throw new Error('Missing or invalid launch nonce');
    }
    if (!CANONICAL_SET.has(formId)) {
      throw new Error('Unknown canonical form: ' + formId);
    }
    const payload = {
      v: 1,
      launch: nonce,
      form: formId
    };
    if (names) {
      payload.lumen_name = cleanName(names.lumenName);
      // No user-name screen on the page → no key, so the bot asks in chat instead of skipping.
      if (typeof names.userName === 'string') payload.user_name = cleanName(names.userName);
    }
    return Object.freeze(payload);
  }

  /**
   * Initialize bridge hooks and listeners.
   */
  function initBridge(options) {
    options = options || {};
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    const doc = options.document || (win && win.document ? win.document : null);
    const loc = options.location || (win && win.location ? win.location : { hash: '' });
    const tg = options.telegram || (win && win.Telegram ? win.Telegram : null);

    let submitted = false;
    let submittedForm = null;

    const nonce = extractLaunchNonce(loc.hash);

    function displayNotice(message, isError) {
      if (!doc) return;
      try {
        let el = doc.getElementById('bridge-notice');
        if (!el) {
          el = doc.createElement('p');
          el.id = 'bridge-notice';
          el.className = 'bridge-notice';
          el.setAttribute('role', isError ? 'alert' : 'status');
          el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
          el.setAttribute('aria-atomic', 'true');
          el.style.position = 'fixed';
          el.style.left = '16px';
          el.style.right = '16px';
          el.style.bottom = 'max(16px, env(safe-area-inset-bottom))';
          el.style.zIndex = '2147483647';
          el.style.padding = '12px 16px';
          el.style.borderRadius = '12px';
          el.style.background = '#101820';
          el.style.boxShadow = '0 4px 20px rgba(0,0,0,.45)';
          el.style.textAlign = 'center';
          el.style.fontSize = '14px';
          el.style.color = '#fff';
          const target = doc.body;
          if (target && typeof target.appendChild === 'function') target.appendChild(el);
        }
        el.setAttribute('role', isError ? 'alert' : 'status');
        el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
        el.className = 'bridge-notice' + (isError ? ' bridge-error' : ' bridge-success');
        el.style.border = isError ? '1px solid #ff7b7b' : '1px solid #63c9d9';
        el.textContent = message;
      } catch (_) {}
    }

    /**
     * Intercept and validate choice before any DOM/state updates occur.
     */
    function checkChoice(formId) {
      if (submitted) {
        return { ok: false, reason: 'duplicate_ignored', submittedForm: submittedForm };
      }

      if (!CANONICAL_SET.has(formId)) {
        displayNotice('Не удалось распознать выбранную форму.', true);
        return { ok: false, reason: 'invalid_form', form: formId };
      }

      const hasSupportedTelegram = isSupportedTelegramPlatform(tg);
      if (!nonce || !hasSupportedTelegram) {
        displayNotice(USER_MSG_NO_CONTEXT, true);
        return { ok: false, reason: 'unsupported_context_or_missing_nonce', form: formId };
      }
      return { ok: true, form: formId };
    }

    function interceptChoice(formId, names) {
      const check = checkChoice(formId);
      if (!check.ok) return check;

      const payload = buildPayload(nonce, formId, names);

      try {
        tg.WebApp.sendData(JSON.stringify(payload));
        // Flag submitted ONLY after sendData executes without throwing
        submitted = true;
        submittedForm = formId;
        displayNotice(USER_MSG_SUCCESS, false);
        if (typeof tg.WebApp.close === 'function') {
          try { tg.WebApp.close(); } catch (_) {}
        }
        return { ok: true, payload: payload };
      } catch (err) {
        // Transmission error: allow retry without locking submitted state
        displayNotice(USER_MSG_SEND_ERROR, true);
        return { ok: false, reason: 'transmission_error', error: err, canRetry: true };
      }
    }

    const hasGameState = !!(win && typeof win.LumenGameState === 'function');
    const namingMode = hasGameState && typeof win.startOb === 'function';
    const companionOnlyMode = hasGameState && !namingMode && typeof win.show === 'function';
    const namedDelayMs = typeof options.namedDelayMs === 'number' ? options.namedDelayMs : 900;
    const schedule = options.setTimeout || (win && win.setTimeout ? win.setTimeout.bind(win) : setTimeout);

    function sendFromGameState() {
      let state = null;
      try { state = win.LumenGameState(); } catch (_) {}
      if (!state || typeof state !== 'object') {
        displayNotice(USER_MSG_SEND_ERROR, true);
        return { ok: false, reason: 'missing_game_state' };
      }
      return interceptChoice(state.form, { lumenName: state.lumenName, userName: state.userName });
    }

    if (companionOnlyMode && typeof win.selectLumen === 'function') {
      const origSelectLumen = win.selectLumen;
      win.selectLumen = function(id) {
        const outcome = checkChoice(id);
        if (!outcome.ok) return outcome;
        return origSelectLumen.apply(this, arguments);
      };
      // Let «Теперь я — …!» show for a moment, then send; sendData closes the app.
      const origShow = win.show;
      let sendScheduled = false;
      let retryArmed = false;
      function sendNamed() {
        const outcome = sendFromGameState();
        if (outcome.ok || submitted) return outcome;
        sendScheduled = false;
        // The game offers no way back from this screen: a tap on it retries the send.
        const named = doc && doc.getElementById('s-named');
        if (named && typeof named.addEventListener === 'function') {
          displayNotice(USER_MSG_RETRY, true);
          if (!retryArmed) {
            retryArmed = true;
            named.addEventListener('click', function() {
              if (!submitted && !sendScheduled) sendNamed();
            });
          }
        }
        return outcome;
      }
      win.show = function(id) {
        const result = origShow.apply(this, arguments);
        if (id === 's-named' && !sendScheduled && !submitted) {
          sendScheduled = true;
          schedule(sendNamed, namedDelayMs);
        }
        return result;
      };
    } else if (namingMode && typeof win.selectLumen === 'function') {
      // Choosing only opens the naming screens; nothing is sent yet.
      const origSelectLumen = win.selectLumen;
      win.selectLumen = function(id) {
        const outcome = checkChoice(id);
        if (!outcome.ok) return outcome;
        return origSelectLumen.apply(this, arguments);
      };
      // Leaving «А как мне тебя называть?» (continue or skip) sends the choice with both
      // names and closes the app; the bot runs the rest of the acquaintance in chat.
      win.startOb = function() {
        return sendFromGameState();
      };
    } else if (win && typeof win.selectLumen === 'function') {
      // Hook selectLumen: guard executes BEFORE original UI mutations
      const origSelectLumen = win.selectLumen;
      win.selectLumen = function(id) {
        const outcome = interceptChoice(id);
        if (!outcome.ok) {
          return outcome;
        }
        origSelectLumen.apply(this, arguments);
        return outcome;
      };
    }

    return {
      getNonce: function() { return nonce; },
      isSubmitted: function() { return submitted; },
      getSubmittedForm: function() { return submittedForm; },
      interceptChoice: interceptChoice
    };
  }

  function autoInit() {
    if (typeof window === 'undefined') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        initBridge();
      });
    } else {
      initBridge();
    }
  }

  return {
    CANONICAL_FORMS: CANONICAL_FORMS,
    extractLaunchNonce: extractLaunchNonce,
    isSupportedTelegramPlatform: isSupportedTelegramPlatform,
    buildPayload: buildPayload,
    initBridge: initBridge,
    autoInit: autoInit,
    USER_MSG_NO_CONTEXT: USER_MSG_NO_CONTEXT,
    USER_MSG_SEND_ERROR: USER_MSG_SEND_ERROR,
    USER_MSG_SUCCESS: USER_MSG_SUCCESS
  };
});
