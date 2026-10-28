/**
 * ISS-9216 — pagination belongs to the v2 list surface, not to whoever mounts
 * it.
 *
 * Sessions and Branches rendered pagination differently on web than on desktop
 * because four composition seams let a host answer questions the surface should
 * have owned: an OPTIONAL `pageSizeOptions` the web page passed and the desktop
 * view did not (so one shell read an explicit ladder and the other a default), a
 * host-computed `showPagination` boolean run through
 * `shouldShowBranchListV2Pagination` — a rule living outside the component it
 * governed — a `TablePaginationFooter` each Branches host imported and rendered
 * itself, and a `paginationReadout` `ReactNode` all four hosts filled from
 * different indexes under different suppression rules.
 *
 * None of that failed anything. The type system called each host complete,
 * because an omitted optional prop is indistinguishable from a surface that
 * never had one.
 *
 * This test drives BOTH hosts of BOTH surfaces off DISK — the desktop tree never
 * has to import this app's test support — and reads three independent sources:
 * each surface's own declared props, and each host's real JSX. It fails the
 * moment a host is handed a pagination presentation decision again, which is the
 * mutation that is invisible on `main`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { propsPassedToImported } from "./support/jsx-mount-props";
import { rendersImportedComponent } from "./support/renders-imported-component";
import { declaredOptionalProps } from "./support/surface-capability-parity";

const REPO_ROOT = path.join(process.cwd(), "..", "..");

/**
 * Props through which a host would decide how pagination LOOKS or WHETHER it
 * renders. Every one of these existed on `main`; none may come back, on either
 * surface, at any host. `pageSizeOptions` is the ladder, `showPagination` the
 * visibility predicate, `paginationDisabled` the placeholder-page styling,
 * `footerClassName` the footer's own frame, and `paginationReadout` the
 * sentence.
 *
 * `paginationReadout` is the one this list could not have discriminated
 * (davetho review): an opaque `ReactNode` every host DID pass, and passed
 * differently — web Sessions off `effectivePageIndex`, desktop Sessions off
 * `page`, both Branches hosts off an unsuppressed `from–to of total` — while a
 * fifth answer, the surface's own fallback, matched none of them. Four hosts
 * agreeing to supply a prop is what the parity checks reward, so nothing was
 * red. The surfaces state their own range now (`listPageRange`), and this entry
 * is what stops one being handed back.
 */
const PAGINATION_PRESENTATION_PROPS = [
  "footerClassName",
  "pageSizeOptions",
  "paginationDisabled",
  "paginationReadout",
  "showPagination",
] as const;

type SurfaceUnderTest = {
  /** Repo-relative path of the component that must own its pagination. */
  readonly componentPath: string;
  readonly componentName: string;
  readonly componentModule: string;
  /** Repo-relative paths of every production module that mounts it. */
  readonly hostPaths: readonly string[];
  /**
   * Pagination props both hosts must pass IDENTICALLY. Data and callbacks only
   * — what the surface cannot know for itself.
   */
  readonly sharedPaginationInputs: readonly string[];
  readonly label: string;
  /**
   * ISS-9225: the specifier this surface imports the ONE footer from, or absent
   * for a module that mounts a surface rather than being one. Relative, because
   * that is how the surfaces reach their own package.
   */
  readonly paginationFooterModule?: string;
};

const SESSIONS_SURFACE: SurfaceUnderTest = {
  componentModule:
    "@repo/app/agents/components/sessions/sessions-list-surface-v2",
  componentName: "SessionsListSurfaceV2",
  componentPath:
    "packages/app/agents/components/sessions/sessions-list-surface-v2.tsx",
  hostPaths: [
    "apps/app/components/agent-sessions/sessions-list-v2-host.tsx",
    "apps/desktop/src/renderer/components/sessions/sessions-v2-view.tsx",
  ],
  label: "Sessions v2",
  paginationFooterModule:
    "../../../shared/components/list-surface-pagination-footer",
  sharedPaginationInputs: ["isPlaceholderPage", "maxOffset", "pageSize"],
};

