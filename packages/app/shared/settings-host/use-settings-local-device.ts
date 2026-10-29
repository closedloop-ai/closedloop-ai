"use client";

import type { SettingsLocalDeviceProjection } from "@repo/api/src/types/settings-host-capabilities";
import { useEffect, useMemo, useState } from "react";
import { useOptionalAuthSnapshot } from "../auth/use-auth-snapshot";
import { useSettingsHostAdapter } from "./provider";
import {
  createSettingsHostCapabilityReader,
  SettingsHostReadOutcome,
} from "./settings-host-capability-reader";

/**
 * The React consumer of {@link createSettingsHostCapabilityReader} (ISS-8379's
 * seam, first consumed by PLN-1915 Step 3).
 *
 * Three states and no fourth: a read still in flight is `pending` and is NEVER
 * folded into an unavailable or errored projection, because "we have not asked
 * yet" and "this host has no local device" send a user to different places.
 *
 * The scope is the signed-in identity, so a response requested for one account
 * is discarded rather than applied under another — the reader owns that
 * discard; this hook only supplies the scope and resets to `pending` when it
 * moves, so a previous identity's device cannot linger on screen while the new
 * read is in flight.
 */

export type SettingsLocalDeviceState =
  | { status: "pending" }
  | { status: "settled"; projection: SettingsLocalDeviceProjection };

const PENDING: SettingsLocalDeviceState = { status: "pending" };

export function useSettingsLocalDevice(): SettingsLocalDeviceState {
  const adapter = useSettingsHostAdapter();
  const { userId, orgId } = useOptionalAuthSnapshot();
  const reader = useMemo(
    () => createSettingsHostCapabilityReader(adapter),
    [adapter]
  );
  const [state, setState] = useState<SettingsLocalDeviceState>(PENDING);

  useEffect(() => () => reader.dispose(), [reader]);

  useEffect(() => {
    setState(PENDING);
    reader.read({ organizationId: orgId, userId }).then((result) => {
      if (result.outcome === SettingsHostReadOutcome.Applied) {
        setState({
          projection: result.capabilities.localDevice,
          status: "settled",
        });
      }
    });
  }, [reader, userId, orgId]);

  return state;
}
