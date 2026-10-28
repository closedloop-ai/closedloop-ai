"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { SettingsLocalSyncPolicyProjection } from "@repo/api/src/types/settings-host-capabilities";
import {
  SettingsLocalDeviceReason,
  SettingsLocalDeviceStatus,
  settingsLocalSyncPolicyError,
} from "@repo/api/src/types/settings-host-capabilities";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettingsHostAdapter } from "./provider";

/**
 * THIS machine's own data-sync level, through the host port (PLN-1915 D6).
 *
 * `supported` is the capability's PRESENCE on the adapter, and it is the whole
 * reason no surface needs a host check: the web adapter omits the capability,
 * so the control is absent on web by construction. An installed desktop build
 * whose preload predates the channels DOES carry the capability and answers
 * `bridge-unavailable` — a different fact, rendered as a row without a selector
 * rather than as an error, because nothing failed.
 *
 * Web shows a desktop's policy through a different path, not this one
 * (ISS-12531): `DeviceDataPolicy`
 * (`packages/app/shared/components/device-data-policy.tsx`) renders a
 * device's REPORTED policy read-only from props. It stays unwired until an
 * API reports a per-device policy; this hook must not grow a web branch to
 * stand in for one, because the web has no local device to ask.
 *
 * The write returns the projection the host answered with rather than the level
 * that was asked for: `applyDataSyncLevel` reconciles a level down when the
 * derived connectivity flags disagree, and echoing the request would show a
 * posture the machine is not actually on.
 *
 * The LAST REQUEST wins, not the last response. Two writes can be in flight at
 * once and can resolve out of order, and this control decides how much of a
 * machine's data leaves it — settling on the earlier answer would put a level
 * the user did not choose on screen, confirmed, with nothing to say so. The
 * same generation retires a request the HOST outlived: on desktop a
 * `DesktopAppCoreMode` flip rebuilds the whole stack including the adapter, and
 * a write issued against the previous host describes a posture this one was
 * never asked about.
 */

export type LocalSyncPolicyState =
  | { status: "pending" }
  | { status: "settled"; projection: SettingsLocalSyncPolicyProjection };

export type LocalSyncPolicy = {
  /** False when this host has no local sync-policy path at all (web). */
  supported: boolean;
  state: LocalSyncPolicyState;
  isWriting: boolean;
  /** The last write's outcome, or null when none has been attempted. */
  writeOutcome: SettingsLocalSyncPolicyProjection | null;
  write: (level: DataSyncLevel) => void;
};

const PENDING: LocalSyncPolicyState = { status: "pending" };

/**
 * The capability contract says both members SETTLE rather than reject, and both
 * shipped adapters honour it — but the type is a plain `Promise`, and an
 * adapter that broke that contract would strand `isWriting` true with the picker
 * disabled and no way back. Reported as a failed host call, which is what it is.
 */
function asFailedHostCall(): SettingsLocalSyncPolicyProjection {
  return settingsLocalSyncPolicyError(SettingsLocalDeviceReason.ReadFailed);
}

export function useLocalSyncPolicy(): LocalSyncPolicy {
  const { localSyncPolicy } = useSettingsHostAdapter();
  const [state, setState] = useState<LocalSyncPolicyState>(PENDING);
  const [isWriting, setIsWriting] = useState(false);
  const [writeOutcome, setWriteOutcome] =
    useState<SettingsLocalSyncPolicyProjection | null>(null);

  /**
   * The generation every in-flight host call is checked against. One counter
   * covers reads and writes together because a host swap retires both, and two
   * counters could disagree about which host the surface is showing.
   */
  const latestHostCall = useRef(0);

  useEffect(() => {
    if (!localSyncPolicy) {
      return;
    }
    // Bumped here, not just in `write`: this effect re-runs when the adapter
    // itself is replaced, and a write issued against the previous host would
    // otherwise settle after this read and stomp the new host's answer with the
    // old one's. Clearing `isWriting` is the other half — a write retired mid
    // flight never reaches its own `setIsWriting(false)`, so without this the
    // picker stays disabled for the life of the panel.
    latestHostCall.current += 1;
    const generation = latestHostCall.current;
    setState(PENDING);
    setIsWriting(false);
    setWriteOutcome(null);
    localSyncPolicy
      .read()
      .catch(asFailedHostCall)
      .then((projection) => {
        if (generation !== latestHostCall.current) {
          return;
        }
        setState({ projection, status: "settled" });
      });
    return () => {
      latestHostCall.current += 1;
    };
  }, [localSyncPolicy]);

  const write = useCallback(
    (level: DataSyncLevel) => {
      if (!localSyncPolicy) {
        return;
      }
      latestHostCall.current += 1;
      const generation = latestHostCall.current;
      setIsWriting(true);
      setWriteOutcome(null);
      localSyncPolicy
        .write(level)
        .catch(asFailedHostCall)
        .then((projection) => {
          if (generation !== latestHostCall.current) {
            return;
          }
          setIsWriting(false);
          setWriteOutcome(projection);
          // A READY answer replaces the read state: it is the same fact, freshly
          // measured, so leaving the old one would let the selector and the
          // confirmation disagree about the level in force.
          //
          // A non-ready one does NOT. It carries no level, so there is nothing
          // for the selector to disagree with — and promoting it to the read
          // state replaces the picker with an error panel, which removes the
          // only control that could retry the write that just failed. The last
          // level actually in force stays on screen and `writeOutcome` says
          // beside it that the change did not take.
          if (projection.status === SettingsLocalDeviceStatus.Ready) {
            setState({ projection, status: "settled" });
          }
        });
    },
    [localSyncPolicy]
  );

  return {
    isWriting,
    state,
    supported: localSyncPolicy !== undefined,
    write,
    writeOutcome,
  };
}
