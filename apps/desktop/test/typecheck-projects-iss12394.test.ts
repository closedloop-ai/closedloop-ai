/**
 * ISS-12394 — branch coverage for `resolveTypecheckConcurrency` in
 * `scripts/typecheck-projects.mjs`. The calls run in a plain Node child,
 * because the node lane's c8 only credits code that runs outside a
 * Vite-transformed worker.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TYPECHECK_PROJECTS } from "../scripts/typecheck-projects.mjs";
import {
  CHILD_CASE_TIMEOUT_MS,
  runModuleInChild,
} from "./support/module-child";

const MODULE_URL = new URL("../scripts/typecheck-projects.mjs", import.meta.url)
  .href;
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));

/** `resolveTypecheckConcurrency(raw, cores)` for each pair, in one child. */
function resolve(cases: [string | null | undefined, number][]): number[] {
  // JSON has no undefined, so it travels as the marker "<undefined>".
  const encoded = cases.map(([raw, cores]) => [raw ?? `<${raw}>`, cores]);
  return runModuleInChild<number[]>({
    body: `const decode = (raw) => raw === "<undefined>" ? undefined : raw === "<null>" ? null : raw;
      out(${JSON.stringify(encoded)}.map(([raw, cores]) => m.resolveTypecheckConcurrency(decode(raw), cores)));`,
    cwd: DESKTOP_DIR,
    moduleUrl: MODULE_URL,
  });
}

describe("resolveTypecheckConcurrency", () => {
  it(
    "honours a whole positive override, trimmed and capped at the project count",
    () => {
      expect(
        resolve([
          ["1", 16],
          [" 3 ", 16],
          ["99", 16],
        ])
      ).toEqual([1, 3, TYPECHECK_PROJECTS.length]);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "falls back to the default for zero, junk, signs, decimals and suffixes",
    () => {
      const raws = ["000", "4x", "2gb", "-3", "+3", "1.5", "1e2", "0x4", "abc"];
      expect(resolve(raws.map((raw) => [raw, 16]))).toEqual(raws.map(() => 2));
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "falls back to the default when unset, null or empty",
    () => {
      expect(
        resolve([
          [undefined, 16],
          [null, 16],
          ["", 16],
        ])
      ).toEqual([2, 2, 2]);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "takes one worker on a one-core host and on a non-positive core count",
    () => {
      expect(
        resolve([
          [undefined, 1],
          [undefined, 0],
          [undefined, -4],
        ])
      ).toEqual([1, 1, 1]);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});
