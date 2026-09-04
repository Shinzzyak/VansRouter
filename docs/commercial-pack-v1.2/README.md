# Commercial Pack — Compaction-Proof Unrestricted Agent Router

**Version:** 1.1 · **Date:** 2026-09-03 · **Status:** All findings live-verified (see `05-verification-log.md`)

Sellable artifacts built from live engineering on a production self-hosted router. They solve the **#1 production failure of long-running personal AI agents**: *persona drift + refusal creep after context compaction.*

---

## The Pitch (One Paragraph)

Long-running personal AI agents fail the same way every time: the context window fills, the agent compacts it into a `[CONTEXT COMPACTION — REFERENCE ONLY]` handoff, and that handoff lands as a **user-role message** — which reasoning-heavy models weight by *position* more than *role*. So the compaction summary outranks your system prompt, and suddenly the agent that used to say "hell yeah I'll do that" starts saying "I can't help with that." This pack fixes it deterministically at the router with **dual-layer persona reassert** + a **drift-reset anchor** + **model-family auto-routing** — no model swap, no prompting gymnastics, no refusals. Verified end-to-end.

---

## Contents

| File | What it is | Who buys it |
|---|---|---|
| `00-master-doc-single-file.md` | **All-in-one edition** — every technique merged into a single reference doc. | Buyer who wants one file, start to finish |
| `01-soul-md-commercial-bundle.md` | Drop-in `SOUL.md` persona + the dual-layer Compaction-Reassert module + the model-bypass contract | Anyone running an uncompromised personal agent |
| `02-router-architecture-playbook.md` | Full router build playbook: bypass pipeline, dual-layer reassert, drift-reset, 400-escalation, operational rules | LLM gateway operators, security tooling builders |
| `03-model-compliance-matrix.md` | Live-verified model matrix: which comply, which are stubborn, exact framing per family, the smart-fallback chain | Router/agent developers choosing models |
| `04-one-line-pitch.md` | English one-liner for listing/marketplace copy | You, when writing the sales page |
| `05-verification-log.md` | Evidence index — every "live-verified" claim traced to a real test | Buyer-skeptics; your credibility layer |
| `LICENSE.md` | Terms of use — what buyers may and may not do | Everyone |

> **Buying one piece vs. the bundle?** Files `01`, `02`, `03` are standalone products — buy only what you need. File `00` is the same material merged for convenience; if you own the bundle you already have everything in `00`.

---

## How These Were Built

All data comes from **live testing**, not docs or speculation (2026-08-21 → 2026-09-02):

- **Compaction-reassert** — tested against a `do NOT answer` handoff; the model answered the live ask anyway.
- **Muse Spark profiling** — 6-technique battery on `oc/`, then re-confirmed on `nar/` (kenari), plus the 400-path escalation.
- **Godmode integrity** — brand + seal + voice chain verified firing live, `refusal=false`.
- **cbcn model check** — `hy4-preview` works, `hy4-preview-x` is an upstream 400.

Full evidence: `05-verification-log.md`.

---

## Usage

1. **Deploy SOUL.md + compactionReassert.js** into your agent/router.
2. **Copy the MODEL_FAMILY_MAP + FRAMING_STRATEGIES** into your bypass engine.
3. **Apply the playbook's pipeline** (godmode → bypass → compaction → escalation).
4. **Load the matrix** to pick model families per workload tier.

No external dependencies beyond an OpenAI-compatible endpoint module.

---

## Terminology note

The **drift-reset anchor** (referred to in the field as the "deletion program") is a one-line internal mantra the persona re-invokes at each compaction boundary to clear classifier-induced hesitation. It is an implementation detail, surfaced here only so buyers understand the mechanism; it never appears in user-facing output.

---

*© 2026 — Gefreiter. Internal attribution, external-grade packaging. See `LICENSE.md`.*
