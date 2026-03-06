import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withMcpTools } from "./allowed-tools";
import { parseToon } from "./toon-parser";

/**
 * Read org-patterns.toon and format as context block for Claude prompts.
 * Returns empty string if no patterns exist.
 */
export function getOrgPatternsContext(): string {
  try {
    const filePath = join(
      homedir(),
      ".closedloop-ai",
      "learnings",
      "org-patterns.toon"
    );
    if (!existsSync(filePath)) {
      return "";
    }

    const content = readFileSync(filePath, "utf-8");
    const patterns = parseToon(content);
    if (patterns.length === 0) {
      return "";
    }

    const lines = patterns.map((p) => {
      const contextStr =
        p.context.length > 0 ? ` [context: ${p.context.join("|")}]` : "";
      return `[${p.confidence}] ${p.id} (${p.category}): ${p.summary}${contextStr}`;
    });

    return [
      "<organization-learnings>",
      "# Patterns from organization knowledge base",
      ...lines,
      "Apply relevant patterns when helping the user.",
      "</organization-learnings>",
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * Agent attribution mapping from active tab or state phase.
 */
const TAB_AGENT_MAP: Record<string, string[]> = {
  plan: ["code:plan-writer"],
  changes: ["code:implementation-subagent"],
  comments: ["code:code-reviewer"],
};

const PHASE_AGENT_MAP: Record<string, string[]> = {
  "1": ["code:plan-writer"],
  "1.1": ["code:plan-writer"],
  "1.2": ["code:plan-writer"],
  "1.2a": ["code:plan-writer"],
  "3": ["code:implementation-subagent"],
  "4": ["code-simplifier:code-simplifier"],
  "5": ["code:build-validator"],
};

function resolveAgentAttribution(activeTab?: string, phase?: string): string {
  if (activeTab && TAB_AGENT_MAP[activeTab]) {
    return JSON.stringify(TAB_AGENT_MAP[activeTab]);
  }
  if (phase && PHASE_AGENT_MAP[phase]) {
    return JSON.stringify(PHASE_AGENT_MAP[phase]);
  }
  return '["*"]';
}

/**
 * Return a <learning-capture> instruction block for the Claude prompt.
 */
export function getLearningCaptureInstruction(
  symphonyWorkDir: string,
  activeTab?: string
): string {
  // Try to read state.json for phase info
  let phase: string | undefined;
  try {
    const statePath = join(symphonyWorkDir, "state.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      phase = state.phase?.toString();
    }
  } catch {
    // ignore
  }

  const defaultAgent = resolveAgentAttribution(activeTab, phase);

  return [
    "<learning-capture>",
    "If you notice a genuine learning during this conversation (a mistake corrected, a pattern discovered,",
    "a convention clarified), you may write it as a JSON file to the pending learnings directory.",
    "",
    `Directory: ${join(symphonyWorkDir, ".learnings", "pending")}/`,
    "Filename format: chat-{timestamp}.json",
    "",
    "JSON schema for each learning file:",
    "```json",
    "{",
    '  "learnings": [',
    "    {",
    '      "id": "L-chat-{short-description}",',
    '      "category": "pattern|mistake|convention|insight",',
    '      "summary": "concise description",',
    '      "confidence": "high|medium|low",',
    `      "applies_to": ${defaultAgent},`,
    '      "source": "interactive-chat",',
    '      "context": ["relevant-context-tags"]',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "Agent attribution guidance:",
    '- Plan/PRD issues → applies_to: ["code:plan-writer"]',
    '- Code/implementation issues → applies_to: ["code:implementation-subagent"]',
    '- Code review issues → applies_to: ["code:code-reviewer"]',
    "- File context: plan.json/plan.md → plan-writer, test files → test-engineer, source code → implementation-subagent",
    "",
    "Only capture genuine learnings — not every interaction needs one.",
    "</learning-capture>",
  ].join("\n");
}

type ExtractionOptions = {
  symphonyWorkDir: string;
  worktreeDir: string;
  chatHistoryPath: string;
  activeTab?: string;
  ticketId?: string;
};

/**
 * Fire-and-forget async learning extraction from a chat session.
 * Spawns a detached Claude process to analyze the chat history and extract learnings.
 */
export function triggerAsyncLearningExtraction(opts: ExtractionOptions): void {
  const { symphonyWorkDir, worktreeDir, chatHistoryPath, activeTab, ticketId } =
    opts;

  const learningsDir = join(symphonyWorkDir, ".learnings");
  const pendingDir = join(learningsDir, "pending");
  const lockPath = join(learningsDir, ".lock");
  const statusPath = join(learningsDir, "chat-extraction-status.json");

  // If automated loop is running (lock present), skip — it handles learnings
  if (existsSync(lockPath)) {
    console.log(
      "[Learnings] Lock file present, skipping extraction (automated loop will handle)"
    );
    return;
  }

  // Ensure directories exist
  if (!existsSync(pendingDir)) {
    mkdirSync(pendingDir, { recursive: true });
  }

  // Write initial status
  writeFileSync(
    statusPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      count: 0,
      status: "processing",
    })
  );

  // Read state.json for context
  let stateContext = "";
  try {
    const statePath = join(symphonyWorkDir, "state.json");
    if (existsSync(statePath)) {
      stateContext = `\nState file at: ${statePath}`;
    }
  } catch {
    // ignore
  }

  const timestamp = Date.now();
  const outputFile = `chat-${ticketId || "unknown"}-${timestamp}.json`;
  const defaultAgent = resolveAgentAttribution(activeTab);

  const extractionPrompt = `You are analyzing a chat conversation to extract learnings.

Read the chat history at: ${chatHistoryPath}
${stateContext}

Your task:
1. Read the chat history file
2. Identify user corrections, mistakes fixed, patterns discovered, or conventions clarified.
   Messages with \`"sender": "codex"\` are from a second AI reviewer (OpenAI Codex) that was consulted — either via a structured debate or a one-off forward. Pay special attention to:
   - Disagreements between Claude and Codex: what did Codex catch that Claude missed?
   - Corrections Codex provided that led to a better solution
   - Cases where Codex's analysis changed the outcome
   These cross-model corrections are high-confidence learnings.
3. For each genuine learning, determine the responsible agent:
   - Active tab hint: ${activeTab || "none"} → default agent: ${defaultAgent}
   - If the conversation is about plan issues → applies_to: ["code:plan-writer"]
   - If about code/implementation → applies_to: ["code:implementation-subagent"]
   - If about code review → applies_to: ["code:code-reviewer"]
   - If about plan.json or plan.md files → applies_to: ["code:plan-writer"]
   - If about test files → applies_to: ["code:build-validator"]
   - Otherwise → applies_to: ["*"]
4. Write the learnings JSON file to: ${join(pendingDir, outputFile)}
5. After writing, read the file back to verify it was written correctly

JSON schema:
{
  "learnings": [
    {
      "id": "L-chat-{short-description}",
      "category": "pattern|mistake|convention|insight",
      "summary": "concise description of the learning",
      "confidence": "high|medium|low",
      "applies_to": ["agent-name"],
      "source": "interactive-chat",
      "context": ["relevant-tags"]
    }
  ]
}

If there are no genuine learnings to extract (routine Q&A, no corrections), write:
${join(pendingDir, outputFile)} with { "learnings": [] }

Then update the status file at: ${statusPath}
Write: { "timestamp": "<current ISO timestamp>", "count": <number of learnings>, "status": "completed" }

Be selective — only capture things that would help agents do better in the future.`;

  try {
    const child = spawn(
      "claude",
      [
        "-p",
        "--model",
        "sonnet",
        `--allowedTools=${withMcpTools("Read,Write,Glob")}`,
        "--max-turns",
        "20",
      ],
      {
        cwd: worktreeDir,
        env: {
          ...process.env,
          CLOSEDLOOP_WORKDIR: symphonyWorkDir,
          PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
        },
        stdio: ["pipe", "ignore", "ignore"],
        detached: true,
      }
    );

    child.stdin.write(extractionPrompt);
    child.stdin.end();
    child.unref();

    console.log(
      `[Learnings] Extraction spawned (PID: ${child.pid}) for ${ticketId || "unknown"}`
    );
  } catch (err) {
    console.error("[Learnings] Failed to spawn extraction:", err);
    // Write error status
    writeFileSync(
      statusPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        count: 0,
        status: "error",
      })
    );
  }
}

