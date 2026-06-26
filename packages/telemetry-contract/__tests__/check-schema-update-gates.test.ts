import { describe, expect, it } from "vitest";
import {
  CompatibilityMappingField,
  type CompatibilityMappingField as CompatibilityMappingFieldName,
  evaluateSchemaUpdateGates,
  listTelemetryContractChangedFiles,
  listTelemetryContractWorktreeChangedFiles,
  RequiredCompatibilityMappingFields,
  runSchemaUpdateGates,
} from "../scripts/check-schema-update-gates";
import { compatibilityAttributesSource } from "./schema-gate-fixtures";

const RESOURCE_SOURCE_PATH = "packages/telemetry-contract/src/resource.ts";
const RESOURCE_TEST_PATH =
  "packages/telemetry-contract/__tests__/resource.test.ts";
const APP_SOURCE_PATH = "packages/telemetry-contract/app.ts";
const APP_TEST_PATH = "packages/telemetry-contract/__tests__/app.test.ts";
const SPAN_SOURCE_PATH = "packages/telemetry-contract/src/span.ts";
const SPAN_TEST_PATH = "packages/telemetry-contract/__tests__/span.test.ts";
const GEN_AI_SOURCE_PATH = "packages/telemetry-contract/src/gen-ai.ts";
const GEN_AI_TEST_PATH = "packages/telemetry-contract/__tests__/gen-ai.test.ts";
const SYNC_SOURCE_PATH = "packages/telemetry-contract/sync.ts";
const SYNC_TEST_PATH = "packages/telemetry-contract/__tests__/sync.test.ts";
const PERMISSION_SOURCE_PATH = "packages/telemetry-contract/permission.ts";
const PERMISSION_TEST_PATH =
  "packages/telemetry-contract/__tests__/permission.test.ts";
const ATTRIBUTES_SOURCE_PATH = "packages/telemetry-contract/src/attributes.ts";
const PACKAGE_MANIFEST_PATH = "packages/telemetry-contract/package.json";
const PNPM_LOCKFILE_PATH = "pnpm-lock.yaml";
const JSON_SCHEMA_PARITY_PATH =
  "packages/telemetry-contract/scripts/check-json-schemas.ts";
const HELPER_SOURCE_PATH = "packages/telemetry-contract/src/validate.ts";
const FUTURE_SOURCE_PATH = "packages/telemetry-contract/src/session.ts";
const FUTURE_NESTED_SOURCE_PATH =
  "packages/telemetry-contract/src/schemas/session.ts";
const METACHARACTER_BASE_REF = "origin/foo$(id)";
const METACHARACTER_HEAD_REF = "foo`date`";
const MISSING_ZOD_TEST_TEXT = "required Zod companion test";
const MISSING_JSON_SCHEMA_TEXT = "required JSON Schema parity file";
const UNCLASSIFIED_SOURCE_TEXT = "is not classified";
const UNSCOPED_LOCKFILE_TEXT = "unrelated pnpm-lock.yaml drift";
const CLASSIFICATION_GUIDANCE_TEXT =
  "schemaGroup, compatibilityAttributes, or nonSchemaSource";
const TELEMETRY_IMPORTER_LOCKFILE_BASE = `importers:
  packages/telemetry-contract:
    devDependencies:
      zod:
        version: 4.3.5
`;
const TELEMETRY_IMPORTER_LOCKFILE_HEAD = `importers:
  packages/telemetry-contract:
    devDependencies:
      zod:
        version: 4.3.6
`;
const ALLOWED_TELEMETRY_IMPORTER_LOCKFILE_DIFF = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -1,8 +1,8 @@
 importers:
   packages/telemetry-contract:
     devDependencies:
       zod:
