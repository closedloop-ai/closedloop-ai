// ISS-4449: focused unit tests for the extracted SessionLinkedArtifactsRow — the
// Properties-pane "Linked artifacts" row. Covers the client-side display cap, the
// reachable "+N" overflow chip (incl. the cross-repo truncated-sync case where
// the served array is shorter than the true total), and the empty case. Rendering
// the component directly keeps this coverage out of the grandfathered
// agent-session-detail-view.test.tsx.

import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";
import {
  getDocumentTypeRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { SessionLinkedArtifactsRow } from "../session-linked-artifacts-row";

// The overflow tooltip's honest trailer for 20 unnamed hidden links.
const AND_20_MORE_TRAILER_REGEX = /and 20 more…$/;
// ISS-4793: the resolved pill's accessible name, which leads with its slug.
const LINKED_ARTIFACT_SLUG_RE = /ISS-4544/;

function linkedArtifacts(count: number): SessionLinkedArtifact[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `doc-${index}`,
    slug: `DOC-${index}`,
    name: `Doc ${index}`,
    documentType: null,
    role: "referenced",
  }));
}

describe("SessionLinkedArtifactsRow (ISS-4449)", () => {
  it("renders nothing when there are no linked artifacts", () => {
    const { container } = render(
      <SessionLinkedArtifactsRow linkedArtifacts={[]} total={0} />
    );

    expect(container.querySelector(".sd3-linked-prop")).toBeNull();
    expect(screen.queryByText("Linked artifacts")).not.toBeInTheDocument();
  });

  it("renders every pill and no overflow chip when the set is under the cap", () => {
    const { container } = render(
      <SessionLinkedArtifactsRow
        linkedArtifacts={linkedArtifacts(4)}
        total={4}
      />
    );

    expect(container.querySelectorAll(".sd3-result-pr")).toHaveLength(4);
    expect(container.querySelector(".sd3-linked-overflow")).toBeNull();
  });

  it("caps a full set at the visible cap (6) and shows a reachable +N chip", () => {
    const { container } = render(
      <SessionLinkedArtifactsRow
        linkedArtifacts={linkedArtifacts(9)}
        total={9}
      />
    );

    // 6 visible pills + the "+3" overflow chip (which is itself a .sd3-result-pr).
    expect(container.querySelectorAll(".sd3-result-pr")).toHaveLength(7);
    const overflow = container.querySelector(".sd3-linked-overflow");
    expect(overflow?.textContent).toBe("+3");
  });

  // Cross-repo skew: the served array is shorter than the true total (Desktop
  // truncated its synced link set). The chip counts the FULL overflow and, since
  // it can't name links it never received, the disclosed panel carries an honest
  // "and K more…" trailer rather than a dead-end count.
  it("shows the true overflow count and an honest 'more' trailer when the sync truncated the array", async () => {
    const user = userEvent.setup();
    // Mounted through the app-core providers like the other disclosure cases
    // below: the chip is a `Popover` trigger, so opening it is a real
    // interaction rather than a hover on an inert span.
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          linkedArtifacts={linkedArtifacts(3)}
          total={23}
        />
      </AppCoreStoryProviders>
    );

    const overflow = container.querySelector(".sd3-linked-overflow");
    // 3 served, resolved total 23 -> "+20" (total minus the shown pills).
    expect(overflow?.textContent).toBe("+20");
    // No hidden links were received (3 < the visible cap), so the disclosure is
    // the honest "and 20 more…" trailer.
    await user.click(screen.getByText("+20"));
    expect(
      await screen.findAllByText(AND_20_MORE_TRAILER_REGEX)
    ).not.toHaveLength(0);
  });
});

