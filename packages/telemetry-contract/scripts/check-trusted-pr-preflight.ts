import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import YAML from "yaml";
import { z } from "zod";
import {
  CompatibilityMappingField,
  evaluateSchemaUpdateGates,
  formatGithubError,
  type GateFinding,
  getStaticPropertyName,
  normalizeRepoPath,
  RequiredCompatibilityMappingFields,
  TelemetryContractPath,
  TelemetrySchemaSourceClassification,
} from "./check-schema-update-gates";

export type TrustedPreflightInput = {
  changedFiles: readonly string[];
  companionChangedFiles?: readonly string[];
  inventoryFileCount?: number;
  expectedChangedFileCount?: number;
  baseAttributesSource?: string;
  headAttributesSource?: string;
  headFileSources?: Readonly<Record<string, string>>;
};

export type TrustedPreflightResult = {
  status: TrustedPreflightStatus;
  mode: TrustedPreflightMode;
  findings: GateFinding[];
};

export type TrustedPreflightEnvironment = {
  GITHUB_REPOSITORY?: string;
  PR_NUMBER?: string;
  EXPECTED_CHANGED_FILE_COUNT?: string;
  BASE_SHA?: string;
  HEAD_SHA?: string;
};

export type GhCommandRunner = (args: readonly string[]) => string;

export type TrustedPreflightFileInventory = {
  changedFiles: string[];
  companionChangedFiles: string[];
  inventoryFileCount: number;
};

export const TrustedPreflightStatus = {
  Passed: "passed",
  Failed: "failed",
  NoOp: "no_op",
} as const;
export type TrustedPreflightStatus =
  (typeof TrustedPreflightStatus)[keyof typeof TrustedPreflightStatus];

export const TrustedPreflightMode = {
  NoTelemetryChanges: "no_telemetry_changes",
  GateValidation: "gate_validation",
  EnforcementLayerEdit: "enforcement_layer_edit",
} as const;
export type TrustedPreflightMode =
  (typeof TrustedPreflightMode)[keyof typeof TrustedPreflightMode];

export const TelemetryPreflightPath = {
  FeatureFlagAttestationWorkflow:
    ".github/workflows/feature-flag-attestation.yml",
  PrTestWorkflow: ".github/workflows/pr-test.yml",
  TrustedPreflightWorkflow:
    ".github/workflows/telemetry-contract-pr-preflight.yml",
  SchemaGateScript:
    "packages/telemetry-contract/scripts/check-schema-update-gates.ts",
  TrustedPreflightScript:
    "packages/telemetry-contract/scripts/check-trusted-pr-preflight.ts",
  SchemaGateFixtures:
    "packages/telemetry-contract/__tests__/schema-gate-fixtures.ts",
  SchemaGateTest:
    "packages/telemetry-contract/__tests__/check-schema-update-gates.test.ts",
  TrustedPreflightTest:
    "packages/telemetry-contract/__tests__/check-trusted-pr-preflight.test.ts",
  FeatureFlagAttestationWorkflowSourceTest:
    "scripts/lint/feature-flag-attestation-workflow-source.test.ts",
  PrWorkflowSourceTest:
    "scripts/lint/pr-test-telemetry-contract-workflow-source.test.ts",
  TrustedWorkflowSourceTest:
    "scripts/lint/telemetry-contract-pr-preflight-workflow-source.test.ts",
} as const;
export type TelemetryPreflightPath =
  (typeof TelemetryPreflightPath)[keyof typeof TelemetryPreflightPath];

export const EnforcementLayerPaths = [
  TelemetryPreflightPath.FeatureFlagAttestationWorkflow,
  TelemetryPreflightPath.PrTestWorkflow,
  TelemetryPreflightPath.TrustedPreflightWorkflow,
  TelemetryPreflightPath.SchemaGateScript,
  TelemetryPreflightPath.TrustedPreflightScript,
  TelemetryPreflightPath.SchemaGateFixtures,
  TelemetryPreflightPath.SchemaGateTest,
  TelemetryPreflightPath.TrustedPreflightTest,
  TelemetryPreflightPath.FeatureFlagAttestationWorkflowSourceTest,
  TelemetryPreflightPath.PrWorkflowSourceTest,
  TelemetryPreflightPath.TrustedWorkflowSourceTest,
] as const;

export const GitHubPullFileStatus = {
  Renamed: "renamed",
  Removed: "removed",
} as const;
export type GitHubPullFileStatus =
  (typeof GitHubPullFileStatus)[keyof typeof GitHubPullFileStatus];

type RequiredSourcePattern = {
  pattern: RegExp;
  message: string;
};

type WorkflowValidationResult = {
  workflow: WorkflowSource | undefined;
  job: WorkflowJob | undefined;
  findings: GateFinding[];
};

type WorkflowRunStepOptions = {
  env?: Readonly<Record<string, string>>;
  if?: string;
};

const TrustedPreflightEnvSchema = z.object({
  GITHUB_REPOSITORY: z.string().min(1),
  PR_NUMBER: z.coerce.number().int().positive(),
  EXPECTED_CHANGED_FILE_COUNT: z.coerce.number().int().nonnegative(),
  BASE_SHA: z.string().min(1),
  HEAD_SHA: z.string().min(1),
});

const GitHubPullFileSchema = z
  .object({
    filename: z.string().min(1),
    status: z.string().min(1).optional(),
    previous_filename: z.string().min(1).optional(),
  })
  .superRefine((file, context) => {
    if (
      file.status === GitHubPullFileStatus.Renamed &&
      !file.previous_filename
    ) {
      context.addIssue({
        code: "custom",
        message: "renamed pull request files must include previous_filename",
      });
    }
  });
type GitHubPullFile = z.infer<typeof GitHubPullFileSchema>;

const GitHubPullFilesResponseSchema = z.union([
  z.array(GitHubPullFileSchema),
  z.array(z.array(GitHubPullFileSchema)),
]);

const GitHubContentResponseSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
});

const WorkflowStepSchema = z
  .object({
    env: z.record(z.string(), z.unknown()).optional(),
    id: z.string().optional(),
    if: z.string().optional(),
    name: z.string().optional(),
    run: z.string().optional(),
    uses: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    "continue-on-error": z.unknown().optional(),
  })
  .passthrough();
type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

const WorkflowJobSchema = z
  .object({
    env: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
    permissions: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(WorkflowStepSchema).optional(),
    "timeout-minutes": z.unknown().optional(),
    "continue-on-error": z.unknown().optional(),
  })
  .passthrough();
type WorkflowJob = z.infer<typeof WorkflowJobSchema>;

