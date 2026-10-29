/**
 * ISS-7016 — the AWS SDK clients apps/api constructs must carry an explicit
 * `requestHandler`.
 *
 * Scope, stated so a green run is not read as more than it is: this file
 * enumerates the two clients below by name, so it catches one of THEM losing
 * its bound and does not catch a fourth client added unbounded tomorrow.
 *
 * The SDK v3 Node handler disables every timeout by default and retries 3
 * times, so a client built without one waits on a hung socket indefinitely. The
 * KMS clients are the sharp edge: every Linear, Google, and Slack token read
 * resolves through `resolveEncryptedIntegrationToken` on the request path, and the
 * secrets-at-rest client sits under the Pensero credential reads, so one dead socket hangs the request until the platform kills it.
 *
 * Each client is asserted equal to the shared config from
 * `@repo/aws/request-handler`, whose aborting behaviour is proved against a
 * real socket in `packages/aws/request-handler.test.ts` — so a hand-rolled
 * weaker handler here fails, not just a missing one.
 */

import {
  boundedRequestHandler,
  CONTROL_PLANE_BOUNDS,
} from "@repo/aws/request-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

type ClientConfig = {
  requestHandler?: unknown;
};

const { kmsClientConfigs } = vi.hoisted(() => ({
  kmsClientConfigs: [] as ClientConfig[],
}));

vi.mock("@repo/aws/credentials", () => ({
  getAwsCredentials: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@aws-sdk/client-kms", () => {
  class KmsClientMock {
    send = vi.fn().mockResolvedValue({ CiphertextBlob: new Uint8Array([1]) });
    constructor(config: ClientConfig) {
      kmsClientConfigs.push(config);
    }
  }
  class CommandMock {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return {
    KMSClient: KmsClientMock,
    EncryptCommand: CommandMock,
    DecryptCommand: CommandMock,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("AWS client request bounds", () => {
  beforeEach(() => {
    kmsClientConfigs.length = 0;
    vi.resetModules();
    process.env.KMS_KEY_ARN =
      "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000000";
  });

  it("builds the integration-token KMS client with the shared control-plane bound", async () => {
    const { encryptIntegrationToken } = await import(
      "@/lib/integration-encryption"
    );

    await encryptIntegrationToken("token");

    expect(kmsClientConfigs).toHaveLength(1);
    expect(kmsClientConfigs[0].requestHandler).toEqual(
      boundedRequestHandler(CONTROL_PLANE_BOUNDS)
    );
  });

  it("builds the secrets-at-rest KMS client with the shared control-plane bound", async () => {
    const { encryptSecret, KmsSecretPurpose } = await import(
      "@/lib/crypto/kms-secret"
    );

    await encryptSecret("secret", KmsSecretPurpose.PenseroApiToken);

    expect(kmsClientConfigs).toHaveLength(1);
    expect(kmsClientConfigs[0].requestHandler).toEqual(
      boundedRequestHandler(CONTROL_PLANE_BOUNDS)
    );
  });
});