// ISS-4793: the pills were reported as "not clickable — only a title tooltip".
// The existing FEA-3635 coverage in agent-session-detail-view.test.tsx asserts an
// <a href> but hands the row a HAND-WRITTEN href (`/acme/features/${slug}`), so it
// would still pass if the real resolver returned null for every type — exactly the
// failure mode the report suspected. These tests drive the PRODUCTION composition
// the web shell uses (`withOrgSlug(orgSlug, getDocumentTypeRoute(type, slug))`),
// so an unmapped route prefix fails here instead of shipping inert pills.
describe("SessionLinkedArtifactsRow link resolution (ISS-4793)", () => {
  const ORG_SLUG = "acme";

  // The exact callback apps/app/.../sessions/[id]/page.tsx builds.
  function webBuildArtifactHref(
    artifact: SessionLinkedArtifact
  ): string | null {
    return withOrgSlug(
      ORG_SLUG,
      getDocumentTypeRoute(artifact.documentType, artifact.slug)
    );
  }

  function renderRow(artifacts: SessionLinkedArtifact[], linked: boolean) {
    return render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          buildArtifactHref={linked ? webBuildArtifactHref : undefined}
          linkedArtifacts={artifacts}
          total={artifacts.length}
        />
      </AppCoreStoryProviders>
    );
  }

  function artifact(
    slug: string,
    documentType: DocumentType | null
  ): SessionLinkedArtifact {
    return {
      id: `id-${slug}`,
      slug,
      name: `Name of ${slug}`,
      documentType,
      role: "referenced",
    };
  }

  // The four navigable document types, through the real prefix map. ISS- and FEA-
  // are both FEATURE documents and both route under /issues/ (FEA-4137).
  it.each([
    ["ISS-4544", DocumentType.Feature, "/acme/issues/ISS-4544"],
    ["FEA-4375", DocumentType.Feature, "/acme/issues/FEA-4375"],
    ["PRD-538", DocumentType.Prd, "/acme/prds/PRD-538"],
    [
      "PLN-988",
      DocumentType.ImplementationPlan,
      "/acme/implementation-plans/PLN-988",
    ],
    ["DOC-1", DocumentType.Doc, "/acme/documents/DOC-1"],
  ])("renders %s (%s) as a real <a href> to %s", (slug, documentType, expectedHref) => {
    const { container } = renderRow([artifact(slug, documentType)], true);

    const pill = container.querySelector("a.sd3-result-pr");
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute("href", expectedHref);
    // A real anchor with an href is natively keyboard-focusable and honors
    // cmd/middle-click — the acceptance criteria's "not a bare label".
    expect(pill?.tagName).toBe("A");
  });

  it("keeps an unresolvable artifact a non-link span rather than a dead link", async () => {
    // No documentType -> no route. Rendering it as an <a> would be a UI that
    // lies about being navigable.
    const user = userEvent.setup();
    const { container } = renderRow([artifact("SES-7", null)], true);

    expect(container.querySelector("a.sd3-result-pr")).toBeNull();
    const pill = container.querySelector("span.sd3-result-pr");
    expect(pill).not.toBeNull();
    // ISS-4793: the description is a DS Tooltip, not a native `title` — a
    // `title` never opens on keyboard focus or touch. The inert pill is a
    // tooltip trigger too, so its name is reachable rather than hover-only.
    expect(pill).not.toHaveAttribute("title");
    await user.hover(screen.getByText("SES-7"));
    expect(await screen.findAllByText("Name of SES-7")).not.toHaveLength(0);
  });

  // The desktop renderer omits buildArtifactHref entirely (it hosts no document
  // detail routes; see SessionDetailView.tsx). Pin that shape so a future change
  // cannot start emitting hrefs the desktop nav guard would silently drop.
  it("renders inert pills on a shell that supplies no href builder (desktop)", () => {
    const { container } = renderRow(
      [artifact("ISS-4544", DocumentType.Feature)],
      false
    );

    expect(container.querySelectorAll("a.sd3-result-pr")).toHaveLength(0);
    expect(container.querySelectorAll("span.sd3-result-pr")).toHaveLength(1);
  });

  it("gives a resolved pill an accessible name and reaches it by keyboard", async () => {
    const user = userEvent.setup();
    renderRow([artifact("ISS-4544", DocumentType.Feature)], true);

    const pill = screen.getByRole("link", { name: LINKED_ARTIFACT_SLUG_RE });
    // The description rides the DS Tooltip on the link branch too, so keyboard
    // and touch users get it — a native `title` fires for neither.
    expect(pill).not.toHaveAttribute("title");

    await user.tab();
    expect(pill).toHaveFocus();
    expect(
      await screen.findAllByText("Issue: Name of ISS-4544")
    ).not.toHaveLength(0);
  });

  // FEA-3635: the row is type-agnostic, so a linked PRD must name itself a "PRD"
  // and never inherit the "Issue" label. Moved here from the grandfathered
  // agent-session-detail-view.test.tsx along with the title -> DS Tooltip switch.
  it("names a linked PRD by its own type rather than as an issue", async () => {
    const user = userEvent.setup();
    renderRow([artifact("PRD-538", DocumentType.Prd)], true);

    await user.hover(screen.getByText("PRD-538"));
    expect(await screen.findAllByText("PRD: Name of PRD-538")).not.toHaveLength(
      0
    );
  });
});

