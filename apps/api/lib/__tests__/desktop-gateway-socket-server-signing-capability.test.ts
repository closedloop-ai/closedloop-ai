import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const socketServerSource = readFileSync(
  new URL("../desktop-gateway-socket-server.ts", import.meta.url),
  "utf8"
);
const socketTypesSource = readFileSync(
  new URL("../desktop-gateway-types.ts", import.meta.url),
  "utf8"
);
const relaySocketEventSource = readFileSync(
  new URL("../../app/internal/relay/socket-event/service.ts", import.meta.url),
  "utf8"
);
const apiKeyVerifyRouteSource = readFileSync(
  new URL("../../app/internal/api-keys/verify/route.ts", import.meta.url),
  "utf8"
);
const relayServerSource = readFileSync(
  new URL("../../../relay/src/index.ts", import.meta.url),
  "utf8"
);

const featureFlagEvaluationPattern =
  /isComputeTargetSigningSupportedForUser\(\{\s*userId: authContext\.userId,\s*clerkUserId: authContext\.clerkUserId,\s*\}\)/;
const helloAckCapabilityPattern =
  /"desktop\.hello\.ack"[\s\S]*serverCapabilities: \{ computeTargetSigning: true \}/;
const relayFeatureFlagEvaluationPattern =
  /isComputeTargetSigningSupportedForUser\(\{\s*userId: auth\.userId,\s*clerkUserId: auth\.clerkUserId,\s*\}\)/;

describe("desktop gateway direct socket command-signing capability", () => {
  it("keeps the authenticated Clerk ID available for feature-flag evaluation", () => {
    expect(socketTypesSource).toContain("clerkUserId?: string | null;");
    expect(socketServerSource).toContain("clerkUserId: user.clerkId");
  });

  it("announces server command-signing support on the direct hello ack", () => {
    expect(socketServerSource).toContain(
      'import { isComputeTargetSigningSupportedForUser } from "./command-signing-feature";'
    );
    expect(socketServerSource).toMatch(featureFlagEvaluationPattern);
    expect(socketServerSource).toMatch(helloAckCapabilityPattern);
  });
});

describe("desktop gateway relay socket command-signing capability", () => {
  it("carries the Clerk ID from relay API-key validation into socket-event auth", () => {
    expect(apiKeyVerifyRouteSource).toContain(
      "clerkUserId: user?.clerkId ?? null"
    );
    expect(relayServerSource).toContain("clerkUserId?: string");
    expect(relayServerSource).toContain(
      "...(clerkUserId ? { clerkUserId } : {})"
    );
  });

  it("announces server command-signing support on the relay hello ack", () => {
    expect(relaySocketEventSource).toMatch(relayFeatureFlagEvaluationPattern);
    expect(relaySocketEventSource).toMatch(helloAckCapabilityPattern);
  });
});
