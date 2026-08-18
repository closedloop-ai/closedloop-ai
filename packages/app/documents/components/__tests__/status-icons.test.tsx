import {
  DOCUMENT_STATUS_OPTIONS,
  DocumentStatus,
  ISSUE_STATUS_OPTIONS,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  DOCUMENT_STATUS_LABELS,
  ISSUE_STATUS_LABELS,
} from "@repo/app/projects/lib/project-constants";
import { NO_MEASURE_DASH_COLOR } from "@repo/design-system/components/ui/internal/status-icon-shared";
import { StatusDash } from "@repo/design-system/components/ui/status-icon-primitives";
import { StatusPercentageIcon } from "@repo/design-system/components/ui/status-percentage-icon";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactStatusIcon } from "../artifact-status-icon";
import { DocumentStatusIcon } from "../document-status-icon";
import { IssueStatusIcon } from "../issue-status-icon";

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector("svg");
  if (!svg) {
    throw new Error("expected an svg to render");
  }
  return svg as SVGSVGElement;
}

describe("DocumentStatusIcon", () => {
  it("renders an svg with the status label for every DocumentStatus", () => {
    for (const status of DOCUMENT_STATUS_OPTIONS) {
      const { container } = render(<DocumentStatusIcon status={status} />);
      expect(svgOf(container).getAttribute("aria-label")).toBe(
        DOCUMENT_STATUS_LABELS[status]
      );
    }
  });

  it("renders Changes Requested, Executed and Obsolete as filled glyphs (a path), not rings", () => {
    for (const status of [
      DocumentStatus.ChangesRequested,
      DocumentStatus.Executed,
      DocumentStatus.Obsolete,
    ]) {
      const { container } = render(<DocumentStatusIcon status={status} />);
      expect(container.querySelector("path")).not.toBeNull();
    }
  });

  it("renders Approved as a full (100%) ring, not a filled glyph", () => {
    const { container } = render(
      <DocumentStatusIcon status={DocumentStatus.Approved} />
    );
    // A ring renders <circle> elements and no glyph <path>.
    expect(container.querySelector("path")).toBeNull();
    expect(container.querySelectorAll("circle").length).toBeGreaterThan(1);
  });

  it("renders Draft as an empty ring (no progress path)", () => {
    const { container } = render(
      <DocumentStatusIcon status={DocumentStatus.Draft} />
    );
    // Empty ring is a lone track <circle>, no glyph <path>.
    expect(container.querySelector("path")).toBeNull();
    expect(container.querySelectorAll("circle").length).toBe(1);
  });
});

describe("IssueStatusIcon", () => {
  it("renders an svg with the status label for every IssueStatus", () => {
    for (const status of ISSUE_STATUS_OPTIONS) {
      const { container } = render(<IssueStatusIcon status={status} />);
      expect(svgOf(container).getAttribute("aria-label")).toBe(
        ISSUE_STATUS_LABELS[status]
      );
    }
  });

  it("renders Triage, Blocked, Done and Canceled as filled glyphs", () => {
    for (const status of [
      IssueStatus.Triage,
      IssueStatus.Blocked,
      IssueStatus.Done,
      IssueStatus.Canceled,
    ]) {
      const { container } = render(<IssueStatusIcon status={status} />);
      expect(container.querySelector("path")).not.toBeNull();
    }
  });

  it("renders Backlog as a dashed ring", () => {
    const { container } = render(
      <IssueStatusIcon status={IssueStatus.Backlog} />
    );
    const track = container.querySelector("circle");
    expect(track?.getAttribute("stroke-dasharray")).toBe("3 3");
  });
});

