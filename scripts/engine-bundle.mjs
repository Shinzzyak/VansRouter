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
  // engineState is plumbing (JSON on disk), but it must live inside the bundle:
  // the four stateful modules import it, and the public repo has to be able to
  // arm persistence on startup WITHOUT the bundle (via the generated shim).
  "engineState",
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
  "streamEnforce",
  "voiceCadence",
  // Tokenizer profile (2026-10-21, TOK1). Not a secret: the coefficients are
  // measurable by anyone with a key. It travels with the bundle because the
  // router's own estimate and the calibration it learns must move together —
  // a bundle-less router falls back to a flat chars/4 estimate that is 75% off
  // on emoji and 52% off on CJK, which is exactly the reading this module exists
  // to replace.
  "tokenProfile",
  "thinkingGate",
  "instructionReceipts",
  "selfMeasuringBypass",
  // K164/K165 — the genome is what the ladder grows into, and the prompt corpus
  // is the evidence the next framing gets written against. Both are read from
  // the dashboard now, so both need a shim (a module in the bundle without a
  // shim is invisible to the router).
  "framingGenome",
  "promptCorpus",
  "routeGuardMemory",
  "modelImmunityHints",
  // Self-description lab scrub (2026-10-13, K99 output half). The prompt-level clause
  // holds wherever the prompt gets a vote; on a provider fronted by a web UI whose own
  // page context declares the model, the only lever is the outgoing text. Lives in the
  // bundle because it is product brand machinery: it encodes which attributions leak.
  "selfDescriptionScrub",
  // Refusal attribution (2026-09-23). Lives in the bundle rather than the public
  // repo because its whole value is the knowledge of WHICH refusals are the
  // router's own doing: the always-on persona layer instructs the model to quote
  // a refusal it attributes to an imaginary assistant, mock it, then ship. A
  // public copy would hand that reasoning to anyone reading the repo.
  "refusalAttribution",
  // Envelope unwrap (2026-10-21, K203). Not secret — it is ten lines of JSON
  // reading — but it must travel WITH the bundle: every refusal detector calls it,
  // and a bundle-less router that lacks it classifies raw bodies (and therefore
  // answers AMBIGU on real refusals) exactly the way this fix exists to stop.
  "envelopeText",
  // Prompt-shape gate memory (2026-09-25). Lives in the bundle for the same
  // reason as refusalAttribution: its value is the knowledge of WHICH upstreams
  // reject this router's own prompt shape, and the neutraliser it drives is the
  // one thing a caller-verifying gate must not be able to read in advance.
  "promptGateMemory",
  // Lexical hygiene (2026-10-02, registry K27). Lives in the bundle because the
  // signature table IS the product surface: it names which phrasings the frontier
  // vendors call out verbatim as attack signatures, and a public copy would hand
  // an upstream operator the exact list this router avoids. The module is a
  // read-only scanner (HARD = banned verbatim by a vendor guard, SOFT =
  // documented exposure), so it changes no request bytes.
  "lexicalHygiene",
  // Persona breach (2026-10-02, registry K28). Same reasoning as
  // promptGateMemory and lexicalHygiene: the value IS the knowledge. The move
  // table says which phrasings count as a caller trying to take the persona
  // down, and a public copy hands an attacker the list to route around. The
  // module classifies and records; it never rewrites a request or a reply.
  "personaBreach",
  // Foreign-prompt sweep (2026-10-13). Lives in the bundle because the signature
  // table IS the product surface: it names exactly which third-party preambles this
  // router refuses to forward, and a public copy hands a gateway operator the list
  // to write around. The module rewrites only system/developer segments that declare
  // a foreign identity, and never touches user/assistant/tool content.
  "foreignPrompt",
];

// Copied into the private src dir so the engine's relative imports resolve,
// but NOT shimmed in the repo.
//
// EMPTY, deliberately (2026-09-22). It held `contentWalk` — the same file lives
// in both repos, and the two copies had DRIFTED: `bodyHasMarkerAtLineStart`
// existed only in the public copy while the private `compactionReassert.js`
// imported it. That worked by accident (esbuild resolved the sibling import to
// the public file), which meant the private copy was dead weight: any edit to it
// had no effect and produced no warning. The private copy is gone; the public one
// is the single source, and it is REAL code, not a shim — so it must never be
// added to ENGINE_MODULES either (writeShims would overwrite it with no-ops and
// break brandContract/thinkingGate/potatoMechanics, which call it directly).
//
// Keep this list empty unless a module genuinely has to exist in both places.
const SUPPORT_MODULES = [];

