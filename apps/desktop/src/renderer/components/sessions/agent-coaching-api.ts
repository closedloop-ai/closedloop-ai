import { parseGeneratedTips } from "./agent-coaching-generate-parse";
import {
  buildAgentCoachingLlmRequest,
  renderAgentCoachingPrompt,
} from "./agent-coaching-llm";
import {
  hasSubstantiveCoachingActivity,
  summarizeLookback,
} from "./agent-coaching-lookback";
import {
  buildAgentCoachingTips,
  excludedCoachingTipIds,
  filterGeneratedTipsByWarrantedLevers,
  warrantedLeversForInput,
} from "./agent-coaching-model";
import { dedupeGeneratedTipsByLever } from "./agent-coaching-scoring";
import {
  appendAgentCoachingFeedback,
  loadAgentCoachingFeedback,
} from "./agent-coaching-storage";
import {
  AGENT_COACHING_DAILY_TIP_LIMIT,
  type AgentCoachingApi,
  type AgentCoachingDesktopApi,
  type AgentCoachingFeedbackEvent,
  type AgentCoachingInput,
  type AgentCoachingLlmProvider,
  type AgentCoachingTip,
  type CoachingPackInfo,
} from "./agent-coaching-types";

type CreateAgentCoachingApiOptions = {
  generateTips?: AgentCoachingLlmProvider;
};

// The harness is non-deterministic, so we generate in a few rounds to fill the
// startup batch toward the daily target, stopping early once full or once a
// round adds nothing new.
const MAX_GENERATION_ROUNDS = 3;

/**
 * Generate tips over a few bounded rounds, accumulating unique ones toward the
 * daily target. Tips the user dismissed-forever or acted on today are filtered
 * out here regardless of what the generator returns (defense in depth — the
 * prompt asks, but we don't trust a non-compliant/deterministic provider).
 */
async function collectGeneratedTips(
  generateTips: AgentCoachingLlmProvider,
  input: AgentCoachingInput,
  seedTips: AgentCoachingTip[],
  bestPracticeSignals: string[] | undefined,
  // FEA-3722/FEA-3837: the caller's selected date range, threaded into the
  // request so the prompt's window label matches the selector (all-time renders
  // as "all time", not the 30-day default). Mirrors what loadTips passes to the
  // groundedMetrics it returns, so the prompt and the Coding Wrap agree.
  lookbackDays: number | null | undefined
): Promise<AgentCoachingTip[]> {
  // An empty-activity corpus (no sessions, events, tokens, or captured events)
  // can't ground a concrete, QUANTIFIED tip — the prompt's hard requirement — so
  // the model correctly refuses. Short-circuit BEFORE the generation loop to
  // skip the (up to MAX_GENERATION_ROUNDS, ~9s each) local `claude -p` spawn
  // entirely; returning [] makes loadTips fall back to the built-in seed tips
  // exactly as it already does when generation yields nothing.
  if (!hasSubstantiveCoachingActivity(input)) {
    return [];
  }
  const excludedTipIds = excludedCoachingTipIds(
    input.feedback,
    input.generatedAt
  );
  // FEA-4179: the levers the user's ACTUAL usage warrants — the SAME per-lever
  // determinism gates the seed builders enforce. Computed ONCE here (the input
  // is invariant across the bounded rounds) and reused to drop each round's
  // ungrounded generated tips. Without this, a lever the model emits but the
  // metrics don't warrant (e.g. a "you're not using plan mode" tip shown to
  // someone who is) would surface, since a nonempty batch REPLACES the
  // deterministically-gated seed tips.
  const warrantedLevers = warrantedLeversForInput(input);
  // No lever is warranted by the user's real usage — every generated tip would
  // be dropped by filterGeneratedTipsByWarrantedLevers below regardless of what
  // the model returns, so skip the (up to MAX_GENERATION_ROUNDS × ~9s) local
  // `claude -p` spawn entirely. loadTips then falls back to the seed tips, whose
  // per-lever gates would likewise surface nothing for this corpus.
  if (warrantedLevers.size === 0) {
    return [];
  }
  const collected: AgentCoachingTip[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < MAX_GENERATION_ROUNDS; round++) {
    if (collected.length >= AGENT_COACHING_DAILY_TIP_LIMIT) {
      break;
    }
    let batch: AgentCoachingTip[];
    try {
      batch = await generateTips(
        buildAgentCoachingLlmRequest(
          input,
          seedTips,
          bestPracticeSignals,
          lookbackDays,
          // FEA-4179: constrain the prompt to the warranted levers (computed
          // once above) so the generator produces only warranted-lever
          // categories up front — the post-filter below stays as
          // defense-in-depth against a non-compliant provider.
          warrantedLevers
        )
      );
    } catch {
      break;
    }
    // Drop this round's tips for any lever the user's usage doesn't warrant.
    const grounded = filterGeneratedTipsByWarrantedLevers(
      batch,
      warrantedLevers
    );
    const before = collected.length;
    for (const tip of grounded) {
      if (!(seen.has(tip.id) || excludedTipIds.has(tip.id))) {
        seen.add(tip.id);
        collected.push(tip);
      }
    }
    // Stop once a round produces nothing new (e.g. deterministic fallback).
    if (collected.length === before) {
      break;
    }
  }
  return collected;
}

