import { applyPrefillFlags, prefillFlag, prefillText, stripEchoedPrefill } from "./prefill.js";
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

// K227 — prefill echo (gateway closed the assistant turn).
check("prefillText reads the tail", prefillText(asst), "Here is");
check("prefillText ignores a user tail", prefillText({ messages: [{ role: "user", content: "x" }] }), null);

check("echo stripped", stripEchoedPrefill("1, 2,", "1, 2, 3"), { echoed: true, text: "3" });
check("echo stripped across whitespace", stripEchoedPrefill("Here is\n", "Here is the answer"), { echoed: true, text: "the answer" });
check("clean continuation untouched", stripEchoedPrefill("1, 2,", "3"), { echoed: false, text: "3" });
check("restart without the prefix untouched", stripEchoedPrefill("1, 2,", "Sure — one, two"), { echoed: false, text: "Sure — one, two" });
check("prefix-only reply untouched", stripEchoedPrefill("1, 2,", "1, 2,"), { echoed: false, text: "1, 2," });
check("empty reply untouched", stripEchoedPrefill("1, 2,", ""), { echoed: false, text: "" });

console.log(bad === 0 ? "ALL PASS" : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
