import {
  AuditScope,
  type CascadeAttempt,
  HarnessName,
} from "@repo/crewd/model";
import { findingKey } from "@repo/crewd/passes/findings";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuditCharacter,
  type AuditFileRequest,
  type AuditFileResult,
  type AuditProgressPayload,
  type AuditRunRequest,
  type AuditRunResult,
} from "../../../../shared/audit-contract";
import { AuditView } from "../audit-view";

// The project + assignee typeaheads (FEA-4008) read the user's org projects and
// members through shared `@repo/app` hooks (cloud API via React Query). Stub
// them so the view can render without an ApiClient/QueryClient provider and so
// the tests control exactly which projects/members the typeaheads offer.
const mockProjects = [
  { id: "proj-1", name: "Platform", slug: "platform" },
  { id: "proj-2", name: "Growth", slug: "growth" },
];
const mockUsers = [
  { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "user-2", name: "Alan Turing", email: "alan@example.com" },
];

// A settable source so a test can model the offline / empty-projects case.
let projectsSource: typeof mockProjects = mockProjects;

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  // Honor the `enabled` gate so the "only fetch once the dialog opens" contract
  // is faithful: return no data (and report loading) until the view opts in.
  useProjects: (_teamId?: string, options?: { enabled?: boolean }) => ({
    data: options?.enabled === false ? [] : projectsSource,
    isLoading: options?.enabled === false,
    isError: false,
  }),
}));
vi.mock("@repo/app/users/hooks/use-org-users-as-popover-users", () => ({
  // Mirror the projects stub: the roster is gated on the dialog being open, so
  // return no members (and loading) until the view opts in. This makes the
  // "assignee roster only loads once the dialog opens" gate testable.
  useOrgUsersPopoverQuery: (options?: { enabled?: boolean }) => ({
    users: options?.enabled === false ? [] : mockUsers,
    isLoading: options?.enabled === false,
  }),
}));

// Radix Popover + cmdk Command need these browser APIs jsdom omits.
class TestResizeObserver {
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}
globalThis.ResizeObserver =
  TestResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {
  // no-op
};
Element.prototype.setPointerCapture ??= () => {
  // no-op
};
Element.prototype.releasePointerCapture ??= () => {
  // no-op
};

// Accessible-name matchers for the typeahead triggers (field-labeled combobox
// names like "ClosedLoop project: Select project…").
const PROJECT_TRIGGER_NAME = /^ClosedLoop project:/;
const ASSIGNEE_TRIGGER_NAME = /^Assignee:/;

type ProgressCallback = (payload: AuditProgressPayload) => void;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

let progressListeners: ProgressCallback[] = [];

function emitProgress(payload: AuditProgressPayload): void {
  act(() => {
    for (const listener of progressListeners) {
      listener(payload);
    }
  });
}

function attempt(overrides: Partial<CascadeAttempt> = {}): CascadeAttempt {
  return {
    harness: "codex",
    model: null,
    outcome: "success",
    startedAt: "2026-07-23T00:00:00.000Z",
    durationMs: 1200,
    exitCode: 0,
    note: "",
    ...overrides,
  };
}

/** A default file result: every requested finding reported as newly created. */
function fileResultFor(request: AuditFileRequest): AuditFileResult {
  return {
    ok: true,
    filed: request.findings.map((f) => ({
      key: findingKey(f),
      title: f.title,
      status: "created",
    })),
    created: request.findings.length,
    skipped: 0,
    reason: null,
    error: null,
  };
}

