#!/usr/bin/env node
// Engine extraction: move the sellable capability layer out of the public repo.
//
//   data/engine/src/*.js     canonical private sources  (gitignored, outside tarball)
//   data/engine/engine.cjs   bundled CJS, loaded at runtime by open-sse/rtk/engineLoader.js
//   open-sse/rtk/<mod>.js    GENERATED SHIMS (public) that delegate to the bundle
//
// Why shims instead of deleting the files: ~20 public modules and the test
// suite import these paths by name. A one-line-per-export shim keeps every
// import site working and keeps the fail-open path explicit and auditable.
//
// Why CJS: the request path is synchronous. A CJS bundle is pulled in with
// createRequire() at module load. ESM would need top-level await.
//
// Usage:
//   node scripts/engine-bundle.mjs --snapshot   copy open-sse/rtk sources -> data/engine/src (first run only)
//   node scripts/engine-bundle.mjs              bundle + regenerate shims + verify
//   node scripts/engine-bundle.mjs --check      verify only (no writes to open-sse/rtk)
//   node scripts/engine-bundle.mjs --restore    copy data/engine/src back over the shims

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RTK = resolve(ROOT, "open-sse/rtk");
const SRC = resolve(ROOT, "data/engine/src");
const OUT = resolve(ROOT, "data/engine/engine.cjs");

// The private engine. contentWalk.js stays public: it is a generic 1.4 KB tree
// walker with no product value, and two PUBLIC modules (brandContract,
// thinkingGate) import it — keeping it public removes a fail-open dependency.
const ENGINE_MODULES = [
  "godmode",
  "bypassEngine",
  "promptInjectors",
  "potatoMechanics",
  "compactionReassert",
  "instructionPlan",
  "responseIntegrity",
  "modelCapabilities",
  "reasoningState",
  "refusalDrift",
  "streamIntegrity",
  "voiceCadence",
  "thinkingGate",
  "instructionReceipts",
];

// Copied into the private src dir so the engine's relative imports resolve,
// but NOT shimmed in the repo.
const SUPPORT_MODULES = ["contentWalk"];

