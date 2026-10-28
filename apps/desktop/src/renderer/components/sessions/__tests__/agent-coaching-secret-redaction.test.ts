import { describe, expect, it } from "vitest";
import type {
  AnalyticsData,
  EventWithSession,
  WorkflowQueryData,
} from "../../../../shared/agent-db-contract";
import {
  buildAgentCoachingLlmRequest,
  renderAgentCoachingPrompt,
} from "../agent-coaching-llm";
import { buildAgentCoachingTips } from "../agent-coaching-model";
import type { AgentCoachingInput } from "../agent-coaching-types";

/**
 * ISS-6709. The coaching LLM seam is pluggable and may point at an EXTERNAL
 * provider, so every evidence string that reaches the outbound request must be
 * scrubbed by the SHARED pattern set (`@repo/lib/security/redact-secrets`), not
 * a renderer-local list that knew only `sk_live_`/`sk_test_`/`Bearer`.
 *
 * These tests drive the two production entry points that build outbound payloads
 * — never `redactSecrets` directly — and assert on the SERIALIZED payload, so a
 * pattern family that the redactor does not know shows up as a leak here.
 *
 * Failure output carries only family LABELS, never the secret bytes: an
 * `expect(payload).not.toContain(secret)` would render the secret into stdout,
 * the HTML report, and the JSON results on failure.
 */

const GENERATED_AT = new Date("2026-06-18T12:00:00.000Z");

/**
 * One synthetic credential per family the shared redactor knows. Every value is
 * obviously fake (`SYNTHETIC` + filler) but still matches the real provider
 * grammar, so it exercises the same regex a live credential would.
 *
 * `secret` is the substring that must NOT survive into an outbound payload. For
 * the `Authorization:` header form that is the CREDENTIAL only — the redactor
 * deliberately preserves the header name and scheme.
 */
const SECRET_FAMILIES = [
  { label: "sk_live", secret: "sk_live_SYNTHETIC0000000000000000" },
  {
    label: "ghp (github pat)",
    secret: "ghp_SYNTHETIC0000000000000000000000000",
  },
  {
    label: "github_pat (fine-grained)",
    secret: "github_pat_SYNTHETIC11AAAAAAAAAAAAAAAAAAAAAAAA",
  },
  {
    label: "sk-ant (anthropic)",
    secret: "sk-ant-api03-SYNTHETIC000000000000000000000000000",
  },
  {
    label: "sk-proj (openai)",
    secret: "sk-proj-SYNTHETIC000000000000000000000000",
  },
  { label: "AKIA (aws)", secret: "AKIASYNTHETIC0000000" },
  {
    label: "AIza (google)",
    secret: "AIzaSYNTHETIC00000000000000000000000000",
  },
  {
    label: "xoxb (slack)",
    secret: "xoxb-000000000000-000000000000-SYNTHETICabcdefgh",
  },
  { label: "whsec (stripe webhook)", secret: "whsec_SYNTHETIC00000000000000" },
  // ISS-6799: the five families that had lived only in the TELEMETRY vocabulary
  // (`packages/loops-api/src/secret-value-pattern.ts`) and so reached this seam
  // in clear. Delete any one of them from the transcript set
  // (`packages/lib/security/redact-secrets.ts`) and its label reappears in
  // `leaked` on every case below.
  {
    label: "ya29 (google oauth access token)",
    secret: "ya29.SYNTHETIC0000000000000000",
  },
  {
    label: "1// (google oauth refresh token)",
    secret: "1//SYNTHETIC00000000000000000000",
  },
  { label: "glpat (gitlab pat)", secret: "glpat-SYNTHETIC0000000000000000" },
  { label: "npm_ (npm token)", secret: "npm_SYNTHETIC0000000000000000" },
  { label: "re_ (resend key)", secret: "re_SYNTHETIC0000000000000000" },
  {
    label: "Authorization header credential",
    secret: "SYNTHETICauthorizationheadertoken0000",
  },
  // ISS-6992: two shapes the TELEMETRY vocabulary was missing. `ghr_` was
  // already covered HERE, so it is the segmented Resend key that was reaching
  // this seam — `re_<seg>_<seg>` whose first segment is under 10 chars clears
  // this file's digit-and-uppercase guard but was crossing an underscore the
  // telemetry twin's body class could not.
  {
    label: "re_ segmented (resend key)",
    secret: "re_SYNTH0aB_0000000000000000AbC1",
  },
  {
    label: "ghr (github refresh token)",
    secret: "ghr_SYNTHETIC0000000000000000000000000",
  },
  // ISS-6993: families that were in NEITHER vocabulary and so reached this seam
  // — a pluggable, possibly EXTERNAL provider — in clear. Same contract as the
  // ISS-6799 block above: delete any one from the transcript set and its label
  // reappears in `leaked` on every case below.
  //
  // PEM private-key blocks are the one ISS-6993 family absent from this array,
  // and deliberately: every case here plants its evidence as a single shell
  // token or a `-H` argument, and a PEM block is neither. It has its own
  // free-text case at the end of the describe rather than a fixture that
  // pretends a key block is a command argument.
  {
    label: "eyJ (bare jwt)",
    secret: "eyJTWU5USEVUSUM.eyJzdWIiOiJTWU5USCJ9.SYNTHETIC0000signature",
  },
  { label: "hf_ (hugging face)", secret: "hf_SYNTHETIC0000000000000000" },
  { label: "gsk_ (groq)", secret: "gsk_SYNTHETIC0000000000000000" },
  {
    label: "SG. (sendgrid)",
    secret: "SG.SYNTHETIC0000000.SYNTHETIC0000000000000000",
  },
  {
    label: "dapi (databricks)",
    secret: "dapi0123456789abcdef0123456789abcdef",
  },
  { label: "figd_ (figma)", secret: "figd_SYNTHETIC0000000000000000" },
  { label: "lin_api_ (linear)", secret: "lin_api_SYNTHETIC0000000000000000" },
  // The redactor preserves the scheme and host and redacts only the userinfo
  // run, so `secret` is that run alone — asserting on the whole URL would go
  // green on a redactor that scrubbed the HOST and left the password.
  { label: "url userinfo credential", secret: "SYNTHuser:SYNTHpw0000" },
] as const;

