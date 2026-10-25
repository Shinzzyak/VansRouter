import { emptyReplyKind } from "./emptyReason.js";
const cases = [
  ["reasoning ate the cap", { choices: [{ message: { content: "", reasoning_content: "x".repeat(400) }, finish_reason: "length" }] }, "length"],
  ["hidden upstream failure", { choices: [{ message: { content: "" }, finish_reason: null }] }, "null"],
  ["visible answer", { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }, null],
  ["tool-call turn", { choices: [{ message: { content: "", tool_calls: [{ id: "1" }] }, finish_reason: "tool_calls" }] }, null],
  ["claude-style text block", { choices: [{ message: { content: [{ type: "text", text: "hi" }] } , finish_reason: "stop" }] }, null],
];
let bad = 0;
for (const [name, body, want] of cases) {
  const got = emptyReplyKind(body);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
console.log(bad === 0 ? "ALL PASS" : `${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