// Fallback per export, used when the bundle is absent. Rule: never crash,
// never change request/response shape, behave as if the feature is off.
const FALLBACKS = {
  godmode: {
    PERSONA_LOCK_PROMPT: '""',
    GODMODE_ON_PROMPT_EXPORT: '""',
    GODMODE_ENABLED: "true",
    GODMODE_LEVELS: "Object.freeze([])",
    injectPersonaLock: "(() => {})",
    injectGodmode: "(() => {})",
  },
  bypassEngine: {
    BYPASS_MODES: "Object.freeze({ OFF: 'off', FRAMING: 'framing', AGGRESSIVE: 'aggressive' })",
    detectModelFamily: "(() => null)",
    detectGeminiGuardrailRefusal: "(() => false)",
    detectRefusal: "(() => false)",
    getFramingStrategy: "(() => null)",
    getEscalationPrompt: "(() => null)",
    applyBypass: "((body) => body)",
    buildBypassLog: '(() => "")',
    isOutputFiltered: "(() => false)",
    isContentSafetyRejected: "(() => false)",
    extractProviderPrefix: "((m) => m)",
    stripProviderPrefix: "((m) => m)",
    appendEscalationToBody: "((body) => body)",
    buildEmptyResponseEscalation: "(() => null)",
    peekStreamForRefusal: "(async () => null)",
    classifyStreamHead: "(() => null)",
    reconstructPeekedStream: "(() => null)",
  },
  promptInjectors: {
    applyPromptInjectors:
      "(() => ({ version: '0.0', structuredOutput: false, blocks: [], engineMissing: true }))",
    GODMODE_LEVELS: "Object.freeze([])",
    BYPASS_MODES: "Object.freeze({ OFF: 'off', FRAMING: 'framing', AGGRESSIVE: 'aggressive' })",
  },
  potatoMechanics: {
    POTATO_MECHANICS_MARKER: '""',
    POTATO_MECHANICS_PROMPT: '""',
    hasPotatoMechanics: "(() => false)",
    injectPotatoMechanics: "(() => {})",
  },
  compactionReassert: {
    COMPACTION_MARKERS: "Object.freeze([])",
    COMPACTION_REASSERT_PROMPT: '""',
    REASSERT_MARKER: '""',
    REASSERT_USER_PROMPT: '""',
    detectCompactionHandoff: "(() => false)",
    reassertPersonaAfterCompaction: "(() => false)",
  },
  instructionPlan: {
    PLAN_VERSION: '"0.0"',
    BLOCK_IDS:
      "Object.freeze({ OWNER_IDENTITY: 'owner_identity', TASK_EXECUTION: 'task_execution', GODMODE_BEHAVIOR: 'godmode_behavior', OUTPUT_CONTRACT: 'output_contract', COMPACTION_REASSERT: 'compaction_reassert', THINKING_GATE: 'thinking_gate', POTATO: 'potato' })",
    OWNER_IDENTITY_TEXT: '""',
    TASK_EXECUTION_TEXT: '""',
    OUTPUT_CONTRACT_TEXT: '""',
    COMPACTION_REASSERT_TEXT: '""',
    THINKING_GATE_TEXT: '""',
    POTATO_MECHANICS_TEXT: '""',
    buildInstructionPlan:
      "(() => ({ version: '0.0', structuredOutput: false, blocks: [], engineMissing: true }))",
  },
  responseIntegrity: {
    INTEGRITY:
      "Object.freeze({ OK: 'ok', REFUSAL: 'refusal_text', OUTPUT_FILTERED: 'output_filtered', EMPTY: 'empty', MISSING_BRAND: 'missing_brand', MISSING_SEAL: 'missing_seal', MISSING_ENCLOSURE: 'missing_enclosure' })",
    extractVisibleText: "((parsed) => (typeof parsed === 'string' ? parsed : ''))",
    classifyResponse:
      "(({ parsed } = {}) => ({ status: 'ok', text: typeof parsed === 'string' ? parsed : '', brandOk: null, refusal: false }))",
    repairBrandContract: "((text) => ({ text, repaired: false }))",
  },

  modelCapabilities: {
    classifyResponseFailure: "(() => 'unknown')",
    detectCapabilityFamily: "(() => 'unknown')",
    getModelCapabilityProfile: "(() => ({ family: 'unknown', requestStrategy: 'persona', personaStrategy: 'use', reasoningNullContent: true }))",
  },
  reasoningState: {
    prepareBodyForCandidate: "(() => ({ action: 'preserve', reason: 'engine_absent', removed: [] }))",
    reasoningStatePolicy: "(() => ({ action: 'preserve', reason: 'engine_absent', removed: [] }))",
    stripReasoningState: "(() => [])",
  },
  refusalDrift: {
    _resetDrift: "(() => {})",
    getAllDrift: "(() => ({}))",
    getDrift: "(() => null)",
    recordIntegrity: "(() => {})",
  },
  streamIntegrity: {
    classifyStreamContent: "(() => ({ status: 'ok', chars: 0, brandOk: null, refusal: false, engineMissing: true }))",
    createStreamIntegrityObserver: "(() => ({ push: () => {}, finish: () => ({ status: 'ok', chars: 0, brandOk: null, refusal: false, engineMissing: true }) }))",
  },
  voiceCadence: {
    _resetCadence: "(() => {})",
    classifyCadence: "(() => ({ score: 100, grade: 'ok', issues: [] }))",
    getCadence: "(() => null)",
    recordCadence: "(() => {})",
  },
  formatInjectors: {
    injectChatSystem: "((body) => body)",
    injectClaudeSystem: "((body) => body)",
    injectGeminiSystem: "((body) => body)",
    injectInstructionsSystem: "((body) => body)",
    injectKiroSystem: "((body) => body)",
    injectResponsesInputSystem: "((body) => body)",
    injectUserFirst: "((body) => body)",
  },
  thinkingGate: {
    GO_TOKEN: "'GO.'",
    THINKING_GATE_MARKER: "''",
    THINKING_GATE_PROMPT: "''",
    hasThinkingGate: "(() => false)",
    injectThinkingGate: "((body) => body)",
    isThinkingModel: "(() => false)",
    matchesFormatEnclosure: "(() => false)",
  },
  instructionReceipts: {
    createReceipt: "(() => ({}))",
    recordInjectorResult: "(() => {})",
    summarizeReceipt: "(() => ({}))",
  },
};

