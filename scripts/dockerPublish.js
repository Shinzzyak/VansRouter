#!/usr/bin/env node

// Build & push multi-platform Docker image to Docker Hub.
// Requires: docker login + buildx (Docker Desktop ships with it).
// Usage: node app/scripts/dockerPublish.js

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const IMAGE = "decolua/9router";
const PLATFORMS = "linux/amd64,linux/arm64";
const BUILDER = "9router-builder";

const appDir = path.resolve(__dirname, "..");
const cliPkgPath = path.resolve(appDir, "cli", "package.json");
const version = JSON.parse(fs.readFileSync(cliPkgPath, "utf8")).version;
const tag = `v${version}`;

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: appDir, ...opts });
}

console.log(`\n🐳 Publishing ${IMAGE}:${tag} (${PLATFORMS}) to Docker Hub...\n`);

// Verify docker login by checking config
try {
  const cfg = path.join(process.env.HOME || "", ".docker", "config.json");
  if (fs.existsSync(cfg)) {
    const json = JSON.parse(fs.readFileSync(cfg, "utf8"));
    if (!json.auths || Object.keys(json.auths).length === 0) {
      console.error("❌ Not logged in to Docker Hub. Run: docker login");
      process.exit(1);
    }
  }
} catch {}

// Ensure buildx builder exists with multi-arch support
try {
  execSync(`docker buildx inspect ${BUILDER}`, { stdio: "ignore", cwd: appDir });
  console.log(`✅ Builder "${BUILDER}" exists`);
} catch {
  console.log(`🔧 Creating buildx builder "${BUILDER}"...`);
  run(`docker buildx create --name ${BUILDER} --driver docker-container --use`);
  run(`docker buildx inspect --bootstrap`);
}

// Build + push multi-platform image
run(
  `docker buildx build --builder ${BUILDER} --platform ${PLATFORMS} ` +
  `-t ${IMAGE}:${tag} -t ${IMAGE}:latest --push .`
);

console.log(`\n✅ Published:`);
console.log(`   - ${IMAGE}:${tag}`);
console.log(`   - ${IMAGE}:latest`);
console.log(`🔗 https://hub.docker.com/r/${IMAGE.replace("/", "/")}`);
