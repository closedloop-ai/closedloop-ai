/**
 * ISS-10005 — the desktop docs-help IPC contract and the shared render contract
 * describe the SAME payload, checked by `tsc`.
 *
 * Two declarations exist on purpose: `apps/desktop/src/shared/docs-help-contract.ts`
 * compiles into the main process, and `packages/app` is renderer-only. What must
 * not exist is DRIFT — the host hands `useDocsHelp`'s values straight to
 * `HelpSurfaceV2` props typed against the `@repo/app` copy.
 *
 * MUTUAL ASSIGNABILITY IS NOT ENOUGH. A type missing an OPTIONAL property stays
 * assignable to one that declares it, and every field here that could drift is
 * optional by policy (`renderBody?`, `group?`, `description?`, `headingSlug?`).
 * The invariant-position `Equals` idiom is exact: optionality included.
 *
 * The "View online" LABEL is pinned too — one action shown in five states
 * across two flag branches, where a second spelling is invisible to `tsc`. Since
 * ISS-10044 the failed-search sentence is pinned here for the same reason: it is
 * one sentence read by the Help pane and the command palette.
 */

import {
  DOCS_HELP_SEARCH_FAILED_DETAIL as SEARCH_FAILED_DETAIL,
  DOCS_HELP_SEARCH_FAILED_TITLE as SEARCH_FAILED_TITLE,
} from "@repo/app/help/lib/docs-help-labels";
import type {
  DocsHelpHeading as SurfaceHeading,
  DocsHelpMatchField as SurfaceMatchField,
  DocsHelpNavGroup as SurfaceNavGroup,
  DocsHelpNavPage as SurfaceNavPage,
  DocsHelpPage as SurfacePage,
  DocsHelpSearchHit as SurfaceSearchHit,
} from "@repo/app/help/lib/docs-help-payload";
import { DOCS_HELP_VIEW_ONLINE_LABEL as SURFACE_VIEW_ONLINE_LABEL } from "@repo/app/help/lib/docs-help-payload";
import { describe, expect, it } from "vitest";
import {
  DOCS_HELP_VIEW_ONLINE_LABEL as WIRE_VIEW_ONLINE_LABEL,
  type DocsHelpHeading as WireHeading,
  type DocsHelpMatchField as WireMatchField,
  type DocsHelpNavGroup as WireNavGroup,
  type DocsHelpNavPage as WireNavPage,
  type DocsHelpPage as WirePage,
  type DocsHelpSearchHit as WireSearchHit,
} from "../../../../shared/docs-help-contract";

/**
 * True only when the two types are identical. Conditional types in INVARIANT
 * position (behind `<T>() =>`) compare structurally rather than by assignability,
 * which is what makes an optional-only difference visible.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const HEADING_MATCHES: Equals<WireHeading, SurfaceHeading> = true;
const PAGE_MATCHES: Equals<WirePage, SurfacePage> = true;
const NAV_PAGE_MATCHES: Equals<WireNavPage, SurfaceNavPage> = true;
const NAV_GROUP_MATCHES: Equals<WireNavGroup, SurfaceNavGroup> = true;
const SEARCH_HIT_MATCHES: Equals<WireSearchHit, SurfaceSearchHit> = true;
const MATCH_FIELD_MATCHES: Equals<WireMatchField, SurfaceMatchField> = true;

describe("desktop docs-help payload parity", () => {
  /**
   * The six consts above are `true` literals at runtime, so this assertion
   * cannot go red — `tsc` is what fails on drift, and this only keeps the
   * declarations referenced. The real runtime coverage is the label below.
   */
  it("references the type-level parity declarations", () => {
    expect([
      HEADING_MATCHES,
      PAGE_MATCHES,
      NAV_PAGE_MATCHES,
      NAV_GROUP_MATCHES,
      SEARCH_HIT_MATCHES,
      MATCH_FIELD_MATCHES,
    ]).toEqual([true, true, true, true, true, true]);
  });

  it("gives the failed-search state one spelling across both surfaces", () => {
    // Literals, not a comparison between the two constants: renaming both the
    // same way would satisfy an equality check and still change what the Help
    // pane and the palette tell a reader.
    expect(SEARCH_FAILED_TITLE).toBe("Couldn't search the docs.");
    expect(SEARCH_FAILED_DETAIL).toBe(
      "This is on our end, not a problem with your query."
    );
  });

  it("gives the docs escape hatch one spelling on both sides", () => {
    // Pinned as a LITERAL, not as `WIRE === SURFACE`: two copies renamed the
    // same way would satisfy an equality check between them and still change
    // what every Help state says.
    expect(WIRE_VIEW_ONLINE_LABEL).toBe("View online");
    expect(SURFACE_VIEW_ONLINE_LABEL).toBe("View online");
  });
});