// ISS-4897: the `+N` overflow chip was the one element in this row that revealed
// content but advertised nothing — a plain `<span>` whose tooltip opened on
// hover only, so a keyboard-only user could never reach the truncated artifacts.
// It is a real `PopoverTrigger` button now, unconditionally (ISS-5366 retired the
// gate to its enabled state), so these assertions are the regression guard: the
// chip must stay a focusable control that NAMES what it reveals and opens on
// activation rather than reverting to an inert, hover-only span.
describe("SessionLinkedArtifactsRow overflow chip (ISS-4897)", () => {
  function renderOverflowRow() {
    return render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          linkedArtifacts={linkedArtifacts(8)}
          total={8}
        />
      </AppCoreStoryProviders>
    );
  }

  it("renders the chip as a named, keyboard-reachable disclosure", async () => {
    const user = userEvent.setup();
    const { container } = renderOverflowRow();

    // The name says WHAT it reveals — "+2, button" would tell a screen-reader
    // user nothing actionable.
    const chip = screen.getByRole("button", {
      name: "Show 2 more linked artifacts",
    });
    expect(container.querySelector("button.sd3-linked-overflow")).toBe(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    // The inert span this replaced advertised nothing and was not a control at
    // all — reverting to it must fail here.
    expect(container.querySelector("span.sd3-linked-overflow")).toBeNull();

    // Reachable by keyboard, which is the whole point: hover was previously the
    // only way to see the hidden links, so keyboard and touch users had none.
    await user.tab();
    expect(chip).toHaveFocus();
  });

  // The regression this control is one primitive away from: a Radix TOOLTIP
  // trigger composes its own `onClick` that CLOSES the tooltip, so activating a
  // button named "Show 2 more linked artifacts" would dismiss the very list it
  // names — on Enter/Space for a keyboard user, and on tap for a touch user,
  // who has no hover to fall back on.
  it("opens the hidden artifacts on activation instead of dismissing them", async () => {
    const user = userEvent.setup();
    renderOverflowRow();

    const chip = screen.getByRole("button", {
      name: "Show 2 more linked artifacts",
    });
    await user.click(chip);

    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("DOC-6")).toBeInTheDocument();
    expect(screen.getByText("DOC-7")).toBeInTheDocument();
  });

  it("opens the hidden artifacts from the keyboard with Enter", async () => {
    const user = userEvent.setup();
    renderOverflowRow();

    const chip = screen.getByRole("button", {
      name: "Show 2 more linked artifacts",
    });
    chip.focus();
    await user.keyboard("{Enter}");

    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("DOC-6")).toBeInTheDocument();
  });

  it("names a single hidden artifact in the singular", () => {
    render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          linkedArtifacts={linkedArtifacts(7)}
          total={7}
        />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByRole("button", { name: "Show 1 more linked artifact" })
    ).toBeInTheDocument();
  });
});

