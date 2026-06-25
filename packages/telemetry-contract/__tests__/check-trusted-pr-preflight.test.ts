import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  RequiredCompatibilityMappingFields,
  TelemetryContractPath,
} from "../scripts/check-schema-update-gates";
import {
  evaluateTrustedPreflight,
  fetchRepositoryTextFile,
  GitHubPullFileStatus,
  listPullRequestFiles,
  runTrustedPreflightFromGitHub,
  TelemetryPreflightPath,
  TrustedPreflightMode,
  TrustedPreflightStatus,
} from "../scripts/check-trusted-pr-preflight";
import { compatibilityAttributesSource } from "./schema-gate-fixtures";

const REPO_ROOT_URL = new URL("../../../", import.meta.url);
const APP_SOURCE_PATH = "packages/telemetry-contract/app.ts";
const APP_TEST_PATH = "packages/telemetry-contract/__tests__/app.test.ts";
const RESOURCE_SOURCE_PATH = "packages/telemetry-contract/src/resource.ts";
const RESOURCE_TEST_PATH =
  "packages/telemetry-contract/__tests__/resource.test.ts";
const FUTURE_SOURCE_PATH = "packages/telemetry-contract/src/session.ts";
const FUTURE_NESTED_SOURCE_PATH =
  "packages/telemetry-contract/src/schemas/session.ts";
const UNRELATED_SOURCE_PATH = "apps/api/lib/health.ts";
const RENAMED_OUTSIDE_TELEMETRY_PATH = "docs/trusted-preflight-notes.md";
const GITHUB_REPOSITORY = "closedloop-ai/symphony-alpha";
const PULL_NUMBER = 1493;
const HEAD_SHA = "head-sha";
const FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE = sourceFixture(
  TelemetryPreflightPath.FeatureFlagAttestationWorkflow
);
const TRUSTED_PREFLIGHT_WORKFLOW_SOURCE = sourceFixture(
  TelemetryPreflightPath.TrustedPreflightWorkflow
);
const PR_WORKFLOW_SOURCE = sourceFixture(TelemetryPreflightPath.PrTestWorkflow);
const TRUSTED_PREFLIGHT_SCRIPT_SOURCE = sourceFixture(
  TelemetryPreflightPath.TrustedPreflightScript
);
const TRUSTED_PREFLIGHT_TEST_SOURCE = sourceFixture(
  TelemetryPreflightPath.TrustedPreflightTest
);
const SCHEMA_GATE_SCRIPT_SOURCE = sourceFixture(
  TelemetryPreflightPath.SchemaGateScript
);
const SCHEMA_GATE_FIXTURE_SOURCE = sourceFixture(
  TelemetryPreflightPath.SchemaGateFixtures
);
const SCHEMA_GATE_TEST_SOURCE = sourceFixture(
  TelemetryPreflightPath.SchemaGateTest
);
const TRUSTED_PREFLIGHT_COMMAND =
  "run: pnpm exec tsx packages/telemetry-contract/scripts/check-trusted-pr-preflight.ts";
const TRUSTED_PREFLIGHT_NON_DEFAULT_BASE_SKIP_COMMAND =
  'run: echo "Trusted telemetry contract preflight only runs for pull requests targeting the default branch."';
const DEFAULT_BASE_BRANCH_CONDITION = [
  "$",
  "{{ github.event.pull_request.base.ref == github.event.repository.default_branch }}",
].join("");
const NON_DEFAULT_BASE_BRANCH_CONDITION = [
  "$",
  "{{ github.event.pull_request.base.ref != github.event.repository.default_branch }}",
].join("");
const BASE_REF_SHELL_PARAMETER = ["$", "{BASE_REF}"].join("");
const PR_WORKFLOW_GATE_COMMAND = [
  'run: pnpm --filter @closedloop-ai/telemetry-contract check:schema-update -- --base "origin/',
  BASE_REF_SHELL_PARAMETER,
  '" --head HEAD',
].join("");
const TURBO_TOKEN_MERGE_GROUP_EMPTY_ENV = [
  "TURBO_TOKEN: ",
  "$",
  "{{ github.event_name != 'merge_group' && secrets.TURBO_TOKEN || '' }}",
].join("");
const TURBO_TEAM_MERGE_GROUP_EMPTY_ENV = [
  "TURBO_TEAM: ",
  "$",
  "{{ github.event_name != 'merge_group' && vars.TURBO_TEAM || '' }}",
].join("");
const TURBO_TOKEN_FALSY_EMPTY_BRANCH_ENV = [
  "TURBO_TOKEN: ",
  "$",
  "{{ github.event_name == 'merge_group' && '' || secrets.TURBO_TOKEN }}",
].join("");
const TURBO_TEAM_FALSY_EMPTY_BRANCH_ENV = [
  "TURBO_TEAM: ",
  "$",
  "{{ github.event_name == 'merge_group' && '' || vars.TURBO_TEAM }}",
].join("");
const TURBO_TOKEN_UNGUARDED_ENV = [
  "TURBO_TOKEN: ",
  "$",
  "{{ secrets.TURBO_TOKEN }}",
].join("");
const TURBO_TEAM_UNGUARDED_ENV = [
  "TURBO_TEAM: ",
  "$",
  "{{ vars.TURBO_TEAM }}",
].join("");
const FEATURE_FLAG_ATTESTATION_MERGE_GROUP_COMMAND =
  'run: echo "Feature flag attestation is enforced on pull requests before merge queue admission."';