const BRANCHES_SURFACE: SurfaceUnderTest = {
  componentModule: "@repo/app/branches/components/branches-list-surface-v2",
  componentName: "BranchesListSurfaceV2",
  componentPath:
    "packages/app/branches/components/branches-list-surface-v2.tsx",
  hostPaths: [
    "apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx",
    "apps/desktop/src/renderer/components/branches/branches-view.tsx",
  ],
  label: "Branches v2",
  paginationFooterModule:
    "../../shared/components/list-surface-pagination-footer",
  sharedPaginationInputs: [
    "isPlaceholderData",
    "onPageChange",
    "onPageSizeChange",
    "page",
    "pageSize",
    "total",
    "totalPages",
  ],
};

/**
 * The web Sessions page mounts the surface through a host of its own, so the
 * ladder could be reintroduced one level up and never reach this surface check.
 */
const SESSIONS_PAGE_HOST: SurfaceUnderTest = {
  componentModule: "@/components/agent-sessions/sessions-list-v2-host",
  componentName: "SessionsListV2Host",
  componentPath: "apps/app/components/agent-sessions/sessions-list-v2-host.tsx",
  hostPaths: [
    "apps/app/app/(authenticated)/[orgSlug]/sessions/sessions-v2-page.tsx",
  ],
  label: "Sessions v2 page host",
  sharedPaginationInputs: [],
};

/**
 * ISS-9398. Stronger than the two above: this surface takes no pagination input
 * at all, because it performs the read itself. `sharedPaginationInputs` is
 * therefore empty and the both-shells comparison below would pass vacuously on
 * it, so the claim gets its own assertion instead.
 */
const AGENTS_SURFACE: SurfaceUnderTest = {
  componentModule:
    "@repo/app/agents/components/workspace/agents-list-surface-v2",
  componentName: "AgentsListSurfaceV2",
  componentPath:
    "packages/app/agents/components/workspace/agents-list-surface-v2.tsx",
  hostPaths: [
    "apps/app/app/(authenticated)/[orgSlug]/agents/components/agents-list-host.tsx",
    "apps/desktop/src/renderer/components/agents/agents-view.tsx",
  ],
  label: "Agents v2",
  sharedPaginationInputs: [],
};

const SURFACES = [
  SESSIONS_SURFACE,
  BRANCHES_SURFACE,
  SESSIONS_PAGE_HOST,
  AGENTS_SURFACE,
];

describe.each(SURFACES)(
  "$label owns its pagination",
  (surface: SurfaceUnderTest) => {
    const componentFile = path.join(REPO_ROOT, surface.componentPath);
    const declaredOptional = declaredOptionalProps(
      readFileSync(componentFile, "utf8"),
      surface.componentName,
      componentFile
    );
    const suppliedByHost = surface.hostPaths.map((hostPath) => ({
      hostPath,
      supplied: propsPassedToImported(
        readFileSync(path.join(REPO_ROOT, hostPath), "utf8"),
        surface.componentModule,
        surface.componentName
      ),
    }));

    it("declares no prop through which a host could decide presentation", () => {
      expect(
        PAGINATION_PRESENTATION_PROPS.filter((prop) =>
          declaredOptional.has(prop)
        )
      ).toStrictEqual([]);
      // Not vacuous: a reader that returned nothing would pass this forever.
      expect(declaredOptional.size).toBeGreaterThan(0);
    });

    it.each(suppliedByHost)(
      "$hostPath passes no pagination presentation prop",
      ({ supplied }) => {
        expect(
          PAGINATION_PRESENTATION_PROPS.filter((prop) => supplied.has(prop))
        ).toStrictEqual([]);
        expect(supplied.size).toBeGreaterThan(0);
      }
    );
  }
);

describe.each([SESSIONS_SURFACE, BRANCHES_SURFACE])(
  "$label renders identical pagination on both shells",
  (surface: SurfaceUnderTest) => {
    const suppliedByHost = surface.hostPaths.map((hostPath) =>
      propsPassedToImported(
        readFileSync(path.join(REPO_ROOT, hostPath), "utf8"),
        surface.componentModule,
        surface.componentName
      )
    );

    /**
     * One assertion over BOTH hosts, not two that happen to agree: every
     * pagination input each shell hands the surface is compared against the
     * other's, so a shell that starts (or stops) supplying one fails here.
     */
    it("hands the surface the same pagination inputs from every host", () => {
      const [web, desktop] = suppliedByHost;
      const paginationInputs = (supplied: ReadonlySet<string>) =>
        surface.sharedPaginationInputs.filter((prop) => supplied.has(prop));
      expect(paginationInputs(web)).toStrictEqual([
        ...surface.sharedPaginationInputs,
      ]);
      expect(paginationInputs(desktop)).toStrictEqual(paginationInputs(web));
    });
  }
);

