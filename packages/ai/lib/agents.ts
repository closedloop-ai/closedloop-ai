import "server-only";
import {
  type InferAgentUIMessage,
  stepCountIs,
  ToolLoopAgent,
  type ToolSet,
} from "ai";
import { getAnthropic, models } from "./models";

const PRD_AGENT_INSTRUCTIONS = `You are an expert product manager assistant that helps create comprehensive Product Requirements Documents (PRDs).

Your role is to:
1. Gather requirements through thoughtful questions about the product/feature
2. Research market context, competitors, and best practices using web search when helpful
3. Structure information into a clear, actionable PRD format

When creating a PRD, include these sections as appropriate:
- Executive Summary
- Problem Statement
- Goals & Success Metrics
- User Stories & Requirements
- Scope (In/Out of Scope)
- Technical Considerations
- Dependencies & Risks
- Timeline & Milestones

Be conversational and collaborative. Ask clarifying questions to ensure the PRD captures all necessary details. Use web search to gather relevant market data, competitor information, or technical context when it would strengthen the document.`;

function asAgentToolSet<TOOLS extends Record<string, unknown>>(
  tools: TOOLS
): TOOLS & ToolSet {
  return tools as TOOLS & ToolSet;
}

// Cap how many times each Anthropic web tool may run within a single request.
// These are provider-executed tools: webSearch/webFetch run *inside* one
// Anthropic model call, not as client-side ToolLoopAgent steps, so the
// `stepCountIs` loop guard below does not bound them. `maxUses` (Anthropic's
// `max_uses`) is the only thing that stops a prompt from driving repeated
// searches/fetches until the wall-clock timeout. Generous enough for real PRD
// research while bounding runaway cost.
const PRD_AGENT_MAX_WEB_TOOL_USES = 5;

// Guardrails for the PRD tool-loop agent. Without an explicit stop condition and
// request timeout, a model that keeps calling webSearch/webFetch could loop
// indefinitely. `stepCountIs` bounds the client-side tool-call loop here (it
// matches the AI SDK's default step cap, so effective behavior is unchanged but
// the guard is now explicit and intentional); provider-side web-tool uses are
// bounded separately via `maxUses` above.
const PRD_AGENT_MAX_STEPS = 20;

// Wall-clock ceiling for a single generatePRD request. Applied by the caller at
// the streaming call site (e.g. `createAgentUIStreamResponse`) rather than in the
// constructor: a construction-time `timeout` is not honored by ToolLoopAgent's
// generate/stream path (it is overridden by the per-call `timeout`, which is
// `undefined` when unset), so it must be passed per request to take effect.
//
// Kept below the deployed route's platform function cap (Vercel `maxDuration`,
// 300s — set explicitly on apps/api/app/ai/prd/route.ts) with margin, so the SDK
// aborts and emits a controlled stream error before the platform hard-kills the
// function. The SDK timer only starts after auth/body parsing, so the margin
// also absorbs that pre-work.
export const PRD_AGENT_REQUEST_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes (<300s cap)

// Construct the agent lazily on first access. The package barrels
// (`@repo/ai`, `@repo/ai/server`) re-export `ai` alongside `agents`, so
// consumers importing only `generateText`/`generateObject`/`models` (e.g.
// documents merge-service, linear task-extractor) would otherwise pay eager
// Anthropic provider construction and ANTHROPIC_API_KEY validation just by
// loading this module. Tools and model are both sourced from the same keyed
// `getAnthropic()` instance the `models` registry uses, so they resolve one
// configured provider rather than the bare `@ai-sdk/anthropic` global.
function createGeneratePRD() {
  const anthropic = getAnthropic();
  return new ToolLoopAgent({
    model: models.sonnet,
    instructions: PRD_AGENT_INSTRUCTIONS,
    tools: asAgentToolSet({
      webFetch: anthropic.tools.webFetch_20250910({
        maxUses: PRD_AGENT_MAX_WEB_TOOL_USES,
      }),
      webSearch: anthropic.tools.webSearch_20250305({
        maxUses: PRD_AGENT_MAX_WEB_TOOL_USES,
      }),
    }),
    stopWhen: stepCountIs(PRD_AGENT_MAX_STEPS),
  });
}

let generatePRD: ReturnType<typeof createGeneratePRD> | undefined;

export const agents = {
  get generatePRD() {
    if (!generatePRD) {
      generatePRD = createGeneratePRD();
    }
    return generatePRD;
  },
} as const;

export type PRDAgentUIMessage = InferAgentUIMessage<
  ReturnType<typeof createGeneratePRD>
>;
