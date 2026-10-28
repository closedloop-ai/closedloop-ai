"use client";

import type { BrowserSession } from "@repo/api/src/types/browser-session";
import { BROWSER_SESSION_PAGE_LIMIT_MAX } from "@repo/api/src/types/browser-session";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { MonitorSmartphoneIcon } from "lucide-react";
import {
  useBrowserSessions,
  useRevokeBrowserSession,
} from "../../../../devices/hooks/use-browser-sessions";
import {
  describeBrowserSession,
  describeBrowserSessionPage,
} from "../../../../devices/lib/browser-session-display";
import { formatRelativeTime } from "../../../../shared/lib/date-utils";
import { SettingsPanelDataStateView } from "../../components/settings-panel-data-state-view";
import { SettingsWriteOutcomeAlert } from "../../components/settings-write-outcome-alert";
import {
  classifySettingsPanelRead,
  SettingsPanelDataState,
} from "../../lib/settings-panel-data-state";
import { BrowserSessionPageCoverageNote } from "./browser-session-page-coverage";
import {
  BROWSER_SESSION_REVOKE_FORBIDDEN_MESSAGE,
  classifyBrowserSessionRevokeError,
} from "./browser-session-revoke-outcome";
import { DevicePanelInlineEmptyState } from "./device-panel-group";

/**
 * The browser sign-in rows of Connected Devices (PLN-1915 Step 3, D5).
 *
 * One of the panel's three producers and the only one with a control: the
 * session the user is holding is not revocable, and the route says so with a
 * 409 rather than trusting the client, so the row simply offers nothing.
 */

const SESSION_SUBJECT = "your browser sessions";

/**
 * Sent on the wire on every request rather than left to the route's default.
 * The query key is keyed by these, and a page whose size the caller never
 * stated cannot be reconciled against `totalCount` afterwards.
 *
 * THE CONTRACT'S MAXIMUM, not its default. This panel offers no paging control,
 * so the one page it asks for is the whole set a user can reach; at the default
 * 20 a user signed in on a 21st device had rows they could not see and could not
 * sign out. Asking for the ceiling is the cap raise, deliberately without a
 * paging UI — the coverage note above the list still reports a `Truncated` page
 * honestly, so a population past this bound is stated rather than hidden.
 *
 * NOT clamped here. `apps/api/lib/validators/pagination.ts` is the one clamp in
 * the repo and the route echoes the bounds it actually used; a second opinion
 * about the limits could only round differently and would hide a caller bug the
 * route's 400 would have surfaced.
 */
const SESSION_PAGE_BOUNDS = {
  limit: BROWSER_SESSION_PAGE_LIMIT_MAX,
  offset: 0,
} as const;

export function BrowserSessionsSection() {
  const sessions = useBrowserSessions(SESSION_PAGE_BOUNDS);
  const revoke = useRevokeBrowserSession();

  const dataState = classifySettingsPanelRead({
    error: sessions.error,
    hasData: sessions.data !== undefined,
    isEmpty: (sessions.data?.sessions.length ?? 0) === 0,
    isPending: sessions.isPending,
  });

  if (dataState === SettingsPanelDataState.Empty) {
    return (
      <DevicePanelInlineEmptyState
        description="You aren't signed in anywhere else right now. New sign-ins appear here."
        icon={MonitorSmartphoneIcon}
        title="No other browser sessions"
      />
    );
  }

  if (dataState !== SettingsPanelDataState.Ready || !sessions.data) {
    return (
      <SettingsPanelDataStateView
        onRetry={() => {
          sessions.refetch();
        }}
        state={dataState}
        subject={SESSION_SUBJECT}
      />
    );
  }

  const page = sessions.data;
  const coverage = describeBrowserSessionPage({
    sessions: page.sessions,
    totalCount: page.totalCount,
  });

  return (
    <div className="flex flex-col gap-3">
      <BrowserSessionPageCoverageNote coverage={coverage} />
      {page.currentSessionKnown ? null : (
        <p
          className="text-muted-foreground text-xs"
          data-browser-session-current-known="false"
        >
          We couldn't tell which of these you're signed in with right now, so
          none is marked as current.
        </p>
      )}
      <RevokeOutcomeAlert error={revoke.error} />
      <ul className="flex flex-col gap-2">
        {page.sessions.map((session) => (
          <BrowserSessionRow
            isCurrent={page.currentSessionKnown && session.isCurrentSession}
            isRevoking={revoke.isPending}
            key={session.id}
            onRevoke={() => revoke.mutate(session.id)}
            session={session}
          />
        ))}
      </ul>
    </div>
  );
}

function BrowserSessionRow({
  session,
  isCurrent,
  isRevoking,
  onRevoke,
}: Readonly<{
  session: BrowserSession;
  isCurrent: boolean;
  isRevoking: boolean;
  onRevoke: () => void;
}>) {
  const display = describeBrowserSession(session.activity);

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
      data-browser-session-current={isCurrent ? "true" : "false"}
      data-browser-session-row={session.id}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium text-sm">{display.browserLabel}</p>
          {isCurrent ? <Badge variant="secondary">This session</Badge> : null}
        </div>
        <p className="text-muted-foreground text-xs">
          {display.deviceLabel} · {display.locationLabel} · Last active{" "}
          {formatRelativeTime(session.lastActiveAt)}
        </p>
      </div>
      {isCurrent ? null : (
        <Button
          disabled={isRevoking}
          onClick={onRevoke}
          size="sm"
          variant="outline"
        >
          Sign out
        </Button>
      )}
    </li>
  );
}

/**
 * The two CODED refusals get this domain's own sentence; everything else goes
 * to the shared alert, which owns one sentence per outcome for all of Settings.
 */
function RevokeOutcomeAlert({ error }: Readonly<{ error: unknown }>) {
  if (!error) {
    return null;
  }
  const outcome = classifyBrowserSessionRevokeError(error);
  if (outcome.kind === "coded") {
    return (
      <Alert data-browser-session-revoke={outcome.code} variant="error">
        <AlertDescription>{outcome.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div data-browser-session-revoke={outcome.state}>
      <SettingsWriteOutcomeAlert
        forbiddenMessage={BROWSER_SESSION_REVOKE_FORBIDDEN_MESSAGE}
        state={outcome.state}
      />
    </div>
  );
}
