import { DesktopRendererEventChannel } from "../shared/desktop-renderer-event-channel.js";

type IpcRendererEventsLike = {
  on: (channel: string, listener: (...args: never[]) => void) => void;
};
type WindowLike = {
  dispatchEvent(event: CustomEvent<unknown>): boolean;
};

/** Forwards main-owned desktop events into the renderer's DOM event boundary. */
export function registerDesktopApiEventForwarders(
  ipcRendererLike: IpcRendererEventsLike,
  targetWindow: WindowLike
): void {
  ipcRendererLike.on(
    DesktopRendererEventChannel.NavigateTab,
    (_event, tab: string) => {
      targetWindow.dispatchEvent(
        new CustomEvent(DesktopRendererEventChannel.NavigateTab, {
          detail: tab,
        })
      );
    }
  );
  for (const channel of [
    DesktopRendererEventChannel.OnboardingStateChanged,
    DesktopRendererEventChannel.ShowOnboardingPopup,
  ]) {
    ipcRendererLike.on(channel, () => {
      targetWindow.dispatchEvent(new CustomEvent(channel));
    });
  }
  for (const channel of [
    DesktopRendererEventChannel.UpdateAvailable,
    DesktopRendererEventChannel.UpdateStatus,
  ]) {
    ipcRendererLike.on(channel, (_event, detail) => {
      targetWindow.dispatchEvent(new CustomEvent(channel, { detail }));
    });
  }
}
