import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export type GateFinding = {
  file: string;
  message: string;
};

type ExecFile = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf-8" }
) => string;

type CliOptions = {
  argv?: string[];
  cwd?: string;
  execFile?: ExecFile;
  stderr?: Pick<typeof console, "error">;
};

type EvaluateInput = {
  changedFiles: readonly string[];
  companionChangedFiles?: readonly string[];
  baseAttributesSource?: string;
  headAttributesSource?: string;
  lockfileDiff?: string;
  lockfileDiffs?: readonly LockfileDiffInput[];
  lockfileBaseSource?: string;
  lockfileHeadSource?: string;
};

export type SchemaSourceClassification = {
  kind: SchemaSourceClassificationKind;
  reason?: string;
  testPath?: string;
};

type CompatibilityMapping = Map<string, CompatibilityMappingFields>;

type LockfileDiffInput = {
  baseSource: string;
  diffText: string;
  headSource: string;
};

type CompatibilityMappingFields = Partial<
  Record<CompatibilityMappingField, string>
>;

const DEFAULT_BASE_REF = "origin/main";
const DEFAULT_HEAD_REF = "HEAD";
export const TelemetryContractPath = {
  PackageRoot: "packages/telemetry-contract",
  PackageManifest: "packages/telemetry-contract/package.json",
  AttributesSource: "packages/telemetry-contract/src/attributes.ts",
  JsonSchemaParity: "packages/telemetry-contract/scripts/check-json-schemas.ts",
} as const;
export type TelemetryContractPath =
  (typeof TelemetryContractPath)[keyof typeof TelemetryContractPath];

export const SchemaSourceClassificationKind = {
  SchemaGroup: "schemaGroup",
  CompatibilityAttributes: "compatibilityAttributes",
  NonSchemaSource: "nonSchemaSource",
} as const;
export type SchemaSourceClassificationKind =
  (typeof SchemaSourceClassificationKind)[keyof typeof SchemaSourceClassificationKind];

export const CompatibilityMappingField = {
  Producer: "producer",
  SourceField: "sourceField",
  Reason: "reason",
} as const;
export type CompatibilityMappingField =
  (typeof CompatibilityMappingField)[keyof typeof CompatibilityMappingField];

export const RequiredCompatibilityMappingFields = [
  CompatibilityMappingField.Producer,
  CompatibilityMappingField.SourceField,
  CompatibilityMappingField.Reason,
] as const satisfies readonly CompatibilityMappingField[];

export const TelemetrySchemaSourceClassification: Readonly<
  Record<string, SchemaSourceClassification>
