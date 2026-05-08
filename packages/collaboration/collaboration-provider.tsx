"use client";

import { LiveblocksProvider } from "@liveblocks/react/suspense";
import type { ReactNode } from "react";
import {
  createResolveMentionSuggestions,
  createResolveUsers,
  type UserInfo,
} from "./user-resolvers";

export type LiveblocksProviderWrapperProps = {
  children: ReactNode;
  users?: UserInfo[];
};

/**
 * Wrapper for LiveblocksProvider with user auth and user resolution.
 */
export function CollaborationProvider({
  children,
  users = [],
}: Readonly<LiveblocksProviderWrapperProps>) {
  return (
    <LiveblocksProvider
      authEndpoint="/api/collaboration/auth"
      resolveMentionSuggestions={createResolveMentionSuggestions(users)}
      resolveUsers={createResolveUsers(users)}
    >
      {children}
    </LiveblocksProvider>
  );
}