const WorkflowSourceSchema = z
  .object({
    env: z.record(z.string(), z.unknown()).optional(),
    jobs: z.record(z.string(), WorkflowJobSchema),
    on: z.record(z.string(), z.unknown()).optional(),
    permissions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
type WorkflowSource = z.infer<typeof WorkflowSourceSchema>;

const ENFORCEMENT_LAYER_PATH_SET: ReadonlySet<string> = new Set(
  EnforcementLayerPaths
);
const BASE64_WHITESPACE_PATTERN = /\s/g;
const PR_SOURCE_TEST_FORK_PATTERN = /fork-safe/i;
const PR_SOURCE_TEST_FAIL_CLOSED_PATTERN = /fail-closed/i;
const FEATURE_FLAG_SOURCE_TEST_MERGE_GROUP_PATTERN = /merge_group/;
const FEATURE_FLAG_SOURCE_TEST_PULL_REQUEST_PATTERN = /pull_request/;
const TRUSTED_WORKFLOW_SOURCE_TEST_TRIGGER_PATTERN = /pull_request_target/;
const TRUSTED_WORKFLOW_SOURCE_TEST_COUNT_PATTERN = /changed_files/;
const TRUSTED_PREFLIGHT_WORKFLOW_JOB_ID =
  "telemetry-contract-schema-update-trusted-preflight";
const FEATURE_FLAG_ATTESTATION_JOB_ID = "check-attestation";
const PR_WORKFLOW_JOB_ID = "telemetry-contract-schema-update-gates";
const PR_WORKFLOW_CHANGES_JOB_ID = "changes";
const CHECKOUT_ACTION = "actions/checkout@v6";
const PATHS_FILTER_ACTION = "dorny/paths-filter@v4";
const MERGE_GROUP_EVENT = "merge_group";
const PULL_REQUEST_EVENT = "pull_request";
const CHECKS_REQUESTED_EVENT_TYPE = "checks_requested";
const PLACEHOLDER_DATABASE_URL = "postgresql://localhost:5432/placeholder";
const TRUSTED_PREFLIGHT_INSTALL_COMMAND = "pnpm install --frozen-lockfile";
const TRUSTED_PREFLIGHT_COMMAND =
  "pnpm exec tsx packages/telemetry-contract/scripts/check-trusted-pr-preflight.ts";
const TRUSTED_PREFLIGHT_NON_DEFAULT_BASE_SKIP_STEP =
  "Skip non-default base branch";
const TRUSTED_PREFLIGHT_NON_DEFAULT_BASE_SKIP_COMMAND =
  'echo "Trusted telemetry contract preflight only runs for pull requests targeting the default branch."';
const TRUSTED_PREFLIGHT_DEFAULT_BASE_CONDITION = [
  "$",
  "{{ github.event.pull_request.base.ref == github.event.repository.default_branch }}",
].join("");
const TRUSTED_PREFLIGHT_NON_DEFAULT_BASE_CONDITION = [
  "$",
  "{{ github.event.pull_request.base.ref != github.event.repository.default_branch }}",
].join("");
const BASE_REF_SHELL_PARAMETER = ["$", "{BASE_REF}"].join("");
const PR_WORKFLOW_GATE_COMMAND = [
  'pnpm --filter @closedloop-ai/telemetry-contract check:schema-update -- --base "origin/',
  BASE_REF_SHELL_PARAMETER,
  '" --head HEAD',
].join("");
const SCHEMA_GATE_DIFF_FILTER_ARGUMENT = "--diff-filter=ACMRT";
const PR_WORKFLOW_BASE_ENV_COMMAND =
  'echo "BASE_REF=$base_ref" >> "$GITHUB_ENV"';
const GITHUB_TOKEN_EXPRESSION = ["$", "{{ github.token }}"].join("");
const GITHUB_REPOSITORY_EXPRESSION = ["$", "{{ github.repository }}"].join("");
const PR_NUMBER_EXPRESSION = [
  "$",
  "{{ github.event.pull_request.number }}",
].join("");
const CHANGED_FILES_EXPRESSION = [
  "$",
  "{{ github.event.pull_request.changed_files }}",
].join("");
const BASE_SHA_EXPRESSION = [
  "$",
  "{{ github.event.pull_request.base.sha }}",
].join("");
const HEAD_SHA_EXPRESSION = [
  "$",
  "{{ github.event.pull_request.head.sha }}",
].join("");
const MERGE_GROUP_BASE_SHA_EXPRESSION = [
  "$",
  "{{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || '' }}",
].join("");
const MERGE_GROUP_HEAD_SHA_EXPRESSION = [
  "$",
  "{{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || '' }}",
].join("");
const MERGE_GROUP_CONDITION = "github.event_name == 'merge_group'";
const PULL_REQUEST_CONDITION = "github.event_name == 'pull_request'";
const TURBO_TOKEN_ENV_NAME = "TURBO_TOKEN";
const TURBO_TEAM_ENV_NAME = "TURBO_TEAM";
const TURBO_TOKEN_MERGE_GROUP_EMPTY_EXPRESSION = [
  "$",
  "{{ github.event_name != 'merge_group' && secrets.TURBO_TOKEN || '' }}",
].join("");
const TURBO_TEAM_MERGE_GROUP_EMPTY_EXPRESSION = [
  "$",
  "{{ github.event_name != 'merge_group' && vars.TURBO_TEAM || '' }}",
].join("");
const PR_BODY_ENV_NAME = "PR_BODY";
const PR_BODY_EXPRESSION = ["$", "{{ github.event.pull_request.body }}"].join(
  ""
);
const FEATURE_FLAG_ATTESTATION_MERGE_GROUP_COMMAND =
  'echo "Feature flag attestation is enforced on pull requests before merge queue admission."';
const FEATURE_FLAG_ATTESTATION_ALLOWED_GREP_COUNT_FALLBACK = String.raw`CHECKED=$(echo "$PR_BODY" | sed -n '/## Feature Flags/,/^## /p' | grep -ci '\[x\]' || true)`;
const SECRET_REFERENCE_TEXT_PATTERN = /secrets\./;
const NODE_AUTH_TOKEN_TEXT_PATTERN = /NODE_AUTH_TOKEN/;
const PR_HEAD_CHECKOUT_TEXT_PATTERN = /github\.event\.pull_request\.head\./;
const GITHUB_OUTPUT_TEXT_PATTERN = /\$GITHUB_OUTPUT/;
const PR_BODY_TEXT_PATTERN = /github\.event\.pull_request\.body|\bPR_BODY\b/;
const TURBO_FALSY_EMPTY_BRANCH_PATTERN =
  /github\.event_name\s*==\s*'merge_group'\s*&&\s*''\s*\|\|\s*(?:secrets|vars)\./;
const FEATURE_FLAG_HEADING_PATTERN = /## Feature Flags/;
const FEATURE_FLAG_OPT_OUT_PATTERN = /\[flag:N\/A\]/;
const EMPTY_PR_BODY_FAILURE_PATTERN = /PR description is empty/;
const EMPTY_PR_BODY_FAILURE_BRANCH_PATTERN =
  /if\s+\[\s+-z\s+"\$PR_BODY"\s+\];\s*then[\s\S]*?exit\s+1/;
const FEATURE_FLAG_OPT_OUT_PR_BODY_COMMAND = String.raw`echo "$PR_BODY" | grep -q '\[flag:N/A\]'`;
const GIT_FETCH_COMMAND_PATTERN = /\bgit\s+fetch\b/;
const GIT_CHECKOUT_COMMAND_PATTERN = /\bgit\s+checkout\b/;
const GH_PR_CHECKOUT_COMMAND_PATTERN = /\bgh\s+pr\s+checkout\b/;
const PACKAGE_INSTALL_COMMAND_PATTERN =
  /\b(?:pnpm\s+install|npm\s+(?:ci|install)|yarn\s+install)\b/;
const SHELL_SOFT_FAIL_TEXT_PATTERN = /\|\| true/;
const EXACT_NEWLINE_INDENT_REGEX_PATTERN = /\\n \{\d+\}/;
const SCHEMA_GATE_TEST_FUTURE_SOURCE_TEST_PATTERN =
  /fails future telemetry source files until they are classified/;
const TRUSTED_PREFLIGHT_TEST_ENFORCEMENT_TEST_PATTERN =
  /enters enforcement-layer edit mode/;
const TRUSTED_PREFLIGHT_TEST_COUNT_TEST_PATTERN = /count mismatch/;
const TRUSTED_PREFLIGHT_TEST_RENAME_TEST_PATTERN = /renamed/;
const TRUSTED_PREFLIGHT_TEST_REMOVAL_TEST_PATTERN = /removed/;
const CompatibilityMappingFieldPropertyByValue = {
  [CompatibilityMappingField.Producer]: "Producer",
  [CompatibilityMappingField.SourceField]: "SourceField",
  [CompatibilityMappingField.Reason]: "Reason",
} as const satisfies Record<
  (typeof RequiredCompatibilityMappingFields)[number],
  keyof typeof CompatibilityMappingField
>;
const EnforcementLayerValidatorByPath = {
  [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
    "validateFeatureFlagAttestationWorkflowSource",
  [TelemetryPreflightPath.PrTestWorkflow]: "validatePrWorkflowSource",
  [TelemetryPreflightPath.TrustedPreflightWorkflow]:
    "validateTrustedPreflightWorkflowSource",
  [TelemetryPreflightPath.SchemaGateScript]: "validateSchemaGateScriptSource",
  [TelemetryPreflightPath.TrustedPreflightScript]:
    "validateTrustedPreflightScriptSource",
  [TelemetryPreflightPath.SchemaGateFixtures]:
    "validateSchemaGateFixtureSource",
  [TelemetryPreflightPath.SchemaGateTest]: "validateSchemaGateTestSource",
  [TelemetryPreflightPath.TrustedPreflightTest]:
    "validateTrustedPreflightTestSource",
  [TelemetryPreflightPath.FeatureFlagAttestationWorkflowSourceTest]:
    "validateSourcePatterns",
  [TelemetryPreflightPath.PrWorkflowSourceTest]: "validateSourcePatterns",
  [TelemetryPreflightPath.TrustedWorkflowSourceTest]: "validateSourcePatterns",
} as const satisfies Record<(typeof EnforcementLayerPaths)[number], string>;

export function evaluateTrustedPreflight(
  input: TrustedPreflightInput
): TrustedPreflightResult {
  const changedFiles = normalizeUniqueRepoPaths(input.changedFiles);
  const companionChangedFiles = normalizeUniqueRepoPaths(
    input.companionChangedFiles ?? input.changedFiles
  );
  const inventoryFindings = validateCompleteFileInventory(
    input.inventoryFileCount ?? input.changedFiles.length,
    input.expectedChangedFileCount
  );
  const telemetryGateFiles = changedFiles.filter(isTelemetryGatePath);

  if (telemetryGateFiles.length === 0) {
    return {
      status:
        inventoryFindings.length === 0
          ? TrustedPreflightStatus.NoOp
          : TrustedPreflightStatus.Failed,
      mode: TrustedPreflightMode.NoTelemetryChanges,
      findings: inventoryFindings,
    };
  }

  const enforcementLayerFiles = changedFiles.filter(isEnforcementLayerPath);
  const findings = [
    ...inventoryFindings,
    ...evaluatePackageGates(changedFiles, companionChangedFiles, input),
    ...validateEnforcementLayerSources(
      enforcementLayerFiles,
      input.headFileSources
    ),
  ];

  return {
    status:
      findings.length === 0
        ? TrustedPreflightStatus.Passed
        : TrustedPreflightStatus.Failed,
    mode:
      enforcementLayerFiles.length === 0
        ? TrustedPreflightMode.GateValidation
        : TrustedPreflightMode.EnforcementLayerEdit,
    findings,
  };
}

export function listPullRequestFiles(
  githubRepository: string,
  pullNumber: number,
  runGhCommand: GhCommandRunner
): TrustedPreflightFileInventory {
  const source = runGhCommand([
    "api",
    "--paginate",
    "--slurp",
    `/repos/${githubRepository}/pulls/${pullNumber}/files?per_page=100`,
  ]);
  const parsed = GitHubPullFilesResponseSchema.parse(JSON.parse(source));
  const files = parsed.flatMap((pageOrFile) =>
    Array.isArray(pageOrFile) ? pageOrFile : [pageOrFile]
  );
  return {
    changedFiles: normalizeUniqueRepoPaths(
      files.flatMap(expandPullFileChangedPaths)
    ),
    companionChangedFiles: normalizeUniqueRepoPaths(
      files.flatMap(expandPullFileCompanionPaths)
    ),
    inventoryFileCount: files.length,
  };
}

export function fetchRepositoryTextFile(
  input: {
    githubRepository: string;
    path: string;
    ref: string;
  },
  runGhCommand: GhCommandRunner
): string {
  const source = runGhCommand([
    "api",
    `/repos/${input.githubRepository}/contents/${encodeRepoPath(input.path)}?ref=${encodeURIComponent(input.ref)}`,
  ]);
  const parsed = GitHubContentResponseSchema.parse(JSON.parse(source));
  return Buffer.from(
    parsed.content.replace(BASE64_WHITESPACE_PATTERN, ""),
    parsed.encoding
  ).toString("utf-8");
}

export function runTrustedPreflightFromGitHub(
  environment: TrustedPreflightEnvironment = process.env,
  runGhCommand: GhCommandRunner = runGhCommandSync
): number {
  const env = TrustedPreflightEnvSchema.parse(environment);
  const fileInventory = listPullRequestFiles(
    env.GITHUB_REPOSITORY,
    env.PR_NUMBER,
    runGhCommand
  );
  const normalizedChangedFiles = normalizeUniqueRepoPaths(
    fileInventory.changedFiles
  );
  const baseAttributesSource = normalizedChangedFiles.includes(
    TelemetryContractPath.AttributesSource
  )
    ? fetchRepositoryTextFile(
        {
          githubRepository: env.GITHUB_REPOSITORY,
          path: TelemetryContractPath.AttributesSource,
          ref: env.BASE_SHA,
        },
        runGhCommand
      )
    : undefined;
  const headAttributesSource = normalizedChangedFiles.includes(
    TelemetryContractPath.AttributesSource
  )
    ? fetchRepositoryTextFile(
        {
          githubRepository: env.GITHUB_REPOSITORY,
          path: TelemetryContractPath.AttributesSource,
          ref: env.HEAD_SHA,
        },
        runGhCommand
      )
    : undefined;
  const result = evaluateTrustedPreflight({
    changedFiles: fileInventory.changedFiles,
    companionChangedFiles: fileInventory.companionChangedFiles,
    inventoryFileCount: fileInventory.inventoryFileCount,
    expectedChangedFileCount: env.EXPECTED_CHANGED_FILE_COUNT,
    baseAttributesSource,
    headAttributesSource,
    headFileSources: fetchHeadFileSources(
      {
        changedFiles: normalizedChangedFiles,
        githubRepository: env.GITHUB_REPOSITORY,
        headSha: env.HEAD_SHA,
      },
      runGhCommand
    ),
  });

  for (const finding of result.findings) {
    console.error(formatGithubError(finding));
    console.error(finding.message);
  }

  if (result.status === TrustedPreflightStatus.NoOp) {
    console.log(
      "Telemetry contract trusted preflight verified the PR file inventory and no-op conditions."
    );
  }

  return result.status === TrustedPreflightStatus.Failed ? 1 : 0;
}

export function isTelemetryGatePath(path: string): boolean {
  const normalizedPath = normalizeRepoPath(path);
  return (
    normalizedPath.startsWith(`${TelemetryContractPath.PackageRoot}/`) ||
    isEnforcementLayerPath(normalizedPath)
  );
}

export function isEnforcementLayerPath(path: string): boolean {
  return ENFORCEMENT_LAYER_PATH_SET.has(normalizeRepoPath(path));
}

function validateCompleteFileInventory(
  actualChangedFileCount: number,
  expectedChangedFileCount: number | undefined
): GateFinding[] {
  if (
    expectedChangedFileCount === undefined ||
    actualChangedFileCount === expectedChangedFileCount
  ) {
    return [];
  }

  return [
    {
      file: TelemetryPreflightPath.TrustedPreflightWorkflow,
      message: `Trusted telemetry preflight changed file count mismatch: GitHub reported ${expectedChangedFileCount}, but REST pagination enumerated ${actualChangedFileCount}.`,
    },
  ];
}

function evaluatePackageGates(
  changedFiles: readonly string[],
  companionChangedFiles: readonly string[],
  input: TrustedPreflightInput
): GateFinding[] {
  try {
    return evaluateSchemaUpdateGates({
      changedFiles,
      companionChangedFiles,
      baseAttributesSource: input.baseAttributesSource,
      headAttributesSource: input.headAttributesSource,
    });
  } catch (error) {
    return [
      {
        file: TelemetryContractPath.AttributesSource,
        message: `Unable to evaluate trusted telemetry package gates: ${formatErrorMessage(error)}`,
      },
    ];
  }
}

function validateEnforcementLayerSources(
  enforcementLayerFiles: readonly string[],
  headFileSources: Readonly<Record<string, string>> | undefined
): GateFinding[] {
  return enforcementLayerFiles.flatMap((path) => {
    const source = headFileSources?.[path];
    if (source === undefined) {
      return [
        {
          file: path,
          message: `Trusted telemetry preflight cannot validate enforcement-layer edit ${path} because PR head source was unavailable as data.`,
        },
      ];
    }
    return validateEnforcementLayerSource(path, source);
  });
}

function validateEnforcementLayerSource(
  path: string,
  source: string
): GateFinding[] {
  if (path === TelemetryPreflightPath.FeatureFlagAttestationWorkflow) {
    return validateFeatureFlagAttestationWorkflowSource(path, source);
  }
  if (path === TelemetryPreflightPath.PrTestWorkflow) {
    return validatePrWorkflowSource(path, source);
  }
  if (path === TelemetryPreflightPath.TrustedPreflightWorkflow) {
    return validateTrustedPreflightWorkflowSource(path, source);
  }
  if (path === TelemetryPreflightPath.SchemaGateScript) {
    return validateSchemaGateScriptSource(path, source);
  }
  if (path === TelemetryPreflightPath.TrustedPreflightScript) {
    return validateTrustedPreflightScriptSource(path, source);
  }
  if (path === TelemetryPreflightPath.SchemaGateFixtures) {
    return validateSchemaGateFixtureSource(path, source);
  }
  if (path === TelemetryPreflightPath.SchemaGateTest) {
    return validateSchemaGateTestSource(path, source);
  }
  if (path === TelemetryPreflightPath.TrustedPreflightTest) {
    return validateTrustedPreflightTestSource(path, source);
  }
  if (
    path === TelemetryPreflightPath.FeatureFlagAttestationWorkflowSourceTest
  ) {
    return validateSourcePatterns(path, source, [
      {
        pattern: FEATURE_FLAG_SOURCE_TEST_MERGE_GROUP_PATTERN,
        message:
          "feature flag attestation workflow source tests must keep merge_group coverage.",
      },
      {
        pattern: FEATURE_FLAG_SOURCE_TEST_PULL_REQUEST_PATTERN,
        message:
          "feature flag attestation workflow source tests must keep pull_request coverage.",
      },
    ]);
  }
  if (path === TelemetryPreflightPath.PrWorkflowSourceTest) {
    return validateSourcePatterns(path, source, [
      {
        pattern: PR_SOURCE_TEST_FORK_PATTERN,
        message: "PR workflow source tests must keep fork-safety coverage.",
      },
      {
        pattern: PR_SOURCE_TEST_FAIL_CLOSED_PATTERN,
        message: "PR workflow source tests must keep fail-closed coverage.",
      },
    ]);
  }
  if (path === TelemetryPreflightPath.TrustedWorkflowSourceTest) {
    return validateSourcePatterns(path, source, [
      {
        pattern: TRUSTED_WORKFLOW_SOURCE_TEST_TRIGGER_PATTERN,
        message:
          "trusted workflow source tests must keep pull_request_target coverage.",
      },
      {
        pattern: TRUSTED_WORKFLOW_SOURCE_TEST_COUNT_PATTERN,
        message:
          "trusted workflow source tests must keep changed_files count coverage.",
      },
    ]);
  }

  return [
    {
      file: path,
      message: `Trusted telemetry preflight has no validator for enforcement-layer path ${path}.`,
    },
  ];
}

function validateTrustedPreflightWorkflowSource(
  path: string,
  source: string
): GateFinding[] {
  const { findings, job, workflow } = parseWorkflowJob(
    path,
    source,
    TRUSTED_PREFLIGHT_WORKFLOW_JOB_ID
  );
  if (!(workflow && job)) {
    return findings;
  }
  return [
    ...findings,
    ...requireSourceInvariant(
      path,
      workflow.on?.pull_request_target !== undefined,
      "trusted preflight workflow must use pull_request_target."
    ),
    ...requireSourceInvariant(
      path,
      job["timeout-minutes"] === 20,
      "trusted preflight workflow must keep timeout-minutes at 20."
    ),
    ...requireSourceInvariant(
      path,
      workflowPermissionEquals(job.permissions, "contents", "read"),
      "trusted preflight workflow must keep contents read-only."
    ),
    ...requireSourceInvariant(
      path,
      workflowPermissionEquals(job.permissions, "pull-requests", "read"),
      "trusted preflight workflow must keep pull-requests read-only."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasCheckoutStep(job),
      "trusted preflight workflow must checkout base-owned code."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasTrustedNonDefaultBaseNoOp(job),
      "trusted preflight workflow must no-op for non-default base branches."
    ),
    ...requireSourceInvariant(
      path,
      workflowExecutableStepsGuardedToDefaultBase(job),
      "trusted preflight workflow must guard all non-skip execution to default-base PRs."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasCheckoutStep(job, {
        ref: BASE_SHA_EXPRESSION,
      }),
      "trusted preflight workflow checkout must pin the PR base sha, not PR head."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasCheckoutStep(job, {
        requirePersistCredentialsFalse: true,
      }),
      "trusted preflight workflow must disable persisted checkout credentials."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, TRUSTED_PREFLIGHT_INSTALL_COMMAND, {
        DATABASE_URL: PLACEHOLDER_DATABASE_URL,
      }),
      "trusted preflight workflow dependency install must provide a placeholder DATABASE_URL."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, TRUSTED_PREFLIGHT_COMMAND, {
        GH_TOKEN: GITHUB_TOKEN_EXPRESSION,
      }),
      "trusted preflight workflow must use the read-only github token."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, TRUSTED_PREFLIGHT_COMMAND, {
        GITHUB_REPOSITORY: GITHUB_REPOSITORY_EXPRESSION,
      }),
      "trusted preflight workflow must pass the repository as data."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, TRUSTED_PREFLIGHT_COMMAND, {
        PR_NUMBER: PR_NUMBER_EXPRESSION,
      }),
      "trusted preflight workflow must pass the PR number."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, TRUSTED_PREFLIGHT_COMMAND, {
        EXPECTED_CHANGED_FILE_COUNT: CHANGED_FILES_EXPRESSION,
      }),
      "trusted preflight workflow must pass changed_files count."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, TRUSTED_PREFLIGHT_COMMAND, {
        BASE_SHA: BASE_SHA_EXPRESSION,
      }),
      "trusted preflight workflow must pass the base sha."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, TRUSTED_PREFLIGHT_COMMAND, {
        HEAD_SHA: HEAD_SHA_EXPRESSION,
      }),
      "trusted preflight workflow must pass the head sha as data."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, TRUSTED_PREFLIGHT_COMMAND),
      "trusted preflight workflow must run the base-owned preflight."
    ),
    ...requireSourceInvariant(
      path,
      workflow.on?.pull_request === undefined,
      "trusted preflight workflow must not use pull_request."
    ),
    ...requireSourceInvariant(
      path,
      !workflowHasWritePermissions(workflow, job),
      "trusted preflight workflow must not request write permissions."
    ),
    ...requireSourceInvariant(
      path,
      !workflowChecksOutPrHead(job),
      "trusted preflight workflow must not checkout PR head content."
    ),
    ...requireSourceInvariant(
      path,
      !workflowHasContinueOnError(job),
      "trusted preflight workflow must not soften failures."
    ),
    ...requireSourceInvariant(
      path,
      !workflowRunTextMatches(job, SHELL_SOFT_FAIL_TEXT_PATTERN),
      "trusted preflight workflow must not soften failures."
    ),
    ...requireSourceInvariant(
      path,
      !workflowTextMatches(job, SECRET_REFERENCE_TEXT_PATTERN),
      "trusted preflight workflow must not reference secrets."
    ),
    ...requireSourceInvariant(
      path,
      !workflowTextMatches(job, NODE_AUTH_TOKEN_TEXT_PATTERN),
      "trusted preflight workflow must not expose package tokens."
    ),
    ...validateTrustedWorkflowShellTrustBoundary(path, job),
  ];
}