> = {
  "packages/telemetry-contract/app.ts": {
    kind: SchemaSourceClassificationKind.SchemaGroup,
    testPath: "packages/telemetry-contract/__tests__/app.test.ts",
  },
  "packages/telemetry-contract/src/resource.ts": {
    kind: SchemaSourceClassificationKind.SchemaGroup,
    testPath: "packages/telemetry-contract/__tests__/resource.test.ts",
  },
  "packages/telemetry-contract/src/span.ts": {
    kind: SchemaSourceClassificationKind.SchemaGroup,
    testPath: "packages/telemetry-contract/__tests__/span.test.ts",
  },
  "packages/telemetry-contract/src/gen-ai.ts": {
    kind: SchemaSourceClassificationKind.SchemaGroup,
    testPath: "packages/telemetry-contract/__tests__/gen-ai.test.ts",
  },
  "packages/telemetry-contract/sync.ts": {
    kind: SchemaSourceClassificationKind.SchemaGroup,
    testPath: "packages/telemetry-contract/__tests__/sync.test.ts",
  },
  "packages/telemetry-contract/permission.ts": {
    kind: SchemaSourceClassificationKind.SchemaGroup,
    testPath: "packages/telemetry-contract/__tests__/permission.test.ts",
  },
  [TelemetryContractPath.AttributesSource]: {
    kind: SchemaSourceClassificationKind.CompatibilityAttributes,
    reason: "ClosedLoop compatibility attributes are enforced by Gate C.",
  },
  "packages/telemetry-contract/src/emit.ts": {
    kind: SchemaSourceClassificationKind.NonSchemaSource,
    reason: "Emit helper; it does not define accepted telemetry payload shape.",
  },
  "packages/telemetry-contract/src/schema-name.ts": {
    kind: SchemaSourceClassificationKind.NonSchemaSource,
    reason: "Schema name discriminator constants, not a schema group.",
  },
  "packages/telemetry-contract/src/schema-primitives.ts": {
    kind: SchemaSourceClassificationKind.NonSchemaSource,
    reason: "Shared schema primitives covered through consuming schema groups.",
  },
  "packages/telemetry-contract/src/schema-shape.ts": {
    kind: SchemaSourceClassificationKind.NonSchemaSource,
    reason: "Schema-shape helper types, not a standalone schema group.",
  },
  "packages/telemetry-contract/src/test-fixtures.ts": {
    kind: SchemaSourceClassificationKind.NonSchemaSource,
    reason: "Shared fixtures for tests and samples, not a published schema.",
  },
  "packages/telemetry-contract/src/validate.ts": {
    kind: SchemaSourceClassificationKind.NonSchemaSource,
    reason: "Runtime validator wrapper; schema groups own payload shape.",
  },
} as const;
const TELEMETRY_ATTRIBUTE_OBJECT_NAME = "TelemetryAttribute";
const COMPATIBILITY_ATTRIBUTE_OBJECT_NAME = "ClosedLoopCompatibilityAttribute";
const COMPATIBILITY_MAPPING_OBJECT_NAME =
  "CompatibilityAttributeProducerMapping";
const PNPM_LOCKFILE_PATH = "pnpm-lock.yaml";
const LOCKFILE_DIFF_CONTEXT_LINES = "0";
const MAX_LOCKFILE_FINDING_EXAMPLES = 3;
export const LEADING_CURRENT_DIRECTORY_PATTERN = /^\.\//;
const UNKNOWN_SCHEMA_SOURCE_MESSAGE =
  "Classify it as schemaGroup, compatibilityAttributes, or nonSchemaSource before the gate can pass.";

export function runSchemaUpdateGates(options: CliOptions = {}): number {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const execFile = options.execFile ?? defaultExecFile;
  const stderr = options.stderr ?? console;
  const refs = parseRefs(argv);

  try {
    const repoRoot = execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
    }).trim();
    const committedChangedFiles = listTelemetryContractChangedFiles(
      execFile,
      repoRoot,
      refs.base,
      refs.head
    );
    const worktreeChangedFiles = refs.includeWorktree
      ? listTelemetryContractWorktreeChangedFiles(execFile, repoRoot)
      : [];
    const changedFiles = uniqueRepoPaths([
      ...committedChangedFiles,
      ...worktreeChangedFiles,
    ]);
    const lockfileDiffs = changedFiles.includes(
      TelemetryContractPath.PackageManifest
    )
      ? readLockfileDiffs({
          execFile,
          base: refs.base,
          head: refs.head,
          includeWorktree: refs.includeWorktree,
          repoRoot,
        })
      : undefined;
    const needsAttributeComparison = changedFiles.includes(
      TelemetryContractPath.AttributesSource
    );
    const findings = evaluateSchemaUpdateGates({
      changedFiles,
      baseAttributesSource: needsAttributeComparison
        ? readGitFile(
            execFile,
            repoRoot,
            refs.base,
            TelemetryContractPath.AttributesSource
          )
        : undefined,
      headAttributesSource: needsAttributeComparison
        ? readHeadAttributesSource({
            execFile,
            head: refs.head,
            repoRoot,
            worktreeChangedFiles,
          })
        : undefined,
      lockfileDiffs,
    });

    for (const finding of findings) {
      stderr.error(formatGithubError(finding));
      stderr.error(finding.message);
    }

    return findings.length === 0 ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : `Unknown schema update gate failure: ${String(error)}`;
    stderr.error(
      `::error::Unable to evaluate telemetry schema update gates. ${message}`
    );
    return 1;
  }
}

