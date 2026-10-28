/** The cloud lifecycle seam; policy writes remain owned by applyDataSyncLevel. */
export type CloudConnectionLifecycleDeps = {
  isGoldenMode: () => boolean;
  isEnabled: () => boolean;
  invalidateStartup: () => void;
  recordEnabled: (enabled: boolean) => void;
  stop: () => void;
  forgetIdentity: () => void;
  applyDisabledState: () => void;
  applyIdleState: () => void;
  restart: () => void;
};

export function setCloudConnectionEnabled(
  enabled: boolean,
  deps: CloudConnectionLifecycleDeps
): void {
  // FEA-2648: golden mode hard-disables cloud egress — the toggle is inert
  // and must not flip persisted or in-memory state.
  if (deps.isGoldenMode()) {
    return;
  }
  // ISS-12422: saving consent must not invalidate an enabled connection.
  if (enabled && deps.isEnabled()) {
    return;
  }
  deps.invalidateStartup();
  deps.recordEnabled(enabled);
  if (!enabled) {
    deps.stop();
    // ISS-8691: cloud egress off — lane 1 must lose its identity too.
    deps.forgetIdentity();
    deps.applyDisabledState();
    return;
  }
  deps.applyIdleState();
  deps.restart();
}
