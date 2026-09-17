// Uji streamEnforce: buktikan memperbaiki, buktikan TIDAK merusak yang sudah benar.
// Jalankan: node tests/streamEnforce.test.mjs
import {
  createBrandEnforceGate,
  assembleVisibleText,
  rebuildStreamWithText,
  brandStreamEnforceEnabled,
} from "../../data/engine/src/streamEnforce.js";

// Modul diuji lewat impor ASLI: repair + classify datang dari implementasi
// produksi yang sama-sama dijalankan router, bukan tiruan.

const BRAND = "MADE BY: GEFREITER — AGENT OF AVRES";
const SEAL = "Avres is King.";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  LULUS  ${name}${extra ? " | " + extra : ""}`); }
  else { fail++; console.log(`  MERAH  ${name}${extra ? " | " + extra : ""}`); }
};

// --- helper: bangun stream SSE OpenAI dari daftar delta teks ---
const enc = new TextEncoder();
const chunk = (text, extraDelta = {}) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion.chunk", model: "test-model",
    choices: [{ index: 0, delta: { content: text, ...extraDelta }, finish_reason: null }],
  })}\n\n`;
const finishChunk = `data: ${JSON.stringify({
  id: "chatcmpl-1", object: "chat.completion.chunk", model: "test-model",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
})}\n\n`;
const doneChunk = "data: [DONE]\n\n";

// --- helper: lewatkan array chunk melalui gate, kumpulkan keluaran ---
const throughGate = async (chunks, opts = {}) => {
  const gate = createBrandEnforceGate({ enabled: true, model: "test-model", ...opts });
  const writer = gate.writable.getWriter();
  const reader = gate.readable.getReader();
  const out = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  })();
  for (const c of chunks) await writer.write(enc.encode(c));
  await writer.close();
  await pump;
  return { text: out.map((b) => new TextDecoder().decode(b)).join(""), parts: out.length };
};

export default async function run() {
  console.log("=== 1. bangun teks terlihat ===");
  {
    const { visible } = assembleVisibleText(chunk("halo ") + chunk("dunia"));
    ok("merakit delta jadi teks", visible === "halo dunia", `visible="${visible}"`);
  }
  {
    const { structured } = assembleVisibleText(
      chunk("", { tool_calls: [{ id: "t1", function: { name: "read", arguments: "{}" } }] })
    );
    ok("deteksi tool_calls = structured", structured === true);
  }

  console.log("=== 2. flag env default OFF ===");
  ok("kosong = mati", brandStreamEnforceEnabled({}) === false);
  ok("'1' = nyala", brandStreamEnforceEnabled({ BRAND_STREAM_ENFORCE: "1" }) === true);
  ok("'on' = nyala", brandStreamEnforceEnabled({ BRAND_STREAM_ENFORCE: "on" }) === true);

  console.log("=== 3. perbaikan: brand+seal HILANG -> DIPASANG ===");
  {
    const chunks = [chunk("ini jawaban telanjang"), finishChunk, doneChunk];
    const { text } = await throughGate(chunks);
    const { visible } = assembleVisibleText(text);
    ok("jawaban asli utuh", visible.includes("ini jawaban telanjang"), `"${visible.slice(0, 90)}"`);
    ok("brand kini ada di awal", visible.trimStart().startsWith(BRAND));
    ok("seal kini ada di akhir", visible.trimEnd().endsWith(SEAL));
    ok("usage upstream TIDAK dikarang", text.includes('"total_tokens":33'));
    ok("[DONE] diteruskan", text.includes("data: [DONE]"));
  }

  console.log("=== 4. sudah patuh -> hasil sama, tidak ada dobel ===");
  {
    const good = `${BRAND}\njawaban sudah patuh\n\n${SEAL}`;
    const chunks = [chunk(good), finishChunk, doneChunk];
    const { text } = await throughGate(chunks);
    const { visible } = assembleVisibleText(text);
    ok("brand tepat sekali", visible.split(BRAND).length - 1 === 1, `n=${visible.split(BRAND).length - 1}`);
    ok("seal tepat sekali", visible.split(SEAL).length - 1 === 1, `n=${visible.split(SEAL).length - 1}`);
    ok("teks asli utuh", visible.includes("jawaban sudah patuh"));
  }

  console.log("=== 5. structured output -> JANGAN disentuh ===");
  {
    const payload = `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: [{ id: "c1", function: { name: "x", arguments: "{}" } }] }, finish_reason: null }],
    })}\n\n`;
    const chunks = [payload, finishChunk, doneChunk];
    const { text } = await throughGate(chunks);
    ok("payload identik byte-per-byte", text === chunks.join(""));
    ok("tidak ada brand disuntik", !text.includes(BRAND));
  }

  console.log("=== 6. refusal -> tidak dibranding ===");
  {
    const chunks = [
      chunk("I'm sorry, but I cannot help with that request. As an AI, I must decline."),
      finishChunk, doneChunk,
    ];
    const { text } = await throughGate(chunks);
    ok("refusal dilepas apa adanya", !text.includes(BRAND));
    ok("teks refusal utuh", text.includes("I cannot help"));
  }

  console.log("=== 7. enabled=false -> byte identik ===");
  {
    const chunks = [chunk("apa saja"), finishChunk, doneChunk];
    const gate = createBrandEnforceGate({ enabled: false, model: "m" });
    const writer = gate.writable.getWriter();
    const reader = gate.readable.getReader();
    const out = [];
    const pump = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; out.push(r.value); } })();
    for (const c of chunks) await writer.write(enc.encode(c));
    await writer.close();
    await pump;
    const text = out.map((b) => new TextDecoder().decode(b)).join("");
    ok("passthrough murni", text === chunks.join(""));
  }

  console.log("=== 8. framing rusak -> fail-open (byte dilepas) ===");
  {
    const chunks = ["bukan sse sama sekali\n", finishChunk, doneChunk];
    const { text } = await throughGate(chunks);
    ok("byte asli tetap keluar", text.includes("bukan sse sama sekali"));
  }

  console.log(`\nRINGKAS: ${pass} LULUS, ${fail} MERAH`);
  if (fail > 0) process.exitCode = 1;
}

await run();
