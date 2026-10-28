import { describe, expect, it } from "vitest";
import type { EventWithSession } from "../../../../shared/agent-db-contract";
import {
  buildAgentCoachingTips,
  extractShellCommand,
} from "../agent-coaching-model";
import type { AgentCoachingTip } from "../agent-coaching-types";
import {
  commandlessShellEvent,
  errorEvent,
  FRUSTRATED_TURN,
  makeAnalytics,
  makeInput,
  shellEvent,
  userEvent,
} from "./fixtures/agent-coaching-input";

// ISS-10696: how a repeated shell command is classified into the family the
// reuse tip names, and the fallbacks the seed builders take when analytics is
// absent. `agent-coaching-model.test.ts` owns the pool ranking and feedback
// contracts; this file pins the command classifier through the tip it drives.

describe("command family classification", () => {
  it.each([
    ["gh pr view 12 --comments", "github-pr-review-preflight"],
    ["git rev-parse HEAD && rg TODO src", "repo-state-inspection"],
    ["cd /repo && pnpm test", "pnpm test"],
    ["node scripts/build.mjs", "node script"],
    ["git log --oneline", "git log"],
    ["pnpm", "pnpm"],
  ])("names %s as the %s family", (command, family) => {
    const tips = tipsFor(repeated(command));

    expect(reuseTip(tips)?.detail.candidateFromThisDryRun?.pattern).toBe(
      family
    );
  });

  it("reads the family past an rtk wrapper, and hands wrapped probes to the workflow tip", () => {
    const tips = tipsFor(repeated("rtk gh api /user"));

    // The two reuse-lever builders name the same family; with nothing left to
    // unwrap the workflow tip outranks the skill tip and takes the lever.
    expect(reuseTip(tips)).toBeUndefined();
    expect(tipById(tips, WORKFLOW_TIP_ID)?.body).toContain(
      "3 repeated gh api signals"
    );
  });

  it("prefers a review-preflight family for the workflow tip over a busier one", () => {
    const tips = tipsFor([
      ...repeated("rtk gh pr view 12 --comments"),
      ...repeated("rtk node scripts/build.mjs", 4),
    ]);

    // Wrapped probes hand the reuse lever to the workflow tip (see above), and
    // that tip asks for the review families first — so the three-strong review
    // family beats the four-strong build one.
    expect(reuseTip(tips)).toBeUndefined();
    expect(tipById(tips, WORKFLOW_TIP_ID)?.evidence).toContain(
      "3 repeated github-pr-review-preflight command events"
    );
  });

  it("skips a shell event with no recoverable command when counting a family", () => {
    const tips = tipsFor([
      commandlessShellEvent("blob"),
      ...repeated("node scripts/build.mjs"),
    ]);

    expect(reuseTip(tips)?.detail.candidateFromThisDryRun).toMatchObject({
      observedCalls: 3,
      pattern: "node script",
    });
  });

  it("does not promote a low-value probe family, even when repeated", () => {
    const tips = tipsFor([
      ...repeated("rtk git status"),
      ...repeated("rg needle src"),
      ...repeated("sed -n 1,20p file.ts"),
      ...repeated("ls -la"),
    ]);

    expect(reuseTip(tips)).toBeUndefined();
    // The workflow tip still surfaces on skill usage alone, and names no
    // family: a low-value probe must not reach it as a repeated command either.
    // pins current behavior (ISS-10701); looks odd because the no-family fallback pattern
    // "repeated review workflow" is fed into "N repeated <pattern> command
    // events", doubling the word and reporting a count of zero as evidence.
    expect(tipById(tips, WORKFLOW_TIP_ID)?.evidence).toContain(
      "0 repeated repeated review workflow command events"
    );
  });

  it("falls back to a generic skill name when the family has no slug", () => {
    const tips = tipsFor(repeated("!!!"));

    expect(reuseTip(tips)?.detail.candidateFromThisDryRun?.pattern).toBe("!!!");
    expect(reuseTip(tips)?.detail.whyThisRecommendation).toContain(
      "Promoting it to reusable-command-skill"
    );
  });

  it("truncates an over-long representative command instead of quoting it whole", () => {
    const long = `make ${"target ".repeat(80)}`.trim();
    const tips = tipsFor(repeated(long));

    const examples =
      reuseTip(tips)?.detail.candidateFromThisDryRun?.representativeCommands;
    expect(examples).toHaveLength(3);
    expect(examples?.[0]).toHaveLength(320 + "... [truncated]".length);
    expect(examples?.[0]?.endsWith("... [truncated]")).toBe(true);
  });

  it("quotes a representative command of exactly the cap whole", () => {
    const atCap = `make ${"x".repeat(315)}`;
    const tips = tipsFor(repeated(atCap));

    expect(
      reuseTip(tips)?.detail.candidateFromThisDryRun?.representativeCommands
    ).toEqual([atCap, atCap, atCap]);
  });

  it("offers the context checkpoint only on a busy enough corpus", () => {
    const analytics = makeAnalytics();
    const busy = buildAgentCoachingTips(
      makeInput({
        analytics: { ...analytics, totalEvents: 200, totalSessions: 2 },
        recentEvents: repeated("gh api /user"),
      })
    );

    expect(tipById(busy, CONTEXT_TIP_ID)).toBeDefined();
    expect(
      tipById(tipsFor(repeated("gh api /user")), CONTEXT_TIP_ID)
    ).toBeUndefined();
  });

  it("keeps building from session events when analytics is absent", () => {
    const tips = buildAgentCoachingTips(
      makeInput({ analytics: null, recentEvents: repeated("gh api /user") })
    );

    expect(reuseTip(tips)?.detail.candidateFromThisDryRun?.pattern).toBe(
      "gh api"
    );
    expect(tipById(tips, CONTEXT_TIP_ID)).toBeUndefined();
  });

  it("builds from captured events alone when neither analytics nor workflow is present", () => {
    const tips = buildAgentCoachingTips(
      makeInput({
        analytics: null,
        recentEvents: repeated("gh api /user"),
        workflow: null,
      })
    );

    expect(reuseTip(tips)?.detail.candidateFromThisDryRun?.pattern).toBe(
      "gh api"
    );
    expect(tipById(tips, CONTEXT_TIP_ID)).toBeUndefined();
  });

  it("falls back to the shell tool's own usage row when no probe family repeats", () => {
    const analytics = makeAnalytics();
    const tips = buildAgentCoachingTips(
      makeInput({
        analytics: {
          ...analytics,
          toolUsage: [{ count: 5, toolName: "Bash" }],
        },
        recentEvents: [shellEvent("git log"), shellEvent("pnpm build")],
      })
    );

    const tip = reuseTip(tips);
    expect(tip?.detail.candidateFromThisDryRun).toMatchObject({
      observedCalls: 5,
      pattern: "Bash",
      representativeCommands: [],
    });
    expect(tip?.evidence).toContain(
      "no representative commands were available from summaries"
    );
  });
});