const GITHUB_ACTIONS_TRUE_EXPRESSION = ["$", "{{ true }}"].join("");
const GITHUB_ACTIONS_EQUALITY_TRUE_EXPRESSION = ["$", "{{ 1 == 1 }}"].join("");
const GITHUB_ACTIONS_FROM_JSON_TRUE_EXPRESSION = [
  "$",
  "{{ fromJSON('true') }}",
].join("");
const BASE64_CONTENT = Buffer.from("trusted source text", "utf-8").toString(
  "base64"
);
const TRUTHY_CONTINUE_ON_ERROR_VALUES = [
  "TRUE",
  "'true'",
  "yes",
  "on",
  "1",
  GITHUB_ACTIONS_TRUE_EXPRESSION,
  GITHUB_ACTIONS_EQUALITY_TRUE_EXPRESSION,
  GITHUB_ACTIONS_FROM_JSON_TRUE_EXPRESSION,
] as const;
const JSON_SCHEMA_PARITY_MISSING_CONDITION =
  "changedFileSet.has(TelemetryContractPath.JsonSchemaParity)";
const EXACT_NEWLINE_INDENT_REGEX_SOURCE = [
  "const BAD_SOURCE_MATCHER = /",
  "\\n",
  " {4}",
  "continue;/;",
].join("");

