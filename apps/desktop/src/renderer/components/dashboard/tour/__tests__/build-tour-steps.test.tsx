/**
 * ISS-5112 (PLN-1600 Step C): what the `guest-onboarding` Labs flag does to the
 * first-launch tour. Both branches, every time — flag OFF must stay byte-for-byte
 * the six-step tour that shipped before, or the gate has leaked.
 */

import { Harness } from "@repo/lib/harness/types";
import type { AgentsInsightsResponse } from "@closedloop-ai/loops-api/insights";
import { describe, expect, it } from "vitest";
import { buildTourSteps } from "../build-tour-steps";
import type { TourStep, TourSummaryRow } from "../tour";

/**
 * Not one of the five collected harnesses, so it has no `Harness` member — but
 * `HARNESS_LABELS` maps it, and the store can hold any recorded string, so this
 * pins that an out-of-contract id still gets its human label.
 */
const GEMINI_HARNESS_ID = "gemini";
/** Mapped nowhere at all: the fallback, not a lookup. */
const UNMAPPED_HARNESS_ID = "windsurf";
/** The claim the row deliberately does not make. */
const VALIDATED_CLAIM_RE = /validated|best effort/i;

const AGENTS: AgentsInsightsResponse = {
  kpis: [],
  charts: {
    modelBreakdown: [],
    modelUsageOverTime: { points: [], series: [] },
  },
};

/** An agents payload whose model spend is attributable to `models`. */
function agentsWithModels(models: string[]): AgentsInsightsResponse {
  return {
    ...AGENTS,
    charts: {
      ...AGENTS.charts,
      modelBreakdown: models.map((model) => ({
        key: model,
        label: model,
        value: 1,
      })),
    },
  };
}

function modelsRow(steps: TourStep[]): TourSummaryRow | undefined {
  return introSummary(steps).find((row) => row.label === "Models in use");
}

function stepKeys(steps: TourStep[]): string[] {
  return steps.map((step) => (step.intro ? "intro" : step.sel));
}

function introSummary(steps: TourStep[]): TourSummaryRow[] {
  const intro = steps[0];
  if (!intro?.intro) {
    throw new Error("Expected the first tour step to be the intro summary");
  }
  return intro.summary;
}

function build(
  overrides: Partial<Parameters<typeof buildTourSteps>[0]> = {}
): TourStep[] {
  return buildTourSteps({
    sessionsTotal: 4695,
    agents: AGENTS,
    guestOnboardingEnabled: false,
    harnesses: [],
    ...overrides,
  });
}

describe("buildTourSteps — the sessions spotlight (ISS-5112)", () => {
  it("keeps the six-step tour, sessions spotlight included, with the flag off", () => {
    const steps = build();

    expect(stepKeys(steps)).toEqual([
      "intro",
      "stats",
      "activity",
      "sessions",
      "models",
      "prs",
    ]);
    const sessionsStep = steps.find(
      (step) => !step.intro && step.sel === "sessions"
    );
    expect(sessionsStep?.title).toBe("Every session, drillable");
  });

  it("drops the sessions spotlight, and only that step, with the flag on", () => {
    const steps = build({ guestOnboardingEnabled: true });

    expect(stepKeys(steps)).toEqual([
      "intro",
      "stats",
      "activity",
      "models",
      "prs",
    ]);
  });

  it("leaves the surviving steps' copy untouched when the flag is on", () => {
    const off = build();
    const on = build({ guestOnboardingEnabled: true });

    // Everything except the dropped step must be identical, including the `prs`
    // eyebrow and body the prototype words differently.
    expect(on.filter((step) => !step.intro)).toEqual(
      off.filter((step) => !(step.intro || step.sel === "sessions"))
    );
  });
});

