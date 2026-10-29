"use client";

import type { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { SIGN_IN_PROVIDER_MARK } from "@repo/app/shared/components/sign-in-provider-mark";
import {
  type SignInMethodConnection,
  SignInMethodStatus,
} from "@repo/app/shared/lib/sign-in-methods";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { KeyRoundIcon, MoreHorizontalIcon } from "lucide-react";
import { DESKTOP_SIGN_IN_PROVIDER_LABEL } from "@/lib/github-connect-redirect";
import type { SignInMethodActionState } from "./use-sign-in-method-actions";

/**
 * @file sign-in-methods-section.tsx
 * @description The "Sign-in methods" rows of the Settings Profile panel
 * (ISS-8364), matching the approved prototype's `ProviderRow` — mark, label,
 * `· detail`, "Current sign-in" badge, overflow menu. The prototype's menu is
 * decorative; here every item is a real mutation with its own pending, error,
 * and reconciliation state. Disconnect acts on select, as the prototype's own
 * Disconnect does — there is no confirm step in the approved design.
 */

/** What the row says when the provider is not connected — prototype copy. */
const AVAILABLE_DETAIL = "Available";

/**
 * `Object.hasOwn`, never `in`: a Clerk provider string reaches this predicate
 * unfiltered, and `"constructor" in DESKTOP_SIGN_IN_PROVIDER_LABEL` is TRUE — which
 * would hand `labelFor` a function to render as this row's provider name.
 */
function isKnownProvider(provider: string): provider is DesktopSignInProvider {
  return Object.hasOwn(DESKTOP_SIGN_IN_PROVIDER_LABEL, provider);
}

function labelFor(connection: SignInMethodConnection): string {
  return isKnownProvider(connection.provider)
    ? DESKTOP_SIGN_IN_PROVIDER_LABEL[connection.provider]
    : connection.provider;
}

function ProviderMark({ provider }: Readonly<{ provider: string }>) {
  if (!isKnownProvider(provider)) {
    return <KeyRoundIcon aria-hidden="true" className="size-4" />;
  }
  const Mark = SIGN_IN_PROVIDER_MARK[provider];
  return <Mark aria-hidden="true" className="size-4" />;
}

/** A removal that landed, with only our copy of the user left stale. */
const UNRECONCILED_ONLY_MESSAGE =
  "Removed, but we couldn't refresh your sign-in methods. Reload to confirm.";

/** Appended to an error, never substituted for it — see {@link rowMessage}. */
const UNRECONCILED_SUFFIX =
  "We also couldn't refresh your sign-in methods, so this row may be out of date. Reload to confirm.";

/**
 * The one sentence under a row. `unreconciled` is the more specific fact — the
 * mutation landed and only our copy of the user is stale — but it does not
 * REPLACE the error. Retry can fail its re-create AND its refresh, and
 * answering that with "Removed" alone tells the user the opposite of the
 * action they took and throws away Clerk's reason for the failure.
 */
function rowMessage(state: SignInMethodActionState): string | null {
  if (state.unreconciled) {
    return state.error === null
      ? UNRECONCILED_ONLY_MESSAGE
      : `${state.error} ${UNRECONCILED_SUFFIX}`;
  }
  return state.error;
}

function detailFor(connection: SignInMethodConnection): string {
  if (connection.status === SignInMethodStatus.Disconnected) {
    return AVAILABLE_DETAIL;
  }
  if (connection.status === SignInMethodStatus.Unverified) {
    // Keep the identifier: with two half-connected accounts, "Not finished"
    // alone does not say which one this row is about.
    return connection.detail === null
      ? "Not finished"
      : `${connection.detail} — not finished`;
  }
  return connection.detail ?? "Connected";
}

type ProviderRowProps = {
  connection: SignInMethodConnection;
  state: SignInMethodActionState;
  onConnect: () => void;
  onRetry: () => void;
  onDisconnect: () => void;
};

/**
 * Finishing a connection destroys the stale account and creates a fresh one,
 * which this panel can only do for a provider it holds a Clerk strategy for.
 * Offering it for an unknown provider would delete a working sign-in identity
 * and leave no way to restore it.
 */
function showFinishConnecting(connection: SignInMethodConnection): boolean {
  return (
    connection.status === SignInMethodStatus.Unverified &&
    isKnownProvider(connection.provider)
  );
}

function ProviderRowMenu({
  connection,
  state,
  onConnect,
  onRetry,
  onDisconnect,
}: Readonly<ProviderRowProps>) {
  const label = labelFor(connection);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`${label} sign-in options`}
          className="ml-auto"
          disabled={state.pending}
          size="icon"
          variant="ghost"
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {connection.status === SignInMethodStatus.Disconnected ? (
          <DropdownMenuItem onSelect={onConnect}>
            Connect {label}
          </DropdownMenuItem>
        ) : null}
        {showFinishConnecting(connection) ? (
          <DropdownMenuItem onSelect={onRetry}>
            Finish connecting {label}
          </DropdownMenuItem>
        ) : null}
        {connection.status === SignInMethodStatus.Disconnected ? null : (
          <DropdownMenuItem onSelect={onDisconnect} variant="destructive">
            Disconnect {label}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProviderRow(props: Readonly<ProviderRowProps>) {
  const { connection, state } = props;
  const message = rowMessage(state);
  return (
    <div data-sign-in-method={connection.provider}>
      <div className="flex items-center gap-2 text-sm">
        <ProviderMark provider={connection.provider} />
        <span className="font-medium">{labelFor(connection)}</span>
        <span className="text-muted-foreground">· {detailFor(connection)}</span>
        {connection.isCurrentSignIn ? (
          <Badge variant="outline">Current sign-in</Badge>
        ) : null}
        <ProviderRowMenu {...props} />
      </div>
      {message === null ? null : (
        <p className="mt-1 text-destructive text-sm" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

export type SignInMethodsSectionProps = {
  connections: readonly SignInMethodConnection[];
  getActionState: (provider: string) => SignInMethodActionState;
  onConnect: (provider: string) => void;
  onRetry: (provider: string) => void;
  onDisconnect: (provider: string) => void;
};

export function SignInMethodsSection({
  connections,
  getActionState,
  onConnect,
  onRetry,
  onDisconnect,
}: Readonly<SignInMethodsSectionProps>) {
  return (
    <div className="flex-1 space-y-3">
      {connections.map((connection) => (
        <ProviderRow
          connection={connection}
          key={connection.provider}
          onConnect={() => onConnect(connection.provider)}
          onDisconnect={() => onDisconnect(connection.provider)}
          onRetry={() => onRetry(connection.provider)}
          state={getActionState(connection.provider)}
        />
      ))}
    </div>
  );
}