function validatePrWorkflowSource(path: string, source: string): GateFinding[] {
  const { findings, job, workflow } = parseWorkflowJob(
    path,
    source,
    PR_WORKFLOW_JOB_ID
  );
  if (!(workflow && job)) {
    return findings;
  }
  return [
    ...findings,
    ...requireSourceInvariant(
      path,
      workflowEventHasType(
        workflow,
        MERGE_GROUP_EVENT,
        CHECKS_REQUESTED_EVENT_TYPE
      ),
      "PR workflow must run on merge_group checks_requested."
    ),
    ...requireSourceInvariant(
      path,
      workflowRecordValueEquals(
        workflow.env,
        TURBO_TOKEN_ENV_NAME,
        TURBO_TOKEN_MERGE_GROUP_EMPTY_EXPRESSION
      ),
      "PR workflow must leave TURBO_TOKEN empty on merge_group."
    ),
    ...requireSourceInvariant(
      path,
      workflowRecordValueEquals(
        workflow.env,
        TURBO_TEAM_ENV_NAME,
        TURBO_TEAM_MERGE_GROUP_EMPTY_EXPRESSION
      ),
      "PR workflow must leave TURBO_TEAM empty on merge_group."
    ),
    ...requireSourceInvariant(
      path,
      job["timeout-minutes"] === 20,
      "PR workflow must keep the telemetry gate timeout."
    ),
    ...requireSourceInvariant(
      path,
      workflowPermissionEquals(job.permissions, "contents", "read"),
      "PR workflow telemetry job must keep contents read-only."
    ),
    ...requireSourceInvariant(
      path,
      workflowPermissionEquals(job.permissions, "pull-requests", "read"),
      "PR workflow telemetry job must keep pull-requests read-only."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasCheckoutStep(job, {
        fetchDepth: 0,
      }),
      "PR workflow checkout must use actions/checkout@v6 with full history."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasCheckoutStep(job, {
        requirePersistCredentialsFalse: true,
      }),
      "PR workflow checkout must not persist credentials."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasUsesStep(job, PATHS_FILTER_ACTION),
      "PR workflow must keep paths-filter as cost optimization."
    ),
    ...requireSourceInvariant(
      path,
      workflowJobHasUsesStep(
        workflow,
        PR_WORKFLOW_CHANGES_JOB_ID,
        PATHS_FILTER_ACTION,
        {
          base: MERGE_GROUP_BASE_SHA_EXPRESSION,
          ref: MERGE_GROUP_HEAD_SHA_EXPRESSION,
        }
      ),
      "PR workflow paths-filter must bind merge_group base/head SHAs."
    ),
    ...requireSourceInvariant(
      path,
      workflowRunTextIncludes(job, PR_WORKFLOW_BASE_ENV_COMMAND),
      "PR workflow must transfer BASE_REF through GITHUB_ENV."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, PR_WORKFLOW_GATE_COMMAND),
      "PR workflow must quote BASE_REF in the gate command."
    ),
    ...requireSourceInvariant(
      path,
      !workflowHasWritePermissions(undefined, job),
      "PR workflow telemetry job must not request write permissions."
    ),
    ...requireSourceInvariant(
      path,
      !workflowTextMatches(job, GITHUB_OUTPUT_TEXT_PATTERN),
      "PR workflow telemetry job must not write branch names to GITHUB_OUTPUT."
    ),
    ...requireSourceInvariant(
      path,
      !workflowRunTextMatches(job, GIT_FETCH_COMMAND_PATTERN),
      "PR workflow telemetry job must not fetch after checkout."
    ),
    ...requireSourceInvariant(
      path,
      !workflowHasContinueOnError(job),
      "PR workflow telemetry job must not soften failures."
    ),
    ...requireSourceInvariant(
      path,
      !workflowRunTextMatches(job, SHELL_SOFT_FAIL_TEXT_PATTERN),
      "PR workflow telemetry job must not soften failures."
    ),
    ...requireSourceInvariant(
      path,
      !workflowTextMatches(job, SECRET_REFERENCE_TEXT_PATTERN),
      "PR workflow telemetry job must not reference secrets."
    ),
    ...requireSourceInvariant(
      path,
      !workflowTextMatches(job, NODE_AUTH_TOKEN_TEXT_PATTERN),
      "PR workflow telemetry job must not expose package tokens."
    ),
    ...validateTurboRemoteCacheMergeGroupBoundary(path, workflow),
  ];
}

