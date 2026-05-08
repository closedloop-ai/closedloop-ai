/**
 * ComputeProvider registry — resolves the correct provider based on loop config.
 *
 * Resolution: loops with a computeTargetId use the desktop provider,
 * all others use ECS.
 */

import type { ComputeProvider } from "./compute-provider";
import { DesktopComputeProvider } from "./desktop-compute-provider";
import { EcsComputeProvider } from "./ecs-compute-provider";

const ProviderType = {
  Ecs: "ecs",
  Desktop: "desktop",
} as const;

type ProviderType = (typeof ProviderType)[keyof typeof ProviderType];

const providers = new Map<ProviderType, ComputeProvider>();

function ensureInitialized(): void {
  if (providers.size > 0) {
    return;
  }
  providers.set(ProviderType.Ecs, new EcsComputeProvider());
  providers.set(ProviderType.Desktop, new DesktopComputeProvider());
}

/**
 * Resolve the compute provider for a loop.
 * Loops with a computeTargetId use the desktop provider; all others use ECS.
 */
export function resolveProvider(loop: {
  computeTargetId: string | null;
}): ComputeProvider {
  ensureInitialized();
  const type = loop.computeTargetId ? ProviderType.Desktop : ProviderType.Ecs;
  const provider = providers.get(type);
  if (!provider) {
    throw new Error(`ComputeProvider not registered for type: ${type}`);
  }
  return provider;
}