describe("trusted PR preflight", () => {
  it("no-ops only after a complete unrelated file inventory is verified", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [UNRELATED_SOURCE_PATH],
      expectedChangedFileCount: 1,
    });

    expect(result.status).toBe(TrustedPreflightStatus.NoOp);
    expect(result.mode).toBe(TrustedPreflightMode.NoTelemetryChanges);
    expect(result.findings).toEqual([]);
  });

  it("fails closed on count mismatch when REST pagination does not match the PR changed_files count", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [UNRELATED_SOURCE_PATH],
      expectedChangedFileCount: 2,
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings[0].file).toBe(
      TelemetryPreflightPath.TrustedPreflightWorkflow
    );
    expect(result.findings[0].message).toContain("count mismatch");
  });

  it("reuses Gate B companion findings for schema source changes", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [
        RESOURCE_SOURCE_PATH,
        TelemetryContractPath.JsonSchemaParity,
      ],
      expectedChangedFileCount: 2,
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.mode).toBe(TrustedPreflightMode.GateValidation);
    expect(result.findings[0].file).toBe(RESOURCE_SOURCE_PATH);
    expect(result.findings[0].message).toContain(RESOURCE_TEST_PATH);
  });

  it("passes App schema source changes with mapped test and JSON Schema parity", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [
        APP_SOURCE_PATH,
        APP_TEST_PATH,
        TelemetryContractPath.JsonSchemaParity,
      ],
      expectedChangedFileCount: 3,
    });

    expect(result.status).toBe(TrustedPreflightStatus.Passed);
    expect(result.mode).toBe(TrustedPreflightMode.GateValidation);
    expect(result.findings).toEqual([]);
  });

  it("does not count removed companion tests as satisfying Gate B", () => {
    const inventory = listPullRequestFiles(GITHUB_REPOSITORY, PULL_NUMBER, () =>
      JSON.stringify([
        [
          { filename: RESOURCE_SOURCE_PATH },
          {
            filename: RESOURCE_TEST_PATH,
            status: GitHubPullFileStatus.Removed,
          },
          { filename: TelemetryContractPath.JsonSchemaParity },
        ],
      ])
    );
    const result = evaluateTrustedPreflight({
      changedFiles: inventory.changedFiles,
      companionChangedFiles: inventory.companionChangedFiles,
      expectedChangedFileCount: 3,
      inventoryFileCount: inventory.inventoryFileCount,
    });

    expect(inventory.changedFiles).toEqual(
      expect.arrayContaining([
        RESOURCE_SOURCE_PATH,
        RESOURCE_TEST_PATH,
        TelemetryContractPath.JsonSchemaParity,
      ])
    );
    expect(inventory.companionChangedFiles).toEqual(
      expect.arrayContaining([
        RESOURCE_SOURCE_PATH,
        TelemetryContractPath.JsonSchemaParity,
      ])
    );
    expect(inventory.companionChangedFiles).not.toContain(RESOURCE_TEST_PATH);
    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings[0].file).toBe(RESOURCE_SOURCE_PATH);
    expect(result.findings[0].message).toContain(RESOURCE_TEST_PATH);
  });

  it("fails future package source files until they are classified", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [FUTURE_SOURCE_PATH],
      expectedChangedFileCount: 1,
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings[0].file).toBe(FUTURE_SOURCE_PATH);
    expect(result.findings[0].message).toContain("is not classified");
  });

  it("fails future nested package source files until they are classified", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [FUTURE_NESTED_SOURCE_PATH],
      expectedChangedFileCount: 1,
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings[0].file).toBe(FUTURE_NESTED_SOURCE_PATH);
    expect(result.findings[0].message).toContain("is not classified");
  });

  it("evaluates Gate C from fetched base and head attribute sources as data", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryContractPath.AttributesSource],
      expectedChangedFileCount: 1,
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      headAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: true,
      }),
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings[0].file).toBe(
      TelemetryContractPath.AttributesSource
    );
    expect(result.findings[0].message).toContain("closedloop.new_attribute");
    for (const field of RequiredCompatibilityMappingFields) {
      expect(result.findings[0].message).toContain(field);
    }
  });

  it("enters enforcement-layer edit mode and validates fetched head sources", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [
        TelemetryPreflightPath.FeatureFlagAttestationWorkflow,
        TelemetryPreflightPath.PrTestWorkflow,
        TelemetryPreflightPath.TrustedPreflightWorkflow,
        TelemetryPreflightPath.TrustedPreflightScript,
        TelemetryPreflightPath.SchemaGateScript,
      ],
      expectedChangedFileCount: 5,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE,
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE,
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE,
        [TelemetryPreflightPath.TrustedPreflightScript]:
          TRUSTED_PREFLIGHT_SCRIPT_SOURCE,
        [TelemetryPreflightPath.SchemaGateScript]: SCHEMA_GATE_SCRIPT_SOURCE,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Passed);
    expect(result.mode).toBe(TrustedPreflightMode.EnforcementLayerEdit);
    expect(result.findings).toEqual([]);
  });

  it("enters enforcement-layer edit mode for shared schema gate fixtures", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.SchemaGateFixtures],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.SchemaGateFixtures]: SCHEMA_GATE_FIXTURE_SOURCE,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Passed);
    expect(result.mode).toBe(TrustedPreflightMode.EnforcementLayerEdit);
    expect(result.findings).toEqual([]);
  });

  it("accepts schema gate test source with future-source coverage", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.SchemaGateTest],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.SchemaGateTest]: SCHEMA_GATE_TEST_SOURCE,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Passed);
    expect(result.mode).toBe(TrustedPreflightMode.EnforcementLayerEdit);
    expect(result.findings).toEqual([]);
  });

  it("rejects shared schema gate fixture edits when PR head source is unavailable", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.SchemaGateFixtures],
      expectedChangedFileCount: 1,
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.mode).toBe(TrustedPreflightMode.EnforcementLayerEdit);
    expect(result.findings[0].message).toContain("head source was unavailable");
  });

  it("rejects enforcement-layer edits when PR head source is unavailable", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.mode).toBe(TrustedPreflightMode.EnforcementLayerEdit);
    expect(result.findings[0].message).toContain("head source was unavailable");
  });

  it("rejects a trusted workflow install without the placeholder database URL", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            "postgresql://localhost:5432/placeholder",
            "postgresql://localhost:5432/missing"
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("placeholder DATABASE_URL"),
      ])
    );
  });

  it("rejects a trusted workflow without the non-default-base no-op", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            `if: ${NON_DEFAULT_BASE_BRANCH_CONDITION}`,
            `if: ${DEFAULT_BASE_BRANCH_CONDITION}`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight workflow must no-op for non-default base branches."
    );
  });

  it("rejects a trusted workflow that changes the non-default-base no-op command", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            TRUSTED_PREFLIGHT_NON_DEFAULT_BASE_SKIP_COMMAND,
            'run: echo "unexpected non-default base execution"'
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight workflow must no-op for non-default base branches."
    );
  });

  it("rejects a trusted workflow that runs base-owned execution on non-default-base PRs", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            `if: ${DEFAULT_BASE_BRANCH_CONDITION}\n        uses: actions/checkout@v6`,
            "uses: actions/checkout@v6"
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight workflow must guard all non-skip execution to default-base PRs."
    );
  });

  it("rejects a trusted workflow that adds any unguarded executable step", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            "      - name: Checkout base-owned repository",
            `      - name: Unexpected non-default execution
        run: echo "should not run"

      - name: Checkout base-owned repository`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight workflow must guard all non-skip execution to default-base PRs."
    );
  });

  it("rejects a trusted workflow with any write permission scope", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            "      pull-requests: read",
            "      pull-requests: read\n      issues: write"
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight workflow must not request write permissions."
    );
  });

  it("rejects a trusted workflow that checks out PR head content", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            "github.event.pull_request.base.sha",
            "github.event.pull_request.head.sha"
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must not checkout PR head content"),
      ])
    );
  });

  it("rejects a trusted workflow that softens failures", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            TRUSTED_PREFLIGHT_COMMAND,
            `continue-on-error: true\n        ${TRUSTED_PREFLIGHT_COMMAND}`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight workflow must not soften failures."
    );
  });

  it.each(
    TRUTHY_CONTINUE_ON_ERROR_VALUES
  )("rejects a trusted workflow that softens failures with continue-on-error: %s", (continueOnErrorValue) => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            TRUSTED_PREFLIGHT_COMMAND,
            `continue-on-error: ${continueOnErrorValue}\n        ${TRUSTED_PREFLIGHT_COMMAND}`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight workflow must not soften failures."
    );
  });

  it("rejects a trusted workflow that materializes PR head content in shell while preserving base checkout and command", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightWorkflow]:
          TRUSTED_PREFLIGHT_WORKFLOW_SOURCE.replace(
            "      - name: Run trusted telemetry contract preflight",
            `      - name: Materialize PR head content
        run: |
          git fetch origin "$HEAD_SHA"
          git checkout FETCH_HEAD
          pnpm install --frozen-lockfile

      - name: Run trusted telemetry contract preflight`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        "trusted preflight workflow must not checkout PR head content.",
        "trusted preflight workflow must not install dependencies after PR head content is materialized.",
      ])
    );
  });

  it("rejects a trusted script that drops changed-file count comparison while preserving old tokens in comments", () => {
    const weakenedScriptSource = replaceFunctionBody(
      TRUSTED_PREFLIGHT_SCRIPT_SOURCE,
      "validateCompleteFileInventory",
      `
  // expectedChangedFileCount changed file count mismatch
  return [];
`
    );
    expect(weakenedScriptSource).not.toBe(TRUSTED_PREFLIGHT_SCRIPT_SOURCE);

    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightScript],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightScript]: weakenedScriptSource,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("compare changed file count"),
      ])
    );
  });

  it("rejects a trusted script that disables API fail-closed behavior while preserving old tokens in comments", () => {
    const weakenedScriptSource = replaceReturnExpression(
      TRUSTED_PREFLIGHT_SCRIPT_SOURCE,
      "main",
      "return 0; // Unable to run trusted telemetry preflight"
    );
    expect(weakenedScriptSource).not.toBe(TRUSTED_PREFLIGHT_SCRIPT_SOURCE);

    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightScript],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightScript]: weakenedScriptSource,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight script must fail closed on API errors."
    );
  });

  it("rejects a PR workflow source edit that re-enables persisted credentials", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.PrTestWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE.replace(
          "persist-credentials: false",
          "persist-credentials: true"
        ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "PR workflow checkout must not persist credentials."
    );
  });

  it("rejects a PR workflow source edit that exposes workflow-scope Turbo token on merge_group", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.PrTestWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE.replace(
          TURBO_TOKEN_MERGE_GROUP_EMPTY_ENV,
          TURBO_TOKEN_UNGUARDED_ENV
        ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "PR workflow must leave TURBO_TOKEN empty on merge_group."
    );
  });

  it("rejects a PR workflow source edit that uses a falsy empty branch before Turbo token fallback", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.PrTestWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE.replace(
          TURBO_TOKEN_MERGE_GROUP_EMPTY_ENV,
          TURBO_TOKEN_FALSY_EMPTY_BRANCH_ENV
        ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "PR workflow must not use a falsy empty-string branch before a TURBO_TOKEN fallback."
    );
  });

  it("rejects a PR workflow source edit that exposes workflow-scope Turbo team on merge_group", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.PrTestWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE.replace(
          TURBO_TEAM_MERGE_GROUP_EMPTY_ENV,
          TURBO_TEAM_UNGUARDED_ENV
        ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "PR workflow must leave TURBO_TEAM empty on merge_group."
    );
  });

  it("rejects a PR workflow source edit that uses a falsy empty branch before Turbo team fallback", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.PrTestWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE.replace(
          TURBO_TEAM_MERGE_GROUP_EMPTY_ENV,
          TURBO_TEAM_FALSY_EMPTY_BRANCH_ENV
        ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "PR workflow must not use a falsy empty-string branch before a TURBO_TEAM fallback."
    );
  });

  it("rejects a PR workflow source edit that exposes job-scope Turbo team on merge_group", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.PrTestWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE.replace(
          "    timeout-minutes: 20",
          `    timeout-minutes: 20
    env:
      TURBO_TEAM: \${{ vars.TURBO_TEAM }}`
        ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "PR workflow job telemetry-contract-schema-update-gates must not expose TURBO_TEAM to merge_group."
    );
  });

  it("rejects a PR workflow source edit that exposes step-scope Turbo token on merge_group", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.PrTestWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE.replace(
          "      - name: Run telemetry schema update gates",
          `      - name: Run telemetry schema update gates
        env:
          TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}`
        ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "PR workflow job telemetry-contract-schema-update-gates step Run telemetry schema update gates must not expose TURBO_TOKEN to merge_group."
    );
  });

  it("rejects a PR workflow source edit that softens failures with expression continue-on-error", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.PrTestWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.PrTestWorkflow]: PR_WORKFLOW_SOURCE.replace(
          PR_WORKFLOW_GATE_COMMAND,
          `continue-on-error: ${GITHUB_ACTIONS_EQUALITY_TRUE_EXPRESSION}
        ${PR_WORKFLOW_GATE_COMMAND}`
        ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "PR workflow telemetry job must not soften failures."
    );
  });

  it("accepts the feature flag attestation workflow merge_group branch and PR validation", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Passed);
    expect(result.findings).toEqual([]);
  });

  it("rejects a feature flag attestation workflow without merge_group checks_requested", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            `  merge_group:
    types: [checks_requested]
`,
            ""
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation workflow must run on merge_group checks_requested."
    );
  });

  it("rejects a feature flag attestation workflow that weakens pull_request body validation", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            "if: github.event_name == 'pull_request'",
            "if: github.event_name == 'merge_group'"
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation workflow must validate the pull_request body only on pull_request."
    );
  });

  it("rejects a feature flag attestation workflow when PR validation text moves to a dead step", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            `        run: |
          if [ -z "$PR_BODY" ]; then`,
            `        run: exit 0

      - name: Dead feature flag validation text
        if: \${{ false }}
        run: |
          echo "PR description is empty"
          echo "## Feature Flags"
          echo "[flag:N/A]"
          if [ true ]; then`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation workflow must fail empty pull_request bodies."
    );
  });

  it("rejects a feature flag attestation workflow when the PR validation step only echoes expected text", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            `        run: |
          if [ -z "$PR_BODY" ]; then
            echo "::error::PR description is empty. Please fill out the feature flag attestation section from the PR template."
            exit 1
          fi

          # Check for opt-out keyword with justification
          if echo "$PR_BODY" | grep -q '\\[flag:N/A\\]'; then
            # Extract everything after [flag:N/A] on the same line
            SAME_LINE=$(echo "$PR_BODY" | grep '\\[flag:N/A\\]' | sed 's/.*\\[flag:N\\/A\\]//' | tr -d '[:space:]')
            # Also check the next non-empty line after the marker
            NEXT_LINE=$(echo "$PR_BODY" | sed -n '/\\[flag:N\\/A\\]/{n;p;}' | tr -d '[:space:]')

            if [ -n "$SAME_LINE" ] || [ -n "$NEXT_LINE" ]; then
              echo "Feature flag opt-out accepted with justification."
              exit 0
            else
              echo "::error::[flag:N/A] found but no justification provided. Add a reason after the marker explaining why no feature flag is needed."
              exit 1
            fi
          fi

          # Check for the attestation section with at least one checked box
          if echo "$PR_BODY" | grep -q '## Feature Flags'; then
            CHECKED=$(echo "$PR_BODY" | sed -n '/## Feature Flags/,/^## /p' | grep -ci '\\[x\\]' || true)
            if [ "$CHECKED" -gt 0 ]; then
              echo "Feature flag attestation verified ($CHECKED item(s) checked)."
              exit 0
            else
              echo "::error::Feature flag attestation section exists but no items are checked. Check the applicable boxes or use [flag:N/A] with a justification."
              exit 1
            fi
          fi

          echo "::error::Missing '## Feature Flags' attestation section in PR description. Please use the PR template or add [flag:N/A] with a justification."
          exit 1
`,
            `        run: |
          echo "PR description is empty"
          echo "## Feature Flags"
          echo "[flag:N/A]"
          exit 0
`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation workflow must enforce PR_BODY-dependent validation branches."
    );
  });

  it("rejects a feature flag attestation workflow whose merge_group branch reads PR body", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            FEATURE_FLAG_ATTESTATION_MERGE_GROUP_COMMAND,
            'run: echo "$PR_BODY"'
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation workflow must explicitly pass merge_group without PR body."
    );
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation non-pull_request branches must not read pull_request body."
    );
  });

  it("rejects a feature flag attestation workflow whose unconditional branch reads PR body", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            "      - name: Check feature flag attestation",
            `      - name: Unsafe unconditional PR body read
        run: echo "$PR_BODY"

      - name: Check feature flag attestation`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation non-pull_request branches must not read pull_request body."
    );
  });

  it("rejects a feature flag attestation workflow with workflow-level PR body exposure", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            "jobs:\n",
            `env:
  PR_BODY: \${{ github.event.pull_request.body }}

jobs:
`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation non-pull_request branches must not read pull_request body."
    );
  });

  it("rejects a feature flag attestation workflow with job-level PR body exposure", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            "    runs-on: ubuntu-latest\n",
            `    env:
      PR_BODY: \${{ github.event.pull_request.body }}
    runs-on: ubuntu-latest
`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation non-pull_request branches must not read pull_request body."
    );
  });

  it("rejects a feature flag attestation workflow that softens failures", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            "      - name: Check feature flag attestation",
            `      - name: Check feature flag attestation
        continue-on-error: true`
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation workflow must not soften failures."
    );
  });

  it("rejects a feature flag attestation workflow that hides an unrelated soft-fail behind the grep fallback", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.FeatureFlagAttestationWorkflow],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.FeatureFlagAttestationWorkflow]:
          FEATURE_FLAG_ATTESTATION_WORKFLOW_SOURCE.replace(
            "exit 1",
            "false || true # grep -ci '\\[x\\]' || true"
          ),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "feature flag attestation workflow must not soften failures."
    );
  });

  it("rejects a schema gate script edit that bypasses unknown-source failure while preserving old text in comments", () => {
    const weakenedScriptSource = replaceIfStatement(
      SCHEMA_GATE_SCRIPT_SOURCE,
      "findMissingSchemaCompanions",
      (node, sourceFile) =>
        node.expression.getText(sourceFile) === "!classification",
      `if (!classification) {
      // Telemetry contract source is not classified.
      continue;
    }`
    );
    expect(weakenedScriptSource).not.toBe(SCHEMA_GATE_SCRIPT_SOURCE);

    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.SchemaGateScript],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.SchemaGateScript]: weakenedScriptSource,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "schema gate script must keep unknown source fail-closed behavior."
    );
  });

  it("rejects a schema gate script edit that reclassifies a known schema source", () => {
    const weakenedScriptSource = replaceObjectProperty(
      SCHEMA_GATE_SCRIPT_SOURCE,
      "TelemetrySchemaSourceClassification",
      RESOURCE_SOURCE_PATH,
      `"packages/telemetry-contract/src/resource.ts": {
    // SchemaSourceClassificationKind.SchemaGroup packages/telemetry-contract/__tests__/resource.test.ts
    kind: SchemaSourceClassificationKind.NonSchemaSource,
    reason: "incorrectly bypassed",
  }`
    );
    expect(weakenedScriptSource).not.toBe(SCHEMA_GATE_SCRIPT_SOURCE);

    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.SchemaGateScript],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.SchemaGateScript]: weakenedScriptSource,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "schema gate script must keep packages/telemetry-contract/src/resource.ts classified as schemaGroup."
    );
  });

  it("rejects a schema gate script edit that removes JSON Schema parity enforcement", () => {
    const weakenedScriptSource = replaceIfStatement(
      SCHEMA_GATE_SCRIPT_SOURCE,
      "findMissingSchemaCompanions",
      (node, sourceFile) =>
        node.expression
          .getText(sourceFile)
          .includes(JSON_SCHEMA_PARITY_MISSING_CONDITION),
      `// changedFileSet.has(TelemetryContractPath.JsonSchemaParity)
    // Telemetry schema source changed without required JSON Schema parity file.`
    );
    expect(weakenedScriptSource).not.toBe(SCHEMA_GATE_SCRIPT_SOURCE);

    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.SchemaGateScript],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.SchemaGateScript]: weakenedScriptSource,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "schema gate script must keep JSON Schema parity enforcement."
    );
  });

  it("rejects a schema gate script edit that inverts JSON Schema parity enforcement", () => {
    const weakenedScriptSource = replaceIfStatementExpression(
      SCHEMA_GATE_SCRIPT_SOURCE,
      "findMissingSchemaCompanions",
      (node, sourceFile) =>
        node.expression
          .getText(sourceFile)
          .includes(JSON_SCHEMA_PARITY_MISSING_CONDITION),
      JSON_SCHEMA_PARITY_MISSING_CONDITION
    );
    expect(weakenedScriptSource).not.toBe(SCHEMA_GATE_SCRIPT_SOURCE);

    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.SchemaGateScript],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.SchemaGateScript]: weakenedScriptSource,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "schema gate script must keep JSON Schema parity enforcement."
    );
  });

  it("rejects a schema gate script edit that includes deleted files in the git diff", () => {
    const weakenedScriptSource = SCHEMA_GATE_SCRIPT_SOURCE.replace(
      '"--diff-filter=ACMRT"',
      '"--diff-filter=ACMRTD"'
    );
    expect(weakenedScriptSource).not.toBe(SCHEMA_GATE_SCRIPT_SOURCE);

    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.SchemaGateScript],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.SchemaGateScript]: weakenedScriptSource,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "schema gate script must keep git diff filter excluding deleted files."
    );
  });

  it("rejects a trusted script edit that removes schema-gate validation dispatch", () => {
    const weakenedScriptSource = replaceIfStatement(
      TRUSTED_PREFLIGHT_SCRIPT_SOURCE,
      "validateEnforcementLayerSource",
      (node, sourceFile) =>
        node.expression.getText(sourceFile) ===
        "path === TelemetryPreflightPath.SchemaGateScript",
      `if (path === TelemetryPreflightPath.SchemaGateScript) {
    // return validateSchemaGateScriptSource(path, source);
    return [];
  }`
    );
    expect(weakenedScriptSource).not.toBe(TRUSTED_PREFLIGHT_SCRIPT_SOURCE);

    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightScript],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightScript]: weakenedScriptSource,
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight script must dispatch packages/telemetry-contract/scripts/check-schema-update-gates.ts to validateSchemaGateScriptSource."
    );
  });

  it("rejects a trusted preflight test edit that reintroduces exact newline indentation source matchers", () => {
    const result = evaluateTrustedPreflight({
      changedFiles: [TelemetryPreflightPath.TrustedPreflightTest],
      expectedChangedFileCount: 1,
      headFileSources: {
        [TelemetryPreflightPath.TrustedPreflightTest]: [
          TRUSTED_PREFLIGHT_TEST_SOURCE,
          EXACT_NEWLINE_INDENT_REGEX_SOURCE,
        ].join("\n"),
      },
    });

    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.findings.map((finding) => finding.message)).toContain(
      "trusted preflight tests must avoid exact newline indentation source-text matchers."
    );
  });

  it("fails closed for a renamed enforcement-layer path even when the new path is outside telemetry scope", () => {
    const inventory = listPullRequestFiles(GITHUB_REPOSITORY, PULL_NUMBER, () =>
      JSON.stringify([
        [
          {
            filename: RENAMED_OUTSIDE_TELEMETRY_PATH,
            previous_filename: TelemetryPreflightPath.TrustedPreflightScript,
            status: GitHubPullFileStatus.Renamed,
          },
        ],
      ])
    );
    const result = evaluateTrustedPreflight({
      changedFiles: inventory.changedFiles,
      expectedChangedFileCount: 1,
      inventoryFileCount: inventory.inventoryFileCount,
    });

    expect(inventory.inventoryFileCount).toBe(1);
    expect(inventory.changedFiles).toEqual(
      expect.arrayContaining([
        RENAMED_OUTSIDE_TELEMETRY_PATH,
        TelemetryPreflightPath.TrustedPreflightScript,
      ])
    );
    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.mode).toBe(TrustedPreflightMode.EnforcementLayerEdit);
    expect(result.findings[0].file).toBe(
      TelemetryPreflightPath.TrustedPreflightScript
    );
  });

  it("fails closed for a removed enforcement-layer path before no-op or pass", () => {
    const inventory = listPullRequestFiles(GITHUB_REPOSITORY, PULL_NUMBER, () =>
      JSON.stringify([
        [
          {
            filename: TelemetryPreflightPath.TrustedPreflightScript,
            status: GitHubPullFileStatus.Removed,
          },
        ],
      ])
    );
    const result = evaluateTrustedPreflight({
      changedFiles: inventory.changedFiles,
      expectedChangedFileCount: 1,
      inventoryFileCount: inventory.inventoryFileCount,
    });

    expect(inventory.inventoryFileCount).toBe(1);
    expect(inventory.changedFiles).toEqual([
      TelemetryPreflightPath.TrustedPreflightScript,
    ]);
    expect(inventory.companionChangedFiles).toEqual([]);
    expect(result.status).toBe(TrustedPreflightStatus.Failed);
    expect(result.mode).toBe(TrustedPreflightMode.EnforcementLayerEdit);
    expect(result.findings[0]).toEqual({
      file: TelemetryPreflightPath.TrustedPreflightScript,
      message: expect.stringContaining("head source was unavailable"),
    });
  });

  it("emits a file-scoped annotation when the full runner sees a renamed-away enforcement path", () => {
    const calls: string[][] = [];
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((message: unknown) => {
        consoleErrors.push(String(message));
      });
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation((message: unknown) => {
        consoleWarnings.push(String(message));
      });

    try {
      const status = runTrustedPreflightFromGitHub(
        {
          BASE_SHA: "base-sha",
          EXPECTED_CHANGED_FILE_COUNT: "1",
          GITHUB_REPOSITORY,
          HEAD_SHA,
          PR_NUMBER: String(PULL_NUMBER),
        },
        (args) => {
          calls.push([...args]);
          if (args[0] === "api" && args.includes("--paginate")) {
            return JSON.stringify([
              [
                {
                  filename: RENAMED_OUTSIDE_TELEMETRY_PATH,
                  previous_filename:
                    TelemetryPreflightPath.TrustedPreflightScript,
                  status: GitHubPullFileStatus.Renamed,
                },
              ],
            ]);
          }
          throw new Error("head source not found");
        }
      );

      expect(status).toBe(1);
      expect(consoleErrors).toEqual(
        expect.arrayContaining([
          `::error file=${TelemetryPreflightPath.TrustedPreflightScript}::Trusted telemetry preflight cannot validate enforcement-layer edit ${TelemetryPreflightPath.TrustedPreflightScript} because PR head source was unavailable as data.`,
        ])
      );
      expect(consoleErrors).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("Unable to run trusted telemetry preflight"),
        ])
      );
      expect(consoleWarnings).toEqual([
        `Trusted telemetry preflight could not fetch PR head source for ${TelemetryPreflightPath.TrustedPreflightScript}: head source not found`,
      ]);
      expect(calls).toEqual([
        [
          "api",
          "--paginate",
          "--slurp",
          `/repos/${GITHUB_REPOSITORY}/pulls/${PULL_NUMBER}/files?per_page=100`,
        ],
        [
          "api",
          `/repos/${GITHUB_REPOSITORY}/contents/packages/telemetry-contract/scripts/check-trusted-pr-preflight.ts?ref=${HEAD_SHA}`,
        ],
      ]);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("emits a file-scoped annotation when the full runner sees a removed enforcement path", () => {
    const calls: string[][] = [];
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((message: unknown) => {
        consoleErrors.push(String(message));
      });
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation((message: unknown) => {
        consoleWarnings.push(String(message));
      });

    try {
      const status = runTrustedPreflightFromGitHub(
        {
          BASE_SHA: "base-sha",
          EXPECTED_CHANGED_FILE_COUNT: "1",
          GITHUB_REPOSITORY,
          HEAD_SHA,
          PR_NUMBER: String(PULL_NUMBER),
        },
        (args) => {
          calls.push([...args]);
          if (args[0] === "api" && args.includes("--paginate")) {
            return JSON.stringify([
              [
                {
                  filename: TelemetryPreflightPath.TrustedPreflightScript,
                  status: GitHubPullFileStatus.Removed,
                },
              ],
            ]);
          }
          throw new Error("head source not found");
        }
      );

      expect(status).toBe(1);
      expect(consoleErrors).toEqual(
        expect.arrayContaining([
          `::error file=${TelemetryPreflightPath.TrustedPreflightScript}::Trusted telemetry preflight cannot validate enforcement-layer edit ${TelemetryPreflightPath.TrustedPreflightScript} because PR head source was unavailable as data.`,
        ])
      );
      expect(consoleErrors).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("Unable to run trusted telemetry preflight"),
        ])
      );
      expect(consoleWarnings).toEqual([
        `Trusted telemetry preflight could not fetch PR head source for ${TelemetryPreflightPath.TrustedPreflightScript}: head source not found`,
      ]);
      expect(calls).toEqual([
        [
          "api",
          "--paginate",
          "--slurp",
          `/repos/${GITHUB_REPOSITORY}/pulls/${PULL_NUMBER}/files?per_page=100`,
        ],
        [
          "api",
          `/repos/${GITHUB_REPOSITORY}/contents/packages/telemetry-contract/scripts/check-trusted-pr-preflight.ts?ref=${HEAD_SHA}`,
        ],
      ]);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("validates paginated PR file inventory returned by GitHub", () => {
    const calls: string[][] = [];
    const inventory = listPullRequestFiles(
      GITHUB_REPOSITORY,
      PULL_NUMBER,
      (args) => {
        calls.push([...args]);
        return JSON.stringify([
          [{ filename: RESOURCE_SOURCE_PATH }],
          [{ filename: RESOURCE_TEST_PATH }],
        ]);
      }
    );

    expect(calls).toEqual([
      [
        "api",
        "--paginate",
        "--slurp",
        `/repos/${GITHUB_REPOSITORY}/pulls/${PULL_NUMBER}/files?per_page=100`,
      ],
    ]);
    expect(inventory).toEqual({
      companionChangedFiles: [RESOURCE_TEST_PATH, RESOURCE_SOURCE_PATH],
      changedFiles: [RESOURCE_TEST_PATH, RESOURCE_SOURCE_PATH],
      inventoryFileCount: 2,
    });
  });

  it("fetches source files as decoded repository content data", () => {
    const calls: string[][] = [];
    const source = fetchRepositoryTextFile(
      {
        githubRepository: GITHUB_REPOSITORY,
        path: TelemetryPreflightPath.TrustedPreflightWorkflow,
        ref: HEAD_SHA,
      },
      (args) => {
        calls.push([...args]);
        return JSON.stringify({
          content: `${BASE64_CONTENT.slice(0, 8)}\n${BASE64_CONTENT.slice(8)}`,
          encoding: "base64",
        });
      }
    );

    expect(source).toBe("trusted source text");
    expect(calls).toEqual([
      [
        "api",
        `/repos/${GITHUB_REPOSITORY}/contents/.github/workflows/telemetry-contract-pr-preflight.yml?ref=${HEAD_SHA}`,
      ],
    ]);
  });
});