describe("buildTourSteps — the harnesses summary row (ISS-5112)", () => {
  it("adds a third summary row AFTER models when the flag is on", () => {
    const summary = introSummary(
      build({
        guestOnboardingEnabled: true,
        harnesses: [Harness.Claude, Harness.Codex],
      })
    );

    // Last, not in the middle. It is the only row with no value, so sitting
    // between the two rows that have one punched a hole in the number column.
    expect(summary.map((row) => row.label)).toEqual([
      "Sessions parsed",
      "Models in use",
      "Harnesses found",
    ]);
    expect(summary.at(-1)?.value).toBeUndefined();
  });

  it("labels each harness chip from the canonical harness label map", () => {
    const summary = introSummary(
      build({
        guestOnboardingEnabled: true,
        harnesses: [Harness.Claude, Harness.Codex, GEMINI_HARNESS_ID],
      })
    );
    const harnessRow = summary.find((row) => row.label === "Harnesses found");

    expect(harnessRow?.chips?.map((chip) => chip.label)).toEqual([
      "Claude Code",
      "Codex",
      "Gemini CLI",
    ]);
  });

  it("title-cases a harness id the label map has never heard of", () => {
    const summary = introSummary(
      build({
        guestOnboardingEnabled: true,
        harnesses: [Harness.Claude, UNMAPPED_HARNESS_ID],
      })
    );
    const harnessRow = summary.find((row) => row.label === "Harnesses found");

    // A raw lowercase slug sitting next to "Claude Code" reads as missing data.
    expect(harnessRow?.chips?.map((chip) => chip.label)).toEqual([
      "Claude Code",
      "Windsurf",
    ]);
  });

  it("carries a caption but no count — the chips already are the answer", () => {
    const summary = introSummary(
      build({
        guestOnboardingEnabled: true,
        harnesses: [Harness.Claude, Harness.Codex],
      })
    );
    const harnessRow = summary.find((row) => row.label === "Harnesses found");

    // "Models in use" earns its number because its chips stop at four and the
    // rest fold into "+N more". This row lists every harness it found, so a
    // count beside them counts to two for someone already looking at both.
    expect(harnessRow?.value).toBeUndefined();
    expect(harnessRow?.chips).toHaveLength(2);
    // Scoped to what was actually read. No validated-vs-best-effort claim ships:
    // the repo has no canonical list to read one from.
    expect(harnessRow?.sub).toBe("detected in your local session logs");
    expect(harnessRow?.sub).not.toMatch(VALIDATED_CLAIM_RE);
  });

  it("omits the row entirely when nothing was found (including while the read is in flight)", () => {
    const summary = introSummary(
      build({ guestOnboardingEnabled: true, harnesses: [] })
    );

    expect(summary.map((row) => row.label)).toEqual([
      "Sessions parsed",
      "Models in use",
    ]);
  });

  it("never adds the row with the flag off, even when harnesses were found", () => {
    const summary = introSummary(build({ harnesses: [Harness.Claude] }));

    expect(summary.map((row) => row.label)).toEqual([
      "Sessions parsed",
      "Models in use",
    ]);
  });
});

describe("buildTourSteps — the models caption (ISS-5112)", () => {
  it("keeps the shipped sentence verbatim with the flag off", () => {
    // Codex-only spend, and the flag-off caption still names Claude: unchanged
    // is the whole contract on this branch.
    const steps = build({ agents: agentsWithModels(["gpt-5-codex"]) });

    expect(modelsRow(steps)?.sub).toBe("across Claude, OpenAI, and more.");
  });

  it("names the providers actually behind this device's spend", () => {
    const steps = build({
      guestOnboardingEnabled: true,
      agents: agentsWithModels(["gpt-5-codex", "o3-mini"]),
    });

    // The "Harnesses found: Codex" row now sits directly above this line, so
    // "across Claude, OpenAI, and more." would contradict it.
    expect(modelsRow(steps)?.sub).toBe("across OpenAI.");
  });

  it("lists several providers in the order they appear", () => {
    const steps = build({
      guestOnboardingEnabled: true,
      agents: agentsWithModels([
        "claude-sonnet-4-6",
        "gpt-5-codex",
        "gemini-2.5-pro",
      ]),
    });

    expect(modelsRow(steps)?.sub).toBe("across Anthropic, OpenAI, and Google.");
  });

  it("folds unrecognized models into 'other providers' rather than naming them", () => {
    const steps = build({
      guestOnboardingEnabled: true,
      agents: agentsWithModels(["claude-sonnet-4-6", "some-local-llm"]),
    });

    expect(modelsRow(steps)?.sub).toBe("across Anthropic and other providers.");
  });

  it("cuts the caption when no provider can be named", () => {
    const noProviders = build({
      guestOnboardingEnabled: true,
      agents: agentsWithModels(["some-local-llm"]),
    });
    const noSpend = build({ guestOnboardingEnabled: true });

    // "across other providers." carries nothing, and inventing a provider would
    // be the same false claim in a quieter voice.
    expect(modelsRow(noProviders)?.sub).toBeUndefined();
    expect(modelsRow(noSpend)?.sub).toBeUndefined();
  });
});
