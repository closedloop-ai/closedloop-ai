/**
 * ISS-8712: the Sessions list's `Tags` column — the org tag vocabulary applied to
 * a session's Artifact.
 *
 * Two contracts, and they are deliberately separate: WHETHER the column renders
 * (a build gate AND a mount seam, both required) and WHAT the cell says once it
 * does (which depends on whether the producer loaded the relation at all).
 */

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  ArtifactTagAvailability,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { SESSIONS_TAGS_COLUMN_ID } from "../../../lib/sessions-table-columns";
import { SessionsTable } from "../session-detail-table";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionTagsCell } from "../session-tags-cell";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const EDIT_TAGS_TRIGGER_PATTERN = /tags for Session One/i;
const TAG_ALPHA_OPTION_PATTERN = /alpha/i;
const TAG_BETA_OPTION_PATTERN = /beta/i;

const TAG_ALPHA = { id: "tag-alpha", name: "alpha", color: TagColor.Blue };
const TAG_BETA = { id: "tag-beta", name: "beta", color: TagColor.Green };
const TAG_GAMMA = { id: "tag-gamma", name: "gamma", color: TagColor.Amber };
const EDIT_TAGS_LABEL = "Edit tags for Session One";

function renderName(row: SessionTableRow, className: string) {
  return <span className={className}>{row.name}</span>;
}

function renderedHeaderIds(): string[] {
  return screen
    .getAllByRole("columnheader")
    .map((cell) => cell.getAttribute("data-column-id"))
    .filter((id): id is string => Boolean(id));
}

/** A stand-in seam, so these cases test the GATE rather than the picker. */
function renderStubTags() {
  return <span>tags-seam</span>;
}

function renderTable(
  props: { renderTags?: (row: SessionTableRow) => ReactNode },
  flagOn: boolean
) {
  const row = createSessionTableRowFixture({ status: "Working" });
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn ? [SESSIONS_ARTIFACT_TAGS_FEATURE_FLAG_KEY] : [],
      })}
    >
      <SessionsTable
        items={[row]}
        mode="expanded"
        renderName={renderName}
        // Every column is renderable here, so the Tags column's absence below
        // can only be the gate or the seam — never a narrowed view.
        {...props}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("the Tags column needs BOTH its gate and its seam (ISS-8712)", () => {
  it("does not render it when the flag is off, even though the host wired the seam", () => {
    renderTable({ renderTags: renderStubTags }, false);
    expect(renderedHeaderIds()).not.toContain(SESSIONS_TAGS_COLUMN_ID);
    // And not because nothing rendered — the ungated columns are still there.
    expect(renderedHeaderIds()).toContain("status");
    expect(screen.queryByText("tags-seam")).not.toBeInTheDocument();
  });

  it("does not render it when the flag is on but no host wired the seam", () => {
    renderTable({}, true);
    expect(renderedHeaderIds()).not.toContain(SESSIONS_TAGS_COLUMN_ID);
    expect(renderedHeaderIds()).toContain("status");
  });

  it("renders it in the prototype's slot when both hold", () => {
    renderTable({ renderTags: renderStubTags }, true);
    const headers = renderedHeaderIds();
    expect(headers).toContain(SESSIONS_TAGS_COLUMN_ID);
    // Slot 2, immediately after Status — the approved contract's order, so this
    // fails if the column lands anywhere else rather than merely existing.
    expect(headers.indexOf(SESSIONS_TAGS_COLUMN_ID)).toBe(
      headers.indexOf("status") + 1
    );
    expect(screen.getByText("tags-seam")).toBeInTheDocument();
  });
});

/**
 * The shared app harness, not a bare render: the cell mounts the real
 * `TagPicker`, which needs the auth + query + API seams. That requirement is
 * exactly why the column is seam-required rather than rendered by the
 * presentational table itself.
 */
function renderCell(row: SessionTableRow) {
  return render(
    <AppCoreStoryProviders>
      <SessionTagsCell row={row} />
    </AppCoreStoryProviders>
  );
}

