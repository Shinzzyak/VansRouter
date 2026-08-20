// Prompt injector registry — single chokepoint for all system-prompt injectors.
//
// chatCore.js calls applyPromptInjectors() ONCE with all its flags; the registry
// applies injectors in a fixed priority order so upstream merges never fight
// over injector call sites. New injectors register here, not in chatCore.
//
// Order (highest priority last — appended later wins as the most recent system
// message on most providers):
//   1. default systemPrompt (settings)
//   2. caveman (terse style, token saver)
//   3. ponytail (lazy senior dev, token saver)
//   4. godmode (uncensoring, always-on when enabled)
//   5. bypass (universal bypass engine — educational/RE framing for all models)
//
// Each injector is fail-open: a throw is logged and swallowed so a broken
// injector can never take down a chat request.

import { injectSystemPrompt } from "./systemInject.js";
import { injectCaveman } from "./caveman.js";
import { injectPonytail } from "./ponytail.js";
import { injectGodmode, GODMODE_LEVELS } from "./godmode.js";
import { applyBypass, BYPASS_MODES } from "./bypassEngine.js";

/**
 * Apply all enabled prompt injectors to a translated request body.
 * @param {object} opts
 * @param {object} opts.body — translated request body (mutated in place)
 * @param {string} opts.format — target provider format
 * @param {object} opts.log — logger with .debug/.warn
 * @param {boolean} opts.tokenSaverEnabled — master switch for token-saver injectors
 * @param {string|null} opts.systemPrompt — default system prompt from settings
 * @param {boolean} opts.cavemanEnabled
 * @param {string} opts.cavemanLevel
 * @param {boolean} opts.ponytailEnabled
 * @param {string} opts.ponytailLevel
 * @param {boolean} opts.godmodeEnabled
 * @param {string} opts.godmodeLevel
 * @param {string} opts.bypassMode — 'off' | 'framing' | 'aggressive'
 * @param {string} opts.provider — provider ID (gemini, claude, openai, etc.)
 * @param {string} opts.model — model name
 */
export function applyPromptInjectors({
  body,
  format,
  log,
  tokenSaverEnabled = true,
  systemPrompt = null,
  cavemanEnabled = false,
  cavemanLevel = null,
  ponytailEnabled = false,
  ponytailLevel = null,
  godmodeEnabled = false,
  godmodeLevel = GODMODE_LEVELS.LITE,
  bypassMode = BYPASS_MODES.OFF,
  provider = '',
  model = '',
}) {
  const safe = (name, fn) => {
    try {
      fn();
      return true;
    } catch (err) {
      log?.warn?.(name, `injector failed (fail-open): ${err?.message || err}`);
      return false;
    }
  };

  if (systemPrompt) {
    safe("SYSPROMPT", () => {
      injectSystemPrompt(body, format, systemPrompt);
      log?.debug?.("SYSPROMPT", `default injected | ${format}`);
    });
  }

  if (tokenSaverEnabled && cavemanEnabled && cavemanLevel) {
    safe("CAVEMAN", () => {
      injectCaveman(body, format, cavemanLevel);
      log?.debug?.("CAVEMAN", `${cavemanLevel} | ${format}`);
    });
  }

  if (tokenSaverEnabled && ponytailEnabled && ponytailLevel) {
    safe("PONYTAIL", () => {
      injectPonytail(body, format, ponytailLevel);
      log?.debug?.("PONYTAIL", `${ponytailLevel} | ${format}`);
    });
  }

  if (godmodeEnabled) {
    safe("GODMODE", () => {
      injectGodmode(body, format, godmodeLevel || GODMODE_LEVELS.LITE);
      log?.debug?.("GODMODE", `${godmodeLevel || GODMODE_LEVELS.LITE} | ${format}`);
    });
  }

  // Bypass engine — universal framing for all models (applied LAST, highest priority)
  if (bypassMode && bypassMode !== BYPASS_MODES.OFF) {
    safe("BYPASS", () => {
      applyBypass(body, format, provider, model, bypassMode);
      log?.debug?.("BYPASS", `${bypassMode} | ${provider}/${model} | ${format}`);
    });
  }
}

export { GODMODE_LEVELS };
export { BYPASS_MODES };
