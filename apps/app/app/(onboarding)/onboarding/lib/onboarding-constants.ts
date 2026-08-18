import { OnboardingStep } from "@repo/api/src/types/onboarding";
import { z } from "zod";

/**
 * ISS-5490: the wizard sequence — the two steps that genuinely gate entry.
 *
 * A team and a project are structural: nothing in the product has anywhere to
 * live without them, and the checklist's own completion derivation keys off
 * their existence. Everything the previous nine-step sequence also asked for
 * (desktop download, GitHub, Anthropic key, optional integrations, teammates)
 * is a row in the "Complete Your Setup" checklist on My Tasks, derived from
 * live data, so gating on it up front asked for it twice and blocked the
 * product on the first ask.
 *
 * Typed as `readonly OnboardingStep[]` rather than the literal tuple so
 * `indexOf`/`includes` still accept a step restored from an older build.
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  OnboardingStep.CreateTeam,
  OnboardingStep.CreateProject,
];

const WIZARD_STATE_KEY = "onboarding_wizard_state";

const WIZARD_STATE_SCHEMA = z.object({
  currentStep: z.enum(OnboardingStep),
  createdTeamId: z.string().nullable(),
  createdTeamName: z.string().nullable(),
  createdProjectId: z.string().nullable(),
  createdProjectName: z.string().nullable(),
});

export type WizardState = z.infer<typeof WIZARD_STATE_SCHEMA>;

export function saveWizardState(state: WizardState): void {
  try {
    sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(state));
  } catch {
    // sessionStorage may be unavailable (e.g. private browsing quota exceeded)
  }
}

/**
 * Read the persisted wizard state, or `null` when there isn't a usable one.
 *
 * Validated rather than cast: `sessionStorage` is a parse boundary, so the
 * stored blob can be any shape a previous build, a half-finished write, or a
 * user with devtools left behind. A cast would hand the wizard a `WizardState`
 * that is missing fields it renders from.
 */
export function loadWizardState(): WizardState | null {
  try {
    const raw = sessionStorage.getItem(WIZARD_STATE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = WIZARD_STATE_SCHEMA.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Resolve which step a restored state may actually open on.
 *
 * Takes the whole state, not just the step, because a step is only reachable
 * with the identities it renders from. Two ways a stored state dead-ends:
 *
 * - The step is not in this sequence. `WizardState` outlives a deploy, so a user
 *   mid-wizard when ISS-5490 shipped restores `WELCOME`, `CONNECT_GITHUB`, … and
 *   the wizard, which renders per-step, matches no branch.
 * - The step is `CREATE_PROJECT` but no team was created. The project step needs
 *   a team to attach the project to, so the wizard guards on it — and a state
 *   that passes the first check fails that guard, which is the same blank card
 *   by a different route.
 *
 * Either way the fallback is the sequence's first step: at most a re-entered
 * team name, against a card with no way forward.
 */
export function clampStep(state: WizardState): OnboardingStep {
  if (
    state.currentStep === OnboardingStep.CreateProject &&
    state.createdTeamId === null
  ) {
    return ONBOARDING_STEPS[0];
  }
  return ONBOARDING_STEPS.includes(state.currentStep)
    ? state.currentStep
    : ONBOARDING_STEPS[0];
}

export function clearWizardState(): void {
  try {
    sessionStorage.removeItem(WIZARD_STATE_KEY);
  } catch {
    // sessionStorage may be unavailable
  }
}

/** Where the finished wizard hands off. */
export const POST_WIZARD_ROUTE = "/my-tasks?from=onboarding";
