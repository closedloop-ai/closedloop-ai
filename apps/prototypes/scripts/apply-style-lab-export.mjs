import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  applyTokenEdits,
  StyleLabExportError,
  TARGET_FILE,
  validatePayload,
} from "./style-lab-export.mjs";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const targetPath = path.join(repoRoot, TARGET_FILE);
const exportPath = process.argv[2];

if (!exportPath) {
  fail("Usage: pnpm -C apps/prototypes style-lab:apply <export.json>");
}

main();

function main() {
  const payload = readExportPayload(path.resolve(repoRoot, exportPath));
  try {
    const tokens = validatePayload(payload);
    const source = readFileSync(targetPath, "utf8");
    const nextSource = applyTokenEdits(source, tokens);
    writeFileSync(targetPath, nextSource);
    console.log(
      `Applied ${tokens.length} Style Lab token change${tokens.length === 1 ? "" : "s"} to ${path.relative(
        repoRoot,
        targetPath
      )}`
    );
  } catch (error) {
    if (error instanceof StyleLabExportError) {
      fail(error.message);
    }
    throw error;
  }
}

function readExportPayload(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return fail(`Could not read Style Lab export JSON: ${error.message}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
