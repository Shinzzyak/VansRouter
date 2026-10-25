// K228: shim harus me-resolve bundle saat DIPANGGIL, bukan saat diimpor.
//
// Kenapa: versi lama menulis `const __E = loadEngine(m) ?? {}` di baris atas modul.
// Kalau shim diimpor pada jendela di mana bundle sedang tidak ada (deploy yang
// menulis bundle setelah boot, atau berkas yang di-rename sementara oleh tes lain),
// __E terkunci ke fallback no-op SELAMANYA — fitur engine mati sampai proses
// di-restart, tanpa satu pun error. Di CI ini muncul sebagai 3 tes merah di
// engine-ledger-signal-quality: firstLevel menjawab T2 (default) padahal family
// xai seharusnya T1.
//
// Tes ini membuktikan sifat itu tanpa menyentuh berkas repo: shim + loader
// disalin ke direktori sementara, bundle disalin ke <tmp>/data/engine/engine.cjs,
// lalu child process me-rename bundle keluar SEBELUM import, mengimpor shim, dan
// memanggilnya lagi setelah bundle kembali. Shim eager => "after" tetap T2.

import { describe, it, expect } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { engineBundlePath } from "open-sse/rtk/engineLoader.js";

const ROOT = resolve(__dirname, "../..");
const RTK = resolve(ROOT, "open-sse/rtk");
const BUNDLE = engineBundlePath();

describe("shim: resolusi bundle terjadi per panggilan", () => {
  it("import saat bundle hilang tidak mengunci fallback selamanya", () => {
    if (!BUNDLE || !existsSync(BUNDLE)) return; // gate hanya berlaku bila bundle ada

    const tmp = mkdtempSync(join(tmpdir(), "k228-"));
    try {
      mkdirSync(join(tmp, "rtk"), { recursive: true });
      mkdirSync(join(tmp, "data/engine"), { recursive: true });
      copyFileSync(resolve(RTK, "engineLoader.js"), join(tmp, "rtk/engineLoader.js"));
      copyFileSync(resolve(RTK, "selfMeasuringBypass.js"), join(tmp, "rtk/selfMeasuringBypass.js"));
      copyFileSync(BUNDLE, join(tmp, "data/engine/engine.cjs"));

      writeFileSync(
        join(tmp, "child.mjs"),
        [
          'import { renameSync } from "node:fs";',
          "const P = process.env.P;",
          'renameSync(P, P + ".hidden");',
          "const S = await import(process.env.SHIM);",
          'const during = S.firstLevel("gcli/grok-4.6");',
          'renameSync(P + ".hidden", P);',
          'const after = S.firstLevel("gcli/grok-4.6");',
          "console.log(JSON.stringify({ during, after }));",
        ].join("\n"),
        "utf8"
      );

      const out = execFileSync(process.execPath, [join(tmp, "child.mjs")], {
        cwd: tmp,
        encoding: "utf8",
        env: { ...process.env, P: join(tmp, "data/engine/engine.cjs"), SHIM: join(tmp, "rtk/selfMeasuringBypass.js") },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const got = JSON.parse(out.trim().split("\n").pop());

      expect(got.during).toBe("T2"); // jendela miss: fallback, bukan crash
      expect(got.after).toBe("T1"); // bundle kembali: implementasi nyata dipakai
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
});