function replaceFunctionBody(
  source: string,
  functionName: string,
  replacementBody: string
): string {
  const sourceFile = createTestSourceFile(source);
  const declaration = findFunctionDeclaration(sourceFile, functionName);
  if (!declaration?.body) {
    throw new Error(`Missing function body ${functionName}`);
  }
  return replaceSourceRange(
    source,
    declaration.body.getStart(sourceFile),
    declaration.body.end,
    `{${replacementBody}}`
  );
}

function replaceReturnExpression(
  source: string,
  functionName: string,
  replacementReturn: string
): string {
  const sourceFile = createTestSourceFile(source);
  const declaration = findFunctionDeclaration(sourceFile, functionName);
  if (!declaration?.body) {
    throw new Error(`Missing function body ${functionName}`);
  }
  const returnStatement = findFirstDescendant(
    declaration.body,
    (node): node is ts.ReturnStatement =>
      ts.isReturnStatement(node) &&
      node.expression?.getText(sourceFile) === "1" &&
      isInsideCatchClause(node)
  );
  if (!returnStatement) {
    throw new Error(`Missing fail-closed return statement in ${functionName}`);
  }
  return replaceSourceRange(
    source,
    returnStatement.getStart(sourceFile),
    returnStatement.end,
    replacementReturn
  );
}

