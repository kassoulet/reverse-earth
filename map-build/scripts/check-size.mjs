#!/usr/bin/env node
/**
 * Report and enforce the GitHub Pages storage budget.
 *
 *   node map-build/scripts/check-size.mjs --archive public/data/world.pmtiles
 *   node map-build/scripts/check-size.mjs dist --require-data
 *
 * The budget is intentionally below GitHub Pages' 1 GB limit so there is room
 * for the app, fonts, styles, metadata and future small assets.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const configPath = resolve(scriptDir, "../configuration/size-budget.json");
const budget = JSON.parse(readFileSync(configPath, "utf8"));

const args = process.argv.slice(2);
let distDir = "dist";
let archivePath = null;
let requireData = false;

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--archive") {
    archivePath = args[++index];
    if (!archivePath) fail("--archive needs a path");
  } else if (arg === "--require-data") {
    requireData = true;
  } else if (arg === "--dist") {
    distDir = args[++index];
    if (!distDir) fail("--dist needs a path");
  } else if (arg === "--help" || arg === "-h") {
    console.log(
      "Usage: check-size.mjs [dist-dir] [--archive <file>] [--require-data]",
    );
    process.exit(0);
  } else if (!arg.startsWith("-")) {
    distDir = arg;
  } else {
    fail(`Unknown argument: ${arg}`);
  }
}

function fail(message) {
  console.error(`size-check: ${message}`);
  process.exit(1);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function walkFiles(root) {
  const files = [];
  const visit = (absolute) => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute)) visit(join(absolute, entry));
    } else if (stat.isFile()) {
      files.push({ path: absolute, size: stat.size });
    }
  };
  visit(root);
  return files;
}

const failures = [];

if (archivePath) {
  const absolute = resolve(archivePath);
  if (!existsSync(absolute)) {
    if (requireData) fail(`Required archive is missing: ${archivePath}`);
    console.log(`archive: missing (${archivePath})`);
  } else {
    const size = lstatSync(absolute).size;
    console.log(
      `archive: ${formatBytes(size)} (${relative(process.cwd(), absolute) || absolute})`,
    );
    const archiveHeadroom = budget.maxArchiveBytes - size;
    console.log(
      `  budget: ${formatBytes(budget.maxArchiveBytes)} ` +
        `(${archiveHeadroom >= 0 ? formatBytes(archiveHeadroom) + " headroom" : formatBytes(-archiveHeadroom) + " over"})`,
    );
    if (size > budget.maxArchiveBytes) {
      failures.push(
        `world.pmtiles is ${formatBytes(size)}, over the ${formatBytes(budget.maxArchiveBytes)} archive budget`,
      );
    }
  }
} else {
  const absoluteDist = resolve(distDir);
  if (!existsSync(absoluteDist)) fail(`Deployment directory not found: ${distDir}`);

  const files = walkFiles(absoluteDist);
  files.sort((a, b) => b.size - a.size);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const deployHeadroom = budget.maxDeployBytes - total;
  const archive = join(absoluteDist, budget.archiveRelativePath);
  const archiveExists = existsSync(archive);

  console.log(`deployment: ${formatBytes(total)} in ${files.length} files`);
  console.log(`directory:  ${absoluteDist}`);
  console.log(
    `deployment budget: ${formatBytes(budget.maxDeployBytes)} ` +
      `(${deployHeadroom >= 0 ? formatBytes(deployHeadroom) + " headroom" : formatBytes(-deployHeadroom) + " over"})`,
  );
  console.log(
    `hard limit:        ${formatBytes(budget.hardDeployBytes)} (GitHub Pages is 1 GB)`,
  );
  console.log("largest files:");

  for (const file of files.slice(0, 10)) {
    console.log(`  ${formatBytes(file.size).padEnd(9)} ${relative(absoluteDist, file.path)}`);
  }

  if (!archiveExists) {
    const message = `archive missing: ${budget.archiveRelativePath}`;
    if (requireData) failures.push(message);
    else console.log(`  note: ${message} (allowed outside a deploy)`);
  } else {
    const archiveSize = lstatSync(archive).size;
    console.log(
      `archive:   ${formatBytes(archiveSize)} (${budget.archiveRelativePath})`,
    );
    if (archiveSize > budget.maxArchiveBytes) {
      failures.push(
        `world.pmtiles is ${formatBytes(archiveSize)}, over the ${formatBytes(budget.maxArchiveBytes)} archive budget`,
      );
    }
  }

  if (total > budget.maxDeployBytes) {
    failures.push(
      `deployment is ${formatBytes(total)}, over the ${formatBytes(budget.maxDeployBytes)} budget`,
    );
  }
  if (total >= budget.hardDeployBytes) {
    failures.push(
      `deployment is ${formatBytes(total)}, at or above the ${formatBytes(budget.hardDeployBytes)} hard limit`,
    );
  }
}

if (failures.length > 0) {
  console.error("\nsize-check FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nIf the archive is too large, rebuild with --maxzoom 9 (z0-z9 are mandatory).",
  );
  process.exit(1);
}

console.log("\nsize-check passed.");
