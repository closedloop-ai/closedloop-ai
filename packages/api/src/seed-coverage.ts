import { z } from "zod";

/**
 * ISS-12017: one JSON file per Prisma model records whether the local seed
 * fills it. Web and Desktop keep separate folders but share this contract, so
 * the two blocking tests and the vibe CLI read the files the same way.
 */
export const SeedCoverageStatus = {
  Seeded: "seeded",
  Skipped: "skipped",
  Todo: "todo",
} as const;
export type SeedCoverageStatus =
  (typeof SeedCoverageStatus)[keyof typeof SeedCoverageStatus];

const nonEmptyText = z.string().trim().min(1);

export const seedCoverageEntrySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal(SeedCoverageStatus.Seeded),
    stage: nonEmptyText,
  }),
  z.strictObject({
    status: z.literal(SeedCoverageStatus.Skipped),
    reason: nonEmptyText,
  }),
  z.strictObject({
    status: z.literal(SeedCoverageStatus.Todo),
  }),
]);
export type SeedCoverageEntry = z.infer<typeof seedCoverageEntrySchema>;

export type SeedCoverageRecord =
  | { readonly valid: true; readonly entry: SeedCoverageEntry }
  | { readonly valid: false; readonly problem: string };

/** Keyed by model name, which is the file name without `.json`. */
export type SeedCoverage = ReadonlyMap<string, SeedCoverageRecord>;

export type SeedCoverageInvalidFile = {
  readonly model: string;
  readonly problem: string;
};

export type SeedCoverageComparison = {
  /** Models with no coverage file. */
  readonly missing: readonly string[];
  /** Coverage files naming a model the schema no longer has. */
  readonly stale: readonly string[];
  /** Coverage files for real models that fail the schema. */
  readonly invalid: readonly SeedCoverageInvalidFile[];
  /** Models whose valid coverage file says `todo`. */
  readonly todo: readonly string[];
};

const COVERAGE_FILE_EXTENSION = ".json";

/**
 * Builds the coverage map from a folder listing. The caller supplies the I/O
 * so this module stays pure; files that are not `.json` (the README) are not
 * coverage files and are ignored.
 */
export function parseSeedCoverageDirectory(
  fileNames: readonly string[],
  readFile: (fileName: string) => string
): SeedCoverage {
  const coverage = new Map<string, SeedCoverageRecord>();
  for (const fileName of [...fileNames].sort()) {
    if (!fileName.endsWith(COVERAGE_FILE_EXTENSION)) {
      continue;
    }
    const model = fileName.slice(0, -COVERAGE_FILE_EXTENSION.length);
    coverage.set(model, parseSeedCoverageContents(readFile(fileName)));
  }
  return coverage;
}

export function parseSeedCoverageContents(
  contents: string
): SeedCoverageRecord {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { valid: false, problem: `not valid JSON (${detail})` };
  }
  const parsed = seedCoverageEntrySchema.safeParse(json);
  if (parsed.success) {
    return { valid: true, entry: parsed.data };
  }
  return { valid: false, problem: describeIssues(parsed.error.issues) };
}

export function compareCoverage(
  modelNames: readonly string[],
  coverage: SeedCoverage
): SeedCoverageComparison {
  const models = new Set(modelNames);
  const missing = [...models].filter((model) => !coverage.has(model)).sort();
  const stale: string[] = [];
  const invalid: SeedCoverageInvalidFile[] = [];
  const todo: string[] = [];
  for (const [model, record] of coverage) {
    if (!models.has(model)) {
      stale.push(model);
    } else if (!record.valid) {
      invalid.push({ model, problem: record.problem });
    } else if (record.entry.status === SeedCoverageStatus.Todo) {
      todo.push(model);
    }
  }
  invalid.sort((left, right) => compareText(left.model, right.model));
  return { missing, stale: stale.sort(), invalid, todo: todo.sort() };
}

/**
 * Failure text for the blocking coverage tests: names each file and the exact
 * edit that fixes it. `coverageDir` is the repo-relative folder.
 */
export function describeMissingSeedCoverage(
  models: readonly string[],
  coverageDir: string
): string {
  const lines = models.map(
    (model) =>
      `Add ${coverageDir}/${model}.json with {"status":"todo"} (or {"status":"seeded","stage":"<stage>"} / {"status":"skipped","reason":"<why no screen needs rows>"}).`
  );
  return [
    `${models.length} Prisma model(s) have no seed coverage file. See ${coverageDir}/README.md.`,
    ...lines,
  ].join("\n");
}

export function describeStaleSeedCoverage(
  models: readonly string[],
  coverageDir: string
): string {
  const lines = models.map(
    (model) =>
      `Delete ${coverageDir}/${model}.json (no Prisma model named ${model}; rename the file if the model was renamed).`
  );
  return [
    `${models.length} seed coverage file(s) name a model the schema does not have.`,
    ...lines,
  ].join("\n");
}

export function describeInvalidSeedCoverage(
  invalid: readonly SeedCoverageInvalidFile[],
  coverageDir: string
): string {
  const lines = invalid.map(
    ({ model, problem }) =>
      `Fix ${coverageDir}/${model}.json: ${problem}. Valid shapes: {"status":"seeded","stage":"<stage>"}, {"status":"skipped","reason":"<one line>"}, {"status":"todo"}.`
  );
  return [
    `${invalid.length} seed coverage file(s) are invalid. See ${coverageDir}/README.md.`,
    ...lines,
  ].join("\n");
}

function describeIssues(issues: z.ZodError["issues"]): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "file";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}