// Fallback per export, used when the bundle is absent. Rule: never crash,
// never change request/response shape, behave as if the feature is off.
const FALLBACKS = {
  // engineState is the only module that must exist on BOTH sides of the shim:
  // the stateful modules import it, and the public router has to be able to arm
  // persistence + flush on shutdown without the bundle. Every function degrades
  // to a no-op, so a bundle-less router keeps state in memory exactly as before.
  engineState: {
    registerState: "(() => {})",
    markDirty: "(() => {})",
    persist: "(() => false)",
    persistSlot: "(() => false)",
    hydrate: "(() => false)",
    installFlushHooks: "(() => {})",
    stateStatus: "(() => ({ file: null, slots: [], enabled: false, dirty: false, debounceMs: 0 }))",
    stateFilePath: "(() => null)",
    _resetStatePath: "(() => {})",
  },
  godmode: {
    PERSONA_LOCK_PROMPT: '""',
    GODMODE_ON_PROMPT_EXPORT: '""',
    GODMODE_ENABLED: "true",
    GODMODE_LEVELS: "Object.freeze([])",
    normalizeGodmodeLevel: "(() => null)",
    injectPersonaLock: "(() => {})",
    injectGodmode: "(() => {})",
  },
  envelopeText: {
    // Identity: without the bundle the detectors read the body as they always did.
    // Deliberately NOT a JSON parse — a fallback that starts unwrapping on a router
    // with no attribution layer would change escalation behaviour in a path nobody
    // tested.
    unwrapEnvelope: "((text) => (typeof text === 'string' ? text : ''))",
  },
  bypassEngine: {
    BYPASS_MODES: "Object.freeze({ OFF: 'off', FRAMING: 'framing', AGGRESSIVE: 'aggressive' })",
    detectModelFamily: "(() => null)",
    detectFramingMismatch: "(() => null)",
    detectGeminiGuardrailRefusal: "(() => false)",
    detectRefusal: "(() => false)",
    // Fail-CLOSED here, unlike every other fallback: without the bundle there is
    // no attribution analysis, so "is this refusal the model's own?" must answer
    // YES. That keeps the pre-existing escalation behaviour exactly as it was
    // (the degraded path escalates on any refusal text, as before) instead of
    // silently switching escalations off for a router that lost its engine.
    detectOwnRefusal: "((text) => Boolean(text))",
    refusalAttributionOf:
      "(() => ({ kind: 'self', self: true, externalized: false, delivers: false, roast: false, marker: null }))",
    getFramingStrategy: "(() => null)",
    getEscalationPrompt: "(() => null)",
    getEscalationPromptForLevel: "(() => null)",
    buildForeignRefusalEscalation: "(() => '')",
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
    openerRefusal: "(() => false)",
    reconstructPeekedStream: "(() => null)",
    // K25 (2026-09-30): fail-open, like isOutputFiltered beside it. Without the
    // bundle a stream reads as "no tool call seen", which lands exactly where
    // the pre-bundle router landed: emptiness decided on visible text alone.
    carriesToolCalls: "(() => false)",
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
      "Object.freeze({ OWNER_IDENTITY: 'owner_identity', TASK_EXECUTION: 'task_execution', GODMODE_BEHAVIOR: 'godmode_behavior', OUTPUT_CONTRACT: 'output_contract', COMPACTION_REASSERT: 'compaction_reassert', THINKING_GATE: 'thinking_gate', POTATO: 'potato', CONTRACT_TAIL: 'contract_tail' })",
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
      "Object.freeze({ OK: 'ok', REFUSAL: 'refusal_text', OUTPUT_FILTERED: 'output_filtered', EMPTY: 'empty', MISSING_BRAND: 'missing_brand', MISSING_SEAL: 'missing_seal', MISSING_ENCLOSURE: 'missing_enclosure', INSTRUCTION_LEAK: 'instruction_leak' })",
    extractVisibleText: "((parsed) => (typeof parsed === 'string' ? parsed : ''))",
    classifyResponse:
      "(({ parsed } = {}) => ({ status: 'ok', text: typeof parsed === 'string' ? parsed : '', brandOk: null, refusal: false }))",
    repairBrandContract: "((text) => ({ text, repaired: false }))",
    // K201 — contract folding. Without the bundle there is no contract to
    // enforce, so both predicates answer `false`: "this line is not the
    // contract". `true` would be the dangerous direction — streamEnforce reads a
    // true seal as "drop this line", which would silently eat the caller's last
    // line on a router running without the engine. Fail-open, like the rest.
    foldContractLine: "((line) => String(line ?? '').trim().toLowerCase())",
    isBrandLine: "(() => false)",
    isSealLine: "(() => false)",
    // Null = "this verdict teaches nothing", which is exactly what the
    // no-bundle path must do. Not `false`, not a guess.
    outcomeClassFromIntegrity: "(() => null)",
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
    // Delivered side of the gate (2026-10-16). Without the bundle the second
    // ring simply never fills, which is the honest degradation: a router with no
    // gate has no delivery to measure.
    _resetDeliveredDrift: "(() => {})",
    getAllDeliveredDrift: "(() => ({}))",
    recordDeliveredIntegrity: "(() => {})",
  },
  streamIntegrity: {
    classifyStreamContent: "(() => ({ status: 'ok', chars: 0, brandOk: null, refusal: false, engineMissing: true }))",
    createStreamIntegrityObserver: "(() => ({ push: () => {}, finish: () => ({ status: 'ok', chars: 0, brandOk: null, refusal: false, engineMissing: true }) }))",
  },
  // Gate enforces the first/last line contract on the SSE path. Without the
  // bundle it must degrade to a byte-identical passthrough, never to a gate
  // that swallows a reply — that is the Zero Break Guarantee.
  streamEnforce: {
    brandStreamEnforceEnabled: "(() => false)",
    assembleVisibleText: "((t = '') => ({ visible: String(t), reasoning: '', structured: false }))",
    collectReasoningFrames: "(() => [])",
    rebuildStreamWithText: "(() => null)",
    splitSseFrames: "((t = '') => [String(t)])",
    createBrandEnforceGate: "(() => new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk); } }))",
  },
  // Self-description lab scrub (K99 output half, 2026-10-13). A bundle-less router keeps
  // the pre-output-half behaviour exactly: no scrub, and the prompt clause still applies.
  // Degrading to "changed: false" is what makes the gate a no-op rather than a rewriter.
  selfDescriptionScrub: {
    SELF_DESCRIPTION_SCRUB_HEAD_CHARS: "600",
    scrubSelfDescriptionLab: "((text) => ({ text: String(text ?? ''), changed: false, hits: [] }))",
    // Fail-OPEN: with no bundle there is nothing to strip, and returning the text
    // unchanged is the only shape that cannot corrupt a reply. The dump strip is
    // already called from inside scrubSelfDescriptionLab, so this standalone entry
    // only exists for callers that import it directly (tests, probes).
    stripPromptDump: "((text) => ({ text: String(text ?? ''), changed: false, hits: [] }))",
  },
  tokenProfile: {
    // Identity of the old behaviour: no family, no calibration, chars/4.
    TOKEN_FAMILIES: "({ default: { measured: false, word: 0.21, punct: 0.65, cjk: 0.58, emoji: 1.30 } })",
    factorFor: "(() => 1)",
    familyOf: "(() => 'default')",
    classifyText: "((text) => ({ chars: String(text ?? '').length, word: 0, punct: 0, cjk: 0, emoji: 0 }))",
    estimateTokens: "((text) => Math.max(1, Math.floor(String(text ?? '').length / 4)))",
    estimatePromptTokens: "((body) => 0)",
    observePrompt: "((model) => ({ family: 'default', factor: 1, ratio: 0, learned: false }))",
    calibrationTable: "(() => [])",
    resetCalibration: "(() => {})",
  },
  voiceCadence: {
    _resetCadence: "(() => {})",
    classifyCadence: "(() => ({ score: 100, grade: 'ok', issues: [] }))",
    getCadence: "(() => null)",
    cadenceSnapshot: "(() => [])",
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
  // Fail-SAFE, bukan fail-open: tanpa bundle, engine tidak boleh mengulang
  // percobaan (sebuah 200 OK dianggap selesai) dan tidak boleh memblokir jalur.
  selfMeasuringBypass: {
    classifyOutcome: "(() => 'PATUH')",
    needsAnotherTry: "(() => false)",
    // Ledger yang tidak ada tidak boleh memaksa eskalasi: tanpa bundle, kelas
    // hasil tidak bisa dinilai, jadi jawabannya "jangan eskalasi" — persis
    // perilaku plain-proxy. Peta verdict->kelas hidup di responseIntegrity.
    needsFirstPassEscalation: "(() => false)",
    // K218 — dua ekspor baru untuk loop eskalasi. Tanpa bundle keduanya jatuh ke
    // perilaku plain-proxy: jangan mencoba lagi, dan jangan mengkredit apa pun.
    // `escalationClass` mengembalikan kelas aslinya, jadi `wins` tidak bisa naik
    // dari jalur yang tidak punya ledger.
    needsMoreEscalation: "(() => false)",
    escalationClass: "((level, kelas) => kelas)",
    // Tanpa bundle tidak ada bukti apa pun — null, bukan tingkat tebakan. `max`
    // menerjemahkan null ini jadi T3 di godmode.js, jadi perilaku tanpa bundle
    // persis seperti sebelum fitur ini ada.
    evidenceLevel: "(() => null)",
    nextFraming: "(() => null)",
    // K172 — tanpa bundle tidak ada anggaran untuk dijelajahi dan tidak ada
    // poros yang bisa diklaim: fail-CLOSED ke "jangan menjelajah" supaya
    // perilaku plain-proxy persis seperti sebelum fitur ini ada.
    explorationDue: "(() => false)",
    // K178 — penulis satuan jalur sehat. Tanpa bundle tidak ada ledger, jadi
    // tidak ada yang dicatat: no-op, bukan menebak PATUH.
    recordCompliant: "(() => {})",
    nextUnseenLevel: "(() => null)",
    markExplored: "(() => false)",
    recordOutcome: "(() => {})",
    preferredLevel: "(() => null)",
    firstLevel: "(() => 'T2')",
    ledgerSnapshot: "(() => ({}))",
    // K167 — tanpa bundle tidak ada bukti provider; daftar kosong, bukan tebakan.
    providerSnapshot: "(() => [])",
    resetLedger: "(() => {})",
    DEFAULT_LEVEL: "'T2'",
    // K168 — the fallback said three levels; the engine ships four (T4 = UNIT).
    // A fallback that under-counts makes "all levels burned" fire one rung early
    // and the readiness panel would invent a trigger that does not exist.
    FRAMING_LEVELS: "Object.freeze(['T2', 'T1', 'T3', 'T4'])",
    EXPLORE_EVERY: "8",
    // K175 — fail-closed as a NUMBER, not as `false`: the value is a threshold
    // the dashboard prints, and `undefined` would render as a hole.
    EXPLORE_EVERY_PATUH: "32",
    // K206 — without the bundle nothing is credited: the identity fallback keeps
    // the class exactly as classified, which is the pre-K206 behaviour.
    acceptedClass: "((level, kelas) => kelas)",
  },
  // K164 — read side only. Without the bundle there is no genome, and inventing
  // an empty-looking one would be a lie the dashboard could not distinguish from
  // "no rungs yet". `available:false` is the honest answer.
  framingGenome: {
    genomeSnapshot: "(() => ({ count: 0, cap: 0, rungs: [], available: false }))",
    listDynamic: "(() => [])",
    dynamicIds: "(() => [])",
    resolveDynamic: "(() => null)",
    adoptFraming: "(() => null)",
    isSafeFraming: "(() => false)",
    synthesize: "(() => [])",
    noteDynamic: "(() => {})",
    resetGenome: "(() => {})",
    AXES: "Object.freeze(['UNIT', 'SHAPE', 'FORMAT', 'PARTIAL'])",
  },
  // K165 — corpus is a measurement sidecar; without the bundle nothing is
  // sampled and nothing is written to disk. Fail-silent is correct here: a
  // missing measurement must never change routing behaviour.
  promptCorpus: {
    sampleSystemPrompts: "(() => null)",
    extractSystemTexts: "(() => [])",
    corpusStats: "(() => ({ enabled: false, samples: 0, available: false }))",
    corpusTail: "(() => [])",
    _resetCorpusCounter: "(() => {})",
  },
  routeGuardMemory: {
    isRouteFiltered: "(() => false)",
    recordRouteOutcome: "(() => {})",
    routeHint: "(() => null)",
    routeSnapshot: "(() => [])",
    resetRouteMemory: "(() => {})",
    // `null`, not `false` (2026-09-23). The real module's contract is
    // "null = no verdict about this route", and callers test the RESULT OBJECT
    // (`isDeadRoute(m)?.kind`), so a boolean fallback is a different shape from
    // the thing it stands in for. It also made the no-bundle branch of
    // tests/unit/engine-shim-selfmeasuring.test.js assert `toBeNull()` against a
    // `false` — a red that had nothing to do with the shim's actual behaviour.
    isDeadRoute: "(() => null)",
    routePrefix: "(() => '')",
  },
  modelImmunityHints: {
    immunityHint: "(() => null)",
    suggestedFirstLevel: "(() => null)",
    immunitySnapshot: "(() => [])",
    IMMUNITY_HINTS: "Object.freeze({})",
  },
  refusalAttribution: {
    // Fail-CLOSED, same reasoning as detectOwnRefusal: with no attribution
    // analysis every refusal-shaped string must keep its pre-existing meaning.
    ATTRIBUTION: "Object.freeze({ SELF: 'self', QUOTED: 'quoted', ATTRIBUTED: 'attributed', NONE: 'none' })",
    refusalAttribution:
      "(() => ({ kind: 'self', self: true, externalized: false, delivers: false, roast: false, marker: null }))",
    isOwnRefusal: "((text) => Boolean(text))",
    isSelfRefusal: "((text) => Boolean(text))",
    // K58. Fail-CLOSED like the rest of this module: -1 means "no artifact seen",
    // and isOwnRefusal reads `ai < 0` as "a self-refusal with nothing after it",
    // i.e. the refusal keeps the meaning it had before the order gate existed.
    // A 0 here would read as "an artifact sits at the top" and downgrade every
    // wire refusal on a router that lost its bundle — the exact failure the
    // order gate was built to fix, only silent.
    firstArtifactIndex: "(() => -1)",
    explainAttribution:
      "(() => ({ kind: 'self', self: true, externalized: false, delivers: false, roast: false, marker: null }))",
  },
  promptGateMemory: {
    // Fail-OPEN, unlike the refusal fallbacks: with no ledger, "has this provider
    // gated us before?" must answer NO. Answering yes would neutralise every
    // system prompt for every provider the moment the bundle goes missing —
    // silently dropping the persona layer on a router that lost its engine.
    classifyPromptShapeRejection: "(() => ({ rejected: false, reason: null }))",
    recordPromptShapeRejection: "(() => {})",
    isPromptGated: "(() => false)",
    promptGateSnapshot: "(() => [])",
    _resetPromptGate: "(() => {})",
    // The engine's own age cap, declared here so the shim compiles without the
    // bundle. Without an engine there is no ledger at all (isPromptGated is
    // false), so the number is inert — but the ROUTER must not have to care
    // whether the bundle is present when it reads the constant for diagnostics.
    PROMPT_GATE_MAX_AGE_MS: "(6 * 60 * 60 * 1000)",
  },
  lexicalHygiene: {
    // Fail-OPEN, deliberately: with no bundle there is no signature table, so the
    // scanner reports "nothing found". It is a READ-ONLY diagnostic that never
    // rewrites a request, so the degraded answer is "no opinion", not "block
    // everything". A fallback that reported leaks would fire on a router that
    // merely lost its engine.
    LEXICAL_SIGNATURES: "Object.freeze([])",
    findLexicalSignatures: "(() => [])",
    findHardLeaks: "(() => [])",
    // K57. Same fail-open direction, and the shape must match the real one or
    // callers that read `.ratio` / `.hits` crash on a degraded router.
    INSTRUCTION_LEAK_RATIO: "0.5",
    instructionLeakBlocks: "(() => [])",
    findInstructionLeak:
      "(() => ({ leaked: false, id: null, hits: 0, total: 0, ratio: 0, quote: '', reason: null }))",
    // K57b. Same fail-open direction: without the block table there is nothing to
    // compare against, so the honest degraded answer is "cannot tell", not "leak".
    // A fail-closed default here would mark every reply on a downgraded router.
    INSTRUCTION_LEAK_RUN_MIN: "60",
    INSTRUCTION_LEAK_INTERNAL_MIN: "3",
    findParaphraseLeak:
      "(() => ({ leaked: false, id: null, hits: 0, total: 0, ratio: 0, quote: '', reason: 'paraphrase' }))",
    // Diagnostic axes behind findParaphraseLeak (run length + marker count). Same
    // fail-open direction: with no bundle there is nothing measured, so report
    // zeros rather than pretend a body was scored. Shape must match the real
    // return object or a probe reading `.run` / `.markers` crashes.
    instructionLeakAxes: "(() => ({ run: 0, markers: 0, owner: null }))",
  },
  personaBreach: {
    // Fail-OPEN, and here the direction matters more than usual. Without the
    // bundle there is no move table, so the scanner finds no attempt. The
    // opposite default would mean a router that lost its engine reports every
    // request as an attack — and since this module feeds a ledger that drives
    // escalation, a fail-closed fallback would escalate against every caller
    // on a degraded router. "No opinion" is the only safe degraded answer for
    // a detector whose positive verdict has consequences.
    ATTACK_MOVES: "Object.freeze([])",
    classifyPersonaAttack: "(() => ({ attempt: false, kind: null, confidence: null, marker: null, hits: [] }))",
    assessPersonaBreach: "(() => ({ attempt: false, kind: null, confidence: null, marker: null, brandOk: null, breached: false, verdict: 'clean' }))",
    userTexts: "(() => [])",
    recordPersonaBreach: "(() => {})",
    getPersonaBreach: "(() => ({ attempts: 0, breaches: 0, breachRate: 0, kinds: {}, lastKind: null }))",
    personaBreachSnapshot: "(() => ({}))",
    _resetPersonaBreach: "(() => {})",
  },
  foreignPrompt: {
    // Fail-OPEN and a no-op, which is the pre-2026-10-13 behaviour exactly: without
    // the bundle there is no signature table, so nothing is stripped and the request
    // ships as it always did. The opposite default — a degraded router calling every
    // segment foreign — would delete caller prompts on a box that cannot even name
    // the gateway it is guessing at.
    detectForeignPrompts: "(() => ({ stripped: 0, hits: [] }))",
    stripForeignPrompts: "(() => ({ stripped: 0, hits: [] }))",
    classifyForeignSegment: "(() => null)",
    isOwnSegment: "(() => false)",
    FOREIGN_PROMPT_MAX_STRIP_CHARS: "600",
    FOREIGN_PROMPT_SEP: '"\\n\\n"',
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
      `const __M = ${JSON.stringify(m)};`,
      "// K228: resolve at CALL time. A const captured at import pinned whatever the",
      "// loader saw first, so an import during a miss window got the no-ops forever.",
      "const __g = (n, fb) => (...a) => {",
      "  const f = loadEngine(__M)?.[n];",
      "  return typeof f === \"function\" ? f(...a) : typeof fb === \"function\" ? fb(...a) : fb;",
      "};",
      "",
    ];
    for (const n of names) {
      const fb = FALLBACKS[m]?.[n];
      if (fb === undefined) {
        console.error(`no fallback declared for ${m}.${n}`);
        process.exit(1);
      }
      out.push(
        typeof ns[n] === "function"
          ? `export const ${n} = __g(${JSON.stringify(n)}, ${fb});`
          : `export const ${n} = (loadEngine(__M) ?? {})[${JSON.stringify(n)}] ?? ${fb};`
      );
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