-        version: 4.3.5
+        version: 4.3.6
`;
const DEEP_TELEMETRY_IMPORTER_LOCKFILE_BASE = `importers:
  apps/app:
    dependencies:
      next:
        specifier: 16.2.6
        version: 16.2.6(@babel/core@7.29.0)
  apps/api:
    dependencies:
      zod:
        specifier: ^4.3.5
        version: 4.3.5
  packages/telemetry-contract:
    devDependencies:
      '@opentelemetry/semantic-conventions':
        specifier: 1.39.0
        version: 1.39.0
      '@repo/typescript-config':
        specifier: workspace:*
        version: link:../typescript-config
      '@types/node':
        specifier: ^25.9.1
        version: 25.9.1
      ajv:
        specifier: ^8.18.0
        version: 8.18.0
      tsup:
        specifier: ^8.5.1
        version: 8.5.1
      zod:
        specifier: ^4.3.5
        version: 4.3.5
snapshots:
  styled-jsx@5.1.6(@babel/core@7.29.7)(react@19.2.5):
    dependencies:
      client-only: 0.0.1
      '@babel/core': 7.29.0
`;
const DEEP_TELEMETRY_IMPORTER_LOCKFILE_HEAD = replaceLineOccurrence(
  replaceLineOccurrence(
    replaceLineOccurrence(
      DEEP_TELEMETRY_IMPORTER_LOCKFILE_BASE,
      "        specifier: ^4.3.5",
      "        specifier: ^4.3.6",
      2
    ),
    "        version: 4.3.5",
    "        version: 4.3.6",
    2
  ),
  "      '@babel/core': 7.29.0",
  "      '@babel/core': 7.29.7"
);
const DEEP_TELEMETRY_IMPORTER_SPECIFIER_LINE = lineNumberOf(
  DEEP_TELEMETRY_IMPORTER_LOCKFILE_BASE,
  "        specifier: ^4.3.5",
  2
);
const DEEP_TELEMETRY_IMPORTER_VERSION_LINE = lineNumberOf(
  DEEP_TELEMETRY_IMPORTER_LOCKFILE_BASE,
  "        version: 4.3.5",
  2
);
const DEEP_PEER_SNAPSHOT_LINE = lineNumberOf(
  DEEP_TELEMETRY_IMPORTER_LOCKFILE_BASE,
  "      '@babel/core': 7.29.0"
);
const ALLOWED_TELEMETRY_IMPORTER_DIFF_WITH_OMITTED_PARENT = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -${DEEP_TELEMETRY_IMPORTER_SPECIFIER_LINE} +${DEEP_TELEMETRY_IMPORTER_SPECIFIER_LINE} @@
-        specifier: ^4.3.5
+        specifier: ^4.3.6
`;
const ALLOWED_THEN_UNRELATED_MULTI_HUNK_LOCKFILE_DIFF = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -${DEEP_TELEMETRY_IMPORTER_VERSION_LINE} +${DEEP_TELEMETRY_IMPORTER_VERSION_LINE} @@
-        version: 4.3.5
+        version: 4.3.6
@@ -${DEEP_PEER_SNAPSHOT_LINE} +${DEEP_PEER_SNAPSHOT_LINE} @@
-      '@babel/core': 7.29.0
+      '@babel/core': 7.29.7
`;
const UNRELATED_IMPORTER_LOCKFILE_BASE = `importers:
  apps/app:
    dependencies:
      next:
        version: 16.2.6(@babel/core@7.29.0)
`;
const UNRELATED_IMPORTER_LOCKFILE_HEAD = `importers:
  apps/app:
    dependencies:
      next:
        version: 16.2.6(@babel/core@7.29.7)
