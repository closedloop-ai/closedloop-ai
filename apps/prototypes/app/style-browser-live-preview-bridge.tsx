"use client";

import { useEffect } from "react";
import {
  applyStyleLabPreviewStyle,
  readPersistedStyleLabSession,
} from "./style-browser-persistence";
import { tokenDefinitions } from "./style-browser-token-manifest.generated";
import {
  buildPreviewStyle,
  buildTokenChanges,
} from "./style-browser-token-operations";

export function StyleLabLivePreviewBridge() {
  useEffect(() => {
    const session = readPersistedStyleLabSession();
    if (!session) {
      return;
    }
    const tokenChanges = buildTokenChanges({
      addedTokens: session.addedTokens,
      baseTokens: tokenDefinitions,
      edits: session.edits,
      removedTokenIds: new Set(session.removedTokenIds),
    });
    applyStyleLabPreviewStyle(buildPreviewStyle(tokenChanges));
  }, []);

  return null;
}
