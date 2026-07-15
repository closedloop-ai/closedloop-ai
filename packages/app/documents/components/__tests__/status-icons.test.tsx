import {
  DOCUMENT_STATUS_OPTIONS,
  DocumentStatus,
  FEATURE_STATUS_OPTIONS,
  FeatureStatus,
} from "@repo/api/src/types/document";
import {
  DOCUMENT_STATUS_LABELS,
  FEATURE_STATUS_LABELS,
} from "@repo/app/projects/lib/project-constants";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArtifactStatusIcon } from "../artifact-status-icon";
import { DocumentStatusIcon } from "../document-status-icon";
import { FeatureStatusIcon } from "../feature-status-icon";

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

describe("FeatureStatusIcon", () => {
  it("renders an svg with the status label for every FeatureStatus", () => {
    for (const status of FEATURE_STATUS_OPTIONS) {
      const { container } = render(<FeatureStatusIcon status={status} />);
      expect(svgOf(container).getAttribute("aria-label")).toBe(
        FEATURE_STATUS_LABELS[status]
      );
    }
  });

  it("renders Triage, Blocked, Done and Canceled as filled glyphs", () => {
    for (const status of [
      FeatureStatus.Triage,
      FeatureStatus.Blocked,
      FeatureStatus.Done,
      FeatureStatus.Canceled,
    ]) {
      const { container } = render(<FeatureStatusIcon status={status} />);
      expect(container.querySelector("path")).not.toBeNull();
    }
  });

  it("renders Backlog as a dashed ring", () => {
    const { container } = render(
      <FeatureStatusIcon status={FeatureStatus.Backlog} />
    );
    const track = container.querySelector("circle");
    expect(track?.getAttribute("stroke-dasharray")).toBe("3 3");
  });
});

describe("ArtifactStatusIcon", () => {
  it("renders the Feature form for a feature-only status", () => {
    const { container } = render(
      <ArtifactStatusIcon status={FeatureStatus.Triage} />
    );
    expect(svgOf(container).getAttribute("aria-label")).toBe(
      FEATURE_STATUS_LABELS[FeatureStatus.Triage]
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
      <ArtifactStatusIcon status={FeatureStatus.InReview} />
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