function installAuditApi(
  runResult: AuditRunResult,
  fileImpl?: (request: AuditFileRequest) => AuditFileResult
): {
  run: ReturnType<typeof vi.fn>;
  file: ReturnType<typeof vi.fn>;
  pick: ReturnType<typeof vi.fn>;
  resolveRun: () => void;
} {
  let resolveRun: () => void = () => {
    // set by the deferred below
  };
  const runPromise = new Promise<AuditRunResult>((resolve) => {
    resolveRun = () => resolve(runResult);
  });
  const run = vi.fn(() => runPromise);
  const file = vi.fn(async (request: AuditFileRequest) =>
    (fileImpl ?? fileResultFor)(request)
  );
  const pick = vi.fn(async () => ({
    path: "/repos/demo",
    isGitRepo: true,
    isRisky: false,
    suggestedPath: undefined,
  }));
  const api = {
    audit: {
      run,
      file,
      onProgress: (callback: ProgressCallback) => {
        progressListeners.push(callback);
        return () => {
          progressListeners = progressListeners.filter((l) => l !== callback);
        };
      },
    },
    pickSandboxDirectory: pick,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return { run, file, pick, resolveRun };
}

function okResult(findings: AuditRunResult["findings"]): AuditRunResult {
  return {
    ok: true,
    character: "docs-darwin",
    harnessUsed: "codex",
    attempts: [attempt()],
    findings,
    reason: null,
    error: null,
  };
}

beforeEach(() => {
  progressListeners = [];
  projectsSource = mockProjects;
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

async function pickRepoAndRun(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Choose repo" }));
  await screen.findByText("/repos/demo");
  fireEvent.click(screen.getByRole("button", { name: "Run audit" }));
}

/** Open the confirm dialog via the triage-list action-bar trigger. */
function openFileDialog(): void {
  fireEvent.click(screen.getByRole("button", { name: "Create issues" }));
}

/** Select a project by name through the typeahead popover inside the dialog. */
async function selectProject(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: PROJECT_TRIGGER_NAME }));
  fireEvent.click(await screen.findByText(name));
}

/** Select an assignee by name through the assignee typeahead popover. */
async function selectAssignee(name: string): Promise<void> {
  fireEvent.click(
    screen.getByRole("combobox", { name: ASSIGNEE_TRIGGER_NAME })
  );
  fireEvent.click(await screen.findByText(name));
}

/** Click the dialog's confirm ("Create issues") action. */
async function confirmCreate(): Promise<void> {
  const dialog = within(await screen.findByRole("alertdialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Create issues" }));
}

