import { log } from "@repo/observability/log";

/** What `/ready` waits on (PLN-2104 step 8; the bus subscriber, PLN-2105 step 5). */
export const Dependency = {
  Redis: "redis",
  Bus: "bus",
  Listener: "listener",
} as const;
export type Dependency = (typeof Dependency)[keyof typeof Dependency];

export type Readiness = {
  markUp(dependency: Dependency): void;
  /** `cause` is a code or error name, never a message. */
  markDown(dependency: Dependency, cause: string): void;
  /** Latched: true from the first moment every dependency was up at once. */
  isReady(): boolean;
  /** A dependency lost after first readiness. `/health` never reads this. */
  isDegraded(): boolean;
};

/**
 * PLN-2104 step 8 and ISS-11210 requirement 3: readiness latches, so losing a
 * dependency afterwards degrades the instance instead of taking it out of the
 * load balancer.
 */
export function createReadiness(
  dependencies: readonly Dependency[]
): Readiness {
  const up = new Set<Dependency>();
  let ready = false;
  return {
    markUp(dependency) {
      if (up.has(dependency)) {
        return;
      }
      up.add(dependency);
      if (ready) {
        log.info("Realtime dependency restored", {
          event: DEPENDENCY_RESTORED_EVENT,
          dependency,
        });
        return;
      }
      if (dependencies.every((each) => up.has(each))) {
        ready = true;
        log.info("Realtime service ready", { event: READY_EVENT });
      }
    },
    markDown(dependency, cause) {
      if (!up.delete(dependency)) {
        return;
      }
      log.warn("Realtime dependency lost", {
        event: DEPENDENCY_LOST_EVENT,
        dependency,
        cause,
        degraded: ready,
      });
    },
    isReady: () => ready,
    isDegraded: () =>
      ready && dependencies.some((dependency) => !up.has(dependency)),
  };
}

export const READY_EVENT = "realtime.ready";
export const DEPENDENCY_LOST_EVENT = "realtime.dependency_lost";
export const DEPENDENCY_RESTORED_EVENT = "realtime.dependency_restored";