function validateFeatureFlagAttestationWorkflowSource(
  path: string,
  source: string
): GateFinding[] {
  const { findings, job, workflow } = parseWorkflowJob(
    path,
    source,
    FEATURE_FLAG_ATTESTATION_JOB_ID
  );
  if (!(workflow && job)) {
    return findings;
  }
  const pullRequestValidationStep = findWorkflowRunStep(job, undefined, {
    env: { [PR_BODY_ENV_NAME]: PR_BODY_EXPRESSION },
    if: PULL_REQUEST_CONDITION,
  });
  return [
    ...findings,
    ...requireSourceInvariant(
      path,
      workflowEventHasType(
        workflow,
        MERGE_GROUP_EVENT,
        CHECKS_REQUESTED_EVENT_TYPE
      ),
      "feature flag attestation workflow must run on merge_group checks_requested."
    ),
    ...requireSourceInvariant(
      path,
      workflow.on?.[PULL_REQUEST_EVENT] !== undefined,
      "feature flag attestation workflow must keep pull_request validation."
    ),
    ...requireSourceInvariant(
      path,
      workflowHasRunStep(job, FEATURE_FLAG_ATTESTATION_MERGE_GROUP_COMMAND, {
        if: MERGE_GROUP_CONDITION,
      }),
      "feature flag attestation workflow must explicitly pass merge_group without PR body."
    ),
    ...requireSourceInvariant(
      path,
      pullRequestValidationStep !== undefined,
      "feature flag attestation workflow must validate the pull_request body only on pull_request."
    ),
    ...requireSourceInvariant(
      path,
      workflowStepRunTextMatches(
        pullRequestValidationStep,
        EMPTY_PR_BODY_FAILURE_PATTERN
      ),
      "feature flag attestation workflow must fail empty pull_request bodies."
    ),
    ...requireSourceInvariant(
      path,
      workflowStepRunTextMatches(
        pullRequestValidationStep,
        FEATURE_FLAG_HEADING_PATTERN
      ),
      "feature flag attestation workflow must require the Feature Flags section."
    ),
    ...requireSourceInvariant(
      path,
      workflowStepRunTextMatches(
        pullRequestValidationStep,
        FEATURE_FLAG_OPT_OUT_PATTERN
      ),
      "feature flag attestation workflow must keep justified [flag:N/A] support."
    ),
    ...requireSourceInvariant(
      path,
      featureFlagAttestationStepEnforcesPrBody(pullRequestValidationStep),
      "feature flag attestation workflow must enforce PR_BODY-dependent validation branches."
    ),
    ...requireSourceInvariant(
      path,
      !featureFlagAttestationHasPrBodyOutsidePullRequestValidation(
        workflow,
        job
      ),
      "feature flag attestation non-pull_request branches must not read pull_request body."
    ),
    ...requireSourceInvariant(
      path,
      !workflowHasContinueOnError(job),
      "feature flag attestation workflow must not soften failures."
    ),
    ...requireSourceInvariant(
      path,
      !workflowHasDisallowedShellSoftFail(job),
      "feature flag attestation workflow must not soften failures."
    ),
  ];
}

function validateSchemaGateScriptSource(
  path: string,
  source: string
): GateFinding[] {
  const sourceFile = createValidationSourceFile(path, source);
  return [
    ...validateSchemaSourceClassificationPolicy(sourceFile, path),
    ...requireConstObjectStringValue(
      sourceFile,
      path,
      "SchemaSourceClassificationKind",
      "SchemaGroup",
      "schemaGroup",
      "schema gate script must keep schemaGroup classification."
    ),
    ...requireConstObjectStringValue(
      sourceFile,
      path,
      "SchemaSourceClassificationKind",
      "CompatibilityAttributes",
      "compatibilityAttributes",
      "schema gate script must keep compatibility attributes classification."
    ),
    ...requireConstObjectStringValue(
      sourceFile,
      path,
      "SchemaSourceClassificationKind",
      "NonSchemaSource",
      "nonSchemaSource",
      "schema gate script must keep explicit non-schema classification."
    ),
    ...requireConstObjectStringValue(
      sourceFile,
      path,
      "CompatibilityMappingField",
      "Producer",
      CompatibilityMappingField.Producer,
      "schema gate script must keep canonical producer mapping field."
    ),
    ...requireConstObjectStringValue(
      sourceFile,
      path,
      "CompatibilityMappingField",
      "SourceField",
      CompatibilityMappingField.SourceField,
      "schema gate script must keep canonical sourceField mapping field."
    ),
    ...requireConstObjectStringValue(
      sourceFile,
      path,
      "CompatibilityMappingField",
      "Reason",
      CompatibilityMappingField.Reason,
      "schema gate script must keep canonical reason mapping field."
    ),
    ...RequiredCompatibilityMappingFields.flatMap((field) =>
      requireArrayConstPropertyAccess(
        sourceFile,
        path,
        "RequiredCompatibilityMappingFields",
        "CompatibilityMappingField",
        getCompatibilityMappingFieldProperty(field),
        `schema gate script must keep required ${field} mapping field coverage.`
      )
    ),
    ...requireSourceInvariant(
      path,
      functionRequiresJsonSchemaParity(sourceFile),
      "schema gate script must keep JSON Schema parity enforcement."
    ),
    ...requireSourceInvariant(
      path,
      functionContainsStringLiteral(
        sourceFile,
        "listTelemetryContractChangedFiles",
        SCHEMA_GATE_DIFF_FILTER_ARGUMENT
      ),
      "schema gate script must keep git diff filter excluding deleted files."
    ),
    ...requireSourceInvariant(
      path,
      functionContainsUnclassifiedSourceFailure(sourceFile),
      "schema gate script must keep unknown source fail-closed behavior."
    ),
  ];
}

function validateTrustedPreflightScriptSource(
  path: string,
  source: string
): GateFinding[] {
  const sourceFile = createValidationSourceFile(path, source);
  const pullFileSchemaProperties = findZodObjectPropertyNames(
    sourceFile,
    "GitHubPullFileSchema"
  );
  return [
    ...requireSourceInvariant(
      path,
      pullFileSchemaProperties.has("filename"),
      "trusted preflight script must parse GitHub PR file filenames."
    ),
    ...requireSourceInvariant(
      path,
      pullFileSchemaProperties.has("status"),
      "trusted preflight script must parse GitHub PR file status."
    ),
    ...requireSourceInvariant(
      path,
      pullFileSchemaProperties.has("previous_filename"),
      "trusted preflight script must parse GitHub PR file previous_filename."
    ),
    ...requireArrayConstPropertyAccess(
      sourceFile,
      path,
      "EnforcementLayerPaths",
      "TelemetryPreflightPath",
      "SchemaGateFixtures",
      "trusted preflight script must protect shared schema gate fixtures."
    ),
    ...requireSourceInvariant(
      path,
      functionContainsCountComparison(sourceFile),
      "trusted preflight script must compare changed file count."
    ),
    ...requireSourceInvariant(
      path,
      functionCallsIdentifier(
        sourceFile,
        "listPullRequestFiles",
        "expandPullFileChangedPaths"
      ),
      "trusted preflight script must include renamed previous paths in file inventory."
    ),
    ...requireSourceInvariant(
      path,
      functionCallsIdentifier(
        sourceFile,
        "runTrustedPreflightFromGitHub",
        "fetchHeadFileSources"
      ),
      "trusted preflight script must fetch PR head sources as data."
    ),
    ...validateEnforcementLayerDispatch(sourceFile, path),
    ...requireSourceInvariant(
      path,
      functionCatchReturnsFailure(sourceFile, "main"),
      "trusted preflight script must fail closed on API errors."
    ),
  ];
}

