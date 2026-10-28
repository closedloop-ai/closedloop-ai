/**
 * ISS-12552 (PRD-800 "Rollout"): a settled
 * parse-policy flip reruns post-boot maintenance once, so the rebuild
 * re-derives every session under the new revision (the db-host lifecycle
 * pushes the policy itself).
 *
 * A flip never supersedes a pass that is running: the rerun waits for it to
 * settle, so no pass is re-listed midway, and flips that land while a rerun is
 * waiting share it, so at most one more pass is queued behind the current one.
 * Before the boot's own maintenance is scheduled there is nothing to rerun:
 * that run selects by the new revision.
 */
export type ParsePolicyMaintenanceRerunDeps = {
  /** Whether the boot's post-boot maintenance has been scheduled. */
  isScheduled: () => boolean;
  /** The pass in flight, if any. It settles without rejecting. */
  currentPass: () => Promise<void> | null;
  isClosed: () => boolean;
  /** Schedules one maintenance pass. */
  rerun: () => void;
};

/** Returns the flip listener. */
export function createParsePolicyMaintenanceRerun(
  deps: ParsePolicyMaintenanceRerunDeps
): () => void {
  let queued = false;
  const rerunWhenIdle = (): void => {
    if (deps.isClosed()) {
      queued = false;
      return;
    }
    const pass = deps.currentPass();
    if (pass) {
      pass.then(rerunWhenIdle, rerunWhenIdle);
      return;
    }
    queued = false;
    deps.rerun();
  };
  return () => {
    if (queued || !deps.isScheduled() || deps.isClosed()) {
      return;
    }
    queued = true;
    rerunWhenIdle();
  };
}