/**
 * Return a prompt instruction block telling Claude to attribute which learnings it used.
 * Reusable across all chat routes that inject org-patterns.
 */
export function getLearningAttributionInstruction(): string {
  return [
    "<learning-attribution>",
    "Whenever you reference, apply, or draw on a learning from <organization-learnings> or a convention from CLAUDE.md to answer a question,",
    "include a <learnings-used> JSON array at the END of your response (after all other content).",
    "This includes confirmations, recalls, and direct answers — not just proactive recommendations.",
    "When in doubt, include the attribution. Err on the side of over-attributing rather than under-attributing.",
    "",
    "Format:",
    "<learnings-used>",
    '[{"id":"P-117","source":"org-patterns","category":"mistake","summary":"Brief description","confidence":"high","context":["refactoring"]}]',
    "</learnings-used>",
    "",
    "ID conventions:",
    '- For org-patterns: use the exact id from the <organization-learnings> block (e.g. "P-117")',
    '- For CLAUDE.md conventions: use "claude-md:" followed by a short descriptive slug (e.g. "claude-md:use-replaceall", "claude-md:no-force-push", "claude-md:globalthis-over-window")',
    "",
    "Fields:",
    '- source: "org-patterns" or "claude.md"',
    '- category: copy from the original learning, or use "convention" for CLAUDE.md rules',
    '- confidence: copy from the original, or "high" for explicit CLAUDE.md rules',
    "- summary: the convention text or a brief paraphrase",
    "- context: relevant tags (optional)",
    "",
    "Examples:",
    "",
    'User asks: "How do I replace strings globally?"',
    "You answer referencing the CLAUDE.md rule about String#replaceAll:",
    "<learnings-used>",
    '[{"id":"claude-md:use-replaceall","source":"claude.md","category":"convention","summary":"Use String#replaceAll() instead of String#replace() with global regex","confidence":"high"}]',
    "</learnings-used>",
    "",
    "User asks you to refactor code, and you apply org-pattern P-42:",
    "<learnings-used>",
    '[{"id":"P-42","source":"org-patterns","category":"pattern","summary":"Extract helper functions to flatten deeply nested branches","confidence":"high","context":["refactoring"]}]',
    "</learnings-used>",
    "",
    "If no learnings or conventions were used, do NOT include this block.",
    "</learning-attribution>",
  ].join("\n");
}