export function evaluateSchemaUpdateGates(input: EvaluateInput): GateFinding[] {
  const changedFiles = input.changedFiles.map(normalizeRepoPath);
  const companionChangedFiles = (
    input.companionChangedFiles ?? input.changedFiles
  ).map(normalizeRepoPath);
  const findings = [
    ...findMissingSchemaCompanions(changedFiles, companionChangedFiles),
    ...findMissingCompatibilityMappings({
      ...input,
      changedFiles,
    }),
    ...findUnscopedTelemetryPackageLockfileChanges({
      changedFiles,
      lockfileDiff: input.lockfileDiff,
      lockfileDiffs: input.lockfileDiffs,
      lockfileBaseSource: input.lockfileBaseSource,
      lockfileHeadSource: input.lockfileHeadSource,
    }),
  ];

  return findings;
}

export function listTelemetryContractChangedFiles(
  execFile: ExecFile,
  repoRoot: string,
  base: string,
  head: string
): string[] {
  const output = execFile(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACMRT",
      `${base}...${head}`,
      "--",
      TelemetryContractPath.PackageRoot,
    ],
    { cwd: repoRoot, encoding: "utf-8" }
  );

  return output
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean)
    .map(normalizeRepoPath);
}

export function listTelemetryContractWorktreeChangedFiles(
  execFile: ExecFile,
  repoRoot: string
): string[] {
  const trackedOutput = execFile(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACMRT",
      "HEAD",
      "--",
      TelemetryContractPath.PackageRoot,
    ],
    { cwd: repoRoot, encoding: "utf-8" }
  );
  const untrackedOutput = execFile(
    "git",
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      TelemetryContractPath.PackageRoot,
    ],
    { cwd: repoRoot, encoding: "utf-8" }
  );

  return uniqueRepoPaths([
    ...parseGitPathList(trackedOutput),
    ...parseGitPathList(untrackedOutput),
  ]);
}

function findMissingSchemaCompanions(
  changedFiles: readonly string[],
  companionChangedFiles: readonly string[]
): GateFinding[] {
  const schemaTriggerFileSet = new Set(changedFiles.map(normalizeRepoPath));
  const changedFileSet = new Set(companionChangedFiles.map(normalizeRepoPath));
  const findings: GateFinding[] = [];

  for (const changedFile of schemaTriggerFileSet) {
    if (!isTelemetrySourceFile(changedFile)) {
      continue;
    }

    const classification = classifyTelemetrySourcePath(changedFile);
    if (!classification) {
      findings.push({
        file: changedFile,
        message: `Telemetry contract source ${changedFile} is not classified. ${UNKNOWN_SCHEMA_SOURCE_MESSAGE}`,
      });
      continue;
    }

    if (classification.kind !== SchemaSourceClassificationKind.SchemaGroup) {
      continue;
    }

    const testPath = classification.testPath;
    if (!testPath) {
      throw new Error(`Schema group ${changedFile} has no mapped test path`);
    }

    if (!changedFileSet.has(testPath)) {
      findings.push({
        file: changedFile,
        message: `Telemetry schema source ${changedFile} changed without required Zod companion test ${testPath} in the PR diff.`,
      });
    }

    if (!changedFileSet.has(TelemetryContractPath.JsonSchemaParity)) {
      findings.push({
        file: changedFile,
        message: `Telemetry schema source ${changedFile} changed without required JSON Schema parity file ${TelemetryContractPath.JsonSchemaParity} in the PR diff.`,
      });
    }
  }

  return findings;
}

