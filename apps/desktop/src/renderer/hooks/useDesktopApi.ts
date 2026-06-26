import { useEffect } from "react";

type DesktopEventMap = {
  "desktop:navigate-tab": CustomEvent<string>;
  "desktop:navigate-settings-tab": CustomEvent<string>;
  "desktop:command-keys-changed": CustomEvent;
  "desktop:update-available": CustomEvent<unknown>;
  "desktop:update-status": CustomEvent<unknown>;
  "desktop:onboarding-state-changed": CustomEvent;
  "desktop:show-onboarding-popup": CustomEvent;
};

export function useDesktopEvent<K extends keyof DesktopEventMap>(
  event: K,
  handler: (detail: DesktopEventMap[K]["detail"]) => void
): void {
  useEffect(() => {
    const listener = (e: Event) => {
      handler((e as DesktopEventMap[K]).detail);
    };
    window.addEventListener(event, listener);
    return () => window.removeEventListener(event, listener);
  }, [event, handler]);
}
