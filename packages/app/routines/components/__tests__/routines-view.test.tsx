import {
  type RunRecord,
  runRecordSchema,
  type ScheduledTask,
  scheduledTaskSchema,
} from "@repo/crewd/model";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { type RoutinesDataSource, RoutinesView } from "../routines-view";

// Render the Radix DropdownMenu inline so its items are queryable without driving
// the open interaction (which is flaky under jsdom's missing pointer capture),
// and wire `onSelect` to a click. Mirrors the house mock precedent in
// branches/components/__tests__/branch-row-actions-menu.test.tsx.
vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => (
    <button onClick={() => onSelect?.()} type="button">
      {children}
    </button>
  ),
}));

const NAME = /history/i;
const ACTIONS_NAME = /nightly review actions/i;
const HUMAN_SCHEDULE = /Every day at 9:00 \(America\/Chicago\)/;
const NEW_ROUTINE = /new routine/i;
const CONFIRM_DELETE = /^delete$/i;

const task: ScheduledTask = scheduledTaskSchema.parse({
  id: "task-1",
  cron: "0 9 * * *",
  name: "Nightly review",
  crew: "mikeangstadt",
  timezone: "America/Chicago",
  enabled: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  nextRunAt: "2026-07-23T14:00:00.000Z",
  lastRunAt: "2026-07-22T14:00:00.000Z",
  lastRunId: "run-1",
  lastStatus: "success",
});

const run: RunRecord = runRecordSchema.parse({
  id: "run-1",
  taskId: "task-1",
  taskName: "Nightly review",
  status: "success",
  startedAt: "2026-07-22T14:00:00.000Z",
  finishedAt: "2026-07-22T14:03:00.000Z",
  harnessUsed: "claude",
  summary: "Reviewed 3 PRs",
  attempts: [
    {
      harness: "codex",
      model: "gpt-5-codex",
      outcome: "failed",
      startedAt: "2026-07-22T14:00:00.000Z",
      durationMs: 1200,
    },
    {
      harness: "claude",
      model: "sonnet",
      outcome: "success",
      startedAt: "2026-07-22T14:00:02.000Z",
      durationMs: 45_000,
    },
  ],
});

function makeDataSource(
  overrides: Partial<RoutinesDataSource> = {}
): RoutinesDataSource {
  return {
    list: () => Promise.resolve([task]),
    runs: () => Promise.resolve([run]),
    create: () => Promise.resolve(task),
    update: () => Promise.resolve(task),
    delete: () => Promise.resolve(true),
    toggle: () => Promise.resolve(task),
    runNow: () => Promise.resolve(true),
    previewSchedule: () =>
      Promise.resolve({ valid: true, error: null, nextRuns: [] }),
    onChanged: () => () => undefined,
    ...overrides,
  };
}

describe("RoutinesView", () => {
  it("renders the task list with a plain-English schedule", async () => {
    render(<RoutinesView dataSource={makeDataSource()} />);

    expect(await screen.findByText("Nightly review")).toBeTruthy();
    // The row humanizes the cron, it does not show the raw "0 9 * * *".
    expect(screen.getByText(HUMAN_SCHEDULE)).toBeTruthy();
    expect(screen.getByText("Success")).toBeTruthy();
  });

  it("shows the empty state with a New routine action when there are no routines", async () => {
    render(
      <RoutinesView
        dataSource={makeDataSource({ list: () => Promise.resolve([]) })}
      />
    );

    expect(await screen.findByText("No routines")).toBeTruthy();
    expect(screen.getByRole("button", { name: NEW_ROUTINE })).toBeTruthy();
  });

  it("toggles a task's enabled flag through the data source", async () => {
    const toggle = vi.fn(() => Promise.resolve(task));
    render(<RoutinesView dataSource={makeDataSource({ toggle })} />);

    fireEvent.click(await screen.findByRole("switch"));

    await waitFor(() => expect(toggle).toHaveBeenCalledWith("task-1", false));
  });

  it("runs a task now from the row overflow menu", async () => {
    const runNow = vi.fn(() => Promise.resolve(true));
    render(<RoutinesView dataSource={makeDataSource({ runNow })} />);

    fireEvent.click(await screen.findByRole("button", { name: ACTIONS_NAME }));
    fireEvent.click(await screen.findByText("Run now"));

    await waitFor(() => expect(runNow).toHaveBeenCalledWith("task-1"));
  });

  it("deletes a task only after the confirm dialog is accepted", async () => {
    const deleteFn = vi.fn(() => Promise.resolve(true));
    render(<RoutinesView dataSource={makeDataSource({ delete: deleteFn })} />);

    fireEvent.click(await screen.findByRole("button", { name: ACTIONS_NAME }));
    fireEvent.click(await screen.findByText("Delete"));
    // A confirm dialog appears; the delete has NOT fired yet.
    expect(deleteFn).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole("button", { name: CONFIRM_DELETE })
    );
    await waitFor(() => expect(deleteFn).toHaveBeenCalledWith("task-1"));
  });

  it("opens the run-history drawer with the run's cascade trail", async () => {
    const runs = vi.fn(() => Promise.resolve([run]));
    render(<RoutinesView dataSource={makeDataSource({ runs })} />);

    fireEvent.click(await screen.findByRole("button", { name: ACTIONS_NAME }));
    fireEvent.click(await screen.findByText(NAME));

    await waitFor(() =>
      expect(runs).toHaveBeenCalledWith({ taskId: "task-1" })
    );
    expect(await screen.findByText("Reviewed 3 PRs")).toBeTruthy();
    // Both cascade steps render with their model, and the successful one is
    // marked as the producer.
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
    expect(screen.getByText("produced the result")).toBeTruthy();
  });

  it("re-fetches the task list when the data source signals a change", async () => {
    // Holder object (not a bare `let`) so TS does not narrow the callback ref to
    // `never` at the call site — the assignment happens inside `onChanged`.
    const subscription: { notify: (() => void) | null } = { notify: null };
    const list = vi
      .fn<() => Promise<ScheduledTask[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task]);
    render(
      <RoutinesView
        dataSource={makeDataSource({
          list,
          onChanged: (callback) => {
            subscription.notify = callback;
            return () => undefined;
          },
        })}
      />
    );

    expect(await screen.findByText("No routines")).toBeTruthy();
    subscription.notify?.();
    expect(await screen.findByText("Nightly review")).toBeTruthy();
  });
});
