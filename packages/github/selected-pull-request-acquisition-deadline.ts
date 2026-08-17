import { z } from "zod";

/** Optional caller cancellation and finite budget for selected-PR acquisition. */
export type SelectedPullRequestAcquisitionOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** One disposable signal shared by every request in an acquisition. */
export type SelectedPullRequestAcquisitionDeadline = {
  signal: AbortSignal;
  dispose(): void;
};

/**
 * Compose caller cancellation with one operation timer.
 *
 * Returns `null` for malformed options so callers can reject them before
 * scheduling provider work.
 */
export function createSelectedPullRequestAcquisitionDeadline(
  options: SelectedPullRequestAcquisitionOptions = {}
): SelectedPullRequestAcquisitionDeadline | null {
  const parsed = acquisitionOptionsSchema.safeParse(options);
  if (!parsed.success) {
    return null;
  }

  const controller = new AbortController();
  const callerSignal = parsed.data.signal;
  const abortFromCaller = () => {
    controller.abort(createAbortError("Selected pull-request read cancelled"));
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeout = setTimeout(() => {
    controller.abort(createAbortError("Selected pull-request read timed out"));
  }, parsed.data.timeoutMs ?? SELECTED_PULL_REQUEST_ACQUISITION_TIMEOUT_MS);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Maximum and default operation budget retained for backward compatibility. */
export const SELECTED_PULL_REQUEST_ACQUISITION_TIMEOUT_MS = 120_000;

/**
 * Field validators for the caller-supplied options, kept as a standalone
 * literal so the keys-covered guard below can see them.
 *
 * `satisfies Record<keyof SelectedPullRequestAcquisitionOptions, z.ZodTypeAny>`
 * is the compile-time guard (FEA-3701, root AGENTS.md). Because the schema
 * below is `.strict()`, a field added to
 * {@link SelectedPullRequestAcquisitionOptions} and passed by a caller without
 * being taught here makes `safeParse` fail — and this module reports a parse
 * failure as `null`, so acquisition is abandoned before any provider work is
 * scheduled rather than degrading. `satisfies` turns that into a `tsc` failure
 * instead: a missing key and an extra key are both errors.
 */
const acquisitionOptionsShape = {
  signal: z.instanceof(AbortSignal).optional(),
  timeoutMs: z
    .number()
    .finite()
    .int()
    .positive()
    .max(SELECTED_PULL_REQUEST_ACQUISITION_TIMEOUT_MS)
    .optional(),
} satisfies Record<keyof SelectedPullRequestAcquisitionOptions, z.ZodTypeAny>;

const acquisitionOptionsSchema = z.object(acquisitionOptionsShape).strict();