function findMissingCompatibilityMappings(input: EvaluateInput): GateFinding[] {
  if (!input.changedFiles.includes(TelemetryContractPath.AttributesSource)) {
    return [];
  }
  if (!(input.baseAttributesSource && input.headAttributesSource)) {
    throw new Error(
      `${TelemetryContractPath.AttributesSource} changed but base/head source was unavailable`
    );
  }

  const baseAttributes = parseClosedLoopCompatibilityAttributes(
    input.baseAttributesSource
  );
  const headAttributes = parseClosedLoopCompatibilityAttributes(
    input.headAttributesSource
  );
  const headMapping = parseCompatibilityProducerMapping(
    input.headAttributesSource
  );

  return [...headAttributes].flatMap((attribute) => {
    const mapping = headMapping.get(attribute);
    const missingFields = RequiredCompatibilityMappingFields.filter(
      (field) => !mapping?.[field]
    );
    if (missingFields.length === 0) {
      return [];
    }

    return [
      {
        file: TelemetryContractPath.AttributesSource,
        message: `${baseAttributes.has(attribute) ? "Current" : "New"} ClosedLoop compatibility attribute "${attribute}" is missing required CompatibilityAttributeProducerMapping fields: ${missingFields.join(", ")}.`,
      },
    ];
  });
}

function findUnscopedTelemetryPackageLockfileChanges(input: {
  changedFiles: readonly string[];
  lockfileDiff?: string;
  lockfileDiffs?: readonly LockfileDiffInput[];
  lockfileBaseSource?: string;
  lockfileHeadSource?: string;
}): GateFinding[] {
  if (!input.changedFiles.includes(TelemetryContractPath.PackageManifest)) {
    return [];
  }
  const lockfileDiffs = normalizeLockfileDiffs(input);
  if (lockfileDiffs.length === 0) {
    return [];
  }

  const unscopedLines = lockfileDiffs.flatMap(findUnscopedLockfileDiffLines);
  if (unscopedLines.length === 0) {
    return [];
  }

  const examples = unscopedLines
    .slice(0, MAX_LOCKFILE_FINDING_EXAMPLES)
    .join("; ");
  const suffix =
    unscopedLines.length > MAX_LOCKFILE_FINDING_EXAMPLES
      ? `, plus ${unscopedLines.length - MAX_LOCKFILE_FINDING_EXAMPLES} more`
      : "";

  return [
    {
      file: PNPM_LOCKFILE_PATH,
      message: `Telemetry contract package metadata changed with unrelated pnpm-lock.yaml drift outside ${TelemetryContractPath.PackageRoot}'s importer block (${examples}${suffix}). Trim or regenerate the lockfile so unrelated importers and peer snapshots are absent.`,
    },
  ];
}

function normalizeLockfileDiffs(input: {
  lockfileDiff?: string;
  lockfileDiffs?: readonly LockfileDiffInput[];
  lockfileBaseSource?: string;
  lockfileHeadSource?: string;
}): LockfileDiffInput[] {
  const lockfileDiffs = input.lockfileDiffs?.filter((diff) =>
    diff.diffText.trim()
  );
  if (lockfileDiffs?.length) {
    return [...lockfileDiffs];
  }
  if (!input.lockfileDiff?.trim()) {
    return [];
  }
  if (!(input.lockfileBaseSource && input.lockfileHeadSource)) {
    throw new Error(
      `${PNPM_LOCKFILE_PATH} diff was provided without full base/head lockfile source for line-range classification`
    );
  }

  return [
    {
      baseSource: input.lockfileBaseSource,
      diffText: input.lockfileDiff,
      headSource: input.lockfileHeadSource,
    },
  ];
}

function findUnscopedLockfileDiffLines(input: LockfileDiffInput): string[] {
  const baseLinePaths = buildYamlLinePaths(input.baseSource);
  const headLinePaths = buildYamlLinePaths(input.headSource);
  const unscopedLines: string[] = [];
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const line of input.diffText.split("\n")) {
    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      oldLineNumber = hunkHeader.oldStart;
      newLineNumber = hunkHeader.newStart;
      continue;
    }
    if (!isUnifiedDiffContentLine(line)) {
      continue;
    }

    const marker = line[0];
    const content = line.slice(1);
    if (marker === " ") {
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    const lineNumber = marker === "+" ? newLineNumber : oldLineNumber;
    const yamlPath =
      marker === "+"
        ? (headLinePaths.get(lineNumber) ?? [])
        : (baseLinePaths.get(lineNumber) ?? []);
    if (content.trim() !== "" && !isTelemetryContractImporterPath(yamlPath)) {
      unscopedLines.push(
        formatLockfileDiffExample({
          line,
          lineNumber,
          path: yamlPath,
        })
      );
    }

    if (marker === "+") {
      newLineNumber += 1;
    } else {
      oldLineNumber += 1;
    }
  }

  return unscopedLines;
}

