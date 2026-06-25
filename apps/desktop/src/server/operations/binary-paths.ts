import { LoopHarness } from "@closedloop-ai/loops-api/desktop-request";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { json } from "./response-utils.js";

type BinaryPaths = {
  claude?: string;
  gh?: string;
  codex?: string;
  cursor?: string;
  opencode?: string;
  python3?: string;
  git?: string;
};
type BinaryPathKey =
  | "claude"
  | "gh"
  | "codex"
  | "cursor"
  | "opencode"
  | "python3"
  | "git";

const KNOWN_BINARY_KEYS: ReadonlySet<string> = new Set<BinaryPathKey>([
  "claude",
  "gh",
  "codex",
  "cursor",
  "opencode",
  "python3",
  "git",
]);
export function registerBinaryPathsRoutes(
  dispatcher: OperationDispatcher,
  getBinaryPaths: () => BinaryPaths,
  applyPatch: (
    patch: Partial<Record<BinaryPathKey, string | null>>
  ) => BinaryPaths
): void {
  dispatcher.register(
    "GET",
    "/api/gateway/settings/binary-paths",
    (context) => {
      json(context, 200, { binaryPaths: getBinaryPaths() });
    }
  );

  dispatcher.register(
    "PATCH",
    "/api/gateway/settings/binary-paths",
    (context) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(context.body || "{}");
      } catch {
        json(context, 400, { error: "invalid JSON body" });
        return;
      }

      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        json(context, 400, { error: "body must be a JSON object" });
        return;
      }

      const body = parsed as Record<string, unknown>;
      const patch: Partial<Record<BinaryPathKey, string | null>> = {};

      for (const [key, value] of Object.entries(body)) {
        if (!KNOWN_BINARY_KEYS.has(key)) {
          json(context, 400, { error: `unknown key: ${key}` });
          return;
        }
        if (value !== null && typeof value !== "string") {
          json(context, 400, {
            error: `value for ${key} must be a string or null`,
          });
          return;
        }
        if (typeof value === "string" && value.trim() === "") {
          json(context, 400, { error: `value for ${key} must not be empty` });
          return;
        }
        patch[key as BinaryPathKey] = value;
      }

      try {
        const updated = applyPatch(patch);
        json(context, 200, { binaryPaths: updated });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(context, 400, { error: message });
      }
    }
  );
}

/**
 * Test-only convenience lookup for harness binary names.
 * Defaults to "claude" when harness is undefined.
 */
export function resolveHarnessBinary(harness?: LoopHarness): LoopHarness {
  return harness ?? LoopHarness.Claude;
}
