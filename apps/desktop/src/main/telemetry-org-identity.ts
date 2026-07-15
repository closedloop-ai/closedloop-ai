import { createHash } from "node:crypto";
import { AppTelemetrySchema } from "@closedloop-ai/telemetry-contract/app";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { z } from "zod";
import { unwrapApiResultData } from "./api-response-utils.js";
import { fetchJsonAndParse } from "./fetch-json-and-parse.js";

/**
 * Multiplayer `org` attribution for desktop fleet telemetry (FEA-1996).
 *
 * Resolves the authenticated organization id from the active API key and
 * exposes it to the telemetry emit path. The single-player guarantee — that
 * unauthenticated installs can *never* attach org/user identity — lives
 * entirely here: {@link TelemetryOrgProvider.getOrganizationId} returns
 * `undefined` whenever the API-key store reports no key, and there is no code
 * path that yields an org without a current key. Callers therefore cannot
 * accidentally leak org in single-player.
 *
 * The organization id is the org UUID returned by `GET /me`; no user id, email,
 * or name is ever read or retained. The plaintext API key is never stored or
 * logged by this module — only an in-memory SHA-256 fingerprint is kept, solely
 * to detect key rotation and invalidate a stale cached org.
 */

/** Minimal API-key reader; intentionally narrower than the full ApiKeyStore. */
export type TelemetryOrgApiKeyReader = {
  getApiKey: () => string | null;
};

export type CreateTelemetryOrgProviderOptions = {
  apiKeyStore: TelemetryOrgApiKeyReader;
  /** Returns the cloud API origin (e.g. https://api.closedloop.ai). */
  getApiOrigin: () => string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

export type TelemetryOrgProvider = {
  /**
   * Synchronous, never throws. Returns the resolved organization id iff an API
   * key is currently present AND the org has been resolved for *that* key;
   * otherwise `undefined`. When a key is present but the org is unresolved or
   * stale, a (deduplicated) background `GET /me` is started so a subsequent
   * emit can carry the org. Safe to call on the hot emit path.
   */
  getOrganizationId: () => string | undefined;
  /**
   * Fire-and-forget warm-up. Triggers resolution for the current key so the
   * next emitted event carries the org, instead of waiting for the first call
   * on the emit path. Safe to call repeatedly; never throws or blocks.
   */
  warm: () => void;
};

/** Only `organizationId` is read from `GET /me`; everything else is discarded. */
const meOrganizationSchema = z
  .object({ organizationId: z.string().min(1) })
  .passthrough();

const ME_PATH = "/me";

/** Upper bound for the best-effort org-resolution request to the cloud API. */
const ME_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Accept an org id only if it satisfies the published `app.organization.id`
 * attribute schema. This guarantees the emit path's (throwing) schema parse can
 * never reject the value and silently drop the whole lifecycle event — a
 * pathological org (over length / control chars) simply resolves to `undefined`
 * and is omitted. Drift-proof: it reuses the same contract schema the emit path
 * validates against rather than re-encoding the bound here.
 */
function asTelemetryValidOrganizationId(
  organizationId: string
): string | undefined {
  const result = AppTelemetrySchema.safeParse({
    [TelemetryAttribute.AppOrganizationId]: organizationId,
  });
  return result.success ? organizationId : undefined;
}

export function createTelemetryOrgProvider(
  options: CreateTelemetryOrgProviderOptions
): TelemetryOrgProvider {
  const fetchImpl = options.fetchImpl ?? fetch;

  // Cache keyed by the current key fingerprint. `organizationId` is undefined
  // until the first successful /me resolution for that fingerprint.
  let cachedFingerprint: string | null = null;
  let cachedOrganizationId: string | undefined;
  // De-dupes concurrent resolutions for the same fingerprint.
  let inFlightFingerprint: string | null = null;

  function reset(): void {
    cachedFingerprint = null;
    cachedOrganizationId = undefined;
    inFlightFingerprint = null;
  }

  function fingerprintOf(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }

  function ensureResolution(key: string, fingerprint: string): void {
    if (inFlightFingerprint === fingerprint) {
      return;
    }
    inFlightFingerprint = fingerprint;
    resolveOrganizationId(key)
      .then((organizationId) => {
        // Only adopt the result if the key has not changed since the request
        // started; otherwise it belongs to a key that is no longer active.
        if (organizationId && cachedFingerprint === fingerprint) {
          cachedOrganizationId = organizationId;
        }
      })
      .catch(() => {
        // resolveOrganizationId is internally exhaustive (every throw site is
        // wrapped), so this handler is currently unreachable. It is kept as the
        // terminal handler for this fire-and-forget chain so a future change
        // that lets resolveOrganizationId reject can never escalate to an
        // unhandledRejection in the Electron main process — a failed resolution
        // simply leaves the org unresolved for the next warm()/emit to retry.
      })
      .finally(() => {
        if (inFlightFingerprint === fingerprint) {
          inFlightFingerprint = null;
        }
      });
  }

  async function resolveOrganizationId(
    key: string
  ): Promise<string | undefined> {
    // Resolve the origin behind the same try/catch that used to wrap the URL
    // build, so resolveOrganizationId stays internally exhaustive: a throwing
    // getApiOrigin() yields `undefined` rather than a rejected promise (keeping
    // the invariant the ensureResolution comment documents true).
    let apiOrigin: string;
    try {
      apiOrigin = options.getApiOrigin();
    } catch {
      return undefined;
    }

    // Bound the request so a stalled /me never wedges the in-flight de-dup slot:
    // on timeout (or any transport/response/schema failure) fetchJsonAndParse
    // resolves to the `undefined` sentinel, and ensureResolution's .finally()
    // frees the fingerprint so a later warm()/emit can retry.
    const parsed = await fetchJsonAndParse(ME_PATH, meOrganizationSchema, {
      apiOrigin,
      token: key,
      unwrap: unwrapApiResultData,
      sentinel: undefined,
      headers: { Accept: "application/json" },
      timeoutMs: ME_REQUEST_TIMEOUT_MS,
      fetchImpl,
    });
    return parsed
      ? asTelemetryValidOrganizationId(parsed.organizationId)
      : undefined;
  }

  function sync(): { key: string; fingerprint: string } | null {
    const key = options.apiKeyStore.getApiKey();
    if (!key) {
      // No API key ⇒ single-player. Drop any cached org so a prior
      // authenticated session can never bleed into unauthenticated telemetry.
      if (cachedFingerprint !== null || cachedOrganizationId !== undefined) {
        reset();
      }
      return null;
    }

    const fingerprint = fingerprintOf(key);
    if (fingerprint !== cachedFingerprint) {
      // New or rotated key: invalidate the stale org but keep the new
      // fingerprint so resolution can populate it.
      cachedFingerprint = fingerprint;
      cachedOrganizationId = undefined;
    }
    return { key, fingerprint };
  }

  return {
    getOrganizationId() {
      const current = sync();
      if (!current) {
        return undefined;
      }
      if (cachedOrganizationId === undefined) {
        ensureResolution(current.key, current.fingerprint);
      }
      return cachedOrganizationId;
    },
    warm() {
      const current = sync();
      if (current && cachedOrganizationId === undefined) {
        ensureResolution(current.key, current.fingerprint);
      }
    },
  };
}
