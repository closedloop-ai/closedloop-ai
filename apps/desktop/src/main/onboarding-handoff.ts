import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeScopePath } from "../shared/sandbox-policy.js";
import { normalizeWebAppOrigin } from "./origin-policy.js";

export const ONBOARDING_HANDOFF_FILE_NAME = "pending-onboarding.json";
export const ONBOARDING_HANDOFF_MAX_AGE_MS = 60 * 60 * 1000;

export type PendingOnboardingHandoff = {
  onboardingAttemptId: string;
  webAppOrigin: string;
  sandboxBaseDirectory?: string;
  createdAt: string;
};

/**
 * Coalesces canonical handoff file-open events that arrive before boot or while
 * Desktop is still processing a previous handoff.
 */
export class OnboardingHandoffQueue {
  private pendingCanonicalOpenFile = false;

  enqueueCanonicalOpenFile(): void {
    this.pendingCanonicalOpenFile = true;
  }

  hasPendingCanonicalOpenFile(): boolean {
    return this.pendingCanonicalOpenFile;
  }

  drainCanonicalOpenFile(): boolean {
    const pending = this.pendingCanonicalOpenFile;
    this.pendingCanonicalOpenFile = false;
    return pending;
  }
}

export type OnboardingHandoffReadResult =
  | { kind: "absent" }
  | { kind: "loaded"; payload: PendingOnboardingHandoff }
  | { kind: "ignored"; reason: OnboardingHandoffFailureReason };

export type OnboardingHandoffFailureReason =
  | "read_failed"
  | "invalid_json"
  | "invalid_shape"
  | "invalid_origin"
  | "invalid_created_at"
  | "stale"
  | "delete_failed";

/**
 * Returns the product-specified macOS handoff path used by the installer.
 */
export function getCanonicalOnboardingHandoffPath(
  homeDir = os.homedir()
): string {
  return path.join(
    homeDir,
    "Library",
    "Application Support",
    "Closedloop Desktop",
    ONBOARDING_HANDOFF_FILE_NAME
  );
}

/**
 * Compares an OS-delivered file path with the canonical handoff path.
 */
export function isCanonicalOnboardingHandoffPath(
  candidatePath: string,
  canonicalPath = getCanonicalOnboardingHandoffPath()
): boolean {
  return path.resolve(candidatePath) === path.resolve(canonicalPath);
}

/**
 * Parses the one-time installer handoff and rejects unexpected fields so the
 * trust boundary stays narrow and auditable.
 */
export function parsePendingOnboardingHandoff(
  raw: unknown,
  now = new Date()
):
  | { ok: true; payload: PendingOnboardingHandoff }
  | { ok: false; reason: OnboardingHandoffFailureReason } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "invalid_shape" };
  }

  const record = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    "onboardingAttemptId",
    "webAppOrigin",
    "sandboxBaseDirectory",
    "createdAt",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return { ok: false, reason: "invalid_shape" };
  }

  const onboardingAttemptId =
    typeof record.onboardingAttemptId === "string"
      ? record.onboardingAttemptId.trim()
      : "";
  if (!onboardingAttemptId) {
    return { ok: false, reason: "invalid_shape" };
  }

  let webAppOrigin: string;
  try {
    if (typeof record.webAppOrigin !== "string") {
      return { ok: false, reason: "invalid_origin" };
    }
    webAppOrigin = normalizeWebAppOrigin(record.webAppOrigin);
  } catch {
    return { ok: false, reason: "invalid_origin" };
  }

  if (typeof record.createdAt !== "string") {
    return { ok: false, reason: "invalid_created_at" };
  }
  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return { ok: false, reason: "invalid_created_at" };
  }
  if (createdAtMs > now.getTime()) {
    return { ok: false, reason: "invalid_created_at" };
  }
  if (now.getTime() - createdAtMs > ONBOARDING_HANDOFF_MAX_AGE_MS) {
    return { ok: false, reason: "stale" };
  }

  let sandboxBaseDirectory: string | undefined;
  if (record.sandboxBaseDirectory !== undefined) {
    if (typeof record.sandboxBaseDirectory !== "string") {
      return { ok: false, reason: "invalid_shape" };
    }
    sandboxBaseDirectory =
      normalizeScopePath(record.sandboxBaseDirectory) ?? undefined;
  }

  return {
    ok: true,
    payload: {
      onboardingAttemptId,
      webAppOrigin,
      ...(sandboxBaseDirectory ? { sandboxBaseDirectory } : {}),
      createdAt: new Date(createdAtMs).toISOString(),
    },
  };
}

/**
 * Reads, validates, and deletes a pending handoff when it exists.
 */
export async function readPendingOnboardingHandoff(
  filePath = getCanonicalOnboardingHandoffPath(),
  now = new Date()
): Promise<OnboardingHandoffReadResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    return { kind: "ignored", reason: "read_failed" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    if (!(await tryDeleteHandoffFile(filePath))) {
      return { kind: "ignored", reason: "delete_failed" };
    }
    return { kind: "ignored", reason: "invalid_json" };
  }

  const parsed = parsePendingOnboardingHandoff(raw, now);
  if (!parsed.ok) {
    if (!(await tryDeleteHandoffFile(filePath))) {
      return { kind: "ignored", reason: "delete_failed" };
    }
    return { kind: "ignored", reason: parsed.reason };
  }
  if (!(await tryDeleteHandoffFile(filePath))) {
    return { kind: "ignored", reason: "delete_failed" };
  }
  return { kind: "loaded", payload: parsed.payload };
}

async function tryDeleteHandoffFile(filePath: string): Promise<boolean> {
  try {
    await fs.rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}
