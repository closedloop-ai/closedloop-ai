/**
 * ISS-5518: the Agents component-detail route carries a human-readable identity.
 *
 * On a content-hash route — which `routableKey` makes the DEFAULT shape for
 * every component with a captured definition — the last crumb rendered the
 * literal string "Agent" and the browser tab the static "Agent Detail", so two
 * navigated-to agents were indistinguishable from their trail.
 *
 * `agentBreadcrumbLabel` has accepted a `resolvedName` since FEA-4335 and its
 * docstring claims "the page passes the resolved `component.name` when it has
 * one" — no production caller ever did, because the only caller was the route's
 * Server Component. A unit test on the helper cannot catch that: the helper is
 * correct, the wiring was missing. So these assertions drive the real component
 * and read the crumb the `Header` was actually handed.
 */
import { AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetailHeader } from "../agent-detail-header";

const { detailMock, featureFlagEnabledMock, headerMock } = vi.hoisted(() => ({
  detailMock: vi.fn(),
  featureFlagEnabledMock: vi.fn(),
  headerMock: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-agent-component-detail", () => ({
  useAgentComponentDetail: detailMock,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => featureFlagEnabledMock(flag),
  useFeatureFlagEnabledOptional: (flag: string) => featureFlagEnabledMock(flag),
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: headerMock,
}));

/** The root layout's default (`apps/app/app/layout.tsx`). */
const ROOT_LAYOUT_TITLE = "Closedloop.ai";
const DIGEST =
  "c22ccd465ae7be300736a0ed014fbbc9a9721872ab6cf5cab5c1e5f72d5e26dd";
const HASH_SLUG = `skill::${DIGEST}`;

const lastCrumbs = (): { label: string; href?: string }[] => {
  const [props] = headerMock.mock.calls.at(-1) as [
    { breadcrumbs: { label: string; href?: string }[] },
  ];
  return props.breadcrumbs;
};

describe("ISS-5518: agent detail identity", () => {
  beforeEach(() => {
    document.title = ROOT_LAYOUT_TITLE;
    headerMock.mockReset();
    headerMock.mockImplementation(() => null);
    detailMock.mockReset();
    detailMock.mockReturnValue({ data: { name: "RTK Optimizer" } });
    featureFlagEnabledMock.mockReset();
    featureFlagEnabledMock.mockImplementation(
      (flag: string) => flag === AGENTS_DETAIL_HONESTY_FEATURE_FLAG_KEY
    );
  });

  afterEach(() => {
    document.title = ROOT_LAYOUT_TITLE;
  });

  it("names the component in the last crumb instead of the literal 'Agent'", () => {
    render(<AgentDetailHeader orgSlug="acme" slug={HASH_SLUG} />);

    expect(lastCrumbs().at(-1)?.label).toBe("RTK Optimizer");
  });

  // The crumb's name is only free if this read hits the query key the BODY
  // already populated. Keyed off anything else it misses the cache, issues a
  // second request, and on the percent-encoded route below resolves nothing and
  // falls back to "Agent" — the ISS-5518 symptom this file exists to prevent.
  // Asserting the argument is what pins crumb and body to one literal.
  it("reads the detail under the same slug the body fetches", () => {
    render(<AgentDetailHeader orgSlug="acme" slug={HASH_SLUG} />);

    expect(detailMock).toHaveBeenCalledWith(HASH_SLUG);
  });

  it("never renders the 64-hex digest in any crumb", () => {
    render(<AgentDetailHeader orgSlug="acme" slug={HASH_SLUG} />);

    expect(lastCrumbs().some((crumb) => crumb.label.includes(DIGEST))).toBe(
      false
    );
  });

  it("names the browser tab after the component", () => {
    render(<AgentDetailHeader orgSlug="acme" slug={HASH_SLUG} />);

    expect(document.title).toBe("RTK Optimizer | Closedloop.ai");
  });

  it("says only the honest generic while the record is unresolved", () => {
    // No name is known yet, so the crumb and the tab name the KIND of page —
    // never the digest, which would read as a name the record does not have.
    detailMock.mockReturnValue({ data: undefined });

    render(<AgentDetailHeader orgSlug="acme" slug={HASH_SLUG} />);

    expect(lastCrumbs().at(-1)?.label).toBe("Agent");
    expect(document.title).toBe("Agent | Closedloop.ai");
  });

  it("keeps the Agents crumb pointing at the org-scoped list", () => {
    render(<AgentDetailHeader orgSlug="acme" slug={HASH_SLUG} />);

    expect(lastCrumbs()[0]).toEqual({ href: "/acme/agents", label: "Agents" });
  });

  // ISS-4776: a router hop can double-encode the segment. The crumb must decode
  // it rather than leak `%3A%3A`/`%2F` — coverage that moved here with the crumb.
  it("decodes a percent-encoded slug rather than leaking its escapes", () => {
    detailMock.mockReturnValue({ data: undefined });

    render(
      <AgentDetailHeader
        orgSlug="acme"
        slug="command%3A%3A%2F%2Fcl-ci-babysit"
      />
    );

    const crumbs = lastCrumbs();
    expect(crumbs.at(-1)?.label).toBe("//cl-ci-babysit");
    expect(crumbs.some((crumb) => crumb.label.includes("%3A"))).toBe(false);
    expect(crumbs.some((crumb) => crumb.label.includes("::"))).toBe(false);
  });

  describe("flag off", () => {
    beforeEach(() => {
      featureFlagEnabledMock.mockReturnValue(false);
    });

    it("falls back to the neutral crumb, exactly as it shipped", () => {
      render(<AgentDetailHeader orgSlug="acme" slug={HASH_SLUG} />);

      expect(lastCrumbs().at(-1)?.label).toBe("Agent");
    });

    it("leaves the route's static metadata title in place", () => {
      render(<AgentDetailHeader orgSlug="acme" slug={HASH_SLUG} />);

      expect(document.title).toBe(ROOT_LAYOUT_TITLE);
    });
  });
});
