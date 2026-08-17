import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RoutinesDataSource } from "../routines-view";
import { ScheduledTaskEditorDialog } from "../scheduled-task-editor-dialog";

const NOT_RECOGNIZED = /not a schedule we recognize/i;
const ADD_STEP = /add step/i;
const CREATE_ROUTINE = /create routine/i;
const HAND_TO_CLAUDE = /hand to claude routine/i;

function makeDataSource(
  overrides: Partial<RoutinesDataSource> = {}
): RoutinesDataSource {
  return {
    list: () => Promise.resolve([]),
    runs: () => Promise.resolve([]),
    create: vi.fn(() => Promise.resolve(undefined as never)),
    update: vi.fn(() => Promise.resolve(undefined as never)),
    delete: () => Promise.resolve(true),
    toggle: () => Promise.resolve(null),
    runNow: () => Promise.resolve(true),
    previewSchedule: vi.fn(() =>
      Promise.resolve({
        valid: true,
        error: null,
        nextRuns: ["2026-07-24T14:00:00.000Z"],
      })
    ),
    onChanged: () => () => undefined,
    ...overrides,
  };
}

describe("ScheduledTaskEditorDialog", () => {
  it("previews the schedule from a natural-language phrase", async () => {
    const previewSchedule = vi.fn(() =>
      Promise.resolve({
        valid: true,
        error: null,
        nextRuns: ["2026-07-24T14:00:00.000Z"],
      })
    );
    render(
      <ScheduledTaskEditorDialog
        dataSource={makeDataSource({ previewSchedule })}
        onOpenChange={vi.fn()}
        open
        task={null}
      />
    );

    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "every weekday at 9am" },
    });

    // The phrase parses to a cron and the preview is requested with it.
    await waitFor(() =>
      expect(previewSchedule).toHaveBeenCalledWith({
        cron: "0 9 * * 1-5",
        count: 3,
      })
    );
    expect(await screen.findByText("Next runs")).toBeTruthy();
  });

  it("surfaces an unrecognized schedule without hitting the data source", async () => {
    const previewSchedule = vi.fn();
    render(
      <ScheduledTaskEditorDialog
        dataSource={makeDataSource({ previewSchedule })}
        onOpenChange={vi.fn()}
        open
        task={null}
      />
    );

    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "banana" },
    });

    expect(await screen.findByText(NOT_RECOGNIZED)).toBeTruthy();
    expect(previewSchedule).not.toHaveBeenCalled();
  });

  it("creates a task with the cascade the editor built", async () => {
    const create = vi.fn(() => Promise.resolve(undefined as never));
    const onOpenChange = vi.fn();
    render(
      <ScheduledTaskEditorDialog
        dataSource={makeDataSource({ create })}
        onOpenChange={onOpenChange}
        open
        task={null}
      />
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Nightly review" },
    });
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "daily at 9am" },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Review the open PRs." },
    });
    fireEvent.click(screen.getByRole("button", { name: ADD_STEP }));

    // Wait for the preview to validate so Create enables.
    const createButton = await screen.findByRole("button", {
      name: CREATE_ROUTINE,
    });
    await waitFor(() => expect(createButton).toHaveProperty("disabled", false));
    fireEvent.click(createButton);

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Nightly review",
          cron: "0 9 * * *",
          kind: "custom",
          prompt: "Review the open PRs.",
          harnessCascade: [{ harness: "codex" }],
          // FEA-3816 M4: the broker route defaults to local-cascade.
          route: "local-cascade",
        })
      )
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("FEA-3816 M4: flips the broker choice to a Claude routine and saves that route", async () => {
    const create = vi.fn(() => Promise.resolve(undefined as never));
    render(
      <ScheduledTaskEditorDialog
        dataSource={makeDataSource({ create })}
        onOpenChange={vi.fn()}
        open
        task={null}
      />
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Cloud sweep" },
    });
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "daily at 9am" },
    });

    // Flip the capability broker to "Hand to Claude routine".
    fireEvent.click(screen.getByRole("radio", { name: HAND_TO_CLAUDE }));

    const createButton = await screen.findByRole("button", {
      name: CREATE_ROUTINE,
    });
    await waitFor(() => expect(createButton).toHaveProperty("disabled", false));
    fireEvent.click(createButton);

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Cloud sweep",
          route: "claude-routine",
        })
      )
    );
  });

  it("surfaces a save failure inline and keeps the dialog open", async () => {
    // The data source is an injected IPC port, not a React Query mutation, so a
    // rejection is not toasted by any global handler — the dialog must surface
    // it itself instead of leaking an unhandled rejection.
    const create = vi.fn(() =>
      Promise.reject(new Error("Scheduler is not running."))
    );
    const onOpenChange = vi.fn();
    render(
      <ScheduledTaskEditorDialog
        dataSource={makeDataSource({ create })}
        onOpenChange={onOpenChange}
        open
        task={null}
      />
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Nightly review" },
    });
    fireEvent.change(screen.getByLabelText("Schedule"), {
      target: { value: "daily at 9am" },
    });

    const createButton = await screen.findByRole("button", {
      name: CREATE_ROUTINE,
    });
    await waitFor(() => expect(createButton).toHaveProperty("disabled", false));
    fireEvent.click(createButton);

    // The rejection is surfaced through an accessible alert…
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Scheduler is not running.");
    // …and the dialog stays open (the input is not lost).
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("keeps Create disabled until a name and a valid schedule are set", () => {
    render(
      <ScheduledTaskEditorDialog
        dataSource={makeDataSource()}
        onOpenChange={vi.fn()}
        open
        task={null}
      />
    );

    const createButton = screen.getByRole("button", { name: CREATE_ROUTINE });
    expect(createButton).toHaveProperty("disabled", true);
  });
});