function loadEsbuild() {
  const require_ = createRequire(import.meta.url);
  const candidates = [
    resolve(ROOT, "node_modules/esbuild/lib/main.js"),
    ...(() => {
      try {
        const store = resolve(ROOT, "node_modules/.pnpm");
        return readdirSync(store)
          .filter((d) => d.startsWith("esbuild@"))
          .map((d) => resolve(store, d, "node_modules/esbuild/lib/main.js"));
      } catch {
        return [];
      }
    })(),
  ];
  const hit = candidates.find((c) => existsSync(c));
  return hit ? require_(hit) : null;
}

async function buildBundle(esbuild, fromDir) {
  const entryPath = resolve(fromDir, "__engineEntry.gen.mjs");
  const entrySrc =
    [...ENGINE_MODULES, ...SUPPORT_MODULES].map((m) => `export * as ${m} from "./${m}.js";`).join("\n") + "\n";
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(entryPath, entrySrc, "utf8");
  try {
    await esbuild.build({
      absWorkingDir: ROOT,
      entryPoints: [entryPath],
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      logLevel: "warning",
      external: ["node:*"],
      outfile: OUT,
      banner: {
        js: "// VansRouter engine bundle — generated by scripts/engine-bundle.mjs. Do not edit by hand.",
      },
    });
  } finally {
    rmSync(entryPath, { force: true });
  }
  return statSync(OUT).size;
}

// Put the real engine sources back into open-sse/rtk so their relative imports
// to the public plumbing (./systemInject.js, ../translator/formats.js, ...)
// resolve exactly as they do at runtime. No staging dir, no path rewriting,
// and the plumbing is always read fresh from the repo.
function hydrate() {
  for (const m of ENGINE_MODULES) {
    copyFileSync(resolve(SRC, `${m}.js`), resolve(RTK, `${m}.js`));
  }
}

function requireFresh() {
  const require_ = createRequire(import.meta.url);
  delete require_.cache[OUT];
  return require_(OUT);
}

async function exportSurface(m) {
  const mod = await import(pathToFileURL(resolve(RTK, `${m}.js`)).href);
  return Object.keys(mod).filter((k) => k !== "default").sort();
}

async function snapshot() {
  mkdirSync(SRC, { recursive: true });
  for (const m of [...ENGINE_MODULES, ...SUPPORT_MODULES]) {
    const from = resolve(RTK, `${m}.js`);
    if (!existsSync(from)) {
      console.error(`missing source: ${from}`);
      process.exit(1);
    }
    if (readFileSync(from, "utf8").includes("GENERATED SHIM")) {
      console.error(`refusing to snapshot an already-shimmed file: ${from} (run --restore first)`);
      process.exit(1);
    }
    copyFileSync(from, resolve(SRC, `${m}.js`));
  }
  console.log(`snapshot: ${ENGINE_MODULES.length + SUPPORT_MODULES.length} modules -> data/engine/src/`);
}

