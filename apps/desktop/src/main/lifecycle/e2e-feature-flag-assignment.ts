import fs from "node:fs";
import path from "node:path";
import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import {
  E2E_FEATURE_FLAG_ASSIGNMENT_ARG,
  E2E_FEATURE_FLAG_ASSIGNMENT_FILE,
  e2eFeatureFlagAssignmentSeedSchema,
} from "../../shared/e2e-feature-flag-assignment-contract.js";

/**
 * ISS-8753: the launch-argument opt-in that lets the Electron E2E harness serve
 * this launch a feature-flag ASSIGNMENT.
 *
 * WHY THIS EXISTS. Desktop flag resolution is the signed-in user's PostHog
 * assignment, fetched server-side and delivered over the IPC bridge. The
 * Electron E2E harness launches with no account, which is a terminal CLOSED
 * answer for every key — so without a seam every Labs-gated spec in
 * `test/e2e/` would assert against a permanently dark app, including the two
 * "(flag on)" cases in `settings-labs-gateway-health.spec.ts` that the required
 * `desktop` job runs. The harness used to open those gates by writing
 * `desktop-settings.json` and letting the renderer read the LOCAL registry;
 * that registry path is the one the cutover removes, and reinstating it would
 * be reinstating exactly what was removed.
 *
 * So the seam substitutes the ASSIGNMENT, not the registry: the harness writes
 * the flag verdicts into {@link E2E_FEATURE_FLAG_ASSIGNMENT_FILE} in the launch
 * profile, and this serves them in the same
 * {@link DesktopFeatureFlagAssignment} wire shape the API returns. The renderer
 * then runs the SAME boundary read over it as over a real reply, so a spec
 * exercises the shipped classification rather than a parallel one.
 *
 * NOT REACHABLE BY A REAL USER, by two independent gates. A packaged build
 * returns `null` before it reads argv or touches the filesystem at all — the
 * same posture, and the same do-not-delete branch, as
 * `isWindowRevealSuppressed`. And an unpackaged build still serves nothing
 * unless {@link E2E_FEATURE_FLAG_ASSIGNMENT_ARG} was passed on the command
 * line, which no shipped launcher passes. A file sitting in a developer's
 * profile therefore opens no gate on its own, which is the property the cutover
 * exists to establish: local state must not decide a flag.
 *
 * Deliberately an app-level LAUNCH ARGUMENT rather than an env var, for the
 * reason `E2E_NO_REVEAL_ARG` and `E2E_EPHEMERAL_LOOPBACK_PORTS_ARG` both state:
 * an env var can be inherited into a real user's session, and an inherited
 * variable that opens feature gates is the product back door this seam must not
 * be. The argument and file names themselves live in
 * `shared/e2e-feature-flag-assignment-contract.ts`, which the Playwright harness
 * can import without dragging this module's dependencies into the spec loader.
 */

/**
 * The subject a harness assignment is reported as evaluated for.
 *
 * The renderer reads a seeded assignment with a `null` subject — the boundary
 * read's documented anonymous/pre-auth case, which is what an unauthenticated
 * launch actually is — so this value is never correlated against an account. It
 * is a legible marker in a payload dump, not an identity.
 */
export const E2E_FEATURE_FLAG_ASSIGNMENT_SUBJECT = "e2e-harness";

/**
 * This launch's harness-seeded assignment, or `null` when there is none.
 *
 * `null` is every failure and every ordinary launch: packaged build, missing
 * argument, missing file, unreadable file, malformed JSON, a non-boolean
 * verdict. The renderer treats `null` as "no seed" and falls through to the real
 * assignment path, so a broken seed degrades to the production behavior rather
 * than to an open gate.
 *
 * @param readSeedFile - injected only so the guards above can be driven without
 *   a temp profile; production passes nothing.
 */
export function readE2eFeatureFlagAssignment(
  argv: readonly string[],
  options: {
    isPackaged: boolean;
    userDataPath: string;
    readSeedFile?: (filePath: string) => string | null;
  }
): DesktopFeatureFlagAssignment | null {
  if (options.isPackaged) {
    return null;
  }
  if (!argv.includes(E2E_FEATURE_FLAG_ASSIGNMENT_ARG)) {
    return null;
  }
  const raw = (options.readSeedFile ?? readSeedFileOrNull)(
    path.join(options.userDataPath, E2E_FEATURE_FLAG_ASSIGNMENT_FILE)
  );
  if (raw === null) {
    return null;
  }
  const flags = parseSeededFlags(raw);
  if (flags === null) {
    return null;
  }
  return {
    userId: E2E_FEATURE_FLAG_ASSIGNMENT_SUBJECT,
    resolved: true,
    flags,
  };
}

function readSeedFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    // Absent — every launch that did not seed — or unreadable. Both are "no
    // seed", never a partially-applied one.
    return null;
  }
}

function parseSeededFlags(raw: string): Record<string, boolean> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = e2eFeatureFlagAssignmentSeedSchema.safeParse(payload);
  return parsed.success ? parsed.data.flags : null;
}
