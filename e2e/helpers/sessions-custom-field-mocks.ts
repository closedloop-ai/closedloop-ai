/**
 * Route helpers for the Sessions custom-field specs.
 *
 * Extracted from `e2e/sessions-custom-fields.spec.ts` (ISS-8884) so a second
 * spec can mount the same mocked custom-field collection without copying the
 * fixture builder. These install routes and assert nothing.
 */

import type { Page, Route } from "@playwright/test";
import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { success } from "./mock-users";

export const CUSTOM_FIELD_COLLECTION_ROUTE = /\/custom-fields$/;

/**
 * davetho review cid 3884191856 — a mock that answers 200 to ANY method
 * cannot fail under the mutation it claims to cover.
 *
 * The handlers this guards live in `sessions-custom-fields.spec.ts` and in
 * `installCustomFieldCollectionRead` below; only the helper moved here
 * (marisolashgrove review). Each used to treat "not GET" as the write it was
 * modelling, so a client regressing to DELETE, PATCH, or the wrong verb
 * entirely still got a plausible success body and the spec stayed green. The
 * URL is only half a contract; a route mounts one write verb at most, and
 * picking the wrong one is a 405 in production.
 *
 * Returns `true` when it has already answered — a loud 405 rather than a
 * `fallback()`, so the mismatch surfaces as this spec's own failed assertion
 * instead of an unmocked request reaching the network.
 */
export async function rejectUnlessMethod(
  route: Route,
  method: "POST" | "PUT"
): Promise<boolean> {
  const actual = route.request().method();
  if (actual === method) {
    return false;
  }
  await fulfillMethodNotAllowed(route, method);
  return true;
}

/** The loud 405 both rejection helpers answer a wrong verb with. */
async function fulfillMethodNotAllowed(
  route: Route,
  expected: string
): Promise<void> {
  await route.fulfill({
    body: JSON.stringify({
      error: `Mock expected ${expected}, received ${route.request().method()}`,
    }),
    contentType: "application/json",
    status: 405,
  });
}

export async function fulfillCustomFieldRead(
  route: Route,
  data: unknown
): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(success(data)),
    contentType: "application/json",
    status: 200,
  });
}

/** Serve a fixed custom-field collection for every GET; reject writes. */
export async function installCustomFieldCollectionRead(
  page: Page,
  fields: readonly CustomFieldWithOptions[]
): Promise<void> {
  await page.route(CUSTOM_FIELD_COLLECTION_ROUTE, async (route) => {
    if (route.request().method() === "GET") {
      await fulfillCustomFieldRead(route, fields);
      return;
    }
    // whitlockk review — this route mounts NO write verb, so `rejectUnlessMethod`
    // is the wrong shape here: it treats its argument as the expected method
    // and answers nothing, and a client regressing to POST then hung until the
    // spec's timeout instead of failing on the documented 405.
    await fulfillMethodNotAllowed(route, "GET");
  });
}

export function buildCustomField(
  input: Pick<
    CustomFieldWithOptions,
    "entityTypes" | "fieldType" | "id" | "name" | "showInTable"
  > &
    Partial<CustomFieldWithOptions>
): CustomFieldWithOptions {
  const timestamp = new Date("2026-08-28T00:00:00.000Z");
  return {
    id: input.id,
    organizationId: "org-1",
    name: input.name,
    description: input.description ?? null,
    fieldType: input.fieldType,
    createdById: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    precision: input.precision ?? null,
    numberFormat: input.numberFormat ?? null,
    currencyCode: input.currencyCode ?? null,
    customLabel: input.customLabel ?? null,
    customLabelPosition: input.customLabelPosition ?? null,
    isGlobalToOrg: true,
    entityTypes: input.entityTypes,
    referenceTargetSources: input.referenceTargetSources ?? [],
    showInTable: input.showInTable,
    isSearchable: input.isSearchable ?? false,
    isSortable: input.isSortable ?? false,
    enumOptions: input.enumOptions ?? [],
  };
}
