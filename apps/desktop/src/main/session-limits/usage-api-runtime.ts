/**
 * @file usage-api-runtime.ts
 * @description PRD-538 R5 (ISS-5353). Desktop-main wiring that supplies the real
 * runtime dependencies — filesystem, home directory, clock, global fetch — to
 * the injectable `/usage` capture stack, mirroring how
 * {@link file://../cost/billing-mode-detector.ts billing-mode-detector.ts} wires
 * the pure billing-mode engine.
 *
 * Keeping this seam separate is what lets the credential reader, the HTTP
 * client, and the scheduler all be unit-tested under the Node test runner with
 * injected fakes — no Electron, no network, and no real credential ever touched
 * by a test.
 *
 * Secret handling: `readFileSync` is called on exactly one path and its contents
 * go straight into the validator inside `readUsageAccessToken`. Nothing here
 * logs, caches, or returns file contents; a read failure becomes a bare null.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageApiService } from "./usage-api-service.js";
import {
  readUsageAccessToken,
  type UsageCredentialDeps,
} from "./usage-credential.js";

/** Real credential-resolution deps for desktop-main. */
function realCredentialDeps(): UsageCredentialDeps {
  return {
    env: process.env,
    homeDir: homedir(),
    readFileText: (path: string): string | null => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        // Missing file, permission denied, or a directory — all mean "no
        // readable credential". The OS error is deliberately not surfaced.
        return null;
      }
    },
    joinPath: (...segments: string[]): string => join(...segments),
    now: () => Date.now(),
  };
}

/**
 * Build the production `/usage` capture service. The caller owns its lifecycle:
 * `start()` on app ready, `dispose()` on shutdown so the interval is cleared.
 * The Labs gate is injected rather than read here so this module stays free of
 * the settings store; with the gate off, `realCredentialDeps` is never even
 * constructed, let alone used to read the credential file.
 */
export function createUsageApiService(options: {
  /** The `subscriptionSessionLimits` Labs gate; off means nothing is read. */
  isEnabled: () => boolean;
}): UsageApiService {
  return new UsageApiService({
    isEnabled: options.isEnabled,
    client: {
      readAccessToken: () => readUsageAccessToken(realCredentialDeps()),
      nowIso: () => new Date().toISOString(),
    },
  });
}
