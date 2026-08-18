import { vi } from "vitest";

/**
 * Shared `window.desktopApi` fixture for the ApprovalsPanel suites. Lives beside
 * them rather than inside either one: the busy-state suite and the rendering
 * suite install the same seven-method surface, and a second copy would drift the
 * moment the panel reaches for another IPC.
 */

export type ApprovalsApi = {
  getPendingApprovals: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
  clearPendingApprovals: ReturnType<typeof vi.fn>;
  approveApproval: ReturnType<typeof vi.fn>;
  denyApproval: ReturnType<typeof vi.fn>;
  alwaysAllowApproval: ReturnType<typeof vi.fn>;
  removeAlwaysAllowRule: ReturnType<typeof vi.fn>;
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

export const PENDING_APPROVAL = {
  id: "approval-1",
  reason: "Run `pnpm build` in ~/code/app",
  request: { path: "/api/gateway/exec" },
  riskTier: "high",
};

export function installApprovalsApi({
  approvals = [],
  rules = [],
  overrides = {},
}: {
  approvals?: unknown[];
  rules?: unknown[];
  overrides?: Partial<ApprovalsApi>;
}): ApprovalsApi {
  const api: ApprovalsApi = {
    getPendingApprovals: vi.fn(async () => approvals),
    getSettings: vi.fn(async () => ({ alwaysAllowRules: rules })),
    clearPendingApprovals: vi.fn(async () => undefined),
    approveApproval: vi.fn(async () => undefined),
    denyApproval: vi.fn(async () => undefined),
    alwaysAllowApproval: vi.fn(async () => undefined),
    removeAlwaysAllowRule: vi.fn(async () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return api;
}

/** `afterEach` hook: restores whatever descriptor the suite started with. */
export function restoreDesktopApi(): void {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
}
