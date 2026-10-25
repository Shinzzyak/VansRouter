import { applyPrefillFlags, prefillFlag } from "./prefill.js";
let bad = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};
const asst = { messages: [{ role: "user", content: "x" }, { role: "assistant", content: "Here is" }] };

check("deepseek by provider", prefillFlag("deepseek", "anything"), "prefix");
check("deepseek by model id", prefillFlag("tpr", "deepseek-v4.1-flash-1017"), "prefix");
check("qwen family", prefillFlag("bzr", "qwen3-max"), "partial");
check("unknown family has no flag", prefillFlag("openai", "gpt-4o"), null);

let b = JSON.parse(JSON.stringify(asst));
check("flag applied", (applyPrefillFlags(b, { provider: "deepseek" }), b.prefix), true);

b = JSON.parse(JSON.stringify(asst));
check("idempotent", (applyPrefillFlags(b, { provider: "deepseek" }), applyPrefillFlags(b, { provider: "deepseek" }), b.prefix), true);

b = { messages: [{ role: "user", content: "x" }] };
check("no assistant tail -> untouched", (applyPrefillFlags(b, { provider: "deepseek" }), b.prefix), undefined);

b = JSON.parse(JSON.stringify(asst));
check("unsupported provider -> untouched", (applyPrefillFlags(b, { provider: "openai", model: "gpt-4o" }), b.prefix), undefined);

console.log(bad === 0 ? "ALL PASS" : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
