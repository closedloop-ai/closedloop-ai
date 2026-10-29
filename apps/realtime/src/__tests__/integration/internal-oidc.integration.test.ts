import { log } from "@repo/observability/log";
import { RealtimeInternalPath } from "@repo/realtime-contract/internal";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORG_A } from "../edge-harness";
import {
  clearRevocationLog,
  connectedPg,
  type HarnessInstance,
  postInternal,
  startHarnessInstance,
  stopHarnessInstance,
} from "./instance-harness";
import { integrationListener, integrationRedisUrl } from "./integration-env";

/** The header and value apps/api sent before ISS-11966 retired the shared secret. */
const RETIRED_SECRET_HEADER = {
  "x-realtime-service-secret": "current-internal-secret",
};

let api: pg.Client | undefined;
let instance: HarnessInstance | undefined;

describe.skipIf(!(integrationListener && integrationRedisUrl))(
  "an instance's /internal/* credentials (ISS-11966)",
  () => {
    beforeEach(async () => {
      if (!(integrationListener && integrationRedisUrl)) {
        return;
      }
      vi.spyOn(log, "info").mockImplementation(() => undefined);
      vi.spyOn(log, "warn").mockImplementation(() => undefined);
      api = await connectedPg(integrationListener);
      await clearRevocationLog(integrationRedisUrl);
    });

    afterEach(async () => {
      if (instance) {
        await stopHarnessInstance(instance);
        instance = undefined;
      }
      await api?.end();
      api = undefined;
      vi.restoreAllMocks();
    });

    it("accepts apps/api's bearer, checked against the issuer's JWKS", async () => {
      if (!(integrationListener && integrationRedisUrl && api)) {
        return;
      }
      instance = await startHarnessInstance(
        integrationRedisUrl,
        integrationListener,
        api
      );

      const response = await postInternal(
        instance,
        RealtimeInternalPath.Revoke,
        { target: { orgId: ORG_A } }
      );

      expect(response.status).toBe(202);
      expect(instance.jwks).toHaveBeenCalledOnce();
    });

    it("refuses the retired shared-secret header, though the task still sets the secret", async () => {
      if (!(integrationListener && integrationRedisUrl && api)) {
        return;
      }
      instance = await startHarnessInstance(
        integrationRedisUrl,
        integrationListener,
        api,
        {
          REALTIME_SERVICE_SECRET:
            RETIRED_SECRET_HEADER["x-realtime-service-secret"],
        }
      );

      const response = await postInternal(
        instance,
        RealtimeInternalPath.Revoke,
        { target: { orgId: ORG_A } },
        RETIRED_SECRET_HEADER
      );

      expect(instance.readiness.isReady()).toBe(true);
      expect(response.status).toBe(401);
    });
  }
);
