import { type BrowserWindow, shell } from "electron";
import { openDocumentAssetDownload } from "../ipc/document-asset-proxy.js";
import { isAllowedRendererExternalUrl } from "../settings/external-url-allowlist.js";

type RendererNavigationGuardOptions = {
  browserWindow: BrowserWindow;
  isAllowedNavigation: (url: string) => boolean;
  isCurrentWindow: () => boolean;
  resolveWebAppOrigin: () => string | null;
};

/** Install deny-by-default navigation and external-open policy for one window. */
export function installRendererNavigationGuards(
  options: RendererNavigationGuardOptions
): void {
  const { browserWindow } = options;
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!options.isCurrentWindow()) {
      return { action: "deny" };
    }
    if (
      openDocumentAssetDownload(url, (assetUrl) =>
        browserWindow.webContents.downloadURL(assetUrl)
      )
    ) {
      return { action: "deny" };
    }
    if (isAllowedRendererExternalUrl(url, readWebAppOrigin(options))) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: "deny" };
  });

  browserWindow.webContents.on("will-navigate", (event, url) => {
    if (!options.isAllowedNavigation(url)) {
      event.preventDefault();
    }
  });
  browserWindow.webContents.on("will-frame-navigate", (details) => {
    if (!options.isAllowedNavigation(details.url)) {
      details.preventDefault();
    }
  });
}

function readWebAppOrigin(
  options: RendererNavigationGuardOptions
): string | null {
  try {
    return options.resolveWebAppOrigin();
  } catch {
    return null;
  }
}