export function createAgentCoachingApi(
  desktopApi: AgentCoachingDesktopApi,
  storage: Storage = window.localStorage,
  options: CreateAgentCoachingApiOptions = {}
): AgentCoachingApi {
  // Default generator: render the prompt and run it through the local harness
  // (`claude -p`) in the main process, then validate the JSON it returns. A test
  // can inject `options.generateTips` to bypass the spawn.
  const generateTips: AgentCoachingLlmProvider =
    options.generateTips ??
    (async (request) => {
      const result = await desktopApi.generateCoachingTips(
        renderAgentCoachingPrompt(request)
      );
      // Operational failures (timeout / spawn error / non-zero exit) come back as
      // a structured `ok:false` — never a throw. Treat them as "no tips this
      // round" so collectGeneratedTips stops and loadTips falls back to the
      // built-in seed tips (a clean state, not a raw handler error).
      if (!result.ok) {
        return [];
      }
      return parseGeneratedTips(result.output);
    });
  // Resolve the active coaching pack once per call. A pack's signals REPLACE
  // the built-in defaults; absent (no pack, old bridge, or error) we pass
  // undefined so buildAgentCoachingLlmRequest uses AGENTIC_DEVELOPMENT_SIGNALS.
  const loadActivePack = (): Promise<CoachingPackInfo | null> =>
    desktopApi.getCoachingPack?.().catch(() => null) ?? Promise.resolve(null);
  // Bridge the live local-DB push to a plain "activity changed" callback so the
  // renderer can wait for the corpus to populate before kicking off generation
  // (startup backfill race). Absent bridge → undefined → the component loads
  // once on mount with no wait. The `sessionId` payload is irrelevant here: any
  // DB write may be the backfill landing sessions/events/tokens, so we re-check.
  const onDbChanged = desktopApi.onDbChanged;
  const subscribeToActivity: AgentCoachingApi["subscribeToActivity"] =
    onDbChanged ? (onChange) => onDbChanged(() => onChange()) : undefined;
  return {
    loadActivePack,
    subscribeToActivity,
    loadTips: async (lookbackDays?: number | null) => {
      // A failed skills read must not read as "no skills" — track the failure so
      // capability-gap coaching treats it as unavailable, not a false zero.
      let skillsUnavailable = false;
      const [analytics, workflow, recentEvents, skills, activePack] =
        await Promise.all([
          // FEA-3722: window the analytics to the caller's selected date range
          // (undefined → default, positive number → that window, `null` →
          // all-time) so the Coding Wrap mirrors the top 7d/30d/90d/All selector.
          desktopApi.db.getAnalytics(lookbackDays).catch(() => null),
          desktopApi.db.getWorkflowData().catch(() => null),
          desktopApi.db.getEventFeed().catch(() => []),
          desktopApi.db.getAllSkills().catch(() => {
            skillsUnavailable = true;
            return [];
          }),
          loadActivePack(),
        ]);
      const input = {
        analytics,
        feedback: loadAgentCoachingFeedback(storage),
        generatedAt: new Date(),
        recentEvents,
        skills,
        skillsUnavailable,
        workflow,
      };
      const seedTips = buildAgentCoachingTips(input);
      const collected = await collectGeneratedTips(
        generateTips,
        input,
        seedTips,
        activePack?.signals,
        lookbackDays
      );
      // The harness is the source of truth when it produces tips; the local
      // heuristic seed is the fallback when it returns nothing or errors. The
      // pack is returned alongside so the badge matches the signals just used.
      // Apply the SAME diversity guarantee to harness output as the heuristic
      // pool gets from rankCandidatePool: dedupe to one tip per lever and cap at
      // the daily limit, so a non-compliant generator can't surface two tips
      // that pull the same lever (e.g. two "make a skill" reuse tips). We can't
      // re-rank by impact here (generated tips carry no scored lever/impact), so
      // the generator's own ordering is preserved.
      const tips =
        collected.length > 0
          ? dedupeGeneratedTipsByLever(
              collected,
              AGENT_COACHING_DAILY_TIP_LIMIT
            )
          : seedTips;
      // Surface the same lookback metrics the generator saw so the Coding
      // Wrapped deck (FEA-3403) can render fun-fact cards without a second pass.
      // summarizeLookback is pure over the input already gathered above, so this
      // adds no IPC and no LLM cost.
      // FEA-3722: pass the requested lookback so the Wrap's window label matches
      // the selected range even for all-time (`null`), where the DB reports a 0
      // windowDays sentinel that must not be shown as "last 30 days".
      return {
        tips,
        activePack,
        groundedMetrics: summarizeLookback(input, lookbackDays),
      };
    },
    recordFeedback: (event: AgentCoachingFeedbackEvent) => {
      appendAgentCoachingFeedback(event, storage);
      return Promise.resolve();
    },
    installArtifact: async (draft: string, harness?: string, kind?: string) => {
      // The install resolves to a structured result; map an operational failure
      // to a thrown Error so useDraftInstaller's existing catch renders a clean
      // "couldn't install, retry" message rather than a raw handler error. `kind`
      // dispatches deterministic new-file vs LLM-driven edit-existing install.
      const result = await desktopApi.installCoachingArtifact(
        draft,
        harness,
        kind
      );
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.output;
    },
  };
}
