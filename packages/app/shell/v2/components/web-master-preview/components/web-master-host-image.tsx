"use client";

import { type ComponentType, createContext, useContext } from "react";

export type WebMasterHostImageProps = {
  alt: string;
  className?: string;
  height: number;
  priority?: boolean;
  src: string;
  unoptimized?: boolean;
  width: number;
};

/**
 * The host's image renderer. `@repo/app` may not import `next/image`, so the
 * sandbox host injects it through {@link WebMasterPreviewShell}; the logo
 * assets themselves are served from the host's public directory.
 */
export type WebMasterHostImage = ComponentType<WebMasterHostImageProps>;

const WebMasterHostImageContext = createContext<WebMasterHostImage | null>(
  null
);

export const WebMasterHostImageProvider = WebMasterHostImageContext.Provider;

export function useWebMasterHostImage(): WebMasterHostImage {
  const image = useContext(WebMasterHostImageContext);
  if (image === null) {
    throw new Error(
      "Web Master preview images require a WebMasterPreviewShell host image component."
    );
  }
  return image;
}
