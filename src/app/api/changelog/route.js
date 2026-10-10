import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

// GET /api/changelog — the release notes this build shipped with (9router-go
// parity). Served as markdown straight from the file in the deployment, so the
// notes a buyer reads are the notes that came with the build they are running,
// not whatever upstream has published since.
export async function GET() {
  const candidates = [
    path.join(process.cwd(), "CHANGELOG.md"),
    path.join(process.cwd(), "docs", "CHANGELOG.md"),
  ];
  for (const file of candidates) {
    try {
      const markdown = fs.readFileSync(file, "utf8");
      if (!markdown.trim()) continue;
      return new Response(markdown, {
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
      });
    } catch {
      // try the next location
    }
  }
  return Response.json({ error: "No changelog bundled with this build" }, { status: 404 });
}
