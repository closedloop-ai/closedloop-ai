import type { ComplianceItem } from "@repo/api/src/types/analytics";
import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import type { Tag } from "@repo/api/src/types/tag";
import { TagColor } from "@repo/api/src/types/tag";

/**
 * @file governance-panel-fixtures.ts
 * @description The three domain shapes the ISS-8367 governance panels render,
 * owned once for the panels' tests and their stories.
 *
 * `CustomFieldWithOptions` alone carries eighteen fields, and it was being
 * hand-copied into every file that needed one — so adding a field to the
 * contract meant finding four literals to keep in step, with nothing failing
 * until someone noticed.
 */

export const GOVERNANCE_FIXTURE_AUTHOR_ID = "user_ada";

/**
 * `createdById` is the parameter that matters: a field with an author exercises
 * the "author read failed" cell, and one without exercises the genuinely
 * authorless em-dash. The story passes `null` for a third reason — a resolved
 * author renders a `UserLink`, which needs a navigation provider Storybook's
 * panel stories do not mount.
 */
export function buildCustomFieldFixture(
  overrides: Partial<CustomFieldWithOptions> = {}
): CustomFieldWithOptions {
  return {
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    createdById: GOVERNANCE_FIXTURE_AUTHOR_ID,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    description: null,
    entityTypes: [],
    enumOptions: [],
    fieldType: CustomFieldType.Text,
    id: "cf_1",
    isGlobalToOrg: false,
    isSearchable: false,
    isSortable: false,
    name: "Customer",
    numberFormat: NumberFormat.None,
    organizationId: "org-1",
    precision: null,
    referenceTargetSources: [],
    showInTable: false,
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

export function buildTagFixture(overrides: Partial<Tag> = {}): Tag {
  return {
    color: TagColor.Blue,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    createdById: GOVERNANCE_FIXTURE_AUTHOR_ID,
    id: "tag_1",
    name: "Customer request",
    organizationId: "org-1",
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...overrides,
  };
}

export function buildComplianceGapFixture(
  overrides: Partial<ComplianceItem> = {}
): ComplianceItem {
  return {
    catalogItemName: "Repo Guardrails",
    distributionId: "dist-1",
    installedButUnusedCount: 1,
    kind: "mcp",
    mode: "auto_install",
    notInstalledCount: 2,
    totalTargetCount: 4,
    ...overrides,
  };
}