function isInsideCatchClause(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isCatchClause(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function replaceIfStatement(
  source: string,
  functionName: string,
  predicate: IfStatementPredicate,
  replacementStatement: string
): string {
  const { ifStatement, sourceFile } = findIfStatement(
    source,
    functionName,
    predicate
  );
  return replaceSourceRange(
    source,
    ifStatement.getStart(sourceFile),
    ifStatement.end,
    replacementStatement
  );
}

function replaceIfStatementExpression(
  source: string,
  functionName: string,
  predicate: IfStatementPredicate,
  replacementExpression: string
): string {
  const { ifStatement, sourceFile } = findIfStatement(
    source,
    functionName,
    predicate
  );
  return replaceSourceRange(
    source,
    ifStatement.expression.getStart(sourceFile),
    ifStatement.expression.end,
    replacementExpression
  );
}

function replaceObjectProperty(
  source: string,
  variableName: string,
  propertyName: string,
  replacementProperty: string
): string {
  const sourceFile = createTestSourceFile(source);
  const objectLiteral = findVariableObjectLiteral(sourceFile, variableName);
  const property = objectLiteral?.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      getStaticPropertyName(candidate.name) === propertyName
  );
  if (!property) {
    throw new Error(`Missing ${variableName}.${propertyName}`);
  }
  return replaceSourceRange(
    source,
    property.getStart(sourceFile),
    property.end,
    replacementProperty
  );
}

function findIfStatement(
  source: string,
  functionName: string,
  predicate: IfStatementPredicate
): { ifStatement: ts.IfStatement; sourceFile: ts.SourceFile } {
  const sourceFile = createTestSourceFile(source);
  const declaration = findFunctionDeclaration(sourceFile, functionName);
  if (!declaration?.body) {
    throw new Error(`Missing function body ${functionName}`);
  }
  const ifStatement = findFirstDescendant(
    declaration.body,
    (node): node is ts.IfStatement =>
      ts.isIfStatement(node) && predicate(node, sourceFile)
  );
  if (!ifStatement) {
    throw new Error(`Missing if statement in ${functionName}`);
  }
  return { ifStatement, sourceFile };
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

function findVariableObjectLiteral(
  sourceFile: ts.SourceFile,
  variableName: string
): ts.ObjectLiteralExpression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === variableName &&
        declaration.initializer
      ) {
        return unwrapObjectLiteral(declaration.initializer);
      }
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return unwrapExpression(expression.expression);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function getStaticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  return undefined;
}

function findFirstDescendant<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T
): T | undefined {
  if (predicate(node)) {
    return node;
  }
  for (const child of node.getChildren()) {
    const match = findFirstDescendant(child, predicate);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function replaceSourceRange(
  source: string,
  start: number,
  end: number,
  replacement: string
): string {
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function createTestSourceFile(source: string): ts.SourceFile {
  return ts.createSourceFile(
    "trusted-preflight-source-fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function sourceFixture(path: string): string {
  return readFileSync(new URL(path, REPO_ROOT_URL), "utf-8");
}

type IfStatementPredicate = (
  node: ts.IfStatement,
  sourceFile: ts.SourceFile
) => boolean;