function validateSchemaGateFixtureSource(
  path: string,
  source: string
): GateFinding[] {
  const sourceFile = createValidationSourceFile(path, source);
  return [
    ...requireSourceInvariant(
      path,
      sourceHasImportSpecifier(
        sourceFile,
        "CompatibilityMappingField",
        "../scripts/check-schema-update-gates"
      ),
      "schema gate fixtures must import canonical compatibility mapping fields."
    ),
    ...requireSourceInvariant(
      path,
      sourceFileContainsIdentifier(sourceFile, "CompatibilityMappingField"),
      "schema gate fixtures must use canonical compatibility mapping fields."
    ),
    ...requireSourceInvariant(
      path,
      sourceHasFunctionDeclaration(sourceFile, "compatibilityAttributesSource"),
      "schema gate fixtures must keep compatibility attribute source generation."
    ),
  ];
}

function validateSchemaGateTestSource(
  path: string,
  source: string
): GateFinding[] {
  const sourceFile = createValidationSourceFile(path, source);
  return [
    ...requireSourceInvariant(
      path,
      sourceHasTestName(
        sourceFile,
        SCHEMA_GATE_TEST_FUTURE_SOURCE_TEST_PATTERN
      ),
      "schema gate tests must keep future-source fail-closed coverage."
    ),
    ...requireSourceInvariant(
      path,
      sourceHasImportSpecifier(
        sourceFile,
        "RequiredCompatibilityMappingFields",
        "../scripts/check-schema-update-gates"
      ),
      "schema gate tests must import canonical mapping field coverage."
    ),
    ...requireSourceInvariant(
      path,
      sourceFileContainsIdentifier(
        sourceFile,
        "RequiredCompatibilityMappingFields"
      ),
      "schema gate tests must use canonical mapping field coverage."
    ),
  ];
}

function validateTrustedPreflightTestSource(
  path: string,
  source: string
): GateFinding[] {
  const sourceFile = createValidationSourceFile(path, source);
  return [
    ...requireSourceInvariant(
      path,
      sourceHasTestName(
        sourceFile,
        TRUSTED_PREFLIGHT_TEST_ENFORCEMENT_TEST_PATTERN
      ),
      "trusted preflight tests must keep enforcement-layer edit coverage."
    ),
    ...requireSourceInvariant(
      path,
      sourceHasTestName(sourceFile, TRUSTED_PREFLIGHT_TEST_COUNT_TEST_PATTERN),
      "trusted preflight tests must keep count-mismatch coverage."
    ),
    ...requireSourceInvariant(
      path,
      sourceHasTestName(sourceFile, TRUSTED_PREFLIGHT_TEST_RENAME_TEST_PATTERN),
      "trusted preflight tests must keep rename coverage."
    ),
    ...requireSourceInvariant(
      path,
      sourceHasTrustedRunnerRemovalCoverage(sourceFile),
      "trusted preflight tests must keep runner-level removal annotation coverage."
    ),
    ...requireSourceInvariant(
      path,
      !sourceHasExactNewlineIndentRegex(sourceFile),
      "trusted preflight tests must avoid exact newline indentation source-text matchers."
    ),
  ];
}

function validateSchemaSourceClassificationPolicy(
  sourceFile: ts.SourceFile,
  path: string
): GateFinding[] {
  const actualPolicy = parseSchemaSourceClassificationPolicy(sourceFile);
  return Object.entries(TelemetrySchemaSourceClassification).flatMap(
    ([sourcePath, expected]) => {
      const actual = actualPolicy.get(sourcePath);
      const expectedKind = expected.kind;
      if (!actual) {
        return [
          {
            file: path,
            message: `schema gate script must keep ${sourcePath} classified as ${expectedKind}.`,
          },
        ];
      }
      const findings: GateFinding[] = [];
      if (actual.kind !== expectedKind) {
        findings.push({
          file: path,
          message: `schema gate script must keep ${sourcePath} classified as ${expectedKind}.`,
        });
      }
      if (expected.testPath && actual.testPath !== expected.testPath) {
        findings.push({
          file: path,
          message: `schema gate script must keep ${sourcePath} mapped to companion test ${expected.testPath}.`,
        });
      }
      if (expected.reason && actual.reason !== expected.reason) {
        findings.push({
          file: path,
          message: `schema gate script must keep ${sourcePath} classification reason.`,
        });
      }
      return findings;
    }
  );
}

function validateEnforcementLayerDispatch(
  sourceFile: ts.SourceFile,
  path: string
): GateFinding[] {
  return Object.entries(EnforcementLayerValidatorByPath).flatMap(
    ([enforcementPath, validatorName]) =>
      requireSourceInvariant(
        path,
        functionDispatchesPathToValidator(
          sourceFile,
          "validateEnforcementLayerSource",
          enforcementPath,
          validatorName
        ),
        `trusted preflight script must dispatch ${enforcementPath} to ${validatorName}.`
      )
  );
}

function requireSourceInvariant(
  path: string,
  invariant: boolean,
  message: string
): GateFinding[] {
  return invariant ? [] : [{ file: path, message }];
}

function validateSourcePatterns(
  path: string,
  source: string,
  requiredPatterns: readonly RequiredSourcePattern[],
  forbiddenPatterns: readonly RequiredSourcePattern[] = []
): GateFinding[] {
  const missingFindings = requiredPatterns
    .filter(({ pattern }) => !pattern.test(source))
    .map(({ message }) => ({ file: path, message }));
  const forbiddenFindings = forbiddenPatterns
    .filter(({ pattern }) => pattern.test(source))
    .map(({ message }) => ({ file: path, message }));
  return [...missingFindings, ...forbiddenFindings];
}

function parseWorkflowJob(
  path: string,
  source: string,
  jobId: string
): WorkflowValidationResult {
  const workflowResult = parseWorkflowSource(path, source);
  if (!workflowResult.workflow) {
    return { ...workflowResult, job: undefined };
  }
  const job = workflowResult.workflow.jobs[jobId];
  if (!job) {
    return {
      workflow: workflowResult.workflow,
      job: undefined,
      findings: [
        ...workflowResult.findings,
        {
          file: path,
          message: `workflow must keep required job ${jobId}.`,
        },
      ],
    };
  }
  return {
    workflow: workflowResult.workflow,
    job,
    findings: workflowResult.findings,
  };
}

function parseWorkflowSource(
  path: string,
  source: string
): { workflow: WorkflowSource | undefined; findings: GateFinding[] } {
  try {
    const result = WorkflowSourceSchema.safeParse(YAML.parse(source));
    if (result.success) {
      return { workflow: result.data, findings: [] };
    }
    return {
      workflow: undefined,
      findings: [
        {
          file: path,
          message: `workflow source must parse as a GitHub Actions workflow: ${result.error.issues[0]?.message ?? "invalid workflow shape"}.`,
        },
      ],
    };
  } catch (error) {
    return {
      workflow: undefined,
      findings: [
        {
          file: path,
          message: `workflow source must parse as YAML: ${formatErrorMessage(error)}.`,
        },
      ],
    };
  }
}

function workflowPermissionEquals(
  permissions: Readonly<Record<string, unknown>> | undefined,
  permissionName: string,
  expectedValue: string
): boolean {
  return permissions?.[permissionName] === expectedValue;
}

function workflowHasWritePermissions(
  workflow: WorkflowSource | undefined,
  job: WorkflowJob
): boolean {
  return [workflow?.permissions, job.permissions].some((permissions) =>
    workflowPermissionsHaveWriteScope(permissions)
  );
}

function workflowPermissionsHaveWriteScope(
  permissions: Readonly<Record<string, unknown>> | undefined
): boolean {
  return Object.values(permissions ?? {}).some(
    (permission) => permission === "write"
  );
}

function workflowHasCheckoutStep(
  job: WorkflowJob,
  options: {
    fetchDepth?: number;
    ref?: string;
    requirePersistCredentialsFalse?: boolean;
  } = {}
): boolean {
  return workflowSteps(job).some(
    (step) =>
      step.uses === CHECKOUT_ACTION &&
      (options.ref === undefined ||
        workflowRecordValueEquals(step.with, "ref", options.ref)) &&
      (options.fetchDepth === undefined ||
        workflowRecordValueEquals(
          step.with,
          "fetch-depth",
          options.fetchDepth
        )) &&
      (!options.requirePersistCredentialsFalse ||
        workflowRecordValueIsFalse(step.with, "persist-credentials"))
  );
}

function workflowHasUsesStep(
  job: WorkflowJob,
  uses: string,
  withValues: Readonly<Record<string, string>> = {}
): boolean {
  return workflowSteps(job).some(
    (step) =>
      step.uses === uses &&
      Object.entries(withValues).every(([key, value]) =>
        workflowRecordValueEquals(step.with, key, value)
      )
  );
}

function workflowJobHasUsesStep(
  workflow: WorkflowSource,
  jobId: string,
  uses: string,
  withValues: Readonly<Record<string, string>>
): boolean {
  const job = workflow.jobs[jobId];
  return Boolean(job && workflowHasUsesStep(job, uses, withValues));
}

function workflowHasRunStep(
  job: WorkflowJob,
  run: string | undefined,
  options: Readonly<Record<string, string>> | WorkflowRunStepOptions = {}
): boolean {
  return findWorkflowRunStep(job, run, options) !== undefined;
}

function findWorkflowRunStep(
  job: WorkflowJob,
  run: string | undefined,
  options: Readonly<Record<string, string>> | WorkflowRunStepOptions = {}
): WorkflowStep | undefined {
  const hasRunStepOptions = isWorkflowRunStepOptions(options);
  const expectedIf = hasRunStepOptions ? options.if : undefined;
  const expectedEnv = hasRunStepOptions ? options.env : options;
  return workflowSteps(job).find((step) => {
    if (run !== undefined && step.run !== run) {
      return false;
    }
    if (run === undefined && step.run === undefined) {
      return false;
    }
    if (expectedIf !== undefined && step.if !== expectedIf) {
      return false;
    }
    return Object.entries(expectedEnv ?? {}).every(([key, value]) =>
      workflowRecordValueEquals(step.env, key, value)
    );
  });
}

function isWorkflowRunStepOptions(
  options: Readonly<Record<string, string>> | WorkflowRunStepOptions
): options is WorkflowRunStepOptions {
  return objectHasOwn(options, "if") || objectHasOwn(options, "env");
}

