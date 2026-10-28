import type { BinaryPaths as PersistedBinaryPaths } from "../../shared/cli-binary-tools.js";
import {
  type CliBinaryTool,
  CliBinaryToolKeyStatus,
  classifyCliBinaryToolKey,
  stripLegacyCliBinaryPaths,
} from "../../shared/cli-binary-tools.js";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { json } from "./response-utils.js";

/** Current configurable binary-path override keys. */
export type BinaryPathKey = CliBinaryTool;

export type { BinaryPaths } from "../../shared/cli-binary-tools.js";

export function registerBinaryPathsRoutes(
  dispatcher: OperationDispatcher,
  getBinaryPaths: () => PersistedBinaryPaths,
  applyPatch: (
    patch: Partial<Record<BinaryPathKey, string | null>>
  ) => PersistedBinaryPaths
): void {
  dispatcher.register(
    "GET",
    "/api/gateway/settings/binary-paths",
    (context) => {
      json(context, 200, {
        binaryPaths: stripLegacyCliBinaryPaths(getBinaryPaths()),
      });
    }
  );

  dispatcher.register(
    "PATCH",
    "/api/gateway/settings/binary-paths",
    (context) => {
      const parsed = parseBinaryPathPatch(context.body || "{}");
      if (!parsed.ok) {
        json(context, 400, { error: parsed.error });
        return;
      }
      try {
        const updated = applyPatch(parsed.patch);
        json(context, 200, {
          binaryPaths: stripLegacyCliBinaryPaths(updated),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(context, 400, { error: message });
      }
    }
  );
}

function parseBinaryPathPatch(bodyText: string): BinaryPathPatchParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "body must be a JSON object" };
  }

  const patch: Partial<Record<BinaryPathKey, string | null>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const keyStatus = classifyCliBinaryToolKey(key);
    if (keyStatus === CliBinaryToolKeyStatus.Unknown) {
      return { ok: false, error: `unknown key: ${key}` };
    }
    if (keyStatus === CliBinaryToolKeyStatus.Legacy) {
      continue;
    }
    if (value !== null && typeof value !== "string") {
      return { ok: false, error: `value for ${key} must be a string or null` };
    }
    if (typeof value === "string" && value.trim() === "") {
      return { ok: false, error: `value for ${key} must not be empty` };
    }
    patch[key as BinaryPathKey] = value;
  }

  return { ok: true, patch };
}

type BinaryPathPatchParseResult =
  | { ok: true; patch: Partial<Record<BinaryPathKey, string | null>> }
  | { ok: false; error: string };