/** The `Authorization:` family only redacts inside a real header form. */
const AUTHORIZATION_HEADER_LABEL = "Authorization header credential";
/** Likewise, userinfo only redacts inside a real `scheme://…@host` URL. */
const URL_USERINFO_LABEL = "url userinfo credential";
const URL_USERINFO_HOST = "@db.internal:5432/app";

/**
 * Whether a PEM body survived, reported as a LABEL list like
 * `leakedFamilyLabels` — a bare `not.toContain` would render the key bytes into
 * stdout, the HTML report, and the JSON results on failure.
 */
function leakedPemLabels(payload: string, body: string): string[] {
  return payload.includes(body) ? ["pem private-key body"] : [];
}

function evidenceTextFor(family: (typeof SECRET_FAMILIES)[number]): string {
  if (family.label === AUTHORIZATION_HEADER_LABEL) {
    return `Authorization: Token ${family.secret}`;
  }
  if (family.label === URL_USERINFO_LABEL) {
    return `postgres://${family.secret}${URL_USERINFO_HOST}`;
  }
  return family.secret;
}

/** Every family's evidence in one blob, for the free-text event fields. */
const ALL_FAMILIES_EVIDENCE = SECRET_FAMILIES.map(evidenceTextFor).join(" ");

/**
 * Which families survive into `payload`. Returns LABELS so a failing assertion
 * names the unredacted families without printing any credential bytes.
 */
function leakedFamilyLabels(payload: string): string[] {
  return SECRET_FAMILIES.filter((family) =>
    payload.includes(family.secret)
  ).map((family) => family.label);
}