function workflowHasTrustedNonDefaultBaseNoOp(job: WorkflowJob): boolean {
  return workflowSteps(job).some(workflowStepIsTrustedNonDefaultBaseNoOp);
}

function workflowExecutableStepsGuardedToDefaultBase(
  job: WorkflowJob
): boolean {
  return workflowSteps(job).every(
    (step) =>
      !workflowStepIsExecutable(step) ||
      workflowStepIsTrustedNonDefaultBaseNoOp(step) ||
      step.if === TRUSTED_PREFLIGHT_DEFAULT_BASE_CONDITION
  );
}

function workflowStepIsTrustedNonDefaultBaseNoOp(step: WorkflowStep): boolean {
  return (
    step.name === TRUSTED_PREFLIGHT_NON_DEFAULT_BASE_SKIP_STEP &&
    step.if === TRUSTED_PREFLIGHT_NON_DEFAULT_BASE_CONDITION &&
    step.run === TRUSTED_PREFLIGHT_NON_DEFAULT_BASE_SKIP_COMMAND &&
    step.uses === undefined
  );
}

function workflowStepIsExecutable(step: WorkflowStep): boolean {
  return step.run !== undefined || step.uses !== undefined;
}

function workflowRunTextIncludes(job: WorkflowJob, text: string): boolean {
  return workflowSteps(job).some((step) => step.run?.includes(text) ?? false);
}

function workflowRunTextMatches(job: WorkflowJob, pattern: RegExp): boolean {
  return workflowSteps(job).some((step) => pattern.test(step.run ?? ""));
}

function workflowStepRunTextMatches(
  step: WorkflowStep | undefined,
  pattern: RegExp
): boolean {
  return pattern.test(step?.run ?? "");
}

function workflowStepRunTextIncludes(
  step: WorkflowStep | undefined,
  text: string
): boolean {
  return step?.run?.includes(text) ?? false;
}

function workflowTextMatches(job: WorkflowJob, pattern: RegExp): boolean {
  return collectWorkflowStringValues(job).some((value) => pattern.test(value));
}

function workflowHasDisallowedShellSoftFail(job: WorkflowJob): boolean {
  return workflowSteps(job).some((step) =>
    (step.run ?? "")
      .split("\n")
      .some(
        (line) =>
          SHELL_SOFT_FAIL_TEXT_PATTERN.test(line) &&
          !isAllowedFeatureFlagAttestationShellSoftFail(line)
      )
  );
}

function isAllowedFeatureFlagAttestationShellSoftFail(line: string): boolean {
  return line.trim() === FEATURE_FLAG_ATTESTATION_ALLOWED_GREP_COUNT_FALLBACK;
}

function featureFlagAttestationStepEnforcesPrBody(
  step: WorkflowStep | undefined
): boolean {
  return (
    workflowStepRunTextMatches(step, EMPTY_PR_BODY_FAILURE_BRANCH_PATTERN) &&
    workflowStepRunTextIncludes(step, FEATURE_FLAG_OPT_OUT_PR_BODY_COMMAND) &&
    workflowStepRunTextIncludes(
      step,
      FEATURE_FLAG_ATTESTATION_ALLOWED_GREP_COUNT_FALLBACK
    )
  );
}

function featureFlagAttestationHasPrBodyOutsidePullRequestValidation(
  workflow: WorkflowSource,
  job: WorkflowJob
): boolean {
  return (
    workflowStringValuesMatch(workflow.env, PR_BODY_TEXT_PATTERN) ||
    workflowStringValuesMatch(job.env, PR_BODY_TEXT_PATTERN) ||
    workflowStepsWithoutIfMatchText(
      job,
      PULL_REQUEST_CONDITION,
      PR_BODY_TEXT_PATTERN
    )
  );
}

function workflowStringValuesMatch(value: unknown, pattern: RegExp): boolean {
  return collectWorkflowStringValues(value).some((text) => pattern.test(text));
}

function workflowStepsWithoutIfMatchText(
  job: WorkflowJob,
  stepIf: string,
  pattern: RegExp
): boolean {
  return workflowSteps(job).some(
    (step) =>
      step.if !== stepIf &&
      collectWorkflowStringValues(step).some((value) => pattern.test(value))
  );
}

function workflowEventHasType(
  workflow: WorkflowSource,
  eventName: string,
  eventType: string
): boolean {
  const event = workflow.on?.[eventName];
  if (!(event && typeof event === "object" && !Array.isArray(event))) {
    return false;
  }
  const eventRecord = event as Record<string, unknown>;
  const types = eventRecord.types;
  return Array.isArray(types) && types.includes(eventType);
}

function validateTurboRemoteCacheMergeGroupBoundary(
  path: string,
  workflow: WorkflowSource
): GateFinding[] {
  const findings: GateFinding[] = [];
  validateTurboEnvRecord(
    findings,
    path,
    workflow.env,
    "workflow",
    TURBO_TOKEN_MERGE_GROUP_EMPTY_EXPRESSION,
    TURBO_TEAM_MERGE_GROUP_EMPTY_EXPRESSION
  );

  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    validateTurboEnvRecord(
      findings,
      path,
      job.env,
      `job ${jobId}`,
      TURBO_TOKEN_MERGE_GROUP_EMPTY_EXPRESSION,
      TURBO_TEAM_MERGE_GROUP_EMPTY_EXPRESSION
    );
    for (const step of workflowSteps(job)) {
      validateTurboEnvRecord(
        findings,
        path,
        step.env,
        `job ${jobId} step ${step.name ?? "<unnamed>"}`,
        TURBO_TOKEN_MERGE_GROUP_EMPTY_EXPRESSION,
        TURBO_TEAM_MERGE_GROUP_EMPTY_EXPRESSION
      );
    }
  }

  return findings;
}

function validateTurboEnvRecord(
  findings: GateFinding[],
  path: string,
  env: Readonly<Record<string, unknown>> | undefined,
  scope: string,
  expectedTokenValue: string,
  expectedTeamValue: string
): void {
  const formattedScope = formatPrWorkflowScope(scope);
  if (
    objectHasOwn(env ?? {}, TURBO_TOKEN_ENV_NAME) &&
    !workflowRecordValueEquals(env, TURBO_TOKEN_ENV_NAME, expectedTokenValue)
  ) {
    findings.push({
      file: path,
      message: `${formattedScope} must not expose TURBO_TOKEN to merge_group.`,
    });
  }
  if (
    workflowRecordValueMatches(
      env,
      TURBO_TOKEN_ENV_NAME,
      TURBO_FALSY_EMPTY_BRANCH_PATTERN
    )
  ) {
    findings.push({
      file: path,
      message: `${formattedScope} must not use a falsy empty-string branch before a TURBO_TOKEN fallback.`,
    });
  }
  if (
    objectHasOwn(env ?? {}, TURBO_TEAM_ENV_NAME) &&
    !workflowRecordValueEquals(env, TURBO_TEAM_ENV_NAME, expectedTeamValue)
  ) {
    findings.push({
      file: path,
      message: `${formattedScope} must not expose TURBO_TEAM to merge_group.`,
    });
  }
  if (
    workflowRecordValueMatches(
      env,
      TURBO_TEAM_ENV_NAME,
      TURBO_FALSY_EMPTY_BRANCH_PATTERN
    )
  ) {
    findings.push({
      file: path,
      message: `${formattedScope} must not use a falsy empty-string branch before a TURBO_TEAM fallback.`,
    });
  }
}

function formatPrWorkflowScope(scope: string): string {
  return scope === "workflow" ? "PR workflow" : `PR workflow ${scope}`;
}

function workflowChecksOutPrHead(job: WorkflowJob): boolean {
  return workflowSteps(job).some(workflowStepChecksOutPrHead);
}

function workflowStepChecksOutPrHead(step: WorkflowStep): boolean {
  return (
    step.uses === CHECKOUT_ACTION &&
    (workflowRecordValueMatches(
      step.with,
      "ref",
      PR_HEAD_CHECKOUT_TEXT_PATTERN
    ) ||
      workflowRecordValueMatches(
        step.with,
        "repository",
        PR_HEAD_CHECKOUT_TEXT_PATTERN
      ))
  );
}

function workflowHasContinueOnError(job: WorkflowJob): boolean {
  return (
    objectHasOwn(job, "continue-on-error") ||
    workflowSteps(job).some((step) => objectHasOwn(step, "continue-on-error"))
  );
}

function validateTrustedWorkflowShellTrustBoundary(
  path: string,
  job: WorkflowJob
): GateFinding[] {
  const findings: GateFinding[] = [];
  let hasPrHeadMaterialization = false;
  let reportedShellMaterialization = false;
  let reportedInstallAfterMaterialization = false;

  for (const step of workflowSteps(job)) {
    const run = step.run ?? "";
    const shellMaterializesPrHead = workflowRunMaterializesPrHead(run);
    const stepChecksOutPrHead = workflowStepChecksOutPrHead(step);

    if (shellMaterializesPrHead && !reportedShellMaterialization) {
      findings.push({
        file: path,
        message:
          "trusted preflight workflow must not checkout PR head content.",
      });
      reportedShellMaterialization = true;
    }

    if (
      (hasPrHeadMaterialization ||
        shellMaterializesPrHead ||
        stepChecksOutPrHead) &&
      PACKAGE_INSTALL_COMMAND_PATTERN.test(run) &&
      !reportedInstallAfterMaterialization
    ) {
      findings.push({
        file: path,
        message:
          "trusted preflight workflow must not install dependencies after PR head content is materialized.",
      });
      reportedInstallAfterMaterialization = true;
    }

    hasPrHeadMaterialization =
      hasPrHeadMaterialization ||
      shellMaterializesPrHead ||
      stepChecksOutPrHead;
  }

  return findings;
}

function workflowRunMaterializesPrHead(run: string): boolean {
  return (
    GIT_FETCH_COMMAND_PATTERN.test(run) ||
    GIT_CHECKOUT_COMMAND_PATTERN.test(run) ||
    GH_PR_CHECKOUT_COMMAND_PATTERN.test(run)
  );
}

function workflowRecordValueEquals(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
  expectedValue: string | number | boolean
): boolean {
  const value = record?.[key];
  return (
    value === expectedValue ||
    (typeof expectedValue === "number" && value === String(expectedValue))
  );
}

function workflowRecordValueIsFalse(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string
): boolean {
  const value = record?.[key];
  return value === false || value === "false";
}

function workflowRecordValueMatches(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
  pattern: RegExp
): boolean {
  const value = record?.[key];
  return typeof value === "string" && pattern.test(value);
}

function workflowSteps(job: WorkflowJob): readonly WorkflowStep[] {
  return job.steps ?? [];
}

export function collectWorkflowStringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectWorkflowStringValues);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectWorkflowStringValues);
  }
  return [];
}