describe("the Tags cell distinguishes unavailable from empty (ISS-8712)", () => {
  it("renders no picker when the producer never loaded the relation", () => {
    const { container } = renderCell(
      createSessionTableRowFixture({ name: "Session One" })
    );
    // No control at all: offering "Add tag" here would state that this session
    // has none, which this render never established.
    expect(
      screen.queryByRole("button", { name: EDIT_TAGS_TRIGGER_PATTERN })
    ).not.toBeInTheDocument();
    expect(container.textContent).toContain("—");
  });

  it("omits the unavailable marker when the narrow identity row owns the slot", () => {
    const { container } = render(
      <AppCoreStoryProviders>
        <SessionTagsCell
          row={createSessionTableRowFixture({ name: "Session One" })}
          showUnavailable={false}
        />
      </AppCoreStoryProviders>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the picker for a loaded-but-empty relation", () => {
    renderCell(
      createSessionTableRowFixture({
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [],
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    expect(
      screen.getByRole("button", { name: "Edit tags for Session One" })
    ).toBeInTheDocument();
  });

  it("names every applied tag in text, never by colour alone", () => {
    renderCell(
      createSessionTableRowFixture({
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA, TAG_BETA],
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    // WCAG 1.4.1: the chip's meaning is its NAME. A chip carrying only a hue
    // would pass a "two chips rendered" count and fail this.
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    // The trigger keeps an accessible name once it collapses to a bare glyph.
    expect(
      screen.getByRole("button", { name: EDIT_TAGS_LABEL })
    ).toBeInTheDocument();
  });

  /**
   * ISS-9215. The case above proves the names are SOMEWHERE on screen, which
   * the defect satisfied: the picker rendered its own chips as siblings of a
   * trigger that had collapsed to a bare glyph, so a "names are present" assert
   * stayed green while the cell told the reader nothing about which control
   * edits what. These pin the two properties that assert actually cared about —
   * the chips are the trigger's own content, and the row cannot grow without
   * bound.
   */
  it("renders the applied chips inside the row's own editor trigger", () => {
    renderCell(
      createSessionTableRowFixture({
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA, TAG_BETA],
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    const trigger = screen.getByRole("button", { name: EDIT_TAGS_LABEL });
    expect(within(trigger).getByText("alpha")).toBeInTheDocument();
    expect(within(trigger).getByText("beta")).toBeInTheDocument();
  });

  it("caps the inline chips and names the overflow rather than growing the row", () => {
    renderCell(
      createSessionTableRowFixture({
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA, TAG_BETA, TAG_GAMMA],
        tagPermissions: { canApply: true, canRemove: true },
      })
    );
    const trigger = screen.getByRole("button", { name: EDIT_TAGS_LABEL });
    expect(within(trigger).getByText("+1")).toBeInTheDocument();
    // The capped tag is still reachable — the overflow indicator names it in a
    // tooltip rather than dropping it.
    expect(within(trigger).getByText("gamma")).toBeInTheDocument();
  });

  it("renders chips and NO editor when the reader can neither apply nor remove", () => {
    const { container } = renderCell(
      createSessionTableRowFixture({
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA],
        tagPermissions: { canApply: false, canRemove: false },
      })
    );
    expect(screen.getByText("alpha")).toBeInTheDocument();
    // A picker that can apply nothing and remove nothing is a control that
    // opens and does nothing.
    expect(
      container.querySelector("button[data-slot='popover-trigger']")
    ).not.toBeInTheDocument();
  });

  /**
   * ISS-9215 moved removal off an inline `×` on the chip and into the picker's
   * `Applied` group, which is where Branches — the shape this cell now shares —
   * has always put it: a chip that is the trigger's own content cannot also
   * carry a nested button. So the grant is asserted where it is now spent.
   */
  it("offers no remove affordance when the caller may not remove", async () => {
    const user = userEvent.setup();
    renderCellWithTransport(
      createSessionTableRowFixture({
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA],
        tagPermissions: { canApply: true, canRemove: false },
      }),
      []
    );
    // The tag is still NAMED — a reader who cannot remove it can still see it.
    expect(screen.getByText("alpha")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: EDIT_TAGS_LABEL }));

    expect(
      await screen.findByRole("button", { name: TAG_ALPHA_OPTION_PATTERN })
    ).toBeDisabled();
  });

  it("offers the remove affordance when the caller may remove", async () => {
    const user = userEvent.setup();
    renderCellWithTransport(
      createSessionTableRowFixture({
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA],
        tagPermissions: { canApply: true, canRemove: true },
      }),
      []
    );

    await user.click(screen.getByRole("button", { name: EDIT_TAGS_LABEL }));

    expect(
      await screen.findByRole("button", { name: TAG_ALPHA_OPTION_PATTERN })
    ).toBeEnabled();
  });

  it("treats absent permissions as no grant, not as full access", () => {
    const { container } = renderCell(
      createSessionTableRowFixture({
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA],
      })
    );
    // No permissions reported is no grant, so no editor is offered at all —
    // and the tag stays readable.
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(
      container.querySelector("button[data-slot='popover-trigger']")
    ).not.toBeInTheDocument();
  });
});

/**
 * ISS-8712 (davetho review): the cell's WRITE, driven end to end through the
 * real `TagPicker` and the real `useApplyTag`/`useRemoveTag` mutations against
 * the harness transport.
 *
 * The cases above prove the column renders and what it says; none of them ever
 * pressed a control. That left the three things this surface is newly
 * responsible for unasserted — the entity TYPE it writes as, the entity ID it
 * writes against (a Session row's `id` IS its Artifact id, which is the whole
 * reason this needs no new endpoint), and whether the write reaches the API at
 * all. Each is a way "a broken Session artifact ID" ships behind green tests.
 *
 * The routes below are registered EXPLICITLY rather than leaning on the
 * harness's unmatched-route default, which resolves every request to a generic
 * success: under that default a picker that posted to the wrong path, with the
 * wrong body, would still look like it worked. The request is captured and
 * asserted from the test body after an awaited settle, never inside the
 * responder, so a write that never happens fails on the length assertion
 * instead of silently skipping an assertion that lives in a callback.
 */
const SESSION_ARTIFACT_ID = "019f0fcb-8336-7c4d-9f64-528fb9520c32";

function renderCellWithTransport(
  row: SessionTableRow,
  captured: FixtureRequestContext[]
) {
  return render(
    <AppCoreStoryProviders
      apiRoutes={[
        { method: "GET", path: "/tags", respond: () => [TAG_ALPHA, TAG_BETA] },
        {
          method: "POST",
          path: "/entity-tags",
          respond: (context) => {
            captured.push(context);
            return { applied: true };
          },
        },
        {
          method: "DELETE",
          path: "/entity-tags",
          respond: (context) => {
            captured.push(context);
            return { removed: true };
          },
        },
      ]}
    >
      <SessionTagsCell row={row} />
    </AppCoreStoryProviders>
  );
}

describe("the Tags cell writes against the row's own Session artifact (ISS-8712)", () => {
  it("applies a tag as an ARTIFACT keyed on the row's artifact id", async () => {
    const captured: FixtureRequestContext[] = [];
    const user = userEvent.setup();
    renderCellWithTransport(
      createSessionTableRowFixture({
        id: SESSION_ARTIFACT_ID,
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [],
        tagPermissions: { canApply: true, canRemove: true },
      }),
      captured
    );

    await user.click(
      screen.getByRole("button", { name: "Edit tags for Session One" })
    );
    await user.click(
      await screen.findByRole("button", { name: TAG_ALPHA_OPTION_PATTERN })
    );

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.body).toEqual({
      tagId: TAG_ALPHA.id,
      entityType: TagEntityType.Artifact,
      entityId: SESSION_ARTIFACT_ID,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });

  it("removes an applied tag against the same artifact id", async () => {
    const captured: FixtureRequestContext[] = [];
    const user = userEvent.setup();
    renderCellWithTransport(
      createSessionTableRowFixture({
        id: SESSION_ARTIFACT_ID,
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA],
        tagPermissions: { canApply: true, canRemove: true },
      }),
      captured
    );

    await user.click(screen.getByRole("button", { name: EDIT_TAGS_LABEL }));
    await user.click(
      await screen.findByRole("button", { name: TAG_ALPHA_OPTION_PATTERN })
    );

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]?.method).toBe("DELETE");
    // The removal rides the query string, so the id is asserted there rather
    // than on a body this request does not carry.
    expect(captured[0]?.searchParams.get("entityId")).toBe(SESSION_ARTIFACT_ID);
    expect(captured[0]?.searchParams.get("entityType")).toBe(
      TagEntityType.Artifact
    );
    expect(captured[0]?.searchParams.get("tagId")).toBe(TAG_ALPHA.id);
  });

  it("issues no write at all when the caller may not apply", () => {
    const captured: FixtureRequestContext[] = [];
    const { container } = renderCellWithTransport(
      createSessionTableRowFixture({
        id: SESSION_ARTIFACT_ID,
        name: "Session One",
        tagAvailability: ArtifactTagAvailability.Available,
        tags: [TAG_ALPHA],
        tagPermissions: { canApply: false, canRemove: false },
      }),
      captured
    );

    // ISS-9215 changed what this case RENDERS, and the change is why the drive
    // is gone: a reader who may neither apply nor remove used to be handed the
    // picker anyway, and this test walked them through opening it to find
    // nothing pressable inside. There is now no editor to open, which is the
    // stronger guarantee — no control that appears and does nothing — so what
    // is asserted is the absent trigger plus the still-readable chip, both
    // rendered states rather than timing windows.
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove alpha" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: EDIT_TAGS_LABEL })
    ).not.toBeInTheDocument();
    expect(
      container.querySelector("button[data-slot='popover-trigger']")
    ).not.toBeInTheDocument();
    expect(screen.queryByText(TAG_BETA_OPTION_PATTERN)).not.toBeInTheDocument();
    expect(captured).toHaveLength(0);
  });
});