// ISS-4898: the desktop renderer hosts no document detail routes, so its
// destination for a linked artifact is the ABSOLUTE web-app URL, which this row
// must render as an external anchor (the Electron window-open handler is what
// turns that into an OS-browser open). A root-relative href must NOT take that
// branch — the web shell relies on it staying an in-app `Link`.
describe("SessionLinkedArtifactsRow external destinations (ISS-4898)", () => {
  const ABSOLUTE_HREF = "https://app.closedloop.ai/acme/issues/ISS-4544";

  function renderWithHref(href: string | null) {
    return render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          buildArtifactHref={() => href}
          linkedArtifacts={[
            {
              documentType: DocumentType.Feature,
              id: "linked-iss-4544",
              name: "E2E: enable merge queue on main",
              role: "referenced",
              slug: "ISS-4544",
            },
          ]}
          total={1}
        />
      </AppCoreStoryProviders>
    );
  }

  it("renders an absolute href as an external anchor that opens in the browser", () => {
    const { container } = renderWithHref(ABSOLUTE_HREF);

    const pill = container.querySelector("a.sd3-result-pr");
    expect(pill).toHaveAttribute("href", ABSOLUTE_HREF);
    expect(pill).toHaveAttribute("target", "_blank");
    expect(pill).toHaveAttribute("rel", "noreferrer");
  });

  it("keeps a root-relative href an in-app link, not an external one", () => {
    const { container } = renderWithHref("/acme/issues/ISS-4544");

    const pill = container.querySelector("a.sd3-result-pr");
    expect(pill).toHaveAttribute("href", "/acme/issues/ISS-4544");
    expect(pill).not.toHaveAttribute("target");
  });

  it("keeps an unresolved artifact an inert span on either shell", () => {
    const { container } = renderWithHref(null);

    expect(container.querySelector("a.sd3-result-pr")).toBeNull();
    expect(container.querySelector("span.sd3-result-pr")).not.toBeNull();
  });
});

/**
 * ISS-5366 (#4579 stage review): the row's three settled branches are all
 * ASSERTIONS — link-colored means "this navigates", the muted inert span means
 * "this does not". A shell whose reachability inputs resolve asynchronously (the
 * desktop renderer's org slug and web-app origin both arrive over IPC) therefore
 * spent its load window making the second claim about artifacts that WERE
 * reachable, then flipped them to links. A loading state wearing the unavailable
 * state's clothes.
 *
 * `artifactHrefPending` gives that window its own rendering. These cases pin
 * that it is DISTINGUISHABLE from the settled label — otherwise the fix is
 * invisible and the row is back to asserting a falsehood.
 */
describe("SessionLinkedArtifactsRow pending reachability (ISS-5366)", () => {
  const PENDING_CLASS = "sd3-result-pr-pending";

  it("marks the pills busy instead of asserting they are unreachable", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          artifactHrefPending
          linkedArtifacts={linkedArtifacts(3)}
          total={3}
        />
      </AppCoreStoryProviders>
    );

    const pills = container.querySelectorAll(`.${PENDING_CLASS}`);
    expect(pills).toHaveLength(3);
    for (const pill of pills) {
      expect(pill.getAttribute("aria-busy")).toBe("true");
    }
    // Still not clickable — an unresolved destination must never render as a
    // link that lies. The point is that it does not render as the SETTLED
    // "not reachable" label either.
    expect(container.querySelectorAll("a.sd3-result-pr")).toHaveLength(0);
  });

  it("renders the settled inert label once the shell has resolved", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          artifactHrefPending={false}
          linkedArtifacts={linkedArtifacts(3)}
          total={3}
        />
      </AppCoreStoryProviders>
    );

    // The same three pills, now making the real claim: no destination resolved.
    expect(container.querySelectorAll(".sd3-result-pr")).toHaveLength(3);
    expect(container.querySelectorAll(`.${PENDING_CLASS}`)).toHaveLength(0);
  });

  it("prefers a resolved href over the pending treatment", () => {
    // A shell can settle one input before the other; the moment an href builds,
    // the answer is known and the pill is a link regardless of the flag.
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          artifactHrefPending
          buildArtifactHref={() => "https://app.example.com/acme/issues/ISS-1"}
          linkedArtifacts={linkedArtifacts(2)}
          total={2}
        />
      </AppCoreStoryProviders>
    );

    expect(container.querySelectorAll("a.sd3-result-pr")).toHaveLength(2);
    expect(container.querySelectorAll(`.${PENDING_CLASS}`)).toHaveLength(0);
  });

  it("defaults to the settled rendering, so a synchronous shell is unaffected", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionLinkedArtifactsRow
          linkedArtifacts={linkedArtifacts(2)}
          total={2}
        />
      </AppCoreStoryProviders>
    );

    expect(container.querySelectorAll(`.${PENDING_CLASS}`)).toHaveLength(0);
  });
});