function buildYamlLinePaths(source: string): Map<number, YamlPathEntry[]> {
  const linePaths = new Map<number, YamlPathEntry[]>();
  const yamlPath: YamlPathEntry[] = [];

  source.split("\n").forEach((line, index) => {
    updateYamlPath(yamlPath, line);
    linePaths.set(index + 1, [...yamlPath]);
  });

  return linePaths;
}

function parseHunkHeader(line: string): LockfileHunkHeader | undefined {
  const match = LOCKFILE_HUNK_HEADER_PATTERN.exec(line);
  if (!match) {
    return undefined;
  }

  const [, oldStart, newStart] = match;
  if (!(oldStart && newStart)) {
    return undefined;
  }

  return {
    oldStart: Number.parseInt(oldStart, 10),
    newStart: Number.parseInt(newStart, 10),
  };
}

function isUnifiedDiffContentLine(line: string): boolean {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return false;
  }

  const marker = line[0];
  return marker === " " || marker === "+" || marker === "-";
}

function updateYamlPath(path: YamlPathEntry[], line: string): void {
  const match = LOCKFILE_YAML_KEY_PATTERN.exec(line);
  if (!match) {
    return;
  }

  const [, rawIndent, rawKey] = match;
  if (rawIndent === undefined || rawKey === undefined) {
    return;
  }

  const indent = rawIndent.length;
  const key = unquoteYamlKey(rawKey.trim());
  while (path.length > 0) {
    const lastEntry = path.at(-1);
    if (lastEntry === undefined || lastEntry.indent < indent) {
      break;
    }
    path.pop();
  }
  path.push({ indent, key });
}

function isTelemetryContractImporterPath(path: readonly YamlPathEntry[]) {
  return (
    path[0]?.key === "importers" &&
    path[1]?.key === TelemetryContractPath.PackageRoot
  );
}

function formatLockfileDiffExample(input: {
  line: string;
  lineNumber: number;
  path: readonly YamlPathEntry[];
}): string {
  const normalizedLine = input.line
    .trim()
    .replace(LOCKFILE_DIFF_WHITESPACE_PATTERN, " ");
  const lockfilePath = input.path.map((entry) => entry.key).join(" > ");
  const prefix = `${PNPM_LOCKFILE_PATH}:${input.lineNumber}`;

  return lockfilePath
    ? `${prefix} ${lockfilePath}: ${normalizedLine}`
    : `${prefix} ${normalizedLine}`;
}

function unquoteYamlKey(key: string): string {
  if (
    (key.startsWith("'") && key.endsWith("'")) ||
    (key.startsWith('"') && key.endsWith('"'))
  ) {
    return key.slice(1, -1);
  }

  return key;
}

export function classifyTelemetrySourcePath(
  path: string
): SchemaSourceClassification | undefined {
  return TelemetrySchemaSourceClassification[normalizeRepoPath(path)];
}

export function isTelemetrySourceFile(path: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  return (
    normalizedPath in TelemetrySchemaSourceClassification ||
    isUnclassifiedTelemetrySourceCandidate(normalizedPath)
  );
}

function isUnclassifiedTelemetrySourceCandidate(path: string): boolean {
  return (
    path.startsWith(`${TelemetryContractPath.PackageRoot}/src/`) &&
    path.endsWith(".ts")
  );
}

