"use client";

import { LiveblocksProvider } from "@liveblocks/react/suspense";
import type { ComponentProps, ReactNode } from "react";
import {
  createResolveMentionSuggestions,
  createResolveUsers,
  type UserInfo,
} from "./user-resolvers";

/**
 * Liveblocks auth mechanism, injected by the shell. `@repo/collaboration` is
 * surface-agnostic (FEA-1510): the web shell points this at apps/api with a
 * Clerk-derived bearer token; the desktop renderer supplies its own session.
 * Neither endpoint is hardcoded here.
 */
export type AuthEndpoint = NonNullable<
  ComponentProps<typeof LiveblocksProvider>["authEndpoint"]
>;

export type LiveblocksProviderWrapperProps = {
  children: ReactNode;
  authEndpoint: AuthEndpoint;
  users?: UserInfo[];
};

/**
 * Wrapper for LiveblocksProvider with user auth and user resolution.
 */
export function CollaborationProvider({
  children,
  authEndpoint,
  users = [],
}: Readonly<LiveblocksProviderWrapperProps>) {
  return (
    <LiveblocksProvider
      authEndpoint={authEndpoint}
      resolveMentionSuggestions={createResolveMentionSuggestions(users)}
      resolveUsers={createResolveUsers(users)}
    >
      {children}
    </LiveblocksProvider>
  );
}
