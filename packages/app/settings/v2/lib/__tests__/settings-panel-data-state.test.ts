import { describe, expect, it } from "vitest";
import { ApiError } from "../../../../shared/api/api-error";
import {
  classifySettingsPanelError,
  classifySettingsPanelRead,
  isStaleResourceError,
  SettingsPanelDataState,
} from "../settings-panel-data-state";

const READY_READ = {
  error: null,
  hasData: true,
  isEmpty: false,
  isPending: false,
};

describe("classifySettingsPanelRead", () => {
  it("keeps loading, empty, forbidden, unavailable and failed apart (ISS-8369)", () => {
    expect(
      classifySettingsPanelRead({
        ...READY_READ,
        hasData: false,
        isPending: true,
      })
    ).toBe(SettingsPanelDataState.Loading);
    expect(classifySettingsPanelRead({ ...READY_READ, isEmpty: true })).toBe(
      SettingsPanelDataState.Empty
    );
    expect(
      classifySettingsPanelRead({
        ...READY_READ,
        error: new ApiError("nope", 403),
      })
    ).toBe(SettingsPanelDataState.Forbidden);
    expect(
      classifySettingsPanelRead({
        ...READY_READ,
        error: new ApiError("no answer", 503),
      })
    ).toBe(SettingsPanelDataState.Unavailable);
    expect(
      classifySettingsPanelRead({
        ...READY_READ,
        error: new ApiError("boom", 500),
      })
    ).toBe(SettingsPanelDataState.Failed);
    expect(classifySettingsPanelRead(READY_READ)).toBe(
      SettingsPanelDataState.Ready
    );
  });

  it("reads a settled body-less response as failed, never as empty", () => {
    // The defect this classifier exists to prevent: the legacy panels leave
    // `data` undefined on a failed list read and render "No API keys yet" /
    // "Not connected" — a failed read shown as a completed one.
    expect(
      classifySettingsPanelRead({
        error: null,
        hasData: false,
        isEmpty: true,
        isPending: false,
      })
    ).toBe(SettingsPanelDataState.Failed);
  });

  it("does not let a held body mask a failing read", () => {
    // A query keeps its last successful body after a later read fails. Showing
    // it would present stale keys and stale connection statuses as live.
    expect(
      classifySettingsPanelRead({
        error: new ApiError("gone away", 500),
        hasData: true,
        isEmpty: false,
        isPending: false,
      })
    ).toBe(SettingsPanelDataState.Failed);
  });

  it("does not let a pending flag mask an error that already arrived", () => {
    expect(
      classifySettingsPanelRead({
        error: new ApiError("nope", 403),
        hasData: false,
        isEmpty: true,
        isPending: true,
      })
    ).toBe(SettingsPanelDataState.Forbidden);
  });
});

describe("classifySettingsPanelError", () => {
  it("does not fold an unresolved role read into a denial", () => {
    // The API reserves 503 for "nothing about your access was decided"
    // (`AuthErrorCode.OrgUnverifiable` ships that way; an unresolved
    // organization role is the same shape). Rendering it as 403 would send a
    // user to ask an admin for a permission they may already hold.
    const unresolved = classifySettingsPanelError(
      new ApiError("role unresolved", 503)
    );
    const denied = classifySettingsPanelError(new ApiError("denied", 403));

    expect(unresolved).toBe(SettingsPanelDataState.Unavailable);
    expect(denied).toBe(SettingsPanelDataState.Forbidden);
    expect(unresolved).not.toBe(denied);
  });

  it("classifies a throw carrying no status as failed, never as a denial", () => {
    expect(classifySettingsPanelError(new Error("network down"))).toBe(
      SettingsPanelDataState.Failed
    );
    expect(classifySettingsPanelError("not an error at all")).toBe(
      SettingsPanelDataState.Failed
    );
  });
});

describe("isStaleResourceError", () => {
  it("recognises the shapes a resource that moved on answers with", () => {
    expect(isStaleResourceError(new ApiError("gone", 404))).toBe(true);
    expect(isStaleResourceError(new ApiError("conflict", 409))).toBe(true);
  });

  it("does not treat a denial, an outage, or a plain throw as stale", () => {
    expect(isStaleResourceError(new ApiError("denied", 403))).toBe(false);
    expect(isStaleResourceError(new ApiError("boom", 500))).toBe(false);
    expect(isStaleResourceError(new Error("network down"))).toBe(false);
  });
});
