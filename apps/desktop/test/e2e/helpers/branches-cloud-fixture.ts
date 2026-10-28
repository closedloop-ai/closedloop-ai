/**
 * Shared fixture pieces for the Branches Electron specs that stand up a real
 * cloud API server and drive the owner facet.
 *
 * Extracted for the reason `branches-cloud-owner-filter-metrics.spec.ts`'s own
 * docstring already records about `date-window-fixture-guard.ts`: a second copy
 * is how the two drift. The facet driver is the piece most exposed to a Filter
 * UI change, and it existed twice.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Locator, Page } from "@playwright/test";
import {
  type BranchKpi,
  BranchKpiState,
  type BranchListResponse,
  type BranchRow,
} from "../../../../../packages/api/src/types/branch";
import { BranchListFacetAvailability } from "../../../../../packages/api/src/types/branch-list-contract";

/** Scoped to `:visible` so a card in a collapsed/offscreen region cannot match. */
export const SUMMARY_CARD_SELECTOR = '[data-slot="card"]:visible';
export const OWNER_FACET_MENUITEM_PATTERN = /^Owner\b/;
export const ALICE_OWNER_OPTION_PATTERN = /^Alice Agent\b/;

/** The provider-qualified identity the Branches facets key an owner on. */
export function ownerKey(row: BranchRow): string {
  const person = row.ownerIdentity?.person;
  return person ? `${person.provider}:${person.id}` : (row.owner ?? "");
}

/**
 * Drive the real Filter menu to the named owner option.
 *
 * NO PRE-CLICK WAIT. There used to be one, for the first-launch import banner,
 * because that banner OVERLAID the toolbar and a click issued while it was up
 * landed on the banner. ISS-4715 unmounted it, and ISS-10492 deleted the
 * in-flow `StartupReadinessPanel` that replaced it. The one progress surface
 * left is the analysis bar, which is fixed to the TOP of the viewport and whose
 * measured height the shell reserves beneath it, so it cannot reach this
 * toolbar either; Playwright's own actionability check already requires the
 * button to be stable across two animation frames before it clicks, which
 * covers the reflow that reservation causes. The obsolete precondition is therefore deleted rather than
 * re-pointed at the new element.
 */
export async function selectOwnerFacetOption(
  page: Page,
  optionName: RegExp
): Promise<void> {
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page
    .getByRole("menuitem", { name: OWNER_FACET_MENUITEM_PATTERN })
    .click();
  await page.getByRole("menuitem", { name: optionName }).click({ force: true });
  await page.keyboard.press("Escape");
}

export function writeJson(response: ServerResponse, data: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ success: true, data }));
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** A summary card located by its visible label. */
export function summaryCard(page: Page, label: string): Locator {
  return page.locator(SUMMARY_CARD_SELECTOR).filter({ hasText: label });
}

export function unavailableKpi(): BranchKpi {
  return {
    baseline30d: null,
    deltaPct: null,
    state: BranchKpiState.Unavailable,
    value: null,
  };
}

/** Every facet complete with no options, for a list response that needs none. */
export function emptyBranchListFacets(): NonNullable<
  BranchListResponse["facets"]
> {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    collaborators: emptyFacet,
    lastActiveRanges: emptyFacet,
    names: emptyFacet,
    owners: emptyFacet,
    pullRequests: emptyFacet,
    repositories: emptyFacet,
    statuses: emptyFacet,
    tags: emptyFacet,
  };
}
