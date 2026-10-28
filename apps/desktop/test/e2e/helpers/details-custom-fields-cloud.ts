/**
 * ISS-12302: the cloud custom-field routes a Details tab reads and writes in
 * desktop Cloud mode, as `extraRoutes` for the Session and Branch stand-ins,
 * and the Cloud-mode edit flow both desktop specs drive against them. Every
 * route requires the bearer token, so a write that did not cross the
 * authenticated bridge cannot be recorded.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, type Page } from "@playwright/test";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract.ts";
import type {
  CustomFieldEntityType,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import {
  DetailsTabGroupId,
  detailsTabGroupSelector,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model.ts";
import {
  DETAILS_FIELD,
  detailsCustomFieldDefinitions,
  detailsCustomFieldValues,
  storeValue,
} from "../../../../../e2e/helpers/details-custom-fields-data";
import { DesktopAuthStatus } from "../../../src/shared/contracts.js";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  rejectUnauthorized,
  writeApiResult,
} from "./branch-details-authenticated-cloud";
import { gotoHash } from "./desktop-app";

export type DetailsCustomFieldCloudWrite = { body: unknown; fieldId: string };

export function detailsCustomFieldCloudRoutes(options: {
  entityId: string;
  entityType: CustomFieldEntityType;
  /** The entity's API segment: `agent-sessions` or `branches`. */
  segment: string;
}) {
  const definitions = detailsCustomFieldDefinitions(options.entityType);
  const valuesPath = `/${options.segment}/${options.entityId}/custom-field-values`;
  let values: CustomFieldValueDetail[] = detailsCustomFieldValues(
    options.entityId,
    definitions
  );
  const writes: DetailsCustomFieldCloudWrite[] = [];

  const route = (
    request: IncomingMessage,
    response: ServerResponse
  ): boolean => {
    const pathname = URL.parse(
      `${REQUEST_ORIGIN}${request.url ?? "/"}`
    )?.pathname;
    const field = definitions.find(
      (definition) => pathname === `${valuesPath}/${definition.id}`
    );
    const isRead =
      request.method === "GET" &&
      (pathname === "/custom-fields" || pathname === valuesPath);
    const isWrite = request.method === "PUT" && field !== undefined;
    if (!(isRead || isWrite)) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      rejectUnauthorized(response);
      return true;
    }
    if (!(isWrite && field)) {
      writeApiResult(response, pathname === valuesPath ? values : definitions);
      return true;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      writes.push({ body, fieldId: field.id });
      const value =
        typeof body === "object" && body !== null && "value" in body
          ? body.value
          : undefined;
      values = storeValue(values, field, value, options.entityId);
      writeApiResult(response, { deleted: true });
    });
    return true;
  };

  return { route, writes };
}

/** Origin used only to parse a relative request URL; never dialled. */
const REQUEST_ORIGIN = "http://127.0.0.1";

const MOUNT_TIMEOUT_MS = 30_000;

export function customFieldsSection(page: Page) {
  return page.locator(detailsTabGroupSelector(DetailsTabGroupId.CustomFields));
}

/**
 * Once the app is signed in, opens the Details tab, checks the seeded values,
 * then saves a TEXT edit on blur and a MULTI_ENUM toggle, each of which must
 * reach the stand-in as its own PUT.
 */
export async function expectCloudCustomFieldEditsSave(
  page: Page,
  options: {
    detailsHash: string;
    itemLabel: string;
    writes: readonly DetailsCustomFieldCloudWrite[];
  }
): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.desktopApi.getDesktopAuthState()))
    .toMatchObject({
      organizationId: AUTHENTICATED_ORGANIZATION_ID,
      status: DesktopAuthStatus.Authenticated,
      userId: AUTHENTICATED_USER_ID,
    });
  await gotoHash(page, options.detailsHash);

  const section = customFieldsSection(page);
  await expect(section).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  const risk = section.getByRole("textbox", { exact: true, name: "Risk" });
  await expect(risk).toHaveValue("high");
  await expect(
    section.getByRole("textbox", { exact: true, name: "Notes" })
  ).toHaveValue("");

  await risk.fill("low");
  await risk.press("Tab");
  await expect
    .poll(() => options.writes)
    .toEqual([
      {
        body: { value: "low", surface: ArtifactStatusEditSurface.Detail },
        fieldId: DETAILS_FIELD.risk,
      },
    ]);

  const labels = section.getByRole("button", {
    exact: true,
    name: `Edit Labels for ${options.itemLabel}`,
  });
  await labels.click();
  await page
    .getByRole("menuitemcheckbox", { exact: true, name: "Alpha" })
    .click();
  await expect
    .poll(() => options.writes)
    .toEqual([
      {
        body: { value: "low", surface: ArtifactStatusEditSurface.Detail },
        fieldId: DETAILS_FIELD.risk,
      },
      {
        body: {
          value: ["alpha"],
          surface: ArtifactStatusEditSurface.Detail,
        },
        fieldId: DETAILS_FIELD.labels,
      },
    ]);
  await expect(page.getByRole("menu")).toBeVisible();

  // The pick must show as a chip, not collapse into the overflow count: a
  // cell sized to its own content measured no room and showed only "+1".
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(labels).not.toContainText(OVERFLOW_COUNT);
}

const OVERFLOW_COUNT = /\+\d/;
