/**
 * ISS-5767 / ISS-5972. Every non-human activity row stated its actor kind FOUR
 * times in about thirty characters: a gear/robot avatar glyph, the word
 * "System" / "Agent" as the actor's name, and a `<Badge>` carrying that word
 * AGAIN plus the same glyph AGAIN. Both comment prototypes use one indicator —
 * the avatar — with the kind in words only where there is no profile to anchor
 * on, so the feed was drift.
 *
 * ISS-5972 graduated the fix UNGATED (Marisol: "we don't need feature flags on any
 * of this"), so the flag-off cases these tests used to carry are gone with the
 * branch they pinned. There is no rollback lever short of a revert, which is
 * exactly why every assertion below is counterfactual: each one was observed
 * RED against the restated form before being kept.
 *
 * These COUNT the kind in the rendered output rather than spot-checking that it
 * is present, because "present" is exactly what the defect also satisfied. They
 * assert the rendered text and which element carries it, never a class name.
 *
 * The cross-SURFACE half of this regression lives in
 * `scripts/lint/no-restated-actor-kind.test.ts`: these tests can only ever speak
 * about this one component, and the whole point of ISS-5972 is that the next
 * surface must not be able to re-introduce the shape.
 */
import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  type ActivityFeedActor,
  ActivityFeedActorKind,
  ActivityFeedItemSource,
} from "@repo/api/src/types/artifact-activity-feed";
import type { User } from "@repo/api/src/types/user";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

// Only needed by the ActivityCard composition cases below; the leaf cases take
// their directory as a plain prop and touch neither hook.
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => READY_USERS_QUERY,
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => READY_PROJECTS_QUERY,
}));

vi.mock("@repo/app/tags/hooks/use-tags", () => ({
  useTags: () => READY_PROJECTS_QUERY,
}));

import { FeedItemKind } from "../../feed-item";
import { ActivityActor } from "../../sources/activity-actor";
import { ActivityCard } from "../../sources/activity-card";
import {
  ACTIVITY_SOURCE_ID,
  type ActivityDirectory,
  ActivityDirectoryStatus,
} from "../../sources/activity-types";
import {
  AGENT_ACTOR,
  DANA,
  HUMAN_ACTOR,
  readyDirectory,
  SYSTEM_ACTOR,
} from "./activity-actor-fixtures";

const READY_DIRECTORY: ActivityDirectory<User> = readyDirectory(DANA);

/** A settled query with records — what `useOrgUserDirectory` reads as Ready. */
const READY_USERS_QUERY = {
  data: [DANA],
  isPending: false,
  isError: false,
  fetchStatus: "idle",
};
const READY_PROJECTS_QUERY = {
  data: [],
  isPending: false,
  isError: false,
  fetchStatus: "idle",
};

function renderActor(actor: ActivityFeedActor) {
  return render(<ActivityActor actor={actor} directory={READY_DIRECTORY} />);
}

