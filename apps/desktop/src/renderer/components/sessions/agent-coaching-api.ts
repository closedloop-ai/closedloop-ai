import { parseGeneratedTips } from "./agent-coaching-generate-parse";
import {
  buildAgentCoachingLlmRequest,
  renderAgentCoachingPrompt,
} from "./agent-coaching-llm";
import {
  buildAgentCoachingTips,
  excludedCoachingTipIds,
} from "./agent-coaching-model";
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
  bestPracticeSignals: string[] | undefined
): Promise<AgentCoachingTip[]> {
  const excludedTipIds = excludedCoachingTipIds(
    input.feedback,
    input.generatedAt
  );
  const collected: AgentCoachingTip[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < MAX_GENERATION_ROUNDS; round++) {
    if (collected.length >= AGENT_COACHING_DAILY_TIP_LIMIT) {
      break;
    }
    let batch: AgentCoachingTip[];
    try {
      batch = await generateTips(
        buildAgentCoachingLlmRequest(input, seedTips, bestPracticeSignals)
      );
    } catch {
      break;
    }
    const before = collected.length;
    for (const tip of batch) {
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
      const output = await desktopApi.generateCoachingTips(
        renderAgentCoachingPrompt(request)
      );
      return parseGeneratedTips(output);
    });
  // Resolve the active coaching pack once per call. A pack's signals REPLACE
  // the built-in defaults; absent (no pack, old bridge, or error) we pass
  // undefined so buildAgentCoachingLlmRequest uses AGENTIC_DEVELOPMENT_SIGNALS.
  const loadActivePack = (): Promise<CoachingPackInfo | null> =>
    desktopApi.getCoachingPack?.().catch(() => null) ?? Promise.resolve(null);
  return {
    loadActivePack,
    loadTips: async () => {
      const [analytics, workflow, recentEvents, skills, activePack] =
        await Promise.all([
          desktopApi.db.getAnalytics().catch(() => null),
          desktopApi.db.getWorkflowData().catch(() => null),
          desktopApi.db.getEventFeed().catch(() => []),
          desktopApi.db.getAllSkills().catch(() => []),
          loadActivePack(),
        ]);
      const input = {
        analytics,
        feedback: loadAgentCoachingFeedback(storage),
        generatedAt: new Date(),
        recentEvents,
        skills,
        workflow,
      };
      const seedTips = buildAgentCoachingTips(input);
      const collected = await collectGeneratedTips(
        generateTips,
        input,
        seedTips,
        activePack?.signals
      );
      // The harness is the source of truth when it produces tips; the local
      // heuristic seed is the fallback when it returns nothing or errors. The
      // pack is returned alongside so the badge matches the signals just used.
      const tips =
        collected.length > 0
          ? collected.slice(0, AGENT_COACHING_DAILY_TIP_LIMIT)
          : seedTips;
      return { tips, activePack };
    },
    recordFeedback: (event: AgentCoachingFeedbackEvent) => {
      appendAgentCoachingFeedback(event, storage);
      return Promise.resolve();
    },
    installArtifact: (draft: string, harness?: string) =>
      desktopApi.installCoachingArtifact(draft, harness),
  };
}
