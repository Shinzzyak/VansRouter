#!/usr/bin/env node

// Build Docker image locally for current platform (test/dev).
// Usage: node app/scripts/dockerBuild.js

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const IMAGE = "decolua/9router";
const appDir = path.resolve(__dirname, "..");
const cliPkgPath = path.resolve(appDir, "cli", "package.json");
const version = JSON.parse(fs.readFileSync(cliPkgPath, "utf8")).version;
const tag = `v${version}`;

console.log(`\n🐳 Building ${IMAGE}:${tag} (local platform)...\n`);

try {
  execSync(
    `docker build -t ${IMAGE}:${tag} -t ${IMAGE}:latest .`,
    { stdio: "inherit", cwd: appDir }
  );
  console.log(`\n✅ Built ${IMAGE}:${tag} + ${IMAGE}:latest`);
  console.log(`▶️  Run: docker run --rm -p 20128:20128 -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data ${IMAGE}:${tag}`);
} catch (e) {
  console.error("❌ Docker build failed");
  process.exit(1);
}
