import {
  MEMBER_PACK_INSTALL_OFFLINE_STATE,
  MemberPackInstallDispatchState,
} from "@repo/api/src/types/member-pack-install";
import { describe, expect, it } from "vitest";
import { PackInstallState } from "../install-state";

/**
 * Cross-module contract guard (FEA-4082 ↔ FEA-4083). The server-owned member
 * install dispatch state (`@repo/api`) and the client-owned packs render state
 * (`@repo/app`) must describe "target offline" with the SAME wire string so the
 * packs UI renders one honest "Target offline" vocabulary across surfaces. The
 * server type intentionally does not import the client enum (it would pull
 * `@repo/design-system` into the server bundle); this test is the only thing
 * pinning the two together, so it must fail the moment either drifts.
 */
describe("member install offline state ↔ PackInstallState.Offline", () => {
  it("shares the exact offline wire string", () => {
    expect(MEMBER_PACK_INSTALL_OFFLINE_STATE).toBe(PackInstallState.Offline);
    expect(MemberPackInstallDispatchState.TargetOffline).toBe(
      PackInstallState.Offline
    );
  });
});
