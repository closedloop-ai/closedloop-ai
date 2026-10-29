import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";
import {
  resolveSessionIssueChips,
  SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID,
  sessionLinkedChipsTrackTestId,
} from "../session-linked-entity-chips";

function makeLinkedArtifact(
  overrides: Partial<SessionLinkedArtifact> = {}
): SessionLinkedArtifact {
  return {
    id: "artifact-1",
    slug: "ISS-1234",
    name: "Fix the thing",
    documentType: DocumentType.Feature,
    role: "referenced",
    ...overrides,
  };
}

describe("resolveSessionIssueChips", () => {
  it("returns no chips when the session has no linked artifacts", () => {
    const item = createAgentSessionListItemFixture({ linkedArtifacts: [] });

    expect(resolveSessionIssueChips(item)).toEqual([]);
  });

  it("returns no chips when linkedArtifacts is undefined", () => {
    const item = createAgentSessionListItemFixture({});
    Reflect.deleteProperty(
      item as unknown as Record<string, unknown>,
      "linkedArtifacts"
    );

    expect(resolveSessionIssueChips(item)).toEqual([]);
  });

  it("includes a Feature-typed linked artifact as an issue chip", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [
        makeLinkedArtifact({
          id: "artifact-1",
          slug: "ISS-1234",
          name: "ISS-1234",
          documentType: DocumentType.Feature,
        }),
      ],
    });

    expect(resolveSessionIssueChips(item)).toEqual([
      { key: "artifact-1", label: "ISS-1234", href: null, title: null },
    ]);
  });

  it("excludes a linked artifact whose document type is not Feature", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [makeLinkedArtifact({ documentType: DocumentType.Prd })],
    });

    expect(resolveSessionIssueChips(item)).toEqual([]);
  });

  it("dedupes repeated links to the same artifact id, keeping one chip", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [
        makeLinkedArtifact({ id: "artifact-1", role: "input" }),
        makeLinkedArtifact({ id: "artifact-1", role: "workspace" }),
      ],
    });

    expect(resolveSessionIssueChips(item)).toHaveLength(1);
  });

  it("falls back to the artifact name when the slug is null", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [
        makeLinkedArtifact({ slug: null, name: "Fix the thing" }),
      ],
    });

    expect(resolveSessionIssueChips(item)[0]?.label).toBe("Fix the thing");
  });

  it("skips an artifact with neither a slug nor a name", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [makeLinkedArtifact({ slug: null, name: null })],
    });

    expect(resolveSessionIssueChips(item)).toEqual([]);
  });

  it("sets the tooltip title to the name only when it differs from the label", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [
        makeLinkedArtifact({ slug: "ISS-1234", name: "Fix the thing" }),
      ],
    });

    expect(resolveSessionIssueChips(item)[0]?.title).toBe("Fix the thing");
  });

  it("omits the tooltip title when the name equals the label", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [
        makeLinkedArtifact({ slug: "ISS-1234", name: "ISS-1234" }),
      ],
    });

    expect(resolveSessionIssueChips(item)[0]?.title).toBeNull();
  });

  it("builds an href from the supplied buildHref callback", () => {
    const artifact = makeLinkedArtifact({ id: "artifact-1", slug: "ISS-1234" });
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [artifact],
    });

    const chips = resolveSessionIssueChips(
      item,
      (linked) => `/issues/${linked.slug}`
    );

    expect(chips[0]?.href).toBe("/issues/ISS-1234");
  });

  it("renders an inert chip (null href) when buildHref itself returns null", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [makeLinkedArtifact()],
    });

    const chips = resolveSessionIssueChips(item, () => null);

    expect(chips[0]?.href).toBeNull();
  });

  it("renders an inert chip (null href) when no buildHref is supplied", () => {
    const item = createAgentSessionListItemFixture({
      linkedArtifacts: [makeLinkedArtifact()],
    });

    expect(resolveSessionIssueChips(item)[0]?.href).toBeNull();
  });
});

describe("sessionLinkedChipsTrackTestId", () => {
  it("derives the track test id from the overflow test id", () => {
    expect(
      sessionLinkedChipsTrackTestId(SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID)
    ).toBe(`${SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID}-track`);
  });
});
