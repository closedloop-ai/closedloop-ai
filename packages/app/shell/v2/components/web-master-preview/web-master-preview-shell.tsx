"use client";

import type { NavigationAdapter } from "@repo/navigation/navigation-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import type { ReactNode } from "react";
import {
  type WebMasterHostImage,
  WebMasterHostImageProvider,
} from "./components/web-master-host-image";
import { WebMasterShell } from "./components/web-master-shell";

/**
 * The Web Master preview shell. The host supplies only its router and image
 * adapters; every route of the preview renders inside it.
 */
export function WebMasterPreviewShell({
  children,
  imageComponent,
  navigationAdapter,
}: {
  children: ReactNode;
  imageComponent: WebMasterHostImage;
  navigationAdapter: NavigationAdapter;
}) {
  return (
    <NavigationProvider adapter={navigationAdapter}>
      <WebMasterHostImageProvider value={imageComponent}>
        <WebMasterShell>{children}</WebMasterShell>
      </WebMasterHostImageProvider>
    </NavigationProvider>
  );
}