describe("AuditView", () => {
  it("renders findings grouped by severity from the run result", async () => {
    const { resolveRun } = installAuditApi(
      okResult([
        { title: "[blocking] broken setup step", description: "README.md:3" },
        { title: "[low] stale flag name", description: "docs/x.md:9" },
      ])
    );
    render(<AuditView />);
    await pickRepoAndRun();
    act(() => resolveRun());

    expect(await screen.findByText("broken setup step")).toBeDefined();
    // Group headers render for each severity bucket.
    expect(screen.getByText("Blocking")).toBeDefined();
    expect(screen.getByText("Low")).toBeDefined();
    // path:line surfaces on the row (as the location chip and the preview).
    expect(screen.getAllByText("README.md:3").length).toBeGreaterThan(0);
  });

  it("runs with the default character and whole-repo scope preset", async () => {
    const { run, resolveRun } = installAuditApi(okResult([]));
    render(<AuditView />);
    await pickRepoAndRun();
    act(() => resolveRun());

    const request = run.mock.calls[0]?.[0] as AuditRunRequest;
    expect(request.character).toBe(AuditCharacter.DocsDarwin);
    expect(request.scopePreset).toBe(AuditScope.WholeRepo);
  });

  it("threads the operator-picked model + cascade order through the picker UI onto run", async () => {
    // Drive the harness-cascade picker THROUGH the UI (model select + reorder
    // buttons) and assert the exact `cascade` payload that reaches
    // `desktopApi.audit.run`. The lower-layer picker/IPC tests inject `cascade`
    // directly and would stay green even if the field were dropped or wired to
    // stale state — only this render-and-bridge test proves the operator's
    // selection is actually carried onto the run call (FEA-4009).
    const { run, resolveRun } = installAuditApi(okResult([]));
    render(<AuditView />);

    // Change Codex's model to a NON-default (Codex default is "gpt-5-codex", so
    // "gpt-5" is a real edit ⇒ the step carries an explicit model).
    fireEvent.click(screen.getByRole("combobox", { name: "Codex model" }));
    fireEvent.click(await screen.findByRole("option", { name: "gpt-5" }));

    // Reorder: move Codex from first to second, so the default codex → opencode
    // → claude order becomes opencode → codex → claude.
    fireEvent.click(screen.getByRole("button", { name: "Move Codex later" }));

    await pickRepoAndRun();
    act(() => resolveRun());

    const request = run.mock.calls[0]?.[0] as AuditRunRequest;
    // The exact edited, reordered cascade must reach the bridge — Codex second,
    // carrying the picked model; opencode/claude keep their default (omitted)
    // model, matching the picker's "default ⇒ omit model" wire contract.
    expect(request.cascade).toEqual([
      { harness: HarnessName.Opencode },
      { harness: HarnessName.Codex, model: "gpt-5" },
      { harness: HarnessName.Claude },
    ]);
  });

  it("shows live cascade progress from streamed onProgress events", async () => {
    const { resolveRun } = installAuditApi(okResult([]));
    render(<AuditView />);
    await pickRepoAndRun();

    emitProgress({
      runId: "r1",
      phase: "start",
      character: "docs-darwin",
      repoDir: "/repos/demo",
      cascade: ["codex", "claude"],
    });
    emitProgress({
      runId: "r1",
      phase: "attempt",
      attempt: attempt({ harness: "codex", outcome: "failed" }),
    });

    // The cascade trail names the harnesses; codex has an outcome, claude runs.
    expect(await screen.findByText("codex")).toBeDefined();
    expect(screen.getByText("claude")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();

    act(() => resolveRun());
    await waitFor(() =>
      expect(screen.queryByText("Cascade progress")).toBeNull()
    );
  });

  it("marks harnesses after a mid-cascade success as Pending, not Running", async () => {
    // The cascade stops on the first success, so a later un-attempted harness
    // must not be shown as still Running.
    installAuditApi(okResult([]));
    render(<AuditView />);
    await pickRepoAndRun();

    emitProgress({
      runId: "r1",
      phase: "start",
      character: "docs-darwin",
      repoDir: "/repos/demo",
      cascade: ["codex", "claude"],
    });
    emitProgress({
      runId: "r1",
      phase: "attempt",
      attempt: attempt({ harness: "codex", outcome: "success" }),
    });

    expect(await screen.findByText("Succeeded")).toBeDefined();
    // claude never ran (codex succeeded) → Pending, and nothing is Running.
    expect(screen.getByText("Pending")).toBeDefined();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("opens the finding-detail drawer with full evidence when a row is clicked", async () => {
    const { resolveRun } = installAuditApi(
      okResult([
        {
          title: "[high] contradicted default",
          description: "README.md:3 says timeout is 30s but code sets 60s",
          signature: "readme-timeout-default",
        },
      ])
    );
    render(<AuditView />);
    await pickRepoAndRun();
    act(() => resolveRun());

    fireEvent.click(await screen.findByText("contradicted default"));

    // Scope to the opened detail drawer so the row's own preview/signature copy
    // does not make the query ambiguous.
    const drawer = within(await screen.findByRole("dialog"));
    expect(drawer.getByText("Evidence & proposed fix")).toBeDefined();
    expect(
      drawer.getByText("README.md:3 says timeout is 30s but code sets 60s")
    ).toBeDefined();
    expect(drawer.getByText("readme-timeout-default")).toBeDefined();
  });

  it("shows a clean no-findings state on a passing run", async () => {
    const { resolveRun } = installAuditApi(okResult([]));
    render(<AuditView />);
    await pickRepoAndRun();
    act(() => resolveRun());

    expect(await screen.findByText("No findings")).toBeDefined();
  });

  it("surfaces a typed refusal without rendering findings", async () => {
    const { resolveRun } = installAuditApi({
      ok: false,
      character: "docs-darwin",
      harnessUsed: null,
      attempts: [],
      findings: [],
      reason: "repo_not_allowed",
      error: "repo not allowed",
    });
    render(<AuditView />);
    await pickRepoAndRun();
    act(() => resolveRun());

    expect(await screen.findByText("Audit could not run")).toBeDefined();
  });

  // ── FEA-3849 (M3): file selected findings to ClosedLoop ──

  async function runWithFindings(
    fileImpl?: (request: AuditFileRequest) => AuditFileResult
  ): Promise<ReturnType<typeof installAuditApi>> {
    const api = installAuditApi(
      okResult([
        {
          title: "[high] stale README step",
          description: "README.md:3",
          signature: "sig:readme",
        },
        {
          title: "[low] wrong flag name",
          description: "docs/x.md:9",
          signature: "sig:flag",
        },
      ]),
      fileImpl
    );
    render(<AuditView />);
    await pickRepoAndRun();
    act(() => api.resolveRun());
    await screen.findByText("stale README step");
    return api;
  }

  it("does NOT file anything on selection alone — only on explicit confirm", async () => {
    const { file } = await runWithFindings();

    // Select a finding. Selection must never trigger a file call by itself.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    // Open the confirm dialog — still no file call until the user confirms.
    openFileDialog();
    await screen.findByRole("alertdialog");
    expect(file).not.toHaveBeenCalled();
  });

  it("gates confirm on a project selection, then files the selected findings with the chosen project + assignee", async () => {
    const { file } = await runWithFindings();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    openFileDialog();
    const dialog = within(await screen.findByRole("alertdialog"));

    // Confirm is disabled until a target project is picked from the typeahead.
    expect(
      dialog
        .getByRole("button", { name: "Create issues" })
        .hasAttribute("disabled")
    ).toBe(true);

    await selectProject("Platform");
    await selectAssignee("Ada Lovelace");
    await confirmCreate();

    await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    const request = file.mock.calls[0]?.[0] as AuditFileRequest;
    // Exactly the ONE selected finding is filed — not the whole result set.
    expect(request.findings.map((f) => f.title)).toEqual([
      "[high] stale README step",
    ]);
    // The typeahead resolves to the project's slug, and the picked assignee
    // threads onto the create call (FEA-4008).
    expect(request.projectSlug).toBe("platform");
    expect(request.assigneeId).toBe("user-1");
    expect(request.character).toBe("docs-darwin");
  });

  it("files under the SETTLED run character, not the live picker default", async () => {
    // The run completed as Code Cassandra; the picker still shows its Docs
    // Darwin default. Filing must tag the findings with the character that
    // produced them (code-cassandra), never the picker's current value.
    const cassandraResult: AuditRunResult = {
      ok: true,
      character: AuditCharacter.CodeCassandra,
      harnessUsed: "codex",
      attempts: [attempt()],
      findings: [
        {
          title: "[high] unchecked cast",
          description: "src/x.ts:3",
          signature: "sig:cast",
        },
      ],
      reason: null,
      error: null,
    };
    const { file, resolveRun } = installAuditApi(cassandraResult);
    render(<AuditView />);
    await pickRepoAndRun();
    act(() => resolveRun());
    await screen.findByText("unchecked cast");

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select finding: unchecked cast" })
    );
    openFileDialog();
    await screen.findByRole("alertdialog");
    await selectProject("Platform");
    await confirmCreate();

    await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    const request = file.mock.calls[0]?.[0] as AuditFileRequest;
    expect(request.character).toBe(AuditCharacter.CodeCassandra);
    // Assignee is optional — omitted (null) when the user picks none.
    expect(request.assigneeId).toBeNull();
  });

  it("surfaces the dedup outcome: a skipped finding is shown as already filed", async () => {
    const { file } = await runWithFindings((request) => ({
      ok: true,
      // Model the dedup guard: the selected finding matches an open issue.
      filed: request.findings.map((f) => ({
        key: findingKey(f),
        title: f.title,
        status: "skipped",
      })),
      created: 0,
      skipped: request.findings.length,
      reason: null,
      error: null,
    }));

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    openFileDialog();
    await screen.findByRole("alertdialog");
    await selectProject("Platform");
    await confirmCreate();

    await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("0 filed, 1 already filed (skipped)")
    ).toBeDefined();
    // A skipped (deduped) finding is NOT created, so it stays in the list for
    // the user to see it was not re-filed — only CREATED findings are cleared.
    expect(screen.getByText("Already filed")).toBeDefined();
    expect(screen.getByText("stale README step")).toBeDefined();
  });

  it("clears successfully-created findings from the triage list, keeping failed ones", async () => {
    // Two findings selected; the file result creates the README one and leaves
    // the flag one as a dedup skip. Only the created finding is dropped.
    const { file } = await runWithFindings((request) => ({
      ok: true,
      filed: request.findings.map((f) => ({
        key: findingKey(f),
        title: f.title,
        status: f.title.includes("stale README step") ? "created" : "skipped",
      })),
      created: 1,
      skipped: 1,
      reason: null,
      error: null,
    }));

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select finding: wrong flag name" })
    );
    openFileDialog();
    await screen.findByRole("alertdialog");
    await selectProject("Platform");
    await confirmCreate();

    await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    // The created finding is removed from the list; the deduped one lingers.
    await waitFor(() =>
      expect(screen.queryByText("stale README step")).toBeNull()
    );
    expect(screen.getByText("wrong flag name")).toBeDefined();
  });

  it("degrades gracefully when the project list is empty (offline / no projects)", async () => {
    projectsSource = [];
    const { file } = await runWithFindings();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    openFileDialog();
    const dialog = within(await screen.findByRole("alertdialog"));

    // With no projects to pick, the typeahead shows the empty state and the
    // confirm action stays disabled — no file call is possible.
    fireEvent.click(
      dialog.getByRole("combobox", { name: PROJECT_TRIGGER_NAME })
    );
    expect(await screen.findByText("No projects found.")).toBeDefined();
    expect(
      dialog
        .getByRole("button", { name: "Create issues" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(file).not.toHaveBeenCalled();
  });

  it("does not offer any assignee members before the dialog opens (roster gated)", async () => {
    // The assignee roster is gated on the dialog being open. The stub returns
    // no members while gated off, so the picker must offer none until opened.
    const { file } = await runWithFindings();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    // Before opening the dialog there is no assignee combobox at all.
    expect(
      screen.queryByRole("combobox", { name: ASSIGNEE_TRIGGER_NAME })
    ).toBeNull();

    openFileDialog();
    await screen.findByRole("alertdialog");
    // Once opened, the gate flips on and the roster is offered.
    fireEvent.click(
      screen.getByRole("combobox", { name: ASSIGNEE_TRIGGER_NAME })
    );
    expect(await screen.findByText("Ada Lovelace")).toBeDefined();
    expect(file).not.toHaveBeenCalled();
  });

  it("keeps the created/skipped outcome visible after the last finding is filed", async () => {
    // Filing every remaining finding must not blank the created/skipped
    // breakdown — the moment the user most wants to see what happened.
    const { file } = await runWithFindings((request) => ({
      ok: true,
      filed: request.findings.map((f) => ({
        key: findingKey(f),
        title: f.title,
        status: "created",
      })),
      created: request.findings.length,
      skipped: 0,
      failed: 0,
      reason: null,
      error: null,
    }));

    // Select BOTH findings so filing clears the whole list.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select finding: wrong flag name" })
    );
    openFileDialog();
    await screen.findByRole("alertdialog");
    await selectProject("Platform");
    await confirmCreate();

    await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    // The "all filed" state renders AND the outcome banner survives.
    expect(await screen.findByText("All findings filed")).toBeDefined();
    expect(screen.getByText("2 filed")).toBeDefined();
    // The cascade trail is still present in the all-filed card.
    expect(screen.getByText("Cascade trail")).toBeDefined();
  });

  it("clears only ONE of two findings that share a dedup key (created), keeping the skipped one", async () => {
    // Both selected findings normalize to the same dedup key: the backend
    // creates the first and skips the second. A key-based clear would drop
    // both; position-correlation drops only the created one.
    const sharedKey = "shared-dedup-key";
    const { file } = await runWithFindings((request) => ({
      ok: true,
      filed: request.findings.map((f, index) => ({
        key: sharedKey,
        title: f.title,
        status: index === 0 ? "created" : "skipped",
      })),
      created: 1,
      skipped: 1,
      failed: 0,
      reason: null,
      error: null,
    }));

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select finding: wrong flag name" })
    );
    openFileDialog();
    await screen.findByRole("alertdialog");
    await selectProject("Platform");
    await confirmCreate();

    await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    // The first (created) is cleared; the second (skipped) lingers and is
    // badged "Already filed", not silently removed as a same-key twin.
    await waitFor(() =>
      expect(screen.queryByText("stale README step")).toBeNull()
    );
    expect(screen.getByText("wrong flag name")).toBeDefined();
    expect(screen.getByText("Already filed")).toBeDefined();
  });

  it("keeps a failed finding in triage and surfaces the failure in the outcome", async () => {
    // A partial batch: the first finding is created, the second fails. The
    // failed one must stay for retry and the banner must not read as a clean
    // success.
    const { file } = await runWithFindings((request) => ({
      ok: true,
      filed: request.findings.map((f) => ({
        key: findingKey(f),
        title: f.title,
        status: f.title.includes("stale README step") ? "created" : "failed",
      })),
      created: 1,
      skipped: 0,
      failed: 1,
      reason: null,
      error: null,
    }));

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select finding: stale README step",
      })
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select finding: wrong flag name" })
    );
    openFileDialog();
    await screen.findByRole("alertdialog");
    await selectProject("Platform");
    await confirmCreate();

    await waitFor(() => expect(file).toHaveBeenCalledTimes(1));
    // The created finding is cleared; the failed one stays and is badged Failed.
    await waitFor(() =>
      expect(screen.queryByText("stale README step")).toBeNull()
    );
    expect(screen.getByText("wrong flag name")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();
    expect(
      screen.getByText("1 filed, 1 failed — kept for retry")
    ).toBeDefined();
  });
});
