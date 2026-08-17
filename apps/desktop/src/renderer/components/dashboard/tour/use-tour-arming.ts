import { useEffect } from "react";
import {
  dashboardOnboardedStorageKey,
  dashboardTourSeenStorageKey,
  readFlag,
  writeFlag,
} from "../dashboard-storage-keys";

export function useTourArming({
  tick,
  settled,
  analyticsLoaded,
  harnessesReady,
  firstLaunch,
  completedRef,
  setTourActive,
}: {
  tick: number;
  settled: boolean;
  analyticsLoaded: boolean;
  /**
   * ISS-5112: the guest tour's "Harnesses found" row comes from its own local
   * read, separate from the analytics the reveal waits on. Arming before it
   * lands would grow the intro summary from two rows to three underneath an
   * already-open callout.
   */
  harnessesReady: boolean;
  firstLaunch: boolean;
  completedRef: React.RefObject<boolean>;
  setTourActive: (v: boolean) => void;
}) {
  useEffect(() => {
    if (
      tick < 100 ||
      !settled ||
      !analyticsLoaded ||
      !harnessesReady ||
      completedRef.current
    ) {
      return;
    }
    if (!firstLaunch) {
      completedRef.current = true;
      return;
    }

    let timer: number | undefined;
    const arm = () => {
      if (completedRef.current) {
        return;
      }
      const button = document.querySelector<HTMLElement>("[data-tour-btn]");
      const onScreen =
        document.visibilityState === "visible" && button?.offsetParent != null;
      if (!onScreen) {
        return;
      }
      completedRef.current = true;
      document.removeEventListener("visibilitychange", arm);
      if (readFlag(dashboardTourSeenStorageKey)) {
        writeFlag(dashboardOnboardedStorageKey);
        return;
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        writeFlag(dashboardOnboardedStorageKey);
        setTourActive(true);
      }, 650);
    };

    arm();
    if (!completedRef.current) {
      document.addEventListener("visibilitychange", arm);
    }
    return () => {
      document.removeEventListener("visibilitychange", arm);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        completedRef.current = false;
      }
    };
  }, [
    tick,
    settled,
    analyticsLoaded,
    harnessesReady,
    firstLaunch,
    completedRef,
    setTourActive,
  ]);
}