function objectHasOwn(object: object, propertyName: string): boolean {
  return Object.hasOwn(object, propertyName);
}

function requireConstObjectStringValue(
  sourceFile: ts.SourceFile,
  path: string,
  objectName: string,
  propertyName: string,
  expectedValue: string,
  message: string
): GateFinding[] {
  return requireSourceInvariant(
    path,
    constObjectHasStringValue(
      sourceFile,
      objectName,
      propertyName,
      expectedValue
    ),
    message
  );
}

function requireArrayConstPropertyAccess(
  sourceFile: ts.SourceFile,
  path: string,
  arrayName: string,
  objectName: string,
  propertyName: string,
  message: string
): GateFinding[] {
  return requireSourceInvariant(
    path,
    arrayConstIncludesPropertyAccess(
      sourceFile,
      arrayName,
      objectName,
      propertyName
    ),
    message
  );
}

function getCompatibilityMappingFieldProperty(
  field: (typeof RequiredCompatibilityMappingFields)[number]
): keyof typeof CompatibilityMappingField {
  return CompatibilityMappingFieldPropertyByValue[field];
}

function constObjectHasStringValue(
  sourceFile: ts.SourceFile,
  objectName: string,
  propertyName: string,
  expectedValue: string
): boolean {
  const objectLiteral = findConstObjectLiteral(sourceFile, objectName);
  if (!objectLiteral) {
    return false;
  }
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (getStaticPropertyName(property.name) !== propertyName) {
      continue;
    }
    return (
      ts.isStringLiteralLike(property.initializer) &&
      property.initializer.text === expectedValue
    );
  }
  return false;
}

function arrayConstIncludesPropertyAccess(
  sourceFile: ts.SourceFile,
  arrayName: string,
  objectName: string,
  propertyName: string
): boolean {
  const declaration = findVariableDeclaration(sourceFile, arrayName);
  const arrayLiteral = declaration?.initializer
    ? unwrapArrayLiteral(declaration.initializer)
    : undefined;
  return (
    arrayLiteral?.elements.some(
      (element) =>
        ts.isPropertyAccessExpression(element) &&
        ts.isIdentifier(element.expression) &&
        element.expression.text === objectName &&
        element.name.text === propertyName
    ) ?? false
  );
}

function parseSchemaSourceClassificationPolicy(
  sourceFile: ts.SourceFile
): Map<string, { kind?: string; reason?: string; testPath?: string }> {
  const declaration = findVariableDeclaration(
    sourceFile,
    "TelemetrySchemaSourceClassification"
  );
  const objectLiteral = declaration?.initializer
    ? unwrapObjectLiteral(declaration.initializer)
    : undefined;
  const policy = new Map<
    string,
    { kind?: string; reason?: string; testPath?: string }
  >();
  for (const property of objectLiteral?.properties ?? []) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const sourcePath = resolveSchemaPolicyKey(sourceFile, property.name);
    const classification = unwrapObjectLiteral(property.initializer);
    if (!(sourcePath && classification)) {
      continue;
    }
    policy.set(
      sourcePath,
      parseSchemaClassificationEntry(sourceFile, classification)
    );
  }
  return policy;
}

function parseSchemaClassificationEntry(
  sourceFile: ts.SourceFile,
  objectLiteral: ts.ObjectLiteralExpression
): { kind?: string; reason?: string; testPath?: string } {
  const entry: { kind?: string; reason?: string; testPath?: string } = {};
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = getStaticPropertyName(property.name);
    if (!(name === "kind" || name === "reason" || name === "testPath")) {
      continue;
    }
    entry[name] = resolveSchemaPolicyString(sourceFile, property.initializer);
  }
  return entry;
}

function resolveSchemaPolicyKey(
  sourceFile: ts.SourceFile,
  name: ts.PropertyName
): string | undefined {
  if (ts.isComputedPropertyName(name)) {
    return resolveSchemaPolicyString(sourceFile, name.expression);
  }
  return getStaticPropertyName(name);
}

function resolveSchemaPolicyString(
  sourceFile: ts.SourceFile,
  expression: ts.Expression
): string | undefined {
  const unwrappedExpression = unwrapExpression(expression);
  if (ts.isStringLiteralLike(unwrappedExpression)) {
    return unwrappedExpression.text;
  }
  if (!ts.isPropertyAccessExpression(unwrappedExpression)) {
    return undefined;
  }
  if (!ts.isIdentifier(unwrappedExpression.expression)) {
    return undefined;
  }
  const objectName = unwrappedExpression.expression.text;
  const propertyName = unwrappedExpression.name.text;
  const objectLiteral = findConstObjectLiteral(sourceFile, objectName);
  for (const property of objectLiteral?.properties ?? []) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    if (getStaticPropertyName(property.name) !== propertyName) {
      continue;
    }
    const initializer = unwrapExpression(property.initializer);
    return ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
  }
  return undefined;
}

function findZodObjectPropertyNames(
  sourceFile: ts.SourceFile,
  schemaName: string
): Set<string> {
  const declaration = findVariableDeclaration(sourceFile, schemaName);
  const objectLiteral = declaration?.initializer
    ? unwrapZodObjectLiteral(declaration.initializer)
    : undefined;
  const propertyNames = new Set<string>();
  for (const property of objectLiteral?.properties ?? []) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const propertyName = getStaticPropertyName(property.name);
    if (propertyName) {
      propertyNames.add(propertyName);
    }
  }
  return propertyNames;
}

function functionContainsCountComparison(sourceFile: ts.SourceFile): boolean {
  const declaration = findFunctionDeclaration(
    sourceFile,
    "validateCompleteFileInventory"
  );
  return Boolean(
    declaration &&
      nodeContains(
        declaration,
        (node) =>
          ts.isBinaryExpression(node) &&
          (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            node.operatorToken.kind ===
              ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
          nodeContainsIdentifier(node.left, "actualChangedFileCount") &&
          nodeContainsIdentifier(node.right, "expectedChangedFileCount")
      )
  );
}

function functionContainsUnclassifiedSourceFailure(
  sourceFile: ts.SourceFile
): boolean {
  const declaration = findFunctionDeclaration(
    sourceFile,
    "findMissingSchemaCompanions"
  );
  return Boolean(
    declaration &&
      nodeContains(
        declaration,
        (node) =>
          ts.isIfStatement(node) &&
          isNotIdentifier(node.expression, "classification") &&
          nodeContainsCallExpression(node.thenStatement, "findings", "push")
      )
  );
}

function functionRequiresJsonSchemaParity(sourceFile: ts.SourceFile): boolean {
  const declaration = findFunctionDeclaration(
    sourceFile,
    "findMissingSchemaCompanions"
  );
  return Boolean(
    declaration &&
      nodeContains(
        declaration,
        (node) =>
          ts.isIfStatement(node) &&
          expressionRequiresMissingCallWithArgument(
            node.expression,
            "changedFileSet",
            "has",
            "JsonSchemaParity"
          ) &&
          nodeContainsCallExpression(node.thenStatement, "findings", "push")
      )
  );
}

function expressionRequiresMissingCallWithArgument(
  expression: ts.Expression,
  objectName: string,
  methodName: string,
  propertyName: string
): boolean {
  const unwrappedExpression = unwrapExpression(expression);
  if (
    ts.isPrefixUnaryExpression(unwrappedExpression) &&
    unwrappedExpression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return expressionIsCallWithArgument(
      unwrappedExpression.operand,
      objectName,
      methodName,
      propertyName
    );
  }
  if (!ts.isBinaryExpression(unwrappedExpression)) {
    return false;
  }
  if (
    unwrappedExpression.operatorToken.kind ===
      ts.SyntaxKind.EqualsEqualsEqualsToken ||
    unwrappedExpression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
  ) {
    return binaryExpressionComparesCallToBoolean(
      unwrappedExpression,
      objectName,
      methodName,
      propertyName,
      false
    );
  }
  if (
    unwrappedExpression.operatorToken.kind ===
      ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    unwrappedExpression.operatorToken.kind ===
      ts.SyntaxKind.ExclamationEqualsToken
  ) {
    return binaryExpressionComparesCallToBoolean(
      unwrappedExpression,
      objectName,
      methodName,
      propertyName,
      true
    );
  }
  return false;
}

function binaryExpressionComparesCallToBoolean(
  expression: ts.BinaryExpression,
  objectName: string,
  methodName: string,
  propertyName: string,
  expectedLiteral: boolean
): boolean {
  return (
    (expressionIsCallWithArgument(
      expression.left,
      objectName,
      methodName,
      propertyName
    ) &&
      expressionIsBooleanLiteral(expression.right, expectedLiteral)) ||
    (expressionIsCallWithArgument(
      expression.right,
      objectName,
      methodName,
      propertyName
    ) &&
      expressionIsBooleanLiteral(expression.left, expectedLiteral))
  );
}

function expressionIsCallWithArgument(
  expression: ts.Expression,
  objectName: string,
  methodName: string,
  propertyName: string
): boolean {
  const unwrappedExpression = unwrapExpression(expression);
  if (
    !(
      ts.isCallExpression(unwrappedExpression) &&
      ts.isPropertyAccessExpression(unwrappedExpression.expression) &&
      ts.isIdentifier(unwrappedExpression.expression.expression) &&
      unwrappedExpression.expression.expression.text === objectName &&
      unwrappedExpression.expression.name.text === methodName
    )
  ) {
    return false;
  }
  return unwrappedExpression.arguments.some(
    (argument) =>
      ts.isPropertyAccessExpression(argument) &&
      ts.isIdentifier(argument.expression) &&
      argument.name.text === propertyName
  );
}

function expressionIsBooleanLiteral(
  expression: ts.Expression,
  expectedLiteral: boolean
): boolean {
  const unwrappedExpression = unwrapExpression(expression);
  return (
    unwrappedExpression.kind ===
    (expectedLiteral ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword)
  );
}

function functionDispatchesPathToValidator(
  sourceFile: ts.SourceFile,
  functionName: string,
  enforcementPath: string,
  validatorName: string
): boolean {
  const declaration = findFunctionDeclaration(sourceFile, functionName);
  return Boolean(
    declaration &&
      nodeContains(declaration, (node) => {
        if (!ts.isIfStatement(node)) {
          return false;
        }
        return (
          expressionComparesPathToTelemetryPath(
            node.expression,
            enforcementPath
          ) && nodeContainsIdentifier(node.thenStatement, validatorName)
        );
      })
  );
}

function functionCallsIdentifier(
  sourceFile: ts.SourceFile,
  functionName: string,
  calledIdentifier: string
): boolean {
  const declaration = findFunctionDeclaration(sourceFile, functionName);
  return Boolean(
    declaration &&
      nodeContains(
        declaration,
        (node) => ts.isIdentifier(node) && node.text === calledIdentifier
      )
  );
}

function functionContainsStringLiteral(
  sourceFile: ts.SourceFile,
  functionName: string,
  expectedText: string
): boolean {
  const declaration = findFunctionDeclaration(sourceFile, functionName);
  return Boolean(
    declaration &&
      nodeContains(
        declaration,
        (node) => ts.isStringLiteralLike(node) && node.text === expectedText
      )
  );
}

function functionCatchReturnsFailure(
  sourceFile: ts.SourceFile,
  functionName: string
): boolean {
  const declaration = findFunctionDeclaration(sourceFile, functionName);
  return Boolean(
    declaration &&
      nodeContains(declaration, (node) => {
        if (!(ts.isTryStatement(node) && node.catchClause)) {
          return false;
        }
        return nodeContains(
          node.catchClause.block,
          (catchNode) =>
            ts.isReturnStatement(catchNode) &&
            catchNode.expression !== undefined &&
            ts.isNumericLiteral(catchNode.expression) &&
            catchNode.expression.text === "1"
        );
      })
  );
}

function sourceHasImportSpecifier(
  sourceFile: ts.SourceFile,
  importedName: string,
  moduleSpecifier: string
): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) {
      return false;
    }
    if (
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier
    ) {
      return false;
    }
    const namedBindings = statement.importClause?.namedBindings;
    return (
      namedBindings !== undefined &&
      ts.isNamedImports(namedBindings) &&
      namedBindings.elements.some(
        (element) => element.name.text === importedName
      )
    );
  });
}

