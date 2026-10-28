import path from "node:path";
import type { DesktopSessionManager } from "../session/desktop-session-manager.js";
import type { SessionMeshHookEvent } from "./session-mesh-hook-contract.js";
import { startSessionMeshHookInstallation } from "./session-mesh-hook-installer.js";
import { sessionMeshLocalToken } from "./session-mesh-local-auth.js";
import {
  SessionMeshRuntime,
  type SessionMeshRuntimeOptions,
} from "./session-mesh-runtime.js";
import { resolveSessionMeshWorkspace } from "./session-mesh-workspace.js";

export function createDesktopSessionMeshController(options: {
  userDataPath: () => string;
  isEnabled: () => boolean;
  sessionManager: () => Pick<
    DesktopSessionManager,
    "getIdentity" | "getAccessToken" | "invalidateAccessToken"
  >;
  computeTargetId: () => string | null;
  getApiOrigin: () => string;
  log: (message: string) => void;
}) {
  return createSessionMeshController({
    ...options,
    getIdentity: () => {
      const identity = options.sessionManager().getIdentity();
      const computeTargetId = options.computeTargetId();
      return identity && computeTargetId
        ? { ...identity, computeTargetId }
        : null;
    },
    getAccessToken: () => options.sessionManager().getAccessToken(),
    invalidateAccessToken: (token) =>
      options.sessionManager().invalidateAccessToken(token),
  });
}

export function createSessionMeshController(
  options: Omit<
    SessionMeshRuntimeOptions,
    "directory" | "localToken" | "resolveWorkspace"
  > & {
    userDataPath: () => string;
    isEnabled: () => boolean;
  }
) {
  let runtime: SessionMeshRuntime | null = null;
  const ensureRuntime = () => {
    if (!options.isEnabled()) {
      return null;
    }
    try {
      if (!runtime) {
        runtime = new SessionMeshRuntime({
          ...options,
          directory: path.join(options.userDataPath(), "session-mesh"),
          localToken: sessionMeshLocalToken(options.userDataPath()),
          resolveWorkspace: resolveSessionMeshWorkspace,
        });
        runtime.start();
      }
      return runtime;
    } catch (error) {
      options.log(`Session Mesh unavailable: ${String(error)}`);
      return null;
    }
  };
  return {
    start() {
      if (!runtime && ensureRuntime()) {
        startSessionMeshHookInstallation(true);
      }
    },
    handle(event: SessionMeshHookEvent) {
      return options.isEnabled() ? runtime?.handle(event) : undefined;
    },
    stop() {
      runtime?.stop();
      runtime = null;
    },
  };
}
