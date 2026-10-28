import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import type { JsonObject } from "@repo/api/src/types/common";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionPropertiesPanel } from "../session-properties-panel";

/**
 * ISS-7259 — the session-detail harness launch-attribution rows.
 *
 * The facet's own module is emphatic that Claude's `attributionSkill` is NOT
 * launch evidence: it is stamped per assistant turn, and in the frozen corpus
 * the first stamped turn routinely sits hundreds of records deep. So the rows
 * under test here are as much about what the panel must NOT claim as about what
 * it shows, and the label and the record position are asserted as contract.
 */

const THREAD_LABEL = "Thread";
const AGENT_ROLE_LABEL = "Agent role";
const SKILL_LABEL = "First attributed skill";
const PROMPT_SOURCE_LABEL = "Prompt source";
const PROPERTIES_TOGGLE_RE = /Properties/;
/** Any wording that would restate the skill as the thing that launched the run. */
const LAUNCHED_BY_RE = /Launched by/i;
/** The over-long skill, had it been clipped onto the row instead of dropped. */
const CLIPPED_SKILL_RE = /^s{100,}/;
/** Any wording that would turn an unread spawn word into a claim about the run. */
const ORDINARY_CLAIM_RE = /\bordinary\b/i;

/**
 * Written out rather than built from `LaunchThreadSource`/the view module: a
 * fixture derived from the thing it polices stays green when a member is
 * renamed or a label map is emptied. The duplication IS the test.
 */
const CODEX_SPAWNED = {
  threadSource: "subagent",
  agentRole: "review-soul",
  agentNickname: "Mencius",
  parentThreadId: "019e6f02-1113-79d2-b26d-9335e524daad",
  depth: 1,
} as const;

const CLAUDE_ATTRIBUTED = {
  threadSource: "unstated",
  firstAttributedSkill: "cl-produce",
  observedSkillCount: 3,
  firstAttributedRecordIndex: 251,
  observedRecordCount: 381,
  promptSource: "sdk",
} as const;