describe("extractShellCommand fallbacks", () => {
  it("falls past an empty tool_input.command to a bare command field", () => {
    expect(
      extractShellCommand({
        ...shellEvent("ignored"),
        data: '{"tool_input":{"command":"  "},"command":"git fetch"}',
        summary: null,
      })
    ).toBe("git fetch");
  });

  it("uses the summary when the data blob parses but carries no command", () => {
    expect(
      extractShellCommand({
        ...shellEvent("pnpm build"),
        data: '{"tool_input":{"cwd":"/repo"}}',
      })
    ).toBe("pnpm build");
  });

  it("answers null when neither summary nor data carries anything", () => {
    expect(
      extractShellCommand({
        ...shellEvent("ignored"),
        data: null,
        summary: null,
      })
    ).toBeNull();
    expect(
      extractShellCommand({
        ...shellEvent("ignored"),
        data: "   ",
        summary: null,
      })
    ).toBeNull();
  });
});

describe("resilience tip wording", () => {
  it("names an unnamed session generically and counts a lone error in the singular", () => {
    const tips = tipsFor([
      { ...userEvent(FRUSTRATED_TURN), sessionName: null },
      errorEvent(),
    ]);

    expect(tipById(tips, "resilience-frustration-reset")?.body).toContain(
      "Your sharpest frustration peak was in a recent session with 1 error clustered right around it."
    );
  });

  it("pluralises the clustered errors past one", () => {
    const tips = tipsFor([
      errorEvent(),
      userEvent(FRUSTRATED_TURN),
      errorEvent(),
    ]);

    expect(tipById(tips, "resilience-frustration-reset")?.body).toContain(
      "with 2 errors clustered right around it."
    );
  });
});

const REUSE_TIP_ID = "shell-probe-reusable-skill";
const WORKFLOW_TIP_ID = "promote-review-workflow";
const CONTEXT_TIP_ID = "context-checkpoint";

function tipById(
  tips: AgentCoachingTip[],
  id: string
): AgentCoachingTip | undefined {
  return tips.find((tip) => tip.id === id);
}

function reuseTip(tips: AgentCoachingTip[]): AgentCoachingTip | undefined {
  return tipById(tips, REUSE_TIP_ID);
}

function tipsFor(recentEvents: EventWithSession[]): AgentCoachingTip[] {
  return buildAgentCoachingTips(makeInput({ recentEvents }));
}

function repeated(command: string, times = 3): EventWithSession[] {
  return Array.from({ length: times }, (_, index) =>
    shellEvent(command, `session-${index}`)
  );
}
