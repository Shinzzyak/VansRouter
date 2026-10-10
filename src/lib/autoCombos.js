import { buildModelsList } from "@/sse/services/allowedModels.js";
import { getCombos, getComboById, createCombo, updateCombo } from "@/lib/localDb";
import { invalidateAllowedModelsCache } from "@/sse/services/allowedModels.js";

// Auto-generated combos (9router-go parity: POST /api/combos/auto-free and
// /api/combos/auto-family).
//
// Both build their member list from the SAME catalog the router publishes, so a
// generated combo can never reference a model this instance cannot reach: only
// providers with a live connection and models the operator has not disabled
// appear here. Rebuild is an explicit call (never a side effect of a connection
// change) because it overwrites operator edits to the generated row.

const LLM_KIND = "llm";

/** Stable ids so a rebuild upserts the same row instead of piling up copies. */
export const AUTO_FREE_COMBO_ID = "auto-free-tier";
export const AUTO_FREE_COMBO_KIND = "auto-free";
export const AUTO_FAMILY_COMBO_KIND = "auto-family";

/** A family with one member has nothing to fall back to. */
export const MIN_FAMILY_MEMBERS = 2;

/**
 * The free-tier naming convention: ":free" / "/free" / "-free" also lands on
 * embedding, image, tts and stt models, so the kind gate matters — a combo that
 * cannot serve a chat turn must never enter a fallback chain.
 */
export function isFreeTierModelId(modelId) {
  if (typeof modelId !== "string" || !modelId) return false;
  const tail = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  return tail.endsWith(":free") || tail.endsWith("-free") || tail.endsWith("/free");
}

/**
 * Normalized family of a model id: provider prefix dropped, free marker and
 * trailing version / size / quant / date noise stripped, so the same model
 * across providers (and its variants) group together.
 *
 * Heuristic on purpose — it only decides which auto combos get *offered*, and
 * an operator can rename or delete any generated row.
 */
export function modelFamily(modelId) {
  if (typeof modelId !== "string" || !modelId) return "";
  let s = modelId.slice(modelId.lastIndexOf("/") + 1).toLowerCase();
  s = s.replace(/:free$|-free$/, "");
  const noise = /^(v?\d+(\.\d+)*|latest|preview|instruct|chat|thinking|reasoning|\d{4}-\d{2}-\d{2}|\d{1,4}b|\d+x\d+b|q\d.*|\d{3,4}k)$/;
  let parts = s.split(/[-_]/);
  while (parts.length > 1 && noise.test(parts[parts.length - 1])) parts.pop();
  return parts.join("-");
}

/** Every "alias/model" id of a live LLM the router can actually serve. */
export async function usableLlmModelIds() {
  const data = await buildModelsList([LLM_KIND], { skipDynamicFetch: true });
  return (data || [])
    .filter((m) => (m.kind || LLM_KIND) === LLM_KIND)
    .map((m) => m.id)
    .filter((id) => typeof id === "string" && id.includes("/") && !id.startsWith("combo/"))
    .sort();
}

/** Free-tier members, stable order so a rebuild yields a diffable list. */
export async function freeTierComboModels() {
  const ids = await usableLlmModelIds();
  return ids.filter(isFreeTierModelId);
}

/** Family -> member ids, only for families with something to fall back to. */
export async function usableModelFamilies() {
  const ids = await usableLlmModelIds();
  const groups = new Map();
  for (const id of ids) {
    const family = modelFamily(id);
    if (!family) continue;
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(id);
  }
  const out = {};
  for (const [family, members] of groups) {
    if (members.length < MIN_FAMILY_MEMBERS) continue;
    out[family] = members.sort();
  }
  return out;
}

function autoFamilyComboId(family) {
  const safe = family.replace(/[/:\s]+/g, "-");
  return `${AUTO_FAMILY_COMBO_KIND}-${safe}`;
}

/** Upsert one generated row; returns "created" or "updated". */
async function upsertCombo(id, name, kind, models) {
  const existing = await getComboById(id);
  if (!existing) {
    await createCombo({ id, name, kind, models });
    return "created";
  }
  await updateCombo(id, { name, kind, models });
  return "updated";
}

/**
 * (Re)build the single free-tier combo. Returns { id, models, action }.
 * Throws when there is nothing free to chain — a combo of zero models is worse
 * than no combo.
 */
export async function rebuildAutoFreeCombo() {
  const models = await freeTierComboModels();
  if (models.length === 0) {
    const err = new Error("no free-tier models found among connected providers");
    err.status = 409;
    throw err;
  }
  const action = await upsertCombo(AUTO_FREE_COMBO_ID, "Auto Free Tier", AUTO_FREE_COMBO_KIND, models);
  invalidateAllowedModelsCache();
  return { id: AUTO_FREE_COMBO_ID, name: "Auto Free Tier", models, action };
}

/** (Re)build one fallback combo per usable family. */
export async function rebuildAutoFamilyCombos() {
  const groups = await usableModelFamilies();
  const created = [];
  for (const family of Object.keys(groups).sort()) {
    await upsertCombo(autoFamilyComboId(family), `Auto: ${family}`, AUTO_FAMILY_COMBO_KIND, groups[family]);
    created.push(family);
  }
  if (created.length > 0) invalidateAllowedModelsCache();
  return { families: created, count: created.length };
}

/** Generated rows only — used by the dashboard to badge them. */
export async function listGeneratedCombos() {
  const combos = await getCombos();
  return (combos || []).filter(
    (c) => c.kind === AUTO_FREE_COMBO_KIND || c.kind === AUTO_FAMILY_COMBO_KIND,
  );
}