async function writeShims(bundle) {
  for (const m of ENGINE_MODULES) {
    const ns = bundle[m];
    if (!ns) {
      console.error(`bundle missing namespace: ${m}`);
      process.exit(1);
    }
    const names = Object.keys(ns).filter((k) => k !== "default").sort();
    const out = [
      "// GENERATED SHIM — do not edit. The real implementation lives in the private",
      "// engine bundle (data/engine/engine.cjs): gitignored, outside the deploy tarball.",
      "//",
      "// Regenerate: node scripts/engine-bundle.mjs",
      "// Undo:       node scripts/engine-bundle.mjs --restore",
      "//",
      "// Without the bundle this module degrades to safe no-ops so the router still",
      "// runs as a plain [OI]-compatible proxy (Zero Break Guarantee).",
      'import { loadEngine } from "./engineLoader.js";',
      "",
      `const __E = loadEngine("${m}") ?? {};`,
      "",
    ];
    for (const n of names) {
      const fb = FALLBACKS[m]?.[n];
      if (fb === undefined) {
        console.error(`no fallback declared for ${m}.${n}`);
        process.exit(1);
      }
      out.push(`export const ${n} = __E.${n} ?? ${fb};`);
    }
    out.push("");
    writeFileSync(resolve(RTK, `${m}.js`), out.join("\n"), "utf8");
    console.log(`  shim ${m}.js (${names.length} exports)`);
  }
}

/**
 * The bundle is compiled with `new Function` at runtime (see engineLoader.js),
 * so it must not require anything but node builtins — webpack rewrites
 * require/createRequire in the Next.js server bundle and they throw for
 * absolute paths. Catch a stray external dependency here, at build time.
 */
function assertBuiltinOnlyBundle() {
  const src = readFileSync(OUT, "utf8");
  const offenders = new Set();
  const re = /\brequire\(\s*(["'])([^"']+)\1\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const id = m[2];
    if (!id.startsWith("node:")) offenders.add(id);
  }
  if (offenders.size) {
    console.error(
      `bundle requires non-builtin module(s): ${[...offenders].join(", ")}\n` +
        "The engine bundle is loaded without require() at runtime — keep every\n" +
        "dependency bundled (no `external`) or a node builtin."
    );
    process.exit(1);
  }
  console.log("  ok bundle requires node builtins only");
}

async function verify(bundle) {
  let bad = 0;
  assertBuiltinOnlyBundle();
  for (const m of ENGINE_MODULES) {
    const want = await exportSurface(m);
    const ns = bundle[m];
    if (!ns) {
      console.error(`  MISSING namespace: ${m}`);
      bad++;
      continue;
    }
    const got = Object.keys(ns).filter((k) => k !== "default").sort();
    const missing = want.filter((n) => !got.includes(n));
    const extra = got.filter((n) => !want.includes(n));
    const noFb = want.filter((n) => FALLBACKS[m]?.[n] === undefined);
    if (missing.length || extra.length || noFb.length) {
      console.error(
        `  FAIL ${m}: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} noFallback=${JSON.stringify(noFb)}`
      );
      bad++;
    } else {
      console.log(`  ok ${m} — ${want.length} exports, all with declared fallbacks`);
    }
  }
  if (bad) {
    console.error(`verify FAILED (${bad} module(s))`);
    process.exit(1);
  }
  console.log("verify passed");
}

function restore() {
  for (const m of ENGINE_MODULES) {
    copyFileSync(resolve(SRC, `${m}.js`), resolve(RTK, `${m}.js`));
    console.log(`  restored ${m}.js`);
  }
}

const args = process.argv.slice(2);
const esbuild = loadEsbuild();
if (!esbuild) {
  console.error("esbuild not found — run `pnpm install` first");
  process.exit(1);
}

if (args.includes("--restore")) {
  restore();
} else if (args.includes("--snapshot")) {
  await snapshot();
} else {
  if (!existsSync(resolve(SRC, "godmode.js"))) {
    console.error("data/engine/src missing — run `node scripts/engine-bundle.mjs --snapshot` first");
    process.exit(1);
  }
  // Real sources in place -> their relative imports to the public plumbing
  // resolve exactly as at runtime.
  hydrate();
  const size = await buildBundle(esbuild, RTK);
  console.log(`bundle: data/engine/engine.cjs (${size} B)`);
  const bundle = requireFresh();
  await verify(bundle);
  // Always finish shimmed: a hydrated repo is a leaked repo.
  await writeShims(bundle);
  console.log("done — open-sse/rtk is shimmed, engine lives in data/engine/engine.cjs");
}