function parseClosedLoopCompatibilityAttributes(sourceText: string) {
  const sourceFile = createSourceFile(sourceText);
  const telemetryAttributes = parseTelemetryAttributeObject(sourceFile);
  const objectLiteral = findConstObjectLiteral(
    sourceFile,
    COMPATIBILITY_ATTRIBUTE_OBJECT_NAME
  );
  const values = new Set<string>();

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const value = resolveStringExpression(
      property.initializer,
      telemetryAttributes
    );
    if (value) {
      values.add(value);
    }
  }

  return values;
}

function parseCompatibilityProducerMapping(
  sourceText: string
): CompatibilityMapping {
  const sourceFile = createSourceFile(sourceText);
  const telemetryAttributes = parseTelemetryAttributeObject(sourceFile);
  const objectLiteral = findConstObjectLiteral(
    sourceFile,
    COMPATIBILITY_MAPPING_OBJECT_NAME
  );
  const mapping: CompatibilityMapping = new Map();

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const attribute = resolvePropertyName(property.name, telemetryAttributes);
    if (!(attribute && ts.isObjectLiteralExpression(property.initializer))) {
      continue;
    }

    mapping.set(attribute, parseStringFieldObject(property.initializer));
  }

  return mapping;
}

function parseTelemetryAttributeObject(
  sourceFile: ts.SourceFile
): Map<string, string> {
  const objectLiteral = findConstObjectLiteral(
    sourceFile,
    TELEMETRY_ATTRIBUTE_OBJECT_NAME
  );
  const values = new Map<string, string>();

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const propertyName = getStaticPropertyName(property.name);
    if (!(propertyName && ts.isStringLiteralLike(property.initializer))) {
      continue;
    }
    values.set(propertyName, property.initializer.text);
  }

  return values;
}

function parseStringFieldObject(
  objectLiteral: ts.ObjectLiteralExpression
): CompatibilityMappingFields {
  const result: Record<string, string | undefined> = {};

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const propertyName = getStaticPropertyName(property.name);
    if (
      propertyName &&
      isCompatibilityMappingField(propertyName) &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      result[propertyName] = property.initializer.text.trim();
    }
  }

  return result;
}

function findConstObjectLiteral(
  sourceFile: ts.SourceFile,
  constName: string
): ts.ObjectLiteralExpression {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === constName &&
        declaration.initializer
      ) {
        return unwrapConstAssertionObject(declaration.initializer);
      }
    }
  }

  throw new Error(`Unable to find exported const object ${constName}`);
}

function unwrapConstAssertionObject(
  expression: ts.Expression
): ts.ObjectLiteralExpression {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return unwrapConstAssertionObject(expression.expression);
  }

  throw new Error("Expected object literal const initializer");
}

function resolvePropertyName(
  name: ts.PropertyName,
  telemetryAttributes: ReadonlyMap<string, string>
): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    return resolveStringExpression(name.expression, telemetryAttributes);
  }

  return getStaticPropertyName(name);
}

function resolveStringExpression(
  expression: ts.Expression,
  telemetryAttributes: ReadonlyMap<string, string>
): string | undefined {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === TELEMETRY_ATTRIBUTE_OBJECT_NAME
  ) {
    return telemetryAttributes.get(expression.name.text);
  }

  return undefined;
}

function isCompatibilityMappingField(
  fieldName: string
): fieldName is CompatibilityMappingField {
  return RequiredCompatibilityMappingFields.some(
    (field) => field === fieldName
  );
}

export function getStaticPropertyName(
  name: ts.PropertyName
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }

  return undefined;
}

