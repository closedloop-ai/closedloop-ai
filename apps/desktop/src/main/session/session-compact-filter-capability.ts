import { isTransientDbHostError } from "../../shared/transient-db-host-error.js";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import {
  SESSION_COMPACT_FILTER_VERSION,
  type SessionCompactFilterCapabilities,
} from "../agent-sync/session-compact-filter-capabilities.js";

const cachedCapabilities = new WeakMap<
  AgentSessionSyncSource,
  Promise<SessionCompactFilterCapabilities | null>
>();

/** Admit only the DB-host operation that declares this filter revision. */
export async function supportsSessionCompactFilter(
  source: AgentSessionSyncSource,
  operation: keyof SessionCompactFilterCapabilities
): Promise<boolean> {
  let pending = cachedCapabilities.get(source);
  if (!pending) {
    pending = readCapabilities(source).catch((error: unknown) => {
      cachedCapabilities.delete(source);
      if (isTransientDbHostError(error)) {
        throw error;
      }
      return null;
    });
    cachedCapabilities.set(source, pending);
  }
  const capabilities = await pending;
  return capabilities?.[operation] === SESSION_COMPACT_FILTER_VERSION;
}

function readCapabilities(
  source: AgentSessionSyncSource
): Promise<SessionCompactFilterCapabilities | null> {
  if (!source.readSessionCompactFilterCapabilities) {
    return Promise.resolve(null);
  }
  return Promise.resolve().then(
    () => source.readSessionCompactFilterCapabilities?.() ?? null
  );
}
