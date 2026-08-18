import {
  type AgentComponentDetail,
  AgentComponentKind,
  ComponentResolvedState,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { ApiError } from "@repo/app/shared/api/api-error";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiAdapterProvider } from "../../../../shared/api/provider";
import { AuthAdapterProvider } from "../../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../../shared/auth/static-auth-adapter";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";
import { agentComponentKeys } from "../../../hooks/use-agent-components";
import { AgentDetail } from "../agent-detail";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDetail(
  overrides: Partial<AgentComponentDetail> = {}
): AgentComponentDetail {
  return {
    id: "uuid-detail-1",
    slug: "subagent::my-orchestrator-agent",
    name: "My Orchestrator Agent",
    kind: AgentComponentKind.Subagent,
    sourceType: SourceType.Repo,
    source: "acme/repo",
    harness: Harness.Claude,
    invocations: 42,
    sessions: 7,
    locPerDollar: 3.14,
    trend: [1, 2, 3],
    collaborators: ["bob"],
    computeTargetIds: ["target-1"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-01T00:00:00.000Z",
    properties: {
      path: ".claude/agents/orchestrator.md",
      format: "md",
    },
    prompt:
      "You are an expert orchestrator agent. Coordinate work efficiently.",
    versions: [],
    resolvedState: ComponentResolvedState.Unresolved,
    sessionsTab: [],
    sessionsTabTruncated: false,
    branchesTab: [],
    branchesTabTruncated: false,
    provenance: [],
    usageSessions: [],
    locDelta: null,
    successRate: null,
    successDelta: null,
    tokenEfficiencyDelta: null,
    efficiencyTrend: [],
    mergedPrs: null,
    qualityScore: null,
    qualityDelta: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test data source factory
// ---------------------------------------------------------------------------

function testDetailSource(
  detail: AgentComponentDetail
): AgentComponentsDataSource {
  return {
    scope: "test-detail",
    list: () => Promise.reject(new Error("list unused in detail tests")),
    detail: () => Promise.resolve(detail),
  };
}

// A genuine 404: the HTTP/local sources reject a missing slug with an
// `ApiError(status 404)`, which `classifyDetailError` reads as NotPresent.
function notFoundSource(): AgentComponentsDataSource {
  return {
    scope: "test-not-found",
    list: () => Promise.reject(new Error("list unused")),
    // A genuine 404 arrives as an ApiError(status: 404) — the detail hook's
    // contract (throwOnError:false) surfaces it as isError with this error,
    // which classifyDetailError reads as NotPresent → the not-found state.
    detail: () => Promise.reject(new ApiError("Not Found", 404)),
  };
}

// A transient provider failure (gateway down / API 5xx). `classifyDetailError`
// reads this as ProviderError, so the body must render "unavailable", NOT claim
// the component doesn't exist (FEA-3987).
function providerErrorSource(): AgentComponentsDataSource {
  return {
    scope: "test-provider-error",
    list: () => Promise.reject(new Error("list unused")),
    detail: () => Promise.reject(new ApiError("Service Unavailable", 503)),
  };
}

// A detail read that never settles, so the query stays pending and the shared
// body renders its loading state (FEA-3987 skeleton).
function pendingSource(): AgentComponentsDataSource {
  return {
    scope: "test-pending",
    list: () => Promise.reject(new Error("list unused")),
    detail: () => new Promise<AgentComponentDetail>(() => undefined),
  };
}

function Wrapper({
  children,
  dataSource,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
}) {
  return (
    <AppCoreStoryProviders>
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}

// ---------------------------------------------------------------------------
// Top-level regex constants (biome/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------

/**
 * ISS-4805: any rendered text still rooted on the capturing machine. Asserting
 * the ABSENCE of this shape (rather than the absence of one literal) is what
 * makes the disclosure guard hold for a path the fixture did not anticipate.
 */
const RE_MACHINE_ROOTED_PATH = /(^|\s)(\/Users\/|\/home\/|~\/|[A-Za-z]:\\)/;
const RE_SESSIONS_TAB = /sessions/i;
const RE_BRANCHES_TAB = /branches/i;
const RE_EVIDENCE_TAB = /evidence/i;
const RE_PROMPT_TEXT = /You are an expert orchestrator agent/;
const RE_NO_CONTENT = /no definition captured/i;
const RE_REVISION_NAMED_EMPTY =
  /current · #aaaaaaa has no captured definition/i;
const RE_GENERIC_EMPTY = /we haven't captured this component's definition yet/i;
const RE_NOT_FOUND = /component not found/i;
const RE_UNAVAILABLE = /component unavailable/i;
const RE_BACK_TO_AGENTS = /back to agents/i;
const SKELETON_SELECTOR = "[data-slot='skeleton']";
const RE_ALLOWED_TOOLS = /allowed tools/i;
const RE_ORCHESTRATES = /orchestrates/i;
const RE_MAX_CONCURRENCY = /max concurrency/i;
const RE_SERVER_URL = /server url/i;

// ---------------------------------------------------------------------------
// T-10.7: AgentDetail component tests
// ---------------------------------------------------------------------------

describe("AgentDetail", () => {
  it("renders the Properties panel with key fields", async () => {
    const detail = makeDetail();

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    // Properties panel header
    expect(await screen.findByText("Properties")).toBeInTheDocument();

    // Kind label rendered in the Properties panel (there may be multiple, use getAllBy)
    const agentLabels = screen.getAllByText("Agent");
    expect(agentLabels.length).toBeGreaterThan(0);
  });

  it("renders per-kind definition properties when present", async () => {
    const detail = makeDetail({
      properties: {
        path: ".claude/agents/orchestrator.md",
        format: "md",
        model: "opus",
        allowedTools: ["Read", "Bash"],
        maxConcurrency: 4,
        orchestrates: ["visual-qa-agent"],
        server: {
          url: "https://api.example/mcp",
          auth: "OAuth",
          health: "Connected",
        },
      },
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    expect(await screen.findByText("Properties")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText(RE_ALLOWED_TOOLS)).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText(RE_MAX_CONCURRENCY)).toBeInTheDocument();
    expect(screen.getByText(RE_ORCHESTRATES)).toBeInTheDocument();
    expect(screen.getByText("visual-qa-agent")).toBeInTheDocument();
    expect(screen.getByText(RE_SERVER_URL)).toBeInTheDocument();
    expect(screen.getByText("https://api.example/mcp")).toBeInTheDocument();
  });

  it("omits per-kind property rows a sparse definition lacks", async () => {
    const detail = makeDetail({
      properties: { path: "/agents/x.md", format: "md" },
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    expect(await screen.findByText("Properties")).toBeInTheDocument();
    expect(screen.queryByText(RE_ALLOWED_TOOLS)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_SERVER_URL)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_MAX_CONCURRENCY)).not.toBeInTheDocument();

    // Source value lives in the Properties panel.
    expect(screen.getByText("acme/repo")).toBeInTheDocument();
    // FEA-4255: the harness label is NOT restated in Properties (the header
    // eyebrow owns it now, and Properties defaults open — a Harness row would
    // print it twice above the fold). It appears exactly once, in the eyebrow.
    const claudeLabels = screen.getAllByText("Claude");
    expect(claudeLabels).toHaveLength(1);
  });

  // FEA-4255: the harness must be surfaced in the always-visible header eyebrow
  // (alongside the kind), not only inside the Properties panel — so it reads on
  // every tab/section. The header eyebrow is the heading's sibling that carries
  // the kind label, so it must contain the harness label too.
  it("surfaces the harness in the header eyebrow next to the kind", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Command,
      harness: Harness.Both,
      name: "Deep Review",
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    const heading = await screen.findByRole("heading", { name: "Deep Review" });
    // The eyebrow is the heading's preceding sibling in the header column.
    const eyebrow = heading.parentElement?.previousElementSibling;
    expect(eyebrow?.textContent).toContain("Command");
    // `Both` surfaces as "Multiple harnesses" (T3/T9), not "Claude + Codex".
    expect(eyebrow?.textContent).toContain("Multiple harnesses");
  });

  // wongk review: the harness value is NOT closed to the `Harness` union at
  // runtime — desktop's `toHarness` passes arbitrary non-empty collector strings
  // through. A stored harness that collides with an Object.prototype key
  // (`constructor`, `toString`, …) must NOT take the HARNESS_META branch via the
  // prototype-walking `in` operator (which would resolve to `undefined.label`
  // and blank the eyebrow); the own-key check falls back to the raw value.
  it("falls back to the raw harness value for a prototype-key-named harness", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Command,
      // A non-Harness string that is an inherited Object.prototype key.
      harness: "constructor" as Harness,
      name: "Odd Harness",
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    const heading = await screen.findByRole("heading", { name: "Odd Harness" });
    const eyebrow = heading.parentElement?.previousElementSibling;
    // The eyebrow prints the raw fallback, not a blank segment.
    expect(eyebrow?.textContent).toContain("Command");
    expect(eyebrow?.textContent).toContain("constructor");
  });

  it("renders the Sessions, Branches, and Evidence tabs", async () => {
    const detail = makeDetail();

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");

    // Sessions and Branches tabs
    expect(
      screen.getByRole("tab", { name: RE_SESSIONS_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: RE_BRANCHES_TAB })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: RE_EVIDENCE_TAB })
    ).toBeInTheDocument();
  });

  it("renders the Definition panel for Subagent kind (has invocation signal)", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Subagent,
      prompt:
        "You are an expert orchestrator agent. Coordinate work efficiently.",
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    // Definition panel header and body
    expect(
      await screen.findByRole("heading", { name: "Definition" })
    ).toBeInTheDocument();
    expect(screen.getByText(RE_PROMPT_TEXT)).toBeInTheDocument();
  });

  it("shows a version selector and the current revision when history exists", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Skill,
      prompt: "Current revision text.",
      versions: [
        {
          hash: "aaaaaaa0000",
          source: "",
          format: "md",
          createdAt: "2026-06-01T00:00:00.000Z",
          isCurrent: true,
          content: "Current revision text.",
        },
        {
          hash: "bbbbbbb1111",
          source: "",
          format: "md",
          createdAt: "2026-05-01T00:00:00.000Z",
          isCurrent: false,
          content: "Older revision text.",
        },
      ],
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    expect(
      await screen.findByRole("heading", { name: "Definition" })
    ).toBeInTheDocument();
    // Defaults to the current revision's content + shows the selector.
    expect(screen.getByText("Current revision text.")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders no version selector for a single-revision component", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Skill,
      prompt: "Only revision.",
      versions: [
        {
          hash: "aaaaaaa0000",
          source: "",
          format: "md",
          createdAt: "2026-06-01T00:00:00.000Z",
          isCurrent: true,
          content: "Only revision.",
        },
      ],
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    expect(
      await screen.findByRole("heading", { name: "Definition" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  // FEA-4255: a prompt-carrying kind whose body was never captured (`prompt`
  // null, no revisions) must still render the Definition section with an honest
  // empty state — never silently drop it, which made the page a dead end.
  it("shows an honest Definition empty state when a Command kind has no captured body", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Command,
      prompt: null,
      versions: [],
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    // The Definition section header renders (not dropped)...
    expect(
      await screen.findByRole("heading", { name: "Definition" })
    ).toBeInTheDocument();
    // ...and it shows the honest "no definition" empty state, not a blank panel.
    expect(screen.getByText(RE_NO_CONTENT)).toBeInTheDocument();
  });

  // FEA-4255: version history can exist for a revision whose body was not
  // captured. The selector still renders, but the body area degrades to the
  // same honest empty state rather than showing a blank box.
  it("shows the Definition empty state when the current revision has no body", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Skill,
      prompt: null,
      versions: [
        {
          hash: "aaaaaaa0000",
          source: "",
          format: "md",
          createdAt: "2026-06-01T00:00:00.000Z",
          isCurrent: true,
          content: "",
        },
      ],
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    expect(
      await screen.findByRole("heading", { name: "Definition" })
    ).toBeInTheDocument();
    expect(screen.getByText(RE_NO_CONTENT)).toBeInTheDocument();
  });

  // FEA-4255 (review): when history exists but the SELECTED revision has no
  // body, the empty state names that revision so paging the dropdown reads as
  // "THIS revision is empty" — not the same generic line on every one.
  it("names the selected revision in the empty state when history exists", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Skill,
      prompt: null,
      versions: [
        {
          hash: "aaaaaaa0000",
          source: "",
          format: "md",
          createdAt: "2026-06-01T00:00:00.000Z",
          isCurrent: true,
          content: "",
        },
        {
          hash: "bbbbbbb1111",
          source: "",
          format: "md",
          createdAt: "2026-05-01T00:00:00.000Z",
          isCurrent: false,
          content: "Older revision text.",
        },
      ],
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    // The current (empty) revision is selected by default; its label — the same
    // "Current · #<hash>" the dropdown uses — is named in the empty copy, and
    // the generic no-history line is NOT shown.
    expect(
      await screen.findByText(RE_REVISION_NAMED_EMPTY)
    ).toBeInTheDocument();
    expect(screen.queryByText(RE_GENERIC_EMPTY)).not.toBeInTheDocument();
  });

  it("does NOT render the Definition panel for Config kind", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Config,
      prompt: null,
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");

    // No Definition section for Config kind
    expect(
      screen.queryByRole("heading", { name: "Definition" })
    ).not.toBeInTheDocument();
  });

  it("does NOT render the Definition panel for Hook kind", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Hook,
      prompt: null,
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");
    expect(
      screen.queryByRole("heading", { name: "Definition" })
    ).not.toBeInTheDocument();
  });

  it("renders metric cards grid", async () => {
    const detail = makeDetail();

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");

    // Should render metric card labels (from componentMetrics).
    // There may be multiple elements (metric card + tab trigger both say "Sessions")
    // so use getAllByText to handle multiple matches.
    const sessionsElements = screen.getAllByText("Sessions");
    expect(sessionsElements.length).toBeGreaterThan(0);

    const invocationsElements = screen.getAllByText("Invocations");
    expect(invocationsElements.length).toBeGreaterThan(0);
  });

  it("shows 'Component not found' when the source rejects with a 404", async () => {
    render(
      <Wrapper dataSource={notFoundSource()}>
        <AgentDetail backHref="/acme/agents" slug="missing-uuid" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(RE_NOT_FOUND)).toBeInTheDocument();
    });
    // A genuine 404 reads as not-found, never the transient "unavailable" copy.
    expect(screen.queryByText(RE_UNAVAILABLE)).not.toBeInTheDocument();
  });

  // FEA-3987: a transient provider failure (5xx / gateway down) must render a
  // distinct "unavailable" state, never claim the component doesn't exist.
  it("shows 'Component unavailable' (not 'not found') when the source rejects with a 5xx", async () => {
    render(
      <Wrapper dataSource={providerErrorSource()}>
        <AgentDetail backHref="/acme/agents" slug="flaky-uuid" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(RE_UNAVAILABLE)).toBeInTheDocument();
    });
    expect(screen.queryByText(RE_NOT_FOUND)).not.toBeInTheDocument();
    // Still a way back out of the transient state.
    expect(
      screen.getByRole("link", { name: RE_BACK_TO_AGENTS })
    ).toHaveAttribute("href", "/acme/agents");
  });

  // FEA-3987: the not-found state threads the surface-injected backHref into the
  // shared EmptyState's "Back to Agents" link so the user has a way back.
  it("renders a 'Back to Agents' link in the not-found state when backHref is injected", async () => {
    render(
      <Wrapper dataSource={notFoundSource()}>
        <AgentDetail backHref="/acme/agents" slug="missing-uuid" />
      </Wrapper>
    );

    await waitFor(() => {
      expect(screen.getByText(RE_NOT_FOUND)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("link", { name: RE_BACK_TO_AGENTS })
    ).toHaveAttribute("href", "/acme/agents");
  });

  // FEA-3987: while the detail is loading the shared body renders a <Skeleton>,
  // not the bare centered "Loading…" text it used before.
  it("renders a skeleton while loading (never the bare 'Loading…' text)", () => {
    render(
      <Wrapper dataSource={pendingSource()}>
        <AgentDetail backHref="/acme/agents" slug="pending-uuid" />
      </Wrapper>
    );

    expect(document.querySelector(SKELETON_SELECTOR)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText(RE_NOT_FOUND)).not.toBeInTheDocument();
    expect(screen.queryByText(RE_UNAVAILABLE)).not.toBeInTheDocument();
  });

  it("renders the component name in the header", async () => {
    const detail = makeDetail({ name: "Expert Python Reviewer" });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    expect(
      await screen.findByText("Expert Python Reviewer")
    ).toBeInTheDocument();
  });

  // FEA-3978: the header subtitle must add information the title does not — it
  // must never be the exact same string as the title.
  it("renders a header subtitle distinct from the title (path)", async () => {
    const detail = makeDetail({
      name: "My Orchestrator Agent",
      properties: { path: ".claude/agents/orchestrator.md", format: "md" },
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    const title = await screen.findByRole("heading", {
      name: "My Orchestrator Agent",
    });
    // The path is shown as the subtitle and is not the title element.
    const subtitle = screen.getByText(".claude/agents/orchestrator.md");
    expect(subtitle).toBeInTheDocument();
    expect(subtitle).not.toBe(title);
    // The name appears exactly once (title only), never duplicated as subtitle.
    expect(screen.getAllByText("My Orchestrator Agent")).toHaveLength(1);
  });

  // ISS-4805: the header still names a location for the common production case
  // (an absolute `installPath`) — it renders the PORTABLE TAIL of that path, the
  // part that is the same anchor on every machine, and never the machine-rooted
  // prefix that carries the capturing user's name and directory layout.
  it("renders the portable tail of a machine-absolute definition path", async () => {
    const detail = makeDetail({
      name: "My Orchestrator Agent",
      properties: {
        path: "/Users/someone/Code/proj/.claude/agents/orchestrator.md",
        format: "md",
      },
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    await screen.findByRole("heading", { name: "My Orchestrator Agent" });
    expect(
      screen.getByText(".claude/agents/orchestrator.md")
    ).toBeInTheDocument();
    expect(screen.queryByText(RE_MACHINE_ROOTED_PATH)).toBeNull();
  });

  // ISS-4805: a machine-absolute path with NO portable anchor has nothing safe
  // to publish, so the subtitle falls through to the identity key rather than
  // printing the private prefix.
  it("falls back to the identity key when no part of the path is portable", async () => {
    const detail = makeDetail({
      name: "My Orchestrator Agent",
      slug: "subagent::orchestrator-key",
      properties: {
        path: "/Users/someone/scratch/orchestrator.md",
        format: "md",
      },
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    await screen.findByRole("heading", { name: "My Orchestrator Agent" });
    expect(screen.getByText("orchestrator-key")).toBeInTheDocument();
    expect(screen.queryByText(RE_MACHINE_ROOTED_PATH)).toBeNull();
  });

  // FEA-3978: when the path would equal the title, the subtitle falls back to
  // the identity key (the `::`-suffix of the raw slug) rather than repeating the
  // name — and never our internal `kind::` identity.
  it("falls back to the identity key when path equals the name", async () => {
    const detail = makeDetail({
      // The DTO slug is the raw org identity (`kind::key`); the key here is a
      // distinct locator, not a repeat of the display name.
      name: "Add comment to issue",
      slug: "tool::_add_comment_to_issue",
      properties: { path: "Add comment to issue", format: "md" },
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    await screen.findByText("Properties");
    // Title renders the name once.
    expect(screen.getAllByText("Add comment to issue")).toHaveLength(1);
    // Subtitle is the identity key — distinct, and not the `kind::` identity.
    const subtitle = screen.getByText("_add_comment_to_issue");
    expect(subtitle).toBeInTheDocument();
    expect(subtitle.textContent ?? "").not.toContain("::");
  });

  // FEA-3520 regression: a Skill-component detail page crashed on web because a
  // record whose `versions[].hash` / `usageSessions[].versionHash` reached the
  // renderer as a non-string threw `TypeError: …slice is not a function` from
  // the version-label path — caught by the top-level LiveblocksErrorBoundary →
  // crash-spiral (same class as the #3208 `sessionStartedAt` fix). The whole
  // detail page (Definition panel + Sessions "Version" column) must render without
  // throwing for such a malformed Skill record.
  it("renders a Skill detail with malformed non-string version hashes without crashing", async () => {
    const detail = makeDetail({
      kind: AgentComponentKind.Skill,
      slug: "skill::claude-api",
      name: "claude-api",
      prompt: "Skill prompt text.",
      versions: [
        {
          // Non-string hash — the malformed stage shape that took the page down.
          hash: 12_345_678 as unknown as string,
          source: "",
          format: "md",
          createdAt: "2026-06-01T00:00:00.000Z",
          isCurrent: true,
          content: "Skill prompt text.",
        },
        {
          hash: 99 as unknown as string,
          source: "",
          format: "md",
          createdAt: "2026-05-01T00:00:00.000Z",
          isCurrent: false,
          content: "Older skill text.",
        },
      ],
      usageSessions: [
        {
          sessionId: "s1",
          branchName: "main",
          invocationCount: 1,
          // Non-string versionHash on the Sessions-tab Version column path.
          versionHash: 12_345_678 as unknown as string,
        },
      ],
    });

    render(
      <Wrapper dataSource={testDetailSource(detail)}>
        <AgentDetail backHref="/acme/agents" slug={detail.id} />
      </Wrapper>
    );

    // The page renders (header + Definition panel) rather than the degraded state.
    expect(await screen.findByText("claude-api")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Definition" })
    ).toBeInTheDocument();
    expect(screen.getByText("Skill prompt text.")).toBeInTheDocument();
    // The version selector is present and its labels coerced the numeric hash
    // into a usable #prefix instead of throwing.
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  // wongk review: the Definition panel's `selectedHash` is local state that must
  // NOT survive same-component navigation. On desktop the detail view can swap
  // `data` in place (cached B replaces A without unmounting AgentDetail). If A's
  // selection carries over to B, B's Select value is not one of B's options and
  // B can render "No definition captured" even when its current revision has
  // content. Keying the panel by `slug` resets the selection on identity change.
  //
  // A's default selection is its own current revision (`#aaaaaaa…`), which is
  // NOT one of B's option hashes. Without the reset, that stale hash leaks into
  // B: `activeIndex` is -1 → `active` undefined → B falls through to its null
  // top-level prompt → the honest empty state, and the Select trigger shows no
  // valid B revision. With the reset, B selects and shows its OWN current
  // revision. This asserts across the swap without opening the Radix dropdown
  // (jsdom lacks pointer-capture), so it stays deterministic.
  it("resets the selected revision when navigating to a different component in place", async () => {
    const detailA = makeDetail({
      id: "uuid-A",
      slug: "skill::component-a",
      name: "Component A",
      kind: AgentComponentKind.Skill,
      prompt: "A current text.",
      versions: [
        {
          hash: "aaaaaaa0000",
          source: "",
          format: "md",
          createdAt: "2026-06-01T00:00:00.000Z",
          isCurrent: true,
          content: "A current text.",
        },
        {
          hash: "ccccccc2222",
          source: "",
          format: "md",
          createdAt: "2026-05-01T00:00:00.000Z",
          isCurrent: false,
          content: "A older text.",
        },
      ],
    });
    // Component B: a DIFFERENT slug whose current revision carries content but
    // whose top-level prompt is null. If A's selected hash (its current,
    // `#aaaaaaa…`) leaked, B would resolve to no active revision and fall
    // through to its null prompt → the empty state.
    const detailB = makeDetail({
      id: "uuid-B",
      slug: "skill::component-b",
      name: "Component B",
      kind: AgentComponentKind.Skill,
      prompt: null,
      versions: [
        {
          hash: "ddddddd3333",
          source: "",
          format: "md",
          createdAt: "2026-06-02T00:00:00.000Z",
          isCurrent: true,
          content: "B current text.",
        },
        {
          hash: "eeeeeee4444",
          source: "",
          format: "md",
          createdAt: "2026-05-02T00:00:00.000Z",
          isCurrent: false,
          content: "B older text.",
        },
      ],
    });

    // Reproduce wongk's exact "navigate to CACHED B" path: preseed both details
    // into the QueryClient (infinite staleTime) so the A→B swap is SYNCHRONOUS —
    // no loading gap unmounts the subtree. AgentDetail and the Definition panel
    // stay mounted while `data` swaps, so a leaked `selectedHash` would carry
    // over exactly as it does on desktop. The provider tree is a single stable
    // instance; only the `slug` prop changes.
    const scope = "test-inplace-nav";
    const source: AgentComponentsDataSource = {
      scope,
      list: () => Promise.reject(new Error("list unused")),
      // Never actually hit — both details are cache hits.
      detail: () => Promise.reject(new Error("detail should be cache-served")),
    };
    const seededWrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        queryData={[
          [agentComponentKeys.detail(scope, detailA.id), detailA],
          [agentComponentKeys.detail(scope, detailB.id), detailB],
        ]}
      >
        <AgentComponentsDataSourceProvider dataSource={source}>
          {children}
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    const { rerender } = render(
      <AgentDetail backHref="/acme/agents" slug={detailA.id} />,
      { wrapper: seededWrapper }
    );

    // A shows its current revision by default (selection = A's current hash).
    await screen.findByText("A current text.");
    expect(screen.getByRole("combobox").textContent).toContain("#aaaaaaa");

    // Navigate in place to cached B: same provider tree + AgentDetail instance,
    // only the slug prop changes; B is served from cache with no loading gap.
    rerender(<AgentDetail backHref="/acme/agents" slug={detailB.id} />);

    // B renders its own CURRENT revision content, never A's leaked selection
    // (which would resolve to B's empty state) or A's stale text.
    await waitFor(() => {
      expect(screen.getByText("B current text.")).toBeInTheDocument();
    });
    expect(screen.queryByText(RE_NO_CONTENT)).not.toBeInTheDocument();
    expect(screen.queryByText("A current text.")).not.toBeInTheDocument();
    // The Select trigger shows B's current revision hash, not A's orphaned one.
    const combo = screen.getByRole("combobox").textContent ?? "";
    expect(combo).toContain("#ddddddd");
    expect(combo).not.toContain("#aaaaaaa");
  });
});

// ---------------------------------------------------------------------------
// FEA-3557/FEA-3294: Invocations tab permalink
// ---------------------------------------------------------------------------

/**
 * A nav-configurable wrapper (the shared `AppCoreStoryProviders` fixes its own
 * memory nav and hides the href) so these tests can seed an initial `?tab=` and
 * read the resulting URL back.
 */
function renderDetailWithNav(options: {
  detail: AgentComponentDetail;
  initialPath: string;
}) {
  const nav = createMemoryNavigation({
    initialPath: options.initialPath,
    orgSlug: "org-test",
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiAdapter = {
    resolveApiOrigin: () => "http://test.invalid",
    fetch: () => Promise.reject(new Error("no network in permalink tests")),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <NavigationProvider adapter={nav.adapter}>
        <AuthAdapterProvider adapter={createStaticAuthAdapter()}>
          <ApiAdapterProvider adapter={apiAdapter}>
            <AgentComponentsDataSourceProvider
              dataSource={testDetailSource(options.detail)}
            >
              {children}
            </AgentComponentsDataSourceProvider>
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </NavigationProvider>
    </QueryClientProvider>
  );
  const view = render(
    <AgentDetail backHref="/acme/agents" slug={options.detail.id} />,
    { wrapper }
  );
  return { nav, ...view };
}

function tabQuery(href: string): string | null {
  const q = href.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : href.slice(q + 1)).get("tab");
}

describe("AgentDetail invocations-tab permalink (FEA-3557)", () => {
  it("defaults to Sessions with no ?tab= param", async () => {
    const { nav } = renderDetailWithNav({
      detail: makeDetail(),
      initialPath: "/agents/detail",
    });

    await screen.findByText("Properties");

    expect(screen.getByRole("tab", { name: RE_SESSIONS_TAB })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(tabQuery(nav.getCurrentHref())).toBeNull();
  });

  it("deep-links to the Branches tab from ?tab=branches", async () => {
    renderDetailWithNav({
      detail: makeDetail(),
      initialPath: "/agents/detail?tab=branches",
    });

    await screen.findByText("Properties");

    expect(screen.getByRole("tab", { name: RE_BRANCHES_TAB })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("deep-links to the Evidence tab from ?tab=evidence", async () => {
    renderDetailWithNav({
      detail: makeDetail(),
      initialPath: "/agents/detail?tab=evidence",
    });

    await screen.findByText("Properties");

    expect(screen.getByRole("tab", { name: RE_EVIDENCE_TAB })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      screen.getByText(
        "This data source does not record exact invocation evidence."
      )
    ).toBeInTheDocument();
  });

  it("falls back to Sessions for an invalid ?tab= value", async () => {
    renderDetailWithNav({
      detail: makeDetail(),
      initialPath: "/agents/detail?tab=bogus",
    });

    await screen.findByText("Properties");

    expect(screen.getByRole("tab", { name: RE_SESSIONS_TAB })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("writes ?tab=branches on switch and cleans it selecting Sessions", async () => {
    const user = userEvent.setup();
    const { nav } = renderDetailWithNav({
      detail: makeDetail(),
      initialPath: "/agents/detail",
    });

    await screen.findByText("Properties");

    await user.click(screen.getByRole("tab", { name: RE_BRANCHES_TAB }));
    await waitFor(() => {
      expect(tabQuery(nav.getCurrentHref())).toBe("branches");
    });

    await user.click(screen.getByRole("tab", { name: RE_SESSIONS_TAB }));
    await waitFor(() => {
      expect(tabQuery(nav.getCurrentHref())).toBeNull();
    });
  });
});