function createSourceFile(sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    TelemetryContractPath.AttributesSource,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function readGitFile(
  execFile: ExecFile,
  repoRoot: string,
  ref: string,
  path: string
): string {
  return execFile("git", ["show", `${ref}:${path}`], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

function readLockfileDiff(
  execFile: ExecFile,
  repoRoot: string,
  base: string,
  head: string
): string {
  return execFile(
    "git",
    [
      "diff",
      `--unified=${LOCKFILE_DIFF_CONTEXT_LINES}`,
      `${base}...${head}`,
      "--",
      PNPM_LOCKFILE_PATH,
    ],
    { cwd: repoRoot, encoding: "utf-8" }
  );
}

function readLockfileDiffs(input: {
  execFile: ExecFile;
  base: string;
  head: string;
  includeWorktree: boolean;
  repoRoot: string;
}): LockfileDiffInput[] {
  const committedDiff = readLockfileDiff(
    input.execFile,
    input.repoRoot,
    input.base,
    input.head
  );
  const lockfileDiffs: LockfileDiffInput[] = [];

  if (committedDiff.trim()) {
    lockfileDiffs.push({
      baseSource: readGitFile(
        input.execFile,
        input.repoRoot,
        input.base,
        PNPM_LOCKFILE_PATH
      ),
      diffText: committedDiff,
      headSource: readGitFile(
        input.execFile,
        input.repoRoot,
        input.head,
        PNPM_LOCKFILE_PATH
      ),
    });
  }

  if (!input.includeWorktree) {
    return lockfileDiffs;
  }

  const worktreeDiff = readWorktreeLockfileDiff(input.execFile, input.repoRoot);
  if (!worktreeDiff.trim()) {
    return lockfileDiffs;
  }

  lockfileDiffs.push({
    baseSource: readGitFile(
      input.execFile,
      input.repoRoot,
      DEFAULT_HEAD_REF,
      PNPM_LOCKFILE_PATH
    ),
    diffText: worktreeDiff,
    headSource: readFileSync(join(input.repoRoot, PNPM_LOCKFILE_PATH), "utf-8"),
  });

  return lockfileDiffs;
}

function readWorktreeLockfileDiff(
  execFile: ExecFile,
  repoRoot: string
): string {
  return execFile(
    "git",
    [
      "diff",
      `--unified=${LOCKFILE_DIFF_CONTEXT_LINES}`,
      "HEAD",
      "--",
      PNPM_LOCKFILE_PATH,
    ],
    { cwd: repoRoot, encoding: "utf-8" }
  );
}

function parseRefs(argv: readonly string[]) {
  let base = DEFAULT_BASE_REF;
  let head = DEFAULT_HEAD_REF;
  let includeWorktree = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--include-worktree") {
      includeWorktree = true;
      continue;
    }
    if (arg === "--base" && next) {
      base = next;
      index += 1;
      continue;
    }
    if (arg === "--head" && next) {
      head = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return { base, head, includeWorktree };
}

export function formatGithubError(finding: GateFinding): string {
  return `::error file=${finding.file}::${finding.message}`;
}

function defaultExecFile(
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf-8" }
): string {
  return execFileSync(command, args, options);
}

export function normalizeRepoPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(LEADING_CURRENT_DIRECTORY_PATTERN, "");
}

function readHeadAttributesSource(input: {
  execFile: ExecFile;
  head: string;
  repoRoot: string;
  worktreeChangedFiles: readonly string[];
}): string {
  if (
    input.worktreeChangedFiles.includes(TelemetryContractPath.AttributesSource)
  ) {
    return readFileSync(
      join(input.repoRoot, TelemetryContractPath.AttributesSource),
      "utf-8"
    );
  }

  return readGitFile(
    input.execFile,
    input.repoRoot,
    input.head,
    TelemetryContractPath.AttributesSource
  );
}

function parseGitPathList(output: string): string[] {
  return output
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean)
    .map(normalizeRepoPath);
}

function uniqueRepoPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeRepoPath))];
}

type YamlPathEntry = {
  indent: number;
  key: string;
};

type LockfileHunkHeader = {
  newStart: number;
  oldStart: number;
};

const LOCKFILE_HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const LOCKFILE_YAML_KEY_PATTERN = /^(\s*)([^:#][^:]*):(?:\s|$)/;
const LOCKFILE_DIFF_WHITESPACE_PATTERN = /\s+/g;

if (process.argv[1]?.endsWith("check-schema-update-gates.ts")) {
  process.exitCode = runSchemaUpdateGates();
}