function sourceFileContainsIdentifier(
  sourceFile: ts.SourceFile,
  identifierName: string
): boolean {
  return nodeContains(
    sourceFile,
    (node) => ts.isIdentifier(node) && node.text === identifierName
  );
}

function sourceHasFunctionDeclaration(
  sourceFile: ts.SourceFile,
  functionName: string
): boolean {
  return Boolean(findFunctionDeclaration(sourceFile, functionName));
}

function sourceHasTestName(
  sourceFile: ts.SourceFile,
  testNamePattern: RegExp
): boolean {
  return nodeContains(sourceFile, (node) => {
    if (!isTestCallExpression(node)) {
      return false;
    }
    const [testName] = node.arguments;
    return (
      testName !== undefined &&
      ts.isStringLiteralLike(testName) &&
      testNamePattern.test(testName.text)
    );
  });
}

function sourceHasTrustedRunnerRemovalCoverage(
  sourceFile: ts.SourceFile
): boolean {
  return nodeContains(sourceFile, (node) => {
    if (!isTestCallExpression(node)) {
      return false;
    }
    const [testName, testBody] = node.arguments;
    if (
      !(
        testName !== undefined &&
        ts.isStringLiteralLike(testName) &&
        TRUSTED_PREFLIGHT_TEST_REMOVAL_TEST_PATTERN.test(testName.text) &&
        testBody !== undefined &&
        (ts.isArrowFunction(testBody) || ts.isFunctionExpression(testBody))
      )
    ) {
      return false;
    }
    return (
      nodeContainsIdentifier(testBody, "runTrustedPreflightFromGitHub") &&
      nodeContainsPropertyAccess(testBody, "GitHubPullFileStatus", "Removed") &&
      nodeContainsStringFragment(testBody, "::error file=") &&
      nodeContainsStringFragment(testBody, "head source was unavailable") &&
      nodeContainsStringFragment(
        testBody,
        "Unable to run trusted telemetry preflight"
      )
    );
  });
}

function sourceHasExactNewlineIndentRegex(sourceFile: ts.SourceFile): boolean {
  return nodeContains(
    sourceFile,
    (node) =>
      ts.isRegularExpressionLiteral(node) &&
      EXACT_NEWLINE_INDENT_REGEX_PATTERN.test(node.text)
  );
}

function isTestCallExpression(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  return isDirectTestExpression(node.expression) || isEachTestExpression(node);
}

function findFunctionDeclaration(
  sourceFile: ts.SourceFile,
  functionName: string
): ts.FunctionDeclaration | undefined {
  return sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName
  );
}

function findVariableDeclaration(
  sourceFile: ts.SourceFile,
  variableName: string
): ts.VariableDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === variableName
      ) {
        return declaration;
      }
    }
  }
  return undefined;
}

function isDirectTestExpression(expression: ts.Expression): boolean {
  return (
    ts.isIdentifier(expression) &&
    (expression.text === "it" || expression.text === "test")
  );
}

function isEachTestExpression(node: ts.CallExpression): boolean {
  const expression = node.expression;
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "each" &&
    isDirectTestExpression(expression.expression.expression)
  );
}

function findConstObjectLiteral(
  sourceFile: ts.SourceFile,
  objectName: string
): ts.ObjectLiteralExpression | undefined {
  const declaration = findVariableDeclaration(sourceFile, objectName);
  return declaration?.initializer
    ? unwrapObjectLiteral(declaration.initializer)
    : undefined;
}

function unwrapZodObjectLiteral(
  expression: ts.Expression
): ts.ObjectLiteralExpression | undefined {
  let current = unwrapExpression(expression);
  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === "superRefine"
  ) {
    current = current.expression.expression;
  }
  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === "z" &&
    current.expression.name.text === "object"
  ) {
    const [schemaArgument] = current.arguments;
    if (schemaArgument && ts.isObjectLiteralExpression(schemaArgument)) {
      return schemaArgument;
    }
  }
  return undefined;
}

function unwrapObjectLiteral(
  expression: ts.Expression
): ts.ObjectLiteralExpression | undefined {
  const unwrappedExpression = unwrapExpression(expression);
  return ts.isObjectLiteralExpression(unwrappedExpression)
    ? unwrappedExpression
    : undefined;
}

function unwrapArrayLiteral(
  expression: ts.Expression
): ts.ArrayLiteralExpression | undefined {
  const unwrappedExpression = unwrapExpression(expression);
  return ts.isArrayLiteralExpression(unwrappedExpression)
    ? unwrappedExpression
    : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return unwrapExpression(expression.expression);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function isNotIdentifier(
  expression: ts.Expression,
  identifierName: string
): boolean {
  return (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(expression.operand) &&
    expression.operand.text === identifierName
  );
}

function nodeContainsCallExpression(
  node: ts.Node,
  objectName: string,
  methodName: string
): boolean {
  return nodeContains(
    node,
    (candidate) =>
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      ts.isIdentifier(candidate.expression.expression) &&
      candidate.expression.expression.text === objectName &&
      candidate.expression.name.text === methodName
  );
}

function expressionComparesPathToTelemetryPath(
  expression: ts.Expression,
  expectedPath: string
): boolean {
  if (!ts.isBinaryExpression(expression)) {
    return false;
  }
  if (
    !(
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
    )
  ) {
    return false;
  }
  return (
    (nodeContainsIdentifier(expression.left, "path") &&
      expressionReferencesTelemetryPath(expression.right, expectedPath)) ||
    (nodeContainsIdentifier(expression.right, "path") &&
      expressionReferencesTelemetryPath(expression.left, expectedPath))
  );
}

function expressionReferencesTelemetryPath(
  expression: ts.Expression,
  expectedPath: string
): boolean {
  const unwrappedExpression = unwrapExpression(expression);
  if (!ts.isPropertyAccessExpression(unwrappedExpression)) {
    return false;
  }
  if (!ts.isIdentifier(unwrappedExpression.expression)) {
    return false;
  }
  if (unwrappedExpression.expression.text !== "TelemetryPreflightPath") {
    return false;
  }
  return Object.entries(TelemetryPreflightPath).some(
    ([propertyName, path]) =>
      propertyName === unwrappedExpression.name.text && path === expectedPath
  );
}

function nodeContainsIdentifier(
  node: ts.Node,
  identifierName: string
): boolean {
  return nodeContains(
    node,
    (candidate) =>
      ts.isIdentifier(candidate) && candidate.text === identifierName
  );
}

function nodeContainsPropertyAccess(
  node: ts.Node,
  objectName: string,
  propertyName: string
): boolean {
  return nodeContains(
    node,
    (candidate) =>
      ts.isPropertyAccessExpression(candidate) &&
      ts.isIdentifier(candidate.expression) &&
      candidate.expression.text === objectName &&
      candidate.name.text === propertyName
  );
}

function nodeContainsStringFragment(node: ts.Node, fragment: string): boolean {
  return nodeContains(node, (candidate) => {
    if (ts.isStringLiteralLike(candidate)) {
      return candidate.text.includes(fragment);
    }
    return (
      (candidate.kind === ts.SyntaxKind.TemplateHead ||
        candidate.kind === ts.SyntaxKind.TemplateMiddle ||
        candidate.kind === ts.SyntaxKind.TemplateTail) &&
      "text" in candidate &&
      typeof candidate.text === "string" &&
      candidate.text.includes(fragment)
    );
  });
}

function nodeContains(
  node: ts.Node,
  predicate: (candidate: ts.Node) => boolean
): boolean {
  if (predicate(node)) {
    return true;
  }
  return node.getChildren().some((child) => nodeContains(child, predicate));
}

function createValidationSourceFile(
  path: string,
  source: string
): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function fetchHeadFileSources(
  input: {
    changedFiles: readonly string[];
    githubRepository: string;
    headSha: string;
  },
  runGhCommand: GhCommandRunner
): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const path of input.changedFiles.filter(isEnforcementLayerPath)) {
    try {
      sources[path] = fetchRepositoryTextFile(
        {
          githubRepository: input.githubRepository,
          path,
          ref: input.headSha,
        },
        runGhCommand
      );
    } catch (error) {
      console.warn(
        `Trusted telemetry preflight could not fetch PR head source for ${path}: ${formatErrorMessage(error)}`
      );
    }
  }
  return sources;
}

function expandPullFileCompanionPaths(file: GitHubPullFile): string[] {
  if (file.status === GitHubPullFileStatus.Removed) {
    return [];
  }
  return expandPullFileChangedPaths(file);
}

function expandPullFileChangedPaths(file: GitHubPullFile): string[] {
  const paths = [file.filename];
  if (file.status === GitHubPullFileStatus.Renamed && file.previous_filename) {
    paths.push(file.previous_filename);
  }
  return paths.map(normalizeRepoPath);
}

function normalizeUniqueRepoPaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths.map(normalizeRepoPath))).sort();
}

function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runGhCommandSync(args: readonly string[]): string {
  return execFileSync("gh", [...args], { encoding: "utf-8" });
}

function main(): number {
  try {
    return runTrustedPreflightFromGitHub();
  } catch (error) {
    console.error(
      `::error::Unable to run trusted telemetry preflight. ${formatErrorMessage(error)}`
    );
    return 1;
  }
}

if (process.argv[1]?.endsWith("check-trusted-pr-preflight.ts")) {
  process.exitCode = main();
}