describe("empty population vs 0% vs Backlog (ISS-4835 / ISS-4812)", () => {
  // These three marks share one 16px column in the documents table: project rows
  // carry the completion ring, issue rows sit directly beneath them carrying
  // IssueStatusIcon. Empty-population used to render the SAME dashed ring
  // Backlog does, and differed from a real 0% only by dashed-vs-solid, which is
  // a texture step the eye loses at that size. The fix separates empty by SHAPE.
  //
  // Shape is what these assertions pin, deliberately. A color or dasharray
  // assertion would go green again the moment someone reintroduced a ring for
  // the empty case with a different track tint, which is exactly the treatment
  // this pair of tickets rejected.
  const emptyMark = () =>
    render(
      <StatusPercentageIcon
        label="No documents or issues yet"
        size={16}
        value={null}
      />
    ).container;
  const zeroMark = () =>
    render(<StatusPercentageIcon size={16} value={0} />).container;
  const backlogMark = () =>
    render(<IssueStatusIcon size={16} status={IssueStatus.Backlog} />)
      .container;

  it("renders the empty population as a dash, with no ring at all", () => {
    const container = emptyMark();
    expect(container.querySelector("line")).not.toBeNull();
    expect(container.querySelector("circle")).toBeNull();
  });

  it("renders a real 0% and Backlog as rings, with no dash", () => {
    for (const container of [zeroMark(), backlogMark()]) {
      expect(container.querySelector("circle")).not.toBeNull();
      expect(container.querySelector("line")).toBeNull();
    }
  });

  it("renders three different marks for the three states at 16px", () => {
    const marks = [
      emptyMark().innerHTML,
      zeroMark().innerHTML,
      backlogMark().innerHTML,
    ];
    expect(new Set(marks).size).toBe(marks.length);
  });

  it("gives the empty mark the same box as the ring it replaces", () => {
    // The dash drops into a ring's slot, so a row must not reflow when a project
    // goes from empty to its first document.
    const empty = svgOf(emptyMark());
    const zero = svgOf(zeroMark());
    expect(empty.getAttribute("width")).toBe(zero.getAttribute("width"));
    expect(empty.getAttribute("height")).toBe(zero.getAttribute("height"));
    expect(empty.getAttribute("viewBox")).toBe(zero.getAttribute("viewBox"));
  });

  it("names the empty mark, since a bare dash carries no meaning on its own", () => {
    expect(svgOf(emptyMark()).getAttribute("aria-label")).toBe(
      "No documents or issues yet"
    );
    expect(svgOf(emptyMark()).getAttribute("role")).toBe("img");
  });
});

describe("StatusDash color prop", () => {
  // Review follow-up: StatusRing takes `color` and FilledStatusCircle takes
  // `fill`, but StatusDash hardcoded its stroke, so the next caller needing a
  // different tone would have hand-rolled a second `<line>` beside this one.
  function lineOf(container: HTMLElement): SVGLineElement {
    const line = container.querySelector("line");
    if (!line) {
      throw new Error("expected a line to render");
    }
    return line as SVGLineElement;
  }

  it("defaults to the muted no-measure tone", () => {
    const { container } = render(<StatusDash label="Nothing to measure" />);
    expect(lineOf(container).getAttribute("stroke")).toBe(
      NO_MEASURE_DASH_COLOR
    );
  });

  it("honors an explicit tone without changing the mark's shape or box", () => {
    const { container } = render(
      <StatusDash color="var(--destructive)" label="Nothing to measure" />
    );
    expect(lineOf(container).getAttribute("stroke")).toBe("var(--destructive)");
    // Still a dash in the same slot - the tone is the only delta.
    expect(container.querySelector("circle")).toBeNull();
    expect(svgOf(container).getAttribute("viewBox")).toBe(
      svgOf(
        render(<StatusDash label="Nothing to measure" />).container
      ).getAttribute("viewBox")
    );
  });

  it("does not leak the tone onto the svg as a color attribute", () => {
    // `color` is Omit-ed from the spread SVG attributes, so it drives the
    // stroke only and never lands on the element as an inherited color.
    const { container } = render(
      <StatusDash color="var(--destructive)" label="Nothing to measure" />
    );
    expect(svgOf(container).getAttribute("color")).toBeNull();
  });
});

describe("ArtifactStatusIcon", () => {
  it("renders the Feature form for a feature-only status", () => {
    const { container } = render(
      <ArtifactStatusIcon status={IssueStatus.Triage} />
    );
    expect(svgOf(container).getAttribute("aria-label")).toBe(
      ISSUE_STATUS_LABELS[IssueStatus.Triage]
    );
  });

  it("renders the Document form for a document-only status", () => {
    const { container } = render(
      <ArtifactStatusIcon status={DocumentStatus.Approved} />
    );
    expect(svgOf(container).getAttribute("aria-label")).toBe(
      DOCUMENT_STATUS_LABELS[DocumentStatus.Approved]
    );
  });

  it("renders IN_REVIEW canonically (the same node for both vocabularies)", () => {
    const asDoc = render(
      <ArtifactStatusIcon status={DocumentStatus.InReview} />
    ).container.innerHTML;
    const asFeature = render(
      <ArtifactStatusIcon status={IssueStatus.InReview} />
    ).container.innerHTML;
    expect(asDoc).toBe(asFeature);
  });

  it("renders a neutral marker (not a mislabeled 'Draft') for an unrecognized status", () => {
    // Branch/session status-group headers pass GitHubPRState / harness strings.
    const { container } = render(
      <ArtifactStatusIcon status={"MERGED" as never} />
    );
    const label = svgOf(container).getAttribute("aria-label");
    expect(label).not.toBe("Draft");
    expect(label).toBe("Status");
  });
});