/** Render the real production composition: `ActivityCard` -> `ActivityActor`. */
function renderCard(kind: ActivityFeedActorKind) {
  return render(
    <ActivityCard
      item={{
        id: "event:1",
        kind: FeedItemKind.Activity,
        sourceId: ACTIVITY_SOURCE_ID,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        event: {
          id: "event:1",
          source: ActivityFeedItemSource.Event,
          action: ArtifactActivityAction.Creation,
          actor: { kind, id: "actor-1" },
          before: null,
          after: null,
          payload: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      }}
    />
  );
}

/**
 * How many times the rendered row STATES the kind in words.
 *
 * `exact` matches whole text content, so "System" inside a longer sentence would
 * not inflate the count. The kind glyphs need no exclusion here and none is
 * claimed: `ignore` in `@testing-library/dom` is a flat `Element.matches()`
 * filter on the candidate ITSELF, not a subtree or accessibility-tree walk, and
 * the matcher only reads an element's own text children — so an `<svg>` carrying
 * no text was never a candidate for "Agent" either way. Do not read this helper
 * as proof that an `aria-hidden` subtree is excluded; it isn't tested for that.
 */
function countKindStatements(kind: string): number {
  return screen.queryAllByText(kind, { exact: true }).length;
}

/** The design-system `Badge`'s own stable selector (`badge.tsx`). */
const BADGE_SELECTOR = '[data-slot="badge"]';

/**
 * Every svg in the row. The tests assert there is exactly ONE before comparing,
 * so adding a second decorative icon fails loudly instead of silently letting a
 * comparison run against the wrong node.
 */
function glyphsOf(container: HTMLElement): NodeListOf<SVGElement> {
  return container.querySelectorAll("svg");
}

const WHITESPACE = /\s+/;
const API_ONLY = /^API$/;

/** The glyph's geometry — what makes a cog a cog and not a robot. */
function glyphShape(glyph: SVGElement): string {
  return Array.from(glyph.querySelectorAll("path,circle,rect,line,polyline"))
    .map((node) => node.outerHTML)
    .join("");
}

/**
 * Everything about the glyph that is NOT its identity: size, stroke, and any
 * colour or presentation class. Lucide bakes a per-icon `lucide-<name>` token
 * into `class`, which is identity rather than styling, so it is dropped —
 * without that, every icon pair trivially differs and the constancy assertion
 * proves nothing. Any OTHER class (a `text-*` colour, say) survives here, which
 * is exactly what has to make the comparison fail.
 */
function glyphStyling(glyph: SVGElement): string {
  return Array.from(glyph.attributes)
    .map((attribute) =>
      attribute.name === "class"
        ? `class=${attribute.value
            .split(WHITESPACE)
            .filter((token) => !token.startsWith("lucide-"))
            .sort()
            .join(" ")}`
        : `${attribute.name}=${attribute.value}`
    )
    .sort()
    .join("|");
}

describe("ActivityActor kind indicators (ISS-5767 / ISS-5972)", () => {
  it.each([
    [ActivityFeedActorKind.Agent, AGENT_ACTOR, "Agent"],
    [ActivityFeedActorKind.System, SYSTEM_ACTOR, "System"],
  ])(
    "states a %s row's kind exactly once, on the name",
    (_kind, actor, label) => {
      renderActor(actor);

      expect(countKindStatements(label)).toBe(1);
      // The survivor is the NAME, not a lone surviving pill. Asserting the tag
      // name would NOT establish this: the design-system `Badge` renders as a
      // `<span>` too, so `tagName === "SPAN"` is satisfied by exactly the
      // malformed declutter this is meant to catch. Key off the Badge's own slot.
      expect(
        screen.getByText(label, { exact: true }).closest(BADGE_SELECTOR)
      ).toBeNull();
    }
  );

  it("renders no badge at all on a System row", () => {
    const { container } = renderActor(SYSTEM_ACTOR);

    // Stated as an absence of the PRIMITIVE, not of a word: a regression that
    // restated the kind with different copy ("Automation", "Service") would
    // still satisfy the count assertion above while putting the pill back.
    expect(container.querySelectorAll(BADGE_SELECTOR)).toHaveLength(0);
  });

  // ISS-12117 (Nerys, 2026-10-07): an agent row is an API-key write, so it
  // carries ONE badge naming the channel, "API" — never the kind word again.
  it("renders exactly one badge on a resolved Agent row, and it names the channel", () => {
    const { container } = renderActor({
      kind: ActivityFeedActorKind.Agent,
      id: DANA.id,
    });

    const badges = container.querySelectorAll(BADGE_SELECTOR);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent(API_ONLY);
  });

  // An unresolved owner already reads "Agent" beside the robot glyph; an API
  // badge there would state the machine kind a third time (review, R3).
  it.each<[string, ActivityFeedActor, ActivityDirectory<User>]>([
    [
      "no owner id",
      { kind: ActivityFeedActorKind.Agent, id: null },
      READY_DIRECTORY,
    ],
    ["an owner the directory does not hold", AGENT_ACTOR, READY_DIRECTORY],
    [
      "an unavailable directory",
      { kind: ActivityFeedActorKind.Agent, id: DANA.id },
      { status: ActivityDirectoryStatus.Unavailable, find: () => null },
    ],
  ])("renders no badge on an Agent row with %s", (_case, actor, directory) => {
    const { container } = render(
      <ActivityActor actor={actor} directory={directory} />
    );

    expect(screen.getByText("Agent", { exact: true })).toBeInTheDocument();
    expect(container.querySelectorAll(BADGE_SELECTOR)).toHaveLength(0);
  });

  it("resolves an agent row to the API-key owner, with the API badge", () => {
    renderActor({ kind: ActivityFeedActorKind.Agent, id: DANA.id });

    // The owner's name, not the kind word: the badge says it came by API key.
    expect(countKindStatements("Dana Reed")).toBe(1);
    expect(screen.queryByText("Agent", { exact: true })).toBeNull();
    expect(screen.getByText("API", { exact: true })).toBeInTheDocument();
  });

  it.each([
    [AGENT_ACTOR, "Agent"],
    [SYSTEM_ACTOR, "System"],
  ])(
    "keeps the kind in the accessibility tree once the pill is gone",
    (actor, label) => {
      renderActor(actor);

      const name = screen.getByText(label, { exact: true });
      // The pill carried a visible label; removing it must de-duplicate the
      // statement, not delete the only accessible one.
      expect(name).toBeInTheDocument();
      expect(name.closest("[aria-hidden='true']")).toBeNull();
    }
  );

  it("keeps agent and system distinguishable by glyph SHAPE, not by styling", () => {
    const agent = renderActor(AGENT_ACTOR);
    const agentGlyphs = glyphsOf(agent.container);
    expect(agentGlyphs).toHaveLength(1);
    const agentShape = glyphShape(agentGlyphs[0]);
    const agentStyling = glyphStyling(agentGlyphs[0]);
    agent.unmount();

    const system = renderActor(SYSTEM_ACTOR);
    const systemGlyphs = glyphsOf(system.container);
    expect(systemGlyphs).toHaveLength(1);
    const systemIcon = systemGlyphs[0];

    // Styling held CONSTANT and geometry DIFFERENT is the whole assertion. A
    // raw markup diff would not establish it: a regression that mapped both
    // kinds to the same icon and told them apart by a colour class alone would
    // still produce different markup, and so would still pass — which is
    // precisely the WCAG 1.4.1 failure this is supposed to rule out.
    expect(glyphStyling(systemIcon)).toBe(agentStyling);
    expect(glyphShape(systemIcon)).not.toBe(agentShape);
    expect(agentShape).not.toBe("");
  });

  it("leaves a resolved human row untouched", () => {
    renderActor(HUMAN_ACTOR);

    expect(countKindStatements("Dana Reed")).toBe(1);
    expect(screen.queryByText("Human", { exact: true })).toBeNull();
  });

  /**
   * The PRODUCTION composition, not the leaf. `ActivityCard` is what the feed
   * actually renders (`activity-card.tsx` builds the actor slot), and reverting
   * the fix at THAT call site — or breaking the flag context's reach to this
   * leaf — would leave every leaf-level case above green. Without this, deleting
   * the production wiring costs nothing in CI.
   */
  it.each([
    [ActivityFeedActorKind.Agent, "Agent"],
    [ActivityFeedActorKind.System, "System"],
  ])(
    "states the kind once through the real ActivityCard (%s)",
    (kind, label) => {
      renderCard(kind);

      expect(countKindStatements(label)).toBe(1);
      expect(
        screen.getByText(label, { exact: true }).closest(BADGE_SELECTOR)
      ).toBeNull();
    }
  );
});
