// @vitest-environment jsdom

/**
 * ISS-10479. Hiding the date picker used to leave the shell initializing,
 * applying, persisting and serializing `range`, so a project collection could
 * arrive filtered by a window with no control on screen to see or clear it.
 *
 * Every case below is a PAIR on one mechanism: the surface that declares no
 * date dimension, and the surface that declares one, driven through the same
 * production entry point. Without the second half, "the rows are unfiltered"
 * would be satisfied by a render that never mounted the filter at all.
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { genericArtifacts } from "../../fixtures";
import {
  artifactDateComparisonLabel,
  withinArtifactDateDimension,
} from "../artifact-date-dimension";
import { initialArtifactFilters } from "../artifact-list-model";
import { buildInitialSavedViews } from "../artifact-saved-views";
import { GenericArtifactListShell } from "../artifact-shells";

/**
 * Every case that mounts the whole shell renders the full list, toolbar and
 * five summary cards; the date-less half renders MORE rows than the windowed
 * half, so it is the slowest and the first to cross a default budget on a
 * loaded box. An explicit ceiling keeps a red here meaning "the behaviour
 * regressed", never "the machine was busy".
 */
const SHELL_RENDER_TIMEOUT_MS = 30_000;

const template = genericArtifacts[0]!;

const RECENT_TITLE = "Edited an hour ago";
const STALE_TITLE = "Edited one hundred days ago";

const ROWS = [
  {
    ...template,
    id: "recent",
    parentArtifactId: null,
    slug: "RECENT",
    title: RECENT_TITLE,
    updatedAgoMinutes: 60,
  },
  {
    ...template,
    id: "stale",
    parentArtifactId: null,
    slug: "STALE",
    title: STALE_TITLE,
    updatedAgoMinutes: 100 * 24 * 60,
  },
];

function renderShell(search: string, hasDateDimension?: boolean) {
  window.history.replaceState({}, "", `/p/generic-artifact${search}`);
  const { container } = render(
    <GenericArtifactListShell
      artifacts={ROWS}
      hasDateDimension={hasDateDimension}
      onOpenArtifact={() => undefined}
    />
  );
  return container.textContent ?? "";
}

beforeEach(() => {
  window.history.replaceState({}, "", "/p/generic-artifact");
});

describe("artifact list date dimension — initialize", () => {
  it(
    "applies no window at all when the surface declares no dimension",
    () => {
      const rendered = renderShell("", false);

      expect(rendered).toContain(STALE_TITLE);
      expect(rendered).toContain(RECENT_TITLE);
    },
    SHELL_RENDER_TIMEOUT_MS
  );

  it(
    "still initializes the 30-day default when the surface has one",
    () => {
      const rendered = renderShell("");

      expect(rendered).not.toContain(STALE_TITLE);
      expect(rendered).toContain(RECENT_TITLE);
    },
    SHELL_RENDER_TIMEOUT_MS
  );
});

describe("artifact list date dimension — apply an inbound URL", () => {
  it(
    "ignores a range the URL carries when the surface has no dimension",
    () => {
      const rendered = renderShell("?range=7d", false);

      expect(rendered).toContain(STALE_TITLE);
    },
    SHELL_RENDER_TIMEOUT_MS
  );

  it(
    "still applies a range the URL carries when the surface has one",
    () => {
      const rendered = renderShell("?range=7d");

      expect(rendered).not.toContain(STALE_TITLE);
      expect(rendered).toContain(RECENT_TITLE);
    },
    SHELL_RENDER_TIMEOUT_MS
  );
});

describe("artifact list date dimension — the presentational alias", () => {
  it(
    "treats a hidden picker as no dimension, not as a hidden window",
    () => {
      window.history.replaceState({}, "", "/p/generic-artifact?range=7d");
      const { container } = render(
        <GenericArtifactListShell
          artifacts={ROWS}
          onOpenArtifact={() => undefined}
          showDateRangeControl={false}
        />
      );

      expect(container.textContent).toContain(STALE_TITLE);
    },
    SHELL_RENDER_TIMEOUT_MS
  );
});

describe("artifact list date dimension — persist through saved views", () => {
  const seed = (present: boolean) =>
    buildInitialSavedViews({
      columnIds: ["name"],
      dateDimension: present
        ? { present: true, range: "30d", setRange: () => undefined }
        : { present: false },
      initialFilters: initialArtifactFilters,
      metricKeys: [],
      statuses: { active: template.status, inReview: template.status },
    });

  it("seeds no range into any view when the surface has no dimension", () => {
    // `Needs team review` is the reachable one: it seeds 90d, so restoring it
    // on a project collection used to narrow the list with nothing on screen.
    expect(seed(false).map((view) => view.state.dateRange)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("still seeds the shipped ranges when the surface has one", () => {
    expect(seed(true).map((view) => view.state.dateRange)).toEqual([
      "30d",
      "30d",
      "90d",
      "30d",
    ]);
  });
});

describe("artifact list date dimension — derived helpers", () => {
  it("keeps every row when there is no dimension to measure against", () => {
    expect(withinArtifactDateDimension({ present: false }, 100 * 24 * 60)).toBe(
      true
    );
  });

  it("names no window in the summary delta when there is no dimension", () => {
    // A delta is still measured; claiming it spans 30 days would not be.
    expect(artifactDateComparisonLabel({ present: false })).toBe(
      "vs. prior period"
    );
  });

  it("still names the active window when there is one", () => {
    expect(
      artifactDateComparisonLabel({
        present: true,
        range: "7d",
        setRange: () => undefined,
      })
    ).toBe("vs. prior 7 days");
  });
});

/**
 * Decision 5 of the ISS-10479 record, and the one most likely to be undone by
 * a later well-meant tidy: the summary delta is STILL measured and STILL
 * rendered on a surface with no date dimension. Only the window CLAIM beside
 * it is dropped. Suppressing the card, blanking the number, or gating the
 * slot off would delete a value whose operands are all present.
 */
describe("artifact list date dimension — the delta survives its window", () => {
  it(
    "still renders the delta, captioned without a window, when there is none",
    () => {
      const rendered = renderShell("", false);

      expect(rendered).toContain("vs. prior period");
      expect(rendered).not.toContain("vs. prior 30 days");
      expect(rendered).toContain("Artifacts created");
      expect(rendered).toContain("12%");
    },
    SHELL_RENDER_TIMEOUT_MS
  );

  it(
    "still names the window when the surface has one",
    () => {
      const rendered = renderShell("");

      expect(rendered).toContain("vs. prior 30 days");
      expect(rendered).toContain("Artifacts created");
      expect(rendered).toContain("12%");
    },
    SHELL_RENDER_TIMEOUT_MS
  );
});