`;
const UNRELATED_IMPORTER_LOCKFILE_DIFF = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -1,8 +1,8 @@
 importers:
   apps/app:
     dependencies:
       next:
-        version: 16.2.6(@babel/core@7.29.0)
+        version: 16.2.6(@babel/core@7.29.7)
`;
const UNRELATED_PEER_SNAPSHOT_LOCKFILE_BASE = `packages:
  '@babel/core@7.29.7':
    resolution: {integrity: sha512-old}
snapshots:
  styled-jsx@5.1.6(@babel/core@7.29.7)(react@19.2.5):
    dependencies:
      client-only: 0.0.1
      '@babel/core': 7.29.0
`;
const UNRELATED_PEER_SNAPSHOT_LOCKFILE_HEAD = `packages:
  '@babel/core@7.29.7':
    resolution: {integrity: sha512-new}
snapshots:
  styled-jsx@5.1.6(@babel/core@7.29.7)(react@19.2.5):
    dependencies:
      client-only: 0.0.1
      '@babel/core': 7.29.7
`;
const UNRELATED_PEER_SNAPSHOT_LOCKFILE_DIFF = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
@@ -2800,8 +2800,8 @@ packages:
 snapshots:
   styled-jsx@5.1.6(@babel/core@7.29.7)(react@19.2.5):
     dependencies:
       client-only: 0.0.1
