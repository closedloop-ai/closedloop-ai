/**
 * @file pack-scanner-fixtures.ts
 * @description Shared on-disk fixture helpers for the pack-scanner walker and
 * catalog-detector suites. The scanners read real directories (resolved from
 * `CLAUDE_HOME` / `CODEX_HOME`), so these build those trees under a temp dir
 * and collect what a scan emits through the production `CollectingSink`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CollectingSink,
  type PackScanPlan,
  type SkillUpsertRow,
} from "../../src/main/packs/pack-scanner.js";

export function writeFixtureFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** A SKILL.md body whose frontmatter carries exactly `fields`. */
export function skillMarkdown(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${value}`
  );
  return `---\n${lines.join("\n")}\n---\n\nBody.\n`;
}

/**
 * Set (or, with `undefined`, remove) an env var and return a restore function
 * that puts back the exact previous state — including "was unset".
 */
export function overrideEnv(
  key: string,
  value: string | undefined
): () => void {
  const hadKey = Object.hasOwn(process.env, key);
  const previous = process.env[key];
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
  return () => {
    if (hadKey && previous !== undefined) {
      process.env[key] = previous;
    } else {
      Reflect.deleteProperty(process.env, key);
    }
  };
}

/** Run one scan phase against a fresh `CollectingSink` and return its plan. */
export async function runWithSink<T>(
  run: (sink: CollectingSink) => Promise<T>,
  recentProjectRoots: string[] = []
): Promise<{ result: T; plan: PackScanPlan }> {
  const sink = new CollectingSink(recentProjectRoots);
  const result = await run(sink);
  return { result, plan: sink.toPlan() };
}

/** Skill rows in a stable order: directory walk order is not guaranteed. */
export function sortSkills(skills: SkillUpsertRow[]): SkillUpsertRow[] {
  return [...skills].sort(
    (a, b) => a.harness.localeCompare(b.harness) || a.name.localeCompare(b.name)
  );
}