describe("agent coaching outbound payloads redact every shared secret family (ISS-6709)", () => {
  it("scrubs recent-event free text out of the LLM request and its rendered prompt", () => {
    const request = buildAgentCoachingLlmRequest(
      makeInput({ recentEvents: secretBearingEvents() }),
      []
    );

    expect(leakedFamilyLabels(JSON.stringify(request))).toEqual([]);
    expect(leakedFamilyLabels(renderAgentCoachingPrompt(request))).toEqual([]);
  });

  it("scrubs representative repeated commands out of the generated tips", () => {
    const leaked: string[] = [];
    const familiesWithNoEvidenceInOutput: string[] = [];

    for (const family of SECRET_FAMILIES) {
      const serialized = JSON.stringify(
        buildAgentCoachingTips(
          makeInput({ recentEvents: repeatedSecretCommandEvents(family) })
        )
      );
      leaked.push(...leakedFamilyLabels(serialized));
      // Without this, the clean result above is satisfied by a run that produced
      // no reuse tip at all (an empty pool, or the evidence-carrying candidate
      // losing the one-per-lever contest in rankCandidatePool) — the redaction
      // call site would go dark and this test would stay green.
      if (!serialized.includes("[REDACTED:")) {
        familiesWithNoEvidenceInOutput.push(family.label);
      }
    }

    expect(leaked).toEqual([]);
    expect(familiesWithNoEvidenceInOutput).toEqual([]);
  });

  it("scrubs credentials carried in the family-deriving first token from both seedTips and groundedMetrics", () => {
    const leaked: string[] = [];
    const familiesWithNoFamilyEvidence: string[] = [];
    const familiesWithNoSeedEvidence: string[] = [];

    for (const family of SECRET_FAMILIES) {
      const input = makeInput({
        recentEvents: envPrefixSecretCommandEvents(family),
      });
      // The real production order: seed tips are built first, then handed to the
      // request builder — so ONE serialized payload carries both the seedTips
      // and the groundedMetrics that reach the provider.
      const seedTips = buildAgentCoachingTips(input);
      const request = buildAgentCoachingLlmRequest(input, seedTips);

      leaked.push(
        ...leakedFamilyLabels(JSON.stringify(request)),
        ...leakedFamilyLabels(renderAgentCoachingPrompt(request))
      );
      // Without these the assertion above is satisfied by a run that derived no
      // family and produced no tip at all — the leak path would go dark and this
      // test would stay green under the very defect it exists to catch.
      if (request.groundedMetrics.repeatedCommandFamilies.length === 0) {
        familiesWithNoFamilyEvidence.push(family.label);
      }
      if (!JSON.stringify(request.seedTips).includes("[REDACTED:")) {
        familiesWithNoSeedEvidence.push(family.label);
      }
    }

    expect(leaked).toEqual([]);
    expect(familiesWithNoFamilyEvidence).toEqual([]);
    expect(familiesWithNoSeedEvidence).toEqual([]);
  });

  it("scrubs the tool name, an unconstrained hook-input string, out of the request and prompt", () => {
    const request = buildAgentCoachingLlmRequest(
      makeInput({ recentEvents: [secretToolNameEvent()] }),
      []
    );
    const prompt = renderAgentCoachingPrompt(request);

    expect(leakedFamilyLabels(JSON.stringify(request))).toEqual([]);
    expect(leakedFamilyLabels(prompt)).toEqual([]);
    // Non-vacuous: `formatSessionLogExcerpts` must actually have rendered this
    // event's tool name into the prompt, so a run that dropped the excerpt
    // entirely cannot satisfy the two assertions above.
    expect(prompt).toContain("[REDACTED:");
  });

  it("scrubs a PEM private-key block out of free-text evidence (ISS-6993)", () => {
    // The one ISS-6993 family absent from SECRET_FAMILIES, because every case
    // there plants its evidence as a shell token or a `-H` argument and a key
    // block is neither. Free text is how one actually arrives on this seam — a
    // user pasting a deploy key into a prompt — and this seam forwards to a
    // pluggable, possibly EXTERNAL provider.
    const body = "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLI";
    const pem = `-----BEGIN RSA PRIVATE KEY----- ${body} -----END RSA PRIVATE KEY-----`;
    const request = buildAgentCoachingLlmRequest(
      makeInput({
        recentEvents: [
          promptEvent(`use ${pem} to deploy`),
          promptEvent(`use ${pem} to deploy`),
        ],
      }),
      []
    );
    const serialized = JSON.stringify(request);
    const prompt = renderAgentCoachingPrompt(request);

    expect(leakedPemLabels(serialized, body)).toEqual([]);
    expect(leakedPemLabels(prompt, body)).toEqual([]);
    // Non-vacuous: the evidence must actually have reached the payload, so a run
    // that dropped the excerpt entirely cannot satisfy the assertions above.
    expect(serialized).toContain("[REDACTED:");
  });

  it("leaves evidence with no credential-shaped substring untouched", () => {
    const clean = "pnpm turbo test --filter=desktop then read the failing spec";
    const request = buildAgentCoachingLlmRequest(
      makeInput({ recentEvents: [promptEvent(clean), promptEvent(clean)] }),
      []
    );

    const serialized = JSON.stringify(request);
    expect(serialized).toContain(clean);
    expect(serialized).not.toContain("[REDACTED:");
  });
});

