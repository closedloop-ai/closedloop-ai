import { z } from "zod";

export type ElectronDetectionState = {
  detected: boolean;
  loading: boolean;
  port: number | null;
  version: string | null;
  machineName: string | null;
  gatewayId: string | null;
  capabilities: Record<string, unknown> | null;
  onboardingCompleted: boolean | null;
  checkedAt: number | null;
};

type ElectronProbeResult = Pick<
  ElectronDetectionState,
  | "detected"
  | "port"
  | "version"
  | "machineName"
  | "gatewayId"
  | "capabilities"
  | "onboardingCompleted"
>;

const PROBE_PORTS = [19_432, 19_433, 19_434, 19_435] as const;
const PROBE_TIMEOUT_MS = 2000;

export function getPossibleElectronHostnames(): {
  hostname: string;
  port: number;
}[] {
  return PROBE_PORTS.map((port) => ({
    hostname: `http://localhost:${port}`,
    port,
  }));
}

export async function probeElectron(): Promise<ElectronProbeResult> {
  for (const { hostname, port } of getPossibleElectronHostnames()) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const response = await fetch(`${hostname}/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!response.ok) {
        continue;
      }

      const payload = await response.json().catch(() => null);
      const result = parseHealthPayload(payload, port);
      if (result) {
        return result;
      }
    } catch {
      // Ignore probe errors and continue to next fallback port.
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    detected: false,
    port: null,
    version: null,
    machineName: null,
    gatewayId: null,
    capabilities: null,
    onboardingCompleted: null,
  };
}

const HealthPayloadSchema = z.looseObject({
  status: z.literal("ok"),
  port: z.number().optional().catch(undefined),
  version: z.string().optional().catch(undefined),
  machineName: z.string().optional().catch(undefined),
  gatewayId: z.string().optional().catch(undefined),
  capabilities: z.record(z.string(), z.unknown()).optional().catch(undefined),
  onboardingCompleted: z.boolean().optional().catch(undefined),
});

function parseHealthPayload(
  payload: unknown,
  fallbackPort: number
): ElectronProbeResult | null {
  const result = HealthPayloadSchema.safeParse(payload);
  if (!result.success) {
    return null;
  }

  const health = result.data;
  const reportedPort = health.port ?? fallbackPort;
  if (reportedPort !== fallbackPort) {
    return null;
  }

  return {
    detected: true,
    port: reportedPort,
    version: health.version ?? null,
    machineName: health.machineName ?? null,
    gatewayId: health.gatewayId?.trim() ? health.gatewayId : null,
    capabilities: health.capabilities ?? {},
    onboardingCompleted: health.onboardingCompleted ?? null,
  };
}
