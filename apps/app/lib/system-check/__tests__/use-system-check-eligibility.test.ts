import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseComputeTargets = vi.fn();
const mockUseElectronDetection = vi.fn();
const mockUseEngineerRoutingSelection = vi.fn();

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: (...args: unknown[]) => mockUseComputeTargets(...args),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: (...args: unknown[]) =>
    mockUseElectronDetection(...args),
}));

vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
}));

vi.mock("@/lib/engineer/constants", () => ({
  CLOUD_RELAY_ENABLED: false,
  DESKTOP_SETUP_URL: "https://closedloop.so/desktop",
  VALID_PROVIDERS: new Set(["claude", "codex"]),
  COMPUTE_TARGETS_QUERY_OPTIONS: { staleTime: 30_000, refetchInterval: 30_000 },
}));

import { useSystemCheckEligibility } from "../use-system-check-eligibility";

describe("useSystemCheckEligibility", () => {
  describe("with CLOUD_RELAY_ENABLED=false", () => {
    beforeEach(() => {
      vi.clearAllMocks();

      mockUseComputeTargets.mockReturnValue({
        data: [],
        isLoading: false,
      });
      mockUseElectronDetection.mockReturnValue({
        detected: false,
        loading: false,
        port: null,
        version: null,
        machineName: null,
        capabilities: null,
        checkedAt: null,
      });
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: null,
        source: "manual",
        updatedAt: Date.now(),
      });
    });

    it("returns shouldRunSystemCheck=false when the selected cloud relay target is online (CLOUD_RELAY_ENABLED=false)", () => {
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "target-2",
        source: "manual",
        updatedAt: Date.now(),
      });
      mockUseComputeTargets.mockReturnValue({
        data: [
          {
            id: "target-1",
            machineName: "Laptop",
            isOnline: false,
          },
          {
            id: "target-2",
            machineName: "Desktop",
            isOnline: true,
          },
        ],
        isLoading: false,
      });

      const { result } = renderHook(() => useSystemCheckEligibility());

      expect(result.current.shouldRunSystemCheck).toBe(false);
      expect(result.current.selectedCloudTargetOnline).toBe(false);
      expect(mockUseElectronDetection).toHaveBeenCalledWith(true);
    });

    it("runs when LocalElectron is selected and detected", () => {
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.LocalElectron,
        computeTargetId: null,
        source: "manual",
        updatedAt: Date.now(),
      });
      mockUseElectronDetection.mockReturnValue({
        detected: true,
        loading: false,
        port: 19_432,
        version: "1.0.0",
        machineName: "desktop",
        capabilities: {},
        checkedAt: Date.now(),
      });

      const { result } = renderHook(() => useSystemCheckEligibility());

      expect(result.current.shouldRunSystemCheck).toBe(true);
      expect(result.current.selectedLocalElectronReady).toBe(true);
      expect(mockUseElectronDetection).toHaveBeenCalledWith(true);
    });

    it("stays disabled when the selected cloud target is offline", () => {
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "target-1",
        source: "manual",
        updatedAt: Date.now(),
      });
      mockUseComputeTargets.mockReturnValue({
        data: [
          {
            id: "target-1",
            machineName: "Desktop",
            isOnline: false,
          },
        ],
        isLoading: false,
      });

      const { result } = renderHook(() => useSystemCheckEligibility());

      expect(result.current.shouldRunSystemCheck).toBe(false);
    });

    it("reports loading while Electron is detected but auto-selection has not settled", () => {
      // Simulates the window between Electron detection completing and
      // EngineerTransportBootstrap auto-selecting LocalElectron.  Without this,
      // the guard would flash the "no target" fallback for one frame.
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: null,
        source: "auto",
        updatedAt: Date.now(),
      });
      mockUseElectronDetection.mockReturnValue({
        detected: true,
        loading: false,
        port: 19_432,
        version: "1.0.0",
        machineName: "desktop",
        capabilities: {},
        checkedAt: Date.now(),
      });

      const { result } = renderHook(() => useSystemCheckEligibility());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.shouldRunSystemCheck).toBe(false);
    });

    it("does not block on Electron probing when a valid cloud target is selected", () => {
      // Cloud-only users should never wait on localhost probing (up to 8s).
      // With CLOUD_RELAY_ENABLED=false, electronLoadingRelevant uses "auto" source check,
      // so manual-sourced CloudRelay + detected=false + loading=true doesn't trigger loading.
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "target-1",
        source: "manual",
        updatedAt: Date.now(),
      });
      mockUseComputeTargets.mockReturnValue({
        data: [{ id: "target-1", machineName: "Desktop", isOnline: true }],
        isLoading: false,
      });
      mockUseElectronDetection.mockReturnValue({
        detected: false,
        loading: true,
        port: null,
        version: null,
        machineName: null,
        capabilities: null,
        checkedAt: null,
      });

      const { result } = renderHook(() => useSystemCheckEligibility());

      // With CLOUD_RELAY_ENABLED=false, selectedCloudTargetOnline is always false.
      // source="manual" so electronLoadingRelevant is false → not blocked by Electron probe.
      // shouldRunSystemCheck is false (no valid cloud target, no LocalElectron).
      expect(result.current.isLoading).toBe(false);
      expect(result.current.shouldRunSystemCheck).toBe(false);
    });

    it("stays loading when auto-sourced CloudRelay is selected and Electron is detected but cloud relay is disabled", () => {
      // Regression: autoSelectionPending was true whenever Electron was detected
      // with auto source + non-LocalElectron mode, even when a valid cloud target
      // meant the bootstrap would never switch to LocalElectron.
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "target-1",
        source: "auto",
        updatedAt: Date.now(),
      });
      mockUseComputeTargets.mockReturnValue({
        data: [{ id: "target-1", machineName: "Desktop", isOnline: true }],
        isLoading: false,
      });
      mockUseElectronDetection.mockReturnValue({
        detected: true,
        loading: false,
        port: 19_432,
        version: "1.0.0",
        machineName: "desktop",
        capabilities: {},
        checkedAt: Date.now(),
      });

      const { result } = renderHook(() => useSystemCheckEligibility());

      // With CLOUD_RELAY_ENABLED=false, selectedCloudTargetOnline is always false.
      // Electron detected + auto source + non-LocalElectron + no online cloud target
      // → autoSelectionPending=true → isLoading=true.
      expect(result.current.isLoading).toBe(true);
      expect(result.current.shouldRunSystemCheck).toBe(false);
      expect(result.current.selectedCloudTargetOnline).toBe(false);
    });

    it("reports normalizationPending loading when user manually selected CloudRelay and Electron is detected", () => {
      // With CLOUD_RELAY_ENABLED=false, normalizationPending=true when routing is CloudRelay
      // and Electron is detected. The routing store needs to normalize away from CloudRelay.
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: null,
        source: "manual",
        updatedAt: Date.now(),
      });
      mockUseElectronDetection.mockReturnValue({
        detected: true,
        loading: false,
        port: 19_432,
        version: "1.0.0",
        machineName: "desktop",
        capabilities: {},
        checkedAt: Date.now(),
      });

      const { result } = renderHook(() => useSystemCheckEligibility());

      // normalizationPending = !CLOUD_RELAY_ENABLED && CloudRelay mode && detected = true
      expect(result.current.isLoading).toBe(true);
      expect(result.current.shouldRunSystemCheck).toBe(false);
    });
  });

  describe("with CLOUD_RELAY_ENABLED=true", () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doMock("@/lib/engineer/constants", () => ({
        CLOUD_RELAY_ENABLED: true,
        DESKTOP_SETUP_URL: "https://closedloop.so/desktop",
        VALID_PROVIDERS: new Set(["claude", "codex"]),
        COMPUTE_TARGETS_QUERY_OPTIONS: {
          staleTime: 30_000,
          refetchInterval: 30_000,
        },
      }));
      vi.doMock("@/hooks/queries/use-compute-targets", () => ({
        useComputeTargets: (...args: unknown[]) =>
          mockUseComputeTargets(...args),
      }));
      vi.doMock("@/lib/engineer/electron-detection", () => ({
        useElectronDetection: (...args: unknown[]) =>
          mockUseElectronDetection(...args),
      }));
      vi.doMock("@/lib/engineer/routing-store", () => ({
        useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
      }));

      vi.clearAllMocks();

      mockUseComputeTargets.mockReturnValue({
        data: [],
        isLoading: false,
      });
      mockUseElectronDetection.mockReturnValue({
        detected: false,
        loading: false,
        port: null,
        version: null,
        machineName: null,
        capabilities: null,
        checkedAt: null,
      });
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: null,
        source: "manual",
        updatedAt: Date.now(),
      });
    });

    it("runs when the selected cloud relay target is online", async () => {
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "target-2",
        source: "manual",
        updatedAt: Date.now(),
      });
      mockUseComputeTargets.mockReturnValue({
        data: [
          {
            id: "target-1",
            machineName: "Laptop",
            isOnline: false,
          },
          {
            id: "target-2",
            machineName: "Desktop",
            isOnline: true,
          },
        ],
        isLoading: false,
      });

      const { useSystemCheckEligibility: useSystemCheckEligibilityEnabled } =
        await import("../use-system-check-eligibility");

      const { result } = renderHook(() => useSystemCheckEligibilityEnabled());

      expect(result.current.shouldRunSystemCheck).toBe(true);
      expect(result.current.selectedCloudTargetOnline).toBe(true);
      expect(mockUseElectronDetection).toHaveBeenCalledWith(true);
    });

    it("stays disabled when cloud relay is enabled but cloud target is offline", async () => {
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "target-1",
        source: "manual",
        updatedAt: Date.now(),
      });
      mockUseComputeTargets.mockReturnValue({
        data: [{ id: "target-1", machineName: "Desktop", isOnline: false }],
        isLoading: false,
      });

      const { useSystemCheckEligibility: useSystemCheckEligibilityEnabled } =
        await import("../use-system-check-eligibility");

      const { result } = renderHook(() => useSystemCheckEligibilityEnabled());

      expect(result.current.shouldRunSystemCheck).toBe(false);
      expect(result.current.selectedCloudTargetOnline).toBe(false);
    });

    it("does not block on Electron probing when cloud relay is enabled and a valid cloud target is selected", async () => {
      mockUseEngineerRoutingSelection.mockReturnValue({
        mode: EngineerRoutingMode.CloudRelay,
        computeTargetId: "target-1",
        source: "manual",
        updatedAt: Date.now(),
      });
      mockUseComputeTargets.mockReturnValue({
        data: [{ id: "target-1", machineName: "Desktop", isOnline: true }],
        isLoading: false,
      });
      mockUseElectronDetection.mockReturnValue({
        detected: false,
        loading: true,
        port: null,
        version: null,
        machineName: null,
        capabilities: null,
        checkedAt: null,
      });

      const { useSystemCheckEligibility: useSystemCheckEligibilityEnabled } =
        await import("../use-system-check-eligibility");

      const { result } = renderHook(() => useSystemCheckEligibilityEnabled());

      expect(result.current.isLoading).toBe(false);
      expect(result.current.shouldRunSystemCheck).toBe(true);
    });
  });
});