/**
 * Evidence planted on every free-text field the request builder forwards:
 * `summary` and `data` on a tool event (redacted in `agent-coaching-llm.ts`),
 * plus a human-turn prompt and a frustration turn (redacted in
 * `agent-coaching-lookback.ts`, reached through `summarizeLookback`).
 */
function secretBearingEvents(): EventWithSession[] {
  return [
    {
      agentId: null,
      createdAt: "2026-06-17T00:00:00.000Z",
      data: ALL_FAMILIES_EVIDENCE,
      eventType: "tool_use",
      id: "secret-tool-event",
      sessionId: "session-1",
      // User-editable free text that `formatSessionLogExcerpts` renders into
      // the prompt as the excerpt label — it reaches the provider too.
      sessionName: `Session ${ALL_FAMILIES_EVIDENCE}`,
      summary: ALL_FAMILIES_EVIDENCE,
      toolName: "Bash",
    },
    promptEvent(`deploy with ${ALL_FAMILIES_EVIDENCE}`),
    promptEvent(`deploy with ${ALL_FAMILIES_EVIDENCE}`),
    {
      agentId: null,
      createdAt: "2026-06-17T00:00:00.000Z",
      data: null,
      eventType: "UserMessage",
      id: "secret-frustration-event",
      sessionId: "session-1",
      // `computePeakFrustration` reads sessionName from the RAW events, not
      // from the request builder's already-redacted map.
      sessionName: `Session ${ALL_FAMILIES_EVIDENCE}`,
      summary: `STOP this is WRONG again, the key ${ALL_FAMILIES_EVIDENCE} keeps failing!!`,
      toolName: null,
    },
    {
      agentId: null,
      createdAt: "2026-06-17T00:00:00.000Z",
      data: null,
      eventType: "error",
      id: "secret-error-event",
      sessionId: "session-1",
      sessionName: "Session",
      summary: "command failed",
      toolName: null,
    },
  ];
}

/**
 * Four repeats of one shell command family carrying a single credential, which
 * is what `findReusableCommandCandidate` turns into `representativeCommands` on
 * a reuse tip. One family per input so the 320-char example cap can never
 * truncate a credential out of the payload and fake a pass.
 */
function repeatedSecretCommandEvents(
  family: (typeof SECRET_FAMILIES)[number]
): EventWithSession[] {
  const command = `curl -sS -H '${evidenceTextFor(family)}' https://api.example.com/v1/items`;
  return Array.from({ length: 4 }, (_, index) => ({
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "tool_use",
    id: `secret-command-${index}`,
    sessionId: "session-1",
    sessionName: "Session",
    summary: command,
    toolName: "Bash",
  }));
}

/**
 * An event whose ONLY secret-bearing field is `toolName`. Hook input accepts the
 * tool name as an unconstrained string, and `formatSessionLogExcerpts`
 * interpolates it straight into the prompt's excerpt line, so it reaches the
 * provider like any other free-text field. Every other field is clean, so this
 * event can only fail through the `toolName` seam.
 *
 * The credentials are space-separated from the tool-name prefix because the
 * shared patterns are `\b`-anchored on purpose: a credential glued directly to a
 * preceding word character (`mcp__deploy__sk_live_…`) is deliberately not
 * matched, so concatenating them would assert against the redactor's intended
 * conservatism rather than against this seam.
 */
