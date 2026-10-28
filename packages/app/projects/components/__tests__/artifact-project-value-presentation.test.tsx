/**
 * ISS-12454 — the three boxes one Project control wears, and why the grid ones
 * differ from the Details one.
 *
 * `ArtifactProjectValue` shipped for a Details ROW. Mounting it in a grid track
 * exposed a box that is wrong there in a way no behavioural test would notice:
 * `INLINE_CELL_TRIGGER_CLASSES` carries `shrink-0` and the Details bundle adds
 * `w-auto`, so the trigger sizes to its text and refuses to shrink — a long
 * project name then paints out of its grid area over the next column instead of
 * ellipsising, because nothing between the cell and the span constrains a width.
 * The design pass caught it in source; this file is what stops it coming back.
 *
 * What this file CANNOT settle: jsdom neither lays out nor applies a stylesheet,
 * so none of these classes has an observable effect here and no claim is made
 * that the name visibly ellipsises. These are the class contracts the rendered
 * behaviour rests on, asserted as exact tokens so a substring could not let
 * `shrink-0` satisfy `shrink`.
 */

import {
  ArtifactProjectPresentation,
  ArtifactProjectValue,
} from "@repo/app/projects/components/artifact-project-value";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_NAME = "Platform Core Infrastructure and Developer Tooling";
const WHITESPACE_PATTERN = /\s+/;

describe("ArtifactProjectValue — the trigger's box per presentation", () => {
  it("lets a grid cell's trigger shrink, so its name can ellipsise", () => {
    const classes = triggerClasses(ArtifactProjectPresentation.Cell);

    // The two that make `truncate` reachable at all.
    expect(classes).toContain("min-w-0");
    expect(classes).toContain("max-w-full");
    // And the two that made it unreachable. `shrink-0` is the one
    // INLINE_CELL_TRIGGER_CLASSES contributes, so it has to be overridden, not
    // merely left unsaid.
    expect(classes).not.toContain("shrink-0");
    expect(classes).not.toContain("w-auto");
  });

  it("keeps the Details row on the box it shipped with", () => {
    // The control is shared with two Details hosts, and ISS-12454 is a LIST
    // ticket: a presentation change that silently reshaped those rows would be
    // scope this ticket never had.
    const classes = triggerClasses(ArtifactProjectPresentation.Details);

    expect(classes).toContain("w-auto");
    expect(classes).toContain("h-auto");
  });

  it("keeps the card's trigger at a touch height", () => {
    // Below the card breakpoint the card list IS the surface and the input is a
    // thumb. `h-auto` collapses the Button's own height to roughly a line box,
    // which is why the card arm alone does not pass it.
    const classes = triggerClasses(ArtifactProjectPresentation.Card);

    expect(classes).not.toContain("h-auto");
    expect(classes).toContain("min-w-0");
  });

  it("drops the folder glyph in a grid cell, so the field reads the same either way", () => {
    // The read-only twin of this field is bare `CellText`. A glyph only on the
    // writable shape makes one field look like two depending on access, and
    // restates a column already headed "Owning project" on every row.
    renderValue(ArtifactProjectPresentation.Cell);
    expect(iconCount()).toBe(0);

    screen.getByRole("combobox");
  });

  it("keeps the folder glyph on the Details row", () => {
    // The counterfactual that stops the case above passing on a picker that had
    // simply stopped drawing its icon anywhere.
    renderValue(ArtifactProjectPresentation.Details);
    expect(iconCount()).toBe(1);
  });
});

function renderValue(presentation: ArtifactProjectPresentation): void {
  render(
    <AppCoreStoryProviders
      apiRoutes={[{ method: "GET", path: "/projects", respond: () => [] }]}
    >
      <ArtifactProjectValue
        artifactId={ARTIFACT_ID}
        presentation={presentation}
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
      />
    </AppCoreStoryProviders>
  );
}

/** The trigger's classes as exact tokens — a substring match would be weaker. */
function triggerClasses(
  presentation: ArtifactProjectPresentation
): readonly string[] {
  renderValue(presentation);
  return screen.getByRole("combobox").className.split(WHITESPACE_PATTERN);
}

/** Lucide renders an `svg`; the trigger's only one would be the folder. */
function iconCount(): number {
  return screen.getByRole("combobox").querySelectorAll("svg").length;
}
