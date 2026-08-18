import type { OperationDispatcher } from "../operation-dispatcher.js";
import type { ProcessManager } from "../process-manager.js";
import {
  type BinaryPathKey,
  type BinaryPaths,
  registerBinaryPathsRoutes,
} from "./binary-paths.js";
import { registerHealthCheckRoutes } from "./health-check.js";
import { registerHealthCheckRepairRoutes } from "./health-check-repair.js";

/**
 * Registers the whole System Check surface — the health check, its Repair
 * operation, and the binary-path settings the two share — behind one call, so
 * the router does not have to thread the same four dependencies through three
 * registrations that must agree.
 */

export type SystemCheckRouteDeps = {
  processManager: ProcessManager;
  getSymphonyDir: () => string;
  getBinaryPaths?: () => BinaryPaths;
  applyBinaryPathPatch?: (
    patch: Partial<Record<BinaryPathKey, string | null>>
  ) => BinaryPaths;
  getAppVersion: () => string | undefined;
  /**
   * `app.isPackaged`. Absent when the host cannot report it, in which case the
   * build stays unclassified and the version row asserts nothing (ISS-5369).
   */
  isPackagedBuild?: () => boolean;
};

export function registerSystemCheckRoutes(
  dispatcher: OperationDispatcher,
  deps: SystemCheckRouteDeps
): void {
  registerHealthCheckRoutes(
    dispatcher,
    deps.processManager,
    deps.getSymphonyDir,
    undefined,
    deps.getBinaryPaths,
    deps.getAppVersion,
    deps.isPackagedBuild
  );
  registerHealthCheckRepairRoutes(dispatcher, {
    processManager: deps.processManager,
    getSymphonyDir: deps.getSymphonyDir,
    getBinaryPaths: deps.getBinaryPaths,
    applyBinaryPathPatch: deps.applyBinaryPathPatch,
    getAppVersion: deps.getAppVersion,
    isPackagedBuild: deps.isPackagedBuild,
  });
  // The binary-path settings routes only exist when the host wired both halves;
  // Repair degrades to a named failure rather than silently doing nothing.
  if (deps.getBinaryPaths && deps.applyBinaryPathPatch) {
    registerBinaryPathsRoutes(
      dispatcher,
      deps.getBinaryPaths,
      deps.applyBinaryPathPatch
    );
  }
}
