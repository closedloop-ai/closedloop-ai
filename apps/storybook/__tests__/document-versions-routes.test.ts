/**
 * The Issue Detail and PRD Detail stories' `POST /documents/:id/versions`
 * fixtures echo a saved version back. No story saves without content, so each
 * route's body handling is driven here by calling its `respond` directly.
 */
import type { DocumentDetail } from "@repo/api/src/types/document";
import type {
  FixtureRequestContext,
  FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { describe, expect, it } from "vitest";
import issueDetailMeta from "../stories/surfaces/issue-detail.stories";
import prdDetailMeta from "../stories/surfaces/prd-detail.stories";

type SurfaceMeta = {
  args: { document: DocumentDetail };
  parameters: { appCore: unknown };
};

const SURFACES: ReadonlyArray<readonly [string, SurfaceMeta]> = [
  ["Issue Detail", issueDetailMeta as unknown as SurfaceMeta],
  ["PRD Detail", prdDetailMeta as unknown as SurfaceMeta],
];

function saverFor(meta: SurfaceMeta) {
  const doc = meta.args.document;
  const path = `/documents/${doc.id}/versions`;
  const routes = (meta.parameters.appCore as { apiRoutes: FixtureRoute[] })
    .apiRoutes;
  const route = routes.find((r) => r.method === "POST" && r.path === path);
  if (!route) {
    throw new Error(`no POST ${path} route`);
  }
  return (body: unknown) =>
    route.respond({
      pathname: path,
      search: "",
      searchParams: new URLSearchParams(),
      method: "POST",
      body,
    } as FixtureRequestContext) as DocumentDetail;
}

describe.each(SURFACES)("%s POST versions fixture", (_name, meta) => {
  const doc = meta.args.document;
  const save = saverFor(meta);

  it("stores the submitted content as the next version", () => {
    const saved = save({ content: "# Rewritten" });
    expect(saved.latestVersion).toBe(doc.latestVersion + 1);
    expect(saved.latestVersionContent).toBe("# Rewritten");
    expect(saved.version?.content).toBe("# Rewritten");
    expect(saved.version?.id).toBe(`${doc.id}-v${doc.latestVersion + 1}`);
    expect(saved.version?.version).toBe(doc.latestVersion + 1);
  });

  it("keeps the current content when the body carries none", () => {
    const saved = save({});
    expect(saved.latestVersionContent).toBe(doc.latestVersionContent);
    expect(saved.version?.content).toBe(doc.version?.content);
    expect(saved.latestVersion).toBe(doc.latestVersion + 1);
  });

  it("keeps the current content when the body is missing", () => {
    const saved = save(undefined);
    expect(saved.latestVersionContent).toBe(doc.latestVersionContent);
    expect(saved.version?.content).toBe(doc.version?.content);
  });
});
