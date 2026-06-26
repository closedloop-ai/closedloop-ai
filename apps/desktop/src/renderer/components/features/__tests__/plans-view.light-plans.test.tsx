import type { LightPlansShellProps } from "@repo/app/agents/components/plans/light-plans-shell";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlanRecord,
  PlanVersionRecord,
} from "../../../../shared/agent-db-contract";
import { invalidateCache } from "../../../hooks/useQueryCache";
import {
  mapPlanRecordToLightPlan,
  mapPlanVersionRecordToLightPlanVersion,
  PlansView,
} from "../PlansView";

const { lightPlansShellMock } = vi.hoisted(() => ({
  lightPlansShellMock: vi.fn(),
}));

vi.mock("@repo/app/agents/components/plans/light-plans-shell", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/agents/components/plans/light-plans-shell")
  >("@repo/app/agents/components/plans/light-plans-shell");

  return {
    ...actual,
    LightPlansShell: lightPlansShellMock,
  };
});

describe("PlansView light-plan adapter", () => {
  beforeEach(() => {
    invalidateCache("db:plans-list");
    invalidateCache("db:plan-versions:plan-1");
    lightPlansShellMock.mockReset();
    lightPlansShellMock.mockImplementation((props: LightPlansShellProps) => (
      <div>
        <span>light-plans-shell</span>
        <span>plans:{props.plans.length}</span>
        <button onClick={() => props.onSelectPlan("plan-1")} type="button">
          select plan
        </button>
        <button onClick={() => props.onConfirmPlan("plan-1")} type="button">
          confirm plan
        </button>
        <button onClick={() => props.onRejectPlan("plan-1")} type="button">
          reject plan
        </button>
      </div>
    ));

    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        db: {
          getPlansList: vi.fn(() => Promise.resolve([planRecordFixture])),
          getPlanVersions: vi.fn(() =>
            Promise.resolve([planVersionRecordFixture])
          ),
          confirmPlan: vi.fn(() => Promise.resolve()),
          rejectPlan: vi.fn(() => Promise.resolve()),
          openPlan: vi.fn(() => Promise.resolve()),
        },
      },
    });
  });

  it("maps existing desktop DTOs into the package shell and callbacks without exposing open-plan", async () => {
    render(<PlansView />);

    expect(await screen.findByText("light-plans-shell")).toBeTruthy();
    const initialProps = lightPlansShellMock.mock.calls.at(-1)?.[0];
    expect(initialProps.plans[0]).toEqual(
      expect.objectContaining({
        id: "plan-1",
        confirmationState: "needs-confirmation",
        statusLabel: "Needs confirmation",
        filePath: "plans/plan.md",
        sourceLogPath: "logs/session.jsonl",
      })
    );
    expect(initialProps.surfaceCapabilities).toEqual({
      projectControls: false,
      teamControls: false,
    });
    expect(initialProps).not.toHaveProperty("onOpenPlan");

    fireEvent.click(screen.getByRole("button", { name: "select plan" }));
    await waitFor(() =>
      expect(window.desktopApi.db.getPlanVersions).toHaveBeenCalledWith(
        "plan-1"
      )
    );

    const selectedProps = lightPlansShellMock.mock.calls.at(-1)?.[0];
    expect(selectedProps.selectedPlan).toEqual(
      expect.objectContaining({ id: "plan-1" })
    );
    expect(selectedProps.versions[0]).toEqual(
      expect.objectContaining({
        id: "version-1",
        versionNumber: 1,
        contentMarkdown: "version content",
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "confirm plan" }));
    fireEvent.click(screen.getByRole("button", { name: "reject plan" }));

    await waitFor(() =>
      expect(window.desktopApi.db.confirmPlan).toHaveBeenCalledWith("plan-1")
    );
    expect(window.desktopApi.db.rejectPlan).toHaveBeenCalledWith("plan-1");
    expect(window.desktopApi.db.openPlan).not.toHaveBeenCalled();
  });

  it("scopes version fetch failures to the version panel without hiding plan detail actions", async () => {
    window.desktopApi.db.getPlanVersions = vi.fn(() =>
      Promise.reject(new Error("versions unavailable"))
    );

    render(<PlansView />);

    expect(await screen.findByText("light-plans-shell")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "select plan" }));
    await waitFor(() =>
      expect(window.desktopApi.db.getPlanVersions).toHaveBeenCalledWith(
        "plan-1"
      )
    );
    await waitFor(() => {
      const selectedProps = lightPlansShellMock.mock.calls.at(-1)?.[0];
      expect(selectedProps.selectedPlan).toEqual(
        expect.objectContaining({ id: "plan-1" })
      );
      expect(selectedProps.isError).toBe(false);
      expect(selectedProps.isVersionsError).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "confirm plan" }));
    fireEvent.click(screen.getByRole("button", { name: "reject plan" }));

    await waitFor(() =>
      expect(window.desktopApi.db.confirmPlan).toHaveBeenCalledWith("plan-1")
    );
    expect(window.desktopApi.db.rejectPlan).toHaveBeenCalledWith("plan-1");
  });

  it("passes pending plan actions while confirm or reject callbacks settle", async () => {
    let resolveConfirm: () => void = () => undefined;
    window.desktopApi.db.confirmPlan = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        })
    );

    render(<PlansView />);

    expect(await screen.findByText("light-plans-shell")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "confirm plan" }));

    await waitFor(() => {
      const props = lightPlansShellMock.mock.calls.at(-1)?.[0];
      expect(props.pendingAction).toEqual({
        planId: "plan-1",
        action: "confirm",
      });
    });

    resolveConfirm();

    await waitFor(() => {
      const props = lightPlansShellMock.mock.calls.at(-1)?.[0];
      expect(props.pendingAction).toBeNull();
    });
  });

  it("passes plan action failures to the shell without client logging", async () => {
    window.desktopApi.db.confirmPlan = vi.fn(() =>
      Promise.reject(new Error("confirm failed"))
    );

    render(<PlansView />);

    expect(await screen.findByText("light-plans-shell")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "confirm plan" }));

    await waitFor(() => {
      const props = lightPlansShellMock.mock.calls.at(-1)?.[0];
      expect(props.actionError).toEqual({
        planId: "plan-1",
        action: "confirm",
        message: "Plan confirmation failed. Try again.",
      });
      expect(props.pendingAction).toBeNull();
    });
  });

  it("keeps confirmed and rejected status precedence over stale confirmation flags", () => {
    expect(
      mapPlanRecordToLightPlan({
        ...planRecordFixture,
        needsConfirmation: true,
        status: "confirmed",
      })
    ).toEqual(
      expect.objectContaining({
        confirmationState: "confirmed",
        statusLabel: "confirmed",
      })
    );
    expect(
      mapPlanRecordToLightPlan({
        ...planRecordFixture,
        needsConfirmation: true,
        status: "rejected",
      })
    ).toEqual(
      expect.objectContaining({
        confirmationState: "rejected",
        statusLabel: "rejected",
      })
    );
  });

  it("maps version rows without rewriting selected plan content", () => {
    expect(
      mapPlanVersionRecordToLightPlanVersion(planVersionRecordFixture)
    ).toEqual({
      id: "version-1",
      versionNumber: 1,
      authorType: "agent",
      captureMethod: "tool-output",
      createdAt: "2026-06-10T12:05:00.000Z",
      contentMarkdown: "version content",
    });
  });
});

const planRecordFixture: PlanRecord = {
  id: "plan-1",
  title: "Plan one",
  status: "pending",
  source: "session",
  captureMethod: "plans-dir",
  harness: "codex",
  sessionId: "session-1",
  filePath: "plans/plan.md",
  sourceLogPath: "logs/session.jsonl",
  needsConfirmation: true,
  confidence: 0.91,
  createdAt: "2026-06-10T12:00:00.000Z",
  updatedAt: "2026-06-10T12:10:00.000Z",
  latestContent: "latest plan content",
  versionCount: 1,
};

const planVersionRecordFixture: PlanVersionRecord = {
  id: "version-1",
  planId: "plan-1",
  versionNumber: 1,
  contentMarkdown: "version content",
  contentSha256: "sha",
  authorType: "agent",
  captureMethod: "tool-output",
  createdAt: "2026-06-10T12:05:00.000Z",
};