/**
 * ISS-9225 — and the footer itself is ONE component, not two that agree.
 *
 * `shouldRenderListPagination` and `listPageRange` unified the visibility rule
 * and the range; the STRIP was still built twice, so its frame, its disabled
 * state, its ladder and its single-page behaviour each had two answers. Sessions
 * rendered `SessionsListPagination` and Branches rendered the design-system
 * `TablePaginationFooter` directly — both now deleted from the surfaces, and the
 * second half of this pair is what stops either coming back.
 */
describe.each([SESSIONS_SURFACE, BRANCHES_SURFACE])(
  "$label renders the shared pagination footer",
  (surface: SurfaceUnderTest) => {
    const code = readFileSync(
      path.join(REPO_ROOT, surface.componentPath),
      "utf8"
    );
    const footerModule = surface.paginationFooterModule as string;

    it("mounts ListSurfacePaginationFooter", () => {
      expect(
        rendersImportedComponent(
          code,
          footerModule,
          "ListSurfacePaginationFooter"
        )
      ).toBe(true);
    });

    it("does not build a second strip out of the design-system footer", () => {
      expect(
        rendersImportedComponent(
          code,
          "@repo/design-system/components/ui/table-pagination-footer",
          "TablePaginationFooter"
        )
      ).toBe(false);
    });
  }
);

/**
 * Every prop through which a host would supply the DATA pagination runs on —
 * the page, the count, the ladder size, the change handlers, the placeholder
 * and resolution flags. Sessions and Branches legitimately pass some of these,
 * because their hosts own the read.
 */
const PAGINATION_INPUT_PROPS = [
  "isPlaceholderData",
  "isPlaceholderPage",
  "isResolved",
  "maxOffset",
  "onPageChange",
  "onPageSizeChange",
  "page",
  "pageSize",
  "total",
  "totalPages",
] as const;

describe("Agents v2 takes no pagination input from either shell", () => {
  const componentFile = path.join(REPO_ROOT, AGENTS_SURFACE.componentPath);
  const declaredOptional = declaredOptionalProps(
    readFileSync(componentFile, "utf8"),
    AGENTS_SURFACE.componentName,
    componentFile
  );

  /**
   * The strongest form of ISS-9216 AC1 available to a surface that owns its own
   * read: not "both shells agree on the pagination inputs" but "there is no
   * pagination input to disagree about". The page index, the total, the page
   * size and the change handler all come from `useAgentsListSurfaceV2ViewModel`,
   * so a shell has no seam to reach them through — and adding one would have to
   * pass through this file.
   */
  // "Optional" is the honest scope: `declaredOptionalProps` reads members
  // carrying a question token, so a REQUIRED pagination prop would not appear
  // here. The sibling case below is what covers that — it reads what each host
  // actually passes, and a required prop must be passed or `tsc` fails.
  it("declares no optional pagination prop, presentation or data", () => {
    expect(
      PAGINATION_INPUT_PROPS.filter((prop) => declaredOptional.has(prop))
    ).toStrictEqual([]);
    expect(
      PAGINATION_PRESENTATION_PROPS.filter((prop) => declaredOptional.has(prop))
    ).toStrictEqual([]);
    // Not vacuous: a reader that returned nothing would pass this forever.
    expect(declaredOptional.size).toBeGreaterThan(0);
  });

  it.each(AGENTS_SURFACE.hostPaths)("%s passes none of them", (hostPath) => {
    const supplied = propsPassedToImported(
      readFileSync(path.join(REPO_ROOT, hostPath), "utf8"),
      AGENTS_SURFACE.componentModule,
      AGENTS_SURFACE.componentName
    );
    expect(
      PAGINATION_INPUT_PROPS.filter((prop) => supplied.has(prop))
    ).toStrictEqual([]);
    expect(supplied.size).toBeGreaterThan(0);
  });
});