describe("ISS-7259 session-detail launch attribution", () => {
  it("renders Codex's stated spawn facts", async () => {
    await renderPanel({ facet: CODEX_SPAWNED, flagOn: true });

    expect(readRow(THREAD_LABEL)).toBe("Agent-spawned (depth 1)");
    expect(readRow(AGENT_ROLE_LABEL)).toBe("review-soul (Mencius)");
  });

  /**
   * A user-started Codex thread. Its own case because it is the OTHER stated
   * spawn word, and without it deleting the `User` entry from the label map
   * renders `undefined` for every user-launched session with nothing red.
   */
  it("renders a user-started thread", async () => {
    await renderPanel({ facet: { threadSource: "user" }, flagOn: true });

    expect(readRow(THREAD_LABEL)).toBe("User-started");
  });

  /** Role without the harness's generated codename — the parenthetical is skipped. */
  it("renders an agent role with no nickname, without an empty parenthetical", async () => {
    await renderPanel({
      facet: { threadSource: "subagent", agentRole: "explorer" },
      flagOn: true,
    });

    expect(readRow(AGENT_ROLE_LABEL)).toBe("explorer");
  });

  /**
   * THE load-bearing case, and the reason this row is not called "Launched by".
   * The name alone cannot tell "launched by cl-produce" from "ran unattributed
   * for 250 turns, then invoked cl-produce" — the position is the only thing on
   * screen that does, so it stays INLINE. The count and the caveat ride the
   * `explanation`, which `PropertyValue` renders into the accessible name too,
   * so `readRow` sees both halves.
   */
  it("qualifies Claude's skill with its record position and never calls it the launcher", async () => {
    await renderPanel({ facet: CLAUDE_ATTRIBUTED, flagOn: true });

    const row = readRow(SKILL_LABEL);
    expect(row).toContain("cl-produce (record 251 of 381)");
    expect(row).toContain("It is 1 of 3 skills attributed in this session.");
    expect(row).toContain("never marks a launch");
    // The panel must not restate the skill as a launch fact anywhere.
    expect(screen.queryByText(LAUNCHED_BY_RE)).toBeNull();
  });

  /**
   * `1` is the common case and its own branch. Without it, replacing the
   * singular/plural ternary with a bare "s" renders "1 of 1 skills" unnoticed.
   */
  it("says one skill in the singular", async () => {
    await renderPanel({
      facet: {
        firstAttributedSkill: "code-review:start",
        observedSkillCount: 1,
      },
      flagOn: true,
    });

    expect(readRow(SKILL_LABEL)).toContain(
      "It is 1 of 1 skill attributed in this session."
    );
  });

  /**
   * A skill the facet could name but never positioned or counted — reachable
   * because each number is coerced independently, so a version-skewed blob can
   * supply the name alone. The bare name is all it knew, and the caveat still
   * ships so the name is never read as the launcher.
   */
  it("renders a bare skill name when the facet carried no position or count", async () => {
    await renderPanel({
      facet: { firstAttributedSkill: "logical-qa" },
      flagOn: true,
    });

    const row = readRow(SKILL_LABEL);
    expect(row).toContain("logical-qa");
    expect(row).not.toContain("record");
    expect(row).not.toContain("skills attributed");
    expect(row).toContain("never marks a launch");
  });

  /**
   * `sdk` / `queued` are Claude's internals, not words for a user, and the row's
   * glyph must not assert a person typed something the value says the SDK sent.
   */
  it("says a prompt source in words rather than shipping the raw token", async () => {
    await renderPanel({ facet: CLAUDE_ATTRIBUTED, flagOn: true });

    expect(readRow(PROMPT_SOURCE_LABEL)).toBe("Injected by the SDK");
  });

  /** An upstream value this build never heard is passed through, not dropped. */
  it("passes an unrecognized prompt source through verbatim", async () => {
    await renderPanel({
      facet: { promptSource: "resumed" },
      flagOn: true,
    });

    expect(readRow(PROMPT_SOURCE_LABEL)).toBe("resumed");
  });

  /**
   * Claude stamps no spawn word at all, so every Claude session carries
   * `threadSource: "unstated"`. Rendering it would put a "Not stated" row on
   * every Claude session forever — an answer to a question the harness never
   * asked, occupying a row that reads like a finding.
   */
  it("renders no Thread row for the unstated spawn word Claude always sends", async () => {
    await renderPanel({ facet: CLAUDE_ATTRIBUTED, flagOn: true });

    expect(screen.queryByText(THREAD_LABEL)).toBeNull();
    // Positive control: the same render DOES show the rows Claude did state,
    // so the absence above is the Unstated rule and not an unmounted subtree.
    expect(screen.queryByText(SKILL_LABEL)).not.toBeNull();
  });

  /**
   * `unknown` is a DIFFERENT fact from `unstated`: the harness stated a word
   * this build does not recognise, which tells the reader this build is behind.
   * Collapsing the two would make a renamed upstream value indistinguishable
   * from one that was never emitted. The word alone would read as a fact about
   * the RUN, so the row carries the same kind of disclosure the Status row does.
   */
  it("keeps an unrecognized spawn word distinct from an unstated one", async () => {
    await renderPanel({ facet: { threadSource: "unknown" }, flagOn: true });

    const row = readRow(THREAD_LABEL);
    expect(row).toContain("Unknown");
    expect(row).toContain("this build is behind");
  });

  /**
   * THE version-skew case, and the one a whitelist re-declared here would fail.
   * A newer producer stating a spawn word this build never heard must still get
   * a row saying so — not silently fall through to the no-row path that means
   * "the harness never said". `"scheduled"` is outside the union on purpose.
   */
  it("renders an unheard-of spawn word as Unknown rather than dropping the row", async () => {
    await renderPanel({ facet: { threadSource: "scheduled" }, flagOn: true });

    expect(readRow(THREAD_LABEL)).toContain("Unknown");
  });

  /**
   * The disclosure names OUR limitation and must not smuggle a claim about the
   * RUN in alongside it. An unrecognised word most likely names a launch mode
   * added after this build shipped, and that mode may itself be agent-spawned —
   * so calling the session ordinary would turn a word we failed to read into a
   * reassurance it cannot carry, on the one row whose job is to say we are
   * behind. `"scheduled"` is the version-skew case that actually reaches this.
   */
  it("discloses the unread spawn word without calling the session ordinary", async () => {
    await renderPanel({ facet: { threadSource: "scheduled" }, flagOn: true });

    const row = readRow(THREAD_LABEL);
    // Positive control first, so the absence below is the honesty rule rather
    // than an unrendered row or an empty explanation.
    expect(row).toContain("this build is behind");
    expect(row).not.toMatch(ORDINARY_CLAIM_RE);
  });

  /**
   * An over-long value is DROPPED, not clipped — a truncated identifier is a
   * different identifier, and a wrong attribution is worse than a missing one.
   */
  it("drops an over-long skill rather than clipping it into a different name", async () => {
    await renderPanel({
      facet: { ...CLAUDE_ATTRIBUTED, firstAttributedSkill: "s".repeat(129) },
      flagOn: true,
    });

    expect(screen.queryByText(SKILL_LABEL)).toBeNull();
    expect(screen.queryByText(CLIPPED_SKILL_RE)).toBeNull();
    // The unrelated member still renders, so the drop is scoped to the skill
    // group rather than having blanked the whole facet.
    expect(readRow(PROMPT_SOURCE_LABEL)).toBe("Injected by the SDK");
  });

  /** Every pre-ISS-7259 payload: no facet at all, so no rows and no em-dashes. */
  it("renders no attribution rows when the session carries no facet", async () => {
    await renderPanel({ facet: null, flagOn: true });

    for (const label of [
      THREAD_LABEL,
      AGENT_ROLE_LABEL,
      SKILL_LABEL,
      PROMPT_SOURCE_LABEL,
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // The rest of the panel still rendered, so the absences are the presence
    // self-gate and not a crashed subtree.
    expect(screen.queryByText("Harness")).not.toBeNull();
  });

  /**
   * The ISS-4779 gate. Positive control is the first two cases: identical
   * fixture and queries, only the flag flipped, so this proves the gate rather
   * than a dead selector.
   */
  it("renders nothing when the flag is off, on a session that would otherwise show it", async () => {
    await renderPanel({ facet: CODEX_SPAWNED, flagOn: false });

    expect(screen.queryByText(THREAD_LABEL)).toBeNull();
    expect(screen.queryByText(AGENT_ROLE_LABEL)).toBeNull();
    expect(screen.queryByText("review-soul (Mencius)")).toBeNull();
    // The rest of the panel is untouched by the closed gate.
    expect(screen.queryByText("Harness")).not.toBeNull();
  });
});

/** The value text of the property row carrying `label`. */
function readRow(label: string): string {
  const labelNode = screen.getByText(label);
  const row = labelNode.closest(".prd-prop");
  if (!row) {
    throw new Error(`No property row for label ${label}`);
  }
  return (row.textContent ?? "").replace(label, "").trim();
}

async function renderPanel({
  facet,
  flagOn,
}: {
  facet: JsonObject | null;
  flagOn: boolean;
}) {
  const base = createAgentSessionDetailFixture();
  const session: AgentSessionDetail = {
    ...base,
    metadata: facet === null ? null : { harnessLaunchAttribution: facet },
  };
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: flagOn
          ? [SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <SessionPropertiesPanel session={session} />
    </FeatureFlagAdapterProvider>
  );
  // The rows under test live in the expanded panel; it starts collapsed.
  await userEvent.click(
    screen.getByRole("button", { name: PROPERTIES_TOGGLE_RE })
  );
}