-      '@babel/core': 7.29.0
+      '@babel/core': 7.29.7
`;
const SCHEMA_SOURCE_GROUPS = [
  {
    sourcePath: APP_SOURCE_PATH,
    testPath: APP_TEST_PATH,
  },
  {
    sourcePath: RESOURCE_SOURCE_PATH,
    testPath: RESOURCE_TEST_PATH,
  },
  {
    sourcePath: SPAN_SOURCE_PATH,
    testPath: SPAN_TEST_PATH,
  },
  {
    sourcePath: GEN_AI_SOURCE_PATH,
    testPath: GEN_AI_TEST_PATH,
  },
  {
    sourcePath: SYNC_SOURCE_PATH,
    testPath: SYNC_TEST_PATH,
  },
  {
    sourcePath: PERMISSION_SOURCE_PATH,
    testPath: PERMISSION_TEST_PATH,
  },
] as const;
const REQUIRED_MAPPING_FIELD_CASES = [
  {
    fieldName: CompatibilityMappingField.Producer,
    mappingFields: {
      [CompatibilityMappingField.Producer]: "",
      [CompatibilityMappingField.SourceField]: "duration_ms",
      [CompatibilityMappingField.Reason]: "Existing route telemetry producer.",
    },
  },
  {
    fieldName: CompatibilityMappingField.SourceField,
    mappingFields: {
      [CompatibilityMappingField.Producer]: "apps/api/lib/route-utils.ts",
      [CompatibilityMappingField.SourceField]: "",
      [CompatibilityMappingField.Reason]: "Existing route telemetry producer.",
    },
  },
  {
    fieldName: CompatibilityMappingField.Reason,
    mappingFields: {
      [CompatibilityMappingField.Producer]: "apps/api/lib/route-utils.ts",
      [CompatibilityMappingField.SourceField]: "duration_ms",
      [CompatibilityMappingField.Reason]: "",
    },
  },
] as const satisfies readonly {
  fieldName: CompatibilityMappingFieldName;
  mappingFields: Record<CompatibilityMappingFieldName, string>;
}[];

describe("schema update gates", () => {
  it.each(
    SCHEMA_SOURCE_GROUPS
  )("passes $sourcePath changes when mapped tests and JSON Schema parity are in the diff", ({
    sourcePath,
    testPath,
  }) => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [sourcePath, testPath, JSON_SCHEMA_PARITY_PATH],
    });

    expect(findings).toEqual([]);
  });

  it("fails schema source changes that omit the mapped Zod test from the diff", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [RESOURCE_SOURCE_PATH, JSON_SCHEMA_PARITY_PATH],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(RESOURCE_SOURCE_PATH);
    expect(findings[0].message).toContain(RESOURCE_SOURCE_PATH);
    expect(findings[0].message).toContain(RESOURCE_TEST_PATH);
    expect(findings[0].message).toContain(MISSING_ZOD_TEST_TEXT);
  });

  it("fails sync schema source changes that omit the mapped Zod test from the diff", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [SYNC_SOURCE_PATH, JSON_SCHEMA_PARITY_PATH],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(SYNC_SOURCE_PATH);
    expect(findings[0].message).toContain(SYNC_SOURCE_PATH);
    expect(findings[0].message).toContain(SYNC_TEST_PATH);
    expect(findings[0].message).toContain(MISSING_ZOD_TEST_TEXT);
  });

  it("fails permission schema source changes that omit the mapped Zod test from the diff", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [PERMISSION_SOURCE_PATH, JSON_SCHEMA_PARITY_PATH],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(PERMISSION_SOURCE_PATH);
    expect(findings[0].message).toContain(PERMISSION_SOURCE_PATH);
    expect(findings[0].message).toContain(PERMISSION_TEST_PATH);
    expect(findings[0].message).toContain(MISSING_ZOD_TEST_TEXT);
  });

  it("fails schema source changes that omit the JSON Schema parity file from the diff", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [SPAN_SOURCE_PATH, SPAN_TEST_PATH],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(SPAN_SOURCE_PATH);
    expect(findings[0].message).toContain(SPAN_SOURCE_PATH);
    expect(findings[0].message).toContain(JSON_SCHEMA_PARITY_PATH);
    expect(findings[0].message).toContain(MISSING_JSON_SCHEMA_TEXT);
  });

  it("fails permission schema source changes that omit the JSON Schema parity file from the diff", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [PERMISSION_SOURCE_PATH, PERMISSION_TEST_PATH],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(PERMISSION_SOURCE_PATH);
    expect(findings[0].message).toContain(PERMISSION_SOURCE_PATH);
    expect(findings[0].message).toContain(JSON_SCHEMA_PARITY_PATH);
    expect(findings[0].message).toContain(MISSING_JSON_SCHEMA_TEXT);
  });

  it("fails sync schema source changes that omit the JSON Schema parity file from the diff", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [SYNC_SOURCE_PATH, SYNC_TEST_PATH],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(SYNC_SOURCE_PATH);
    expect(findings[0].message).toContain(SYNC_SOURCE_PATH);
    expect(findings[0].message).toContain(JSON_SCHEMA_PARITY_PATH);
    expect(findings[0].message).toContain(MISSING_JSON_SCHEMA_TEXT);
  });

  it("does not require schema companion files for helper-only package changes", () => {
    for (const sourcePath of [HELPER_SOURCE_PATH]) {
      const findings = evaluateSchemaUpdateGates({
        changedFiles: [sourcePath],
      });

      expect(findings).toEqual([]);
    }
  });

  it("allows telemetry contract package metadata changes with no lockfile diff", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [PACKAGE_MANIFEST_PATH],
    });

    expect(findings).toEqual([]);
  });

  it("allows telemetry contract package metadata changes with scoped package importer lockfile changes", () => {
    const findings = evaluatePackageMetadataLockfileDiff({
      baseSource: TELEMETRY_IMPORTER_LOCKFILE_BASE,
      diffText: ALLOWED_TELEMETRY_IMPORTER_LOCKFILE_DIFF,
      headSource: TELEMETRY_IMPORTER_LOCKFILE_HEAD,
    });

    expect(findings).toEqual([]);
  });

  it("allows scoped package importer lockfile changes when the hunk omits the importer parent key", () => {
    const findings = evaluatePackageMetadataLockfileDiff({
      baseSource: DEEP_TELEMETRY_IMPORTER_LOCKFILE_BASE,
      diffText: ALLOWED_TELEMETRY_IMPORTER_DIFF_WITH_OMITTED_PARENT,
      headSource: DEEP_TELEMETRY_IMPORTER_LOCKFILE_HEAD,
    });

    expect(findings).toEqual([]);
  });

  it("fails telemetry contract package metadata changes with unrelated importer lockfile drift", () => {
    const findings = evaluatePackageMetadataLockfileDiff({
      baseSource: UNRELATED_IMPORTER_LOCKFILE_BASE,
      diffText: UNRELATED_IMPORTER_LOCKFILE_DIFF,
      headSource: UNRELATED_IMPORTER_LOCKFILE_HEAD,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(PNPM_LOCKFILE_PATH);
    expect(findings[0].message).toContain(UNSCOPED_LOCKFILE_TEXT);
    expect(findings[0].message).toContain("apps/app");
    expect(findings[0].message).toContain("peer snapshots");
  });

  it("fails telemetry contract package metadata changes with unrelated peer-snapshot lockfile drift", () => {
    const findings = evaluatePackageMetadataLockfileDiff({
      baseSource: UNRELATED_PEER_SNAPSHOT_LOCKFILE_BASE,
      diffText: UNRELATED_PEER_SNAPSHOT_LOCKFILE_DIFF,
      headSource: UNRELATED_PEER_SNAPSHOT_LOCKFILE_HEAD,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(PNPM_LOCKFILE_PATH);
    expect(findings[0].message).toContain(UNSCOPED_LOCKFILE_TEXT);
    expect(findings[0].message).toContain("@babel/core");
    expect(findings[0].message).toContain("peer snapshots");
  });

  it("fails multi-hunk lockfile drift after an allowed telemetry contract importer change", () => {
    const findings = evaluatePackageMetadataLockfileDiff({
      baseSource: DEEP_TELEMETRY_IMPORTER_LOCKFILE_BASE,
      diffText: ALLOWED_THEN_UNRELATED_MULTI_HUNK_LOCKFILE_DIFF,
      headSource: DEEP_TELEMETRY_IMPORTER_LOCKFILE_HEAD,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(PNPM_LOCKFILE_PATH);
    expect(findings[0].message).toContain(UNSCOPED_LOCKFILE_TEXT);
    expect(findings[0].message).toContain("snapshots");
    expect(findings[0].message).toContain("@babel/core");
  });

  it("fails future telemetry source files until they are classified", () => {
    for (const sourcePath of [FUTURE_SOURCE_PATH, FUTURE_NESTED_SOURCE_PATH]) {
      const findings = evaluateSchemaUpdateGates({
        changedFiles: [sourcePath],
      });

      expect(findings).toHaveLength(1);
      expect(findings[0].file).toBe(sourcePath);
      expect(findings[0].message).toContain(UNCLASSIFIED_SOURCE_TEXT);
      expect(findings[0].message).toContain(CLASSIFICATION_GUIDANCE_TEXT);
    }
  });

  it("passes new compatibility attributes with complete producer mappings", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      headAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: true,
        mappingFields: {
          [CompatibilityMappingField.Producer]: "apps/api/lib/new-producer.ts",
          [CompatibilityMappingField.SourceField]: "newProducerField",
          [CompatibilityMappingField.Reason]:
            "Documents the handoff until the pinned OTel package ships it.",
        },
      }),
    });

    expect(findings).toEqual([]);
  });

  it("fails new compatibility attributes with no producer mapping", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      headAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: true,
      }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("closedloop.new_attribute");
    for (const field of RequiredCompatibilityMappingFields) {
      expect(findings[0].message).toContain(field);
    }
  });

  it("fails current compatibility attributes with no producer mapping", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      headAttributesSource: compatibilityAttributesSource({
        includeExistingMapping: false,
        includeNewAttribute: false,
      }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("duration_ms");
    for (const field of RequiredCompatibilityMappingFields) {
      expect(findings[0].message).toContain(field);
    }
  });

  it.each(
    REQUIRED_MAPPING_FIELD_CASES
  )("fails current compatibility attributes with an empty $fieldName field", ({
    fieldName,
    mappingFields,
  }) => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      headAttributesSource: compatibilityAttributesSource({
        existingMappingFields: mappingFields,
        includeNewAttribute: false,
      }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("duration_ms");
    expect(findings[0].message).toContain(fieldName);
  });

  it("fails new compatibility attributes with an empty producer field", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      headAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: true,
        mappingFields: {
          [CompatibilityMappingField.Producer]: "",
          [CompatibilityMappingField.SourceField]: "newProducerField",
          [CompatibilityMappingField.Reason]: "Documents the handoff.",
        },
      }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain(CompatibilityMappingField.Producer);
    expect(findings[0].message).not.toContain(
      CompatibilityMappingField.SourceField
    );
    expect(findings[0].message).not.toContain(CompatibilityMappingField.Reason);
  });

  it("fails new compatibility attributes with an empty sourceField field", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      headAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: true,
        mappingFields: {
          [CompatibilityMappingField.Producer]: "apps/api/lib/new-producer.ts",
          [CompatibilityMappingField.SourceField]: "",
          [CompatibilityMappingField.Reason]: "Documents the handoff.",
        },
      }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].message).not.toContain(
      CompatibilityMappingField.Producer
    );
    expect(findings[0].message).toContain(
      CompatibilityMappingField.SourceField
    );
    expect(findings[0].message).not.toContain(CompatibilityMappingField.Reason);
  });

  it("fails new compatibility attributes with an empty reason field", () => {
    const findings = evaluateSchemaUpdateGates({
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      headAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: true,
        mappingFields: {
          [CompatibilityMappingField.Producer]: "apps/api/lib/new-producer.ts",
          [CompatibilityMappingField.SourceField]: "newProducerField",
          [CompatibilityMappingField.Reason]: "",
        },
      }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].message).not.toContain(
      CompatibilityMappingField.Producer
    );
    expect(findings[0].message).not.toContain(
      CompatibilityMappingField.SourceField
    );
    expect(findings[0].message).toContain(CompatibilityMappingField.Reason);
  });

  it("reads changed files through git argument arrays without shell-interpolating refs", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const changedFiles = listTelemetryContractChangedFiles(
      (command, args) => {
        calls.push({ command, args });
        return `${RESOURCE_SOURCE_PATH}\n`;
      },
      "/repo",
      METACHARACTER_BASE_REF,
      METACHARACTER_HEAD_REF
    );

    expect(changedFiles).toEqual([RESOURCE_SOURCE_PATH]);
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "diff",
          "--name-only",
          "--diff-filter=ACMRT",
          `${METACHARACTER_BASE_REF}...${METACHARACTER_HEAD_REF}`,
          "--",
          "packages/telemetry-contract",
        ],
      },
    ]);
  });

  it("reads tracked and untracked worktree package files through git argument arrays", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const changedFiles = listTelemetryContractWorktreeChangedFiles(
      (command, args) => {
        calls.push({ command, args });
        if (args[0] === "diff") {
          return `${APP_TEST_PATH}\n`;
        }
        if (args[0] === "ls-files") {
          return `${APP_SOURCE_PATH}\n`;
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
      "/repo"
    );

    expect(changedFiles).toEqual([APP_TEST_PATH, APP_SOURCE_PATH]);
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "diff",
          "--name-only",
          "--diff-filter=ACMRT",
          "HEAD",
          "--",
          "packages/telemetry-contract",
        ],
      },
      {
        command: "git",
        args: [
          "ls-files",
          "--others",
          "--exclude-standard",
          "--",
          "packages/telemetry-contract",
        ],
      },
    ]);
  });

  it("can validate the current worktree diff when branch head has no committed package changes", () => {
    const result = runSchemaUpdateGateCli({
      changedFiles: [],
      includeWorktree: true,
      worktreeChangedFiles: [APP_TEST_PATH, JSON_SCHEMA_PARITY_PATH],
      worktreeUntrackedFiles: [APP_SOURCE_PATH],
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.calls).toEqual(
      expect.arrayContaining([
        {
          command: "git",
          args: [
            "diff",
            "--name-only",
            "--diff-filter=ACMRT",
            "origin/main...HEAD",
            "--",
            "packages/telemetry-contract",
          ],
        },
        {
          command: "git",
          args: [
            "diff",
            "--name-only",
            "--diff-filter=ACMRT",
            "HEAD",
            "--",
            "packages/telemetry-contract",
          ],
        },
        {
          command: "git",
          args: [
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            "packages/telemetry-contract",
          ],
        },
      ])
    );
  });

  it("reads lockfile drift through git argument arrays when package metadata changes", () => {
    const result = runSchemaUpdateGateCli({
      changedFiles: [PACKAGE_MANIFEST_PATH],
      lockfileDiff: UNRELATED_IMPORTER_LOCKFILE_DIFF,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error file=${PNPM_LOCKFILE_PATH}::`);
    expect(result.stderr).toContain(UNSCOPED_LOCKFILE_TEXT);
    expect(result.calls).toEqual(
      expect.arrayContaining([
        {
          command: "git",
          args: [
            "diff",
            "--unified=0",
            "origin/main...HEAD",
            "--",
            PNPM_LOCKFILE_PATH,
          ],
        },
      ])
    );
  });

  it("emits a CLI annotation when a schema source omits the mapped Zod test", () => {
    const result = runSchemaUpdateGateCli({
      changedFiles: [RESOURCE_SOURCE_PATH, JSON_SCHEMA_PARITY_PATH],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error file=${RESOURCE_SOURCE_PATH}::`);
    expect(result.stderr).toContain(RESOURCE_SOURCE_PATH);
    expect(result.stderr).toContain(RESOURCE_TEST_PATH);
    expect(result.stderr).toContain(MISSING_ZOD_TEST_TEXT);
  });

  it("emits a CLI annotation when a schema source omits JSON Schema parity", () => {
    const result = runSchemaUpdateGateCli({
      changedFiles: [SPAN_SOURCE_PATH, SPAN_TEST_PATH],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error file=${SPAN_SOURCE_PATH}::`);
    expect(result.stderr).toContain(SPAN_SOURCE_PATH);
    expect(result.stderr).toContain(JSON_SCHEMA_PARITY_PATH);
    expect(result.stderr).toContain(MISSING_JSON_SCHEMA_TEXT);
  });

  it("emits a CLI annotation for unmapped compatibility attributes", () => {
    const result = runSchemaUpdateGateCli({
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      headAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: true,
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error file=${ATTRIBUTES_SOURCE_PATH}::`);
    expect(result.stderr).toContain("closedloop.new_attribute");
    for (const field of RequiredCompatibilityMappingFields) {
      expect(result.stderr).toContain(field);
    }
  });

  it("reads head compatibility attributes from the explicit head ref", () => {
    const result = runSchemaUpdateGateCli({
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      headAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: true,
      }),
      headRef: "feature/schema-update",
    });

    expect(result.status).toBe(1);
    expect(result.calls).toEqual(
      expect.arrayContaining([
        {
          command: "git",
          args: ["show", `origin/main:${ATTRIBUTES_SOURCE_PATH}`],
        },
        {
          command: "git",
          args: ["show", `feature/schema-update:${ATTRIBUTES_SOURCE_PATH}`],
        },
      ])
    );
    expect(result.stderr).toContain("closedloop.new_attribute");
  });

  it.each(
    REQUIRED_MAPPING_FIELD_CASES
  )("emits a CLI annotation for empty compatibility mapping field $fieldName", ({
    fieldName,
    mappingFields,
  }) => {
    const result = runSchemaUpdateGateCli({
      baseAttributesSource: compatibilityAttributesSource({
        includeNewAttribute: false,
      }),
      changedFiles: [ATTRIBUTES_SOURCE_PATH],
      headAttributesSource: compatibilityAttributesSource({
        existingMappingFields: mappingFields,
        includeNewAttribute: false,
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`::error file=${ATTRIBUTES_SOURCE_PATH}::`);
    expect(result.stderr).toContain("duration_ms");
    expect(result.stderr).toContain(fieldName);
  });
});

function evaluatePackageMetadataLockfileDiff(input: {
  baseSource: string;
  diffText: string;
  headSource: string;
}) {
  return evaluateSchemaUpdateGates({
    changedFiles: [PACKAGE_MANIFEST_PATH],
    lockfileBaseSource: input.baseSource,
    lockfileDiff: input.diffText,
    lockfileHeadSource: input.headSource,
  });
}

function lineNumberOf(source: string, needle: string, occurrence = 1): number {
  let remainingOccurrences = occurrence;
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line !== needle) {
      continue;
    }
    remainingOccurrences -= 1;
    if (remainingOccurrences === 0) {
      return index + 1;
    }
  }

  throw new Error(`Missing line in lockfile fixture: ${needle}`);
}

function replaceLineOccurrence(
  source: string,
  needle: string,
  replacement: string,
  occurrence = 1
): string {
  let remainingOccurrences = occurrence;
  return source
    .split("\n")
    .map((line) => {
      if (line !== needle) {
        return line;
      }
      remainingOccurrences -= 1;
      return remainingOccurrences === 0 ? replacement : line;
    })
    .join("\n");
}

function runSchemaUpdateGateCli(options: {
  changedFiles: readonly string[];
  baseAttributesSource?: string;
  headAttributesSource?: string;
  lockfileDiff?: string;
  lockfileBaseSource?: string;
  lockfileHeadSource?: string;
  baseRef?: string;
  headRef?: string;
  includeWorktree?: boolean;
  worktreeChangedFiles?: readonly string[];
  worktreeUntrackedFiles?: readonly string[];
}): {
  calls: Array<{ command: string; args: string[] }>;
  status: number;
  stderr: string;
} {
  const baseRef = options.baseRef ?? "origin/main";
  const headRef = options.headRef ?? "HEAD";
  const calls: Array<{ command: string; args: string[] }> = [];
  const stderr: string[] = [];
  const argv = ["--", "--base", baseRef, "--head", headRef];
  if (options.includeWorktree) {
    argv.push("--include-worktree");
  }
  const status = runSchemaUpdateGates({
    argv,
    cwd: "/repo/packages/telemetry-contract",
    execFile: (command, args) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "rev-parse") {
        return "/repo\n";
      }
      if (command === "git" && args[0] === "diff") {
        if (args.at(-1) === PNPM_LOCKFILE_PATH) {
          return options.lockfileDiff ?? "";
        }
        if (args[3] === "HEAD") {
          return `${(options.worktreeChangedFiles ?? []).join("\n")}\n`;
        }
        return `${options.changedFiles.join("\n")}\n`;
      }
      if (command === "git" && args[0] === "ls-files") {
        return `${(options.worktreeUntrackedFiles ?? []).join("\n")}\n`;
      }
      if (command === "git" && args[0] === "show") {
        if (args[1] === `${baseRef}:${PNPM_LOCKFILE_PATH}`) {
          return options.lockfileBaseSource ?? UNRELATED_IMPORTER_LOCKFILE_BASE;
        }
        if (args[1] === `${headRef}:${PNPM_LOCKFILE_PATH}`) {
          return options.lockfileHeadSource ?? UNRELATED_IMPORTER_LOCKFILE_HEAD;
        }
        if (args[1] === `${baseRef}:${ATTRIBUTES_SOURCE_PATH}`) {
          return (
            options.baseAttributesSource ??
            compatibilityAttributesSource({ includeNewAttribute: false })
          );
        }
        if (args[1] === `${headRef}:${ATTRIBUTES_SOURCE_PATH}`) {
          return (
            options.headAttributesSource ??
            compatibilityAttributesSource({ includeNewAttribute: false })
          );
        }
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
    stderr: { error: (message) => stderr.push(message) },
  });

  return { calls, status, stderr: stderr.join("\n") };
}