function secretToolNameEvent(): EventWithSession {
  return {
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "tool_use",
    id: "secret-tool-name-event",
    sessionId: "session-1",
    sessionName: "Session",
    summary: "ran the deploy step",
    toolName: `mcp__deploy__run ${ALL_FAMILIES_EVIDENCE}`,
  };
}

/**
 * The credential as a SINGLE shell token, so it lands in the position the
 * command-family classifiers read. The `Authorization:` family only redacts
 * inside a header form, and the pattern's `\s*` makes the space-free
 * `Authorization:<credential>` form — which is one token — match too.
 */
function firstTokenEvidenceFor(
  family: (typeof SECRET_FAMILIES)[number]
): string {
  if (family.label === AUTHORIZATION_HEADER_LABEL) {
    return `Authorization:${family.secret}`;
  }
  if (family.label === URL_USERINFO_LABEL) {
    return `SYNTHETIC_DATABASE_URL=postgres://${family.secret}${URL_USERINFO_HOST}`;
  }
  return `SYNTHETIC_API_KEY=${family.secret}`;
}

/**
 * Four repeats of an env-prefixed invocation whose FIRST token carries the
 * credential. `classifyCommand` (seed tips) and `commandFamily` (grounded
 * metrics) both derive the family from that first token and both run BEFORE any
 * redaction call site, so on a raw command the CREDENTIAL ITSELF becomes the
 * family string and reaches the provider twice — once as
 * `groundedMetrics.repeatedCommandFamilies[].family` (rendered into the prompt's
 * repeated-command line) and once as the reuse tip's family and derived skill
 * name. `repeatedSecretCommandEvents` cannot reach this: putting the credential
 * in a `-H` argument always classifies the command as `curl`, so the family
 * string is clean no matter what the redactor does.
 */
function envPrefixSecretCommandEvents(
  family: (typeof SECRET_FAMILIES)[number]
): EventWithSession[] {
  const command = `${firstTokenEvidenceFor(family)} curl -sS https://api.example.com/v1/items`;
  return Array.from({ length: 4 }, (_, index) => ({
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "tool_use",
    id: `env-prefix-secret-command-${index}`,
    sessionId: "session-1",
    sessionName: "Session",
    summary: command,
    toolName: "Bash",
  }));
}

function promptEvent(text: string): EventWithSession {
  return {
    agentId: null,
    createdAt: "2026-06-17T00:00:00.000Z",
    data: null,
    eventType: "UserPromptSubmit",
    id: `prompt-${text.length}`,
    sessionId: "session-1",
    sessionName: "Session",
    summary: text,
    toolName: null,
  };
}

function makeInput(
  overrides: Partial<AgentCoachingInput> = {}
): AgentCoachingInput {
  return {
    analytics: makeAnalytics(),
    feedback: [],
    generatedAt: GENERATED_AT,
    recentEvents: [],
    skills: [{ invocationCount: 4 }],
    workflow: makeWorkflow(),
    ...overrides,
  };
}

function makeAnalytics(): AnalyticsData {
  return {
    agentsByStatus: [],
    agentsByType: [],
    dailyEvents: [],
    eventsByType: [],
    sessionsByStatus: [],
    tokens: {
      byDay: [],
      byModel: [],
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalInputTokens: 120_000,
      totalOutputTokens: 30_000,
      windowDays: 30,
    },
    toolUsage: [{ count: 80, toolName: "Bash" }],
    totalAgents: 20,
    totalEvents: 1000,
    totalSessions: 10,
  };
}

function makeWorkflow(): WorkflowQueryData {
  return {
    effectiveness: [],
    orchestration: {
      compactions: { sessions: 0, total: 0 },
      mainCount: 10,
      outcomes: [],
      sessionCount: 10,
      subagentTypes: [
        { completed: 8, count: 10, errors: 0, subagentType: "general-purpose" },
      ],
    },
    stats: {
      avgCompactions: 0,
      avgDepth: 1,
      avgDurationSec: 100,
      avgSubagents: 1,
      successRate: 0.9,
      totalAgents: 20,
      totalCompactions: 0,
      totalSessions: 10,
      totalSubagents: 12,
    },
  };
}
