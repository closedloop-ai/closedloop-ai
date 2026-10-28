import { createSessionSyncIdentityAdapter } from "../../src/main/agent-sync/retained-compute-target-identity.js";
import type { CloudSocketStatus } from "../../src/main/cloud/cloud-protocol.js";
import { CloudSocketService } from "../../src/main/cloud/cloud-socket.js";
import type { SignedInUserIdentity } from "../../src/main/util/user-identity.js";
import { CloudSocketState } from "../../src/shared/cloud-socket-error.js";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import { createStubOptions, FakeSocket } from "./cloud-socket-fixtures.js";

/**
 * The wire-to-guard chain, driven end to end: emit a real `desktop.hello.ack`
 * frame at the production `CloudSocketService` handler, mirror `app.ts`'s online
 * branch (`remember` on the Online transition), and return the compute target
 * the session-sync lane then resolves for a profile posting to `apiOrigin`.
 *
 * The field name on the frame is pinned by the caller's literal rather than by
 * the type under test, so a rename the parse missed fails here.
 */
export function adoptedFromHelloAckFrame(
  frame: Record<string, unknown>,
  apiOrigin: string,
  identity: SignedInUserIdentity
): string | null {
  let cloudStatus: CloudSocketStatus = { state: CloudSocketState.Idle };
  const adapter = createSessionSyncIdentityAdapter({
    getIdentity: () => identity,
    getAuthStatus: () => DesktopAuthStatus.Authenticated,
    getApiOrigin: () => apiOrigin,
    getCloudStatus: () => cloudStatus,
  });
  const service = new CloudSocketService(
    createStubOptions({
      onStatusChange: (status) => {
        cloudStatus = status;
        if (status.state === CloudSocketState.Online) {
          adapter.remember(status);
        }
      },
    })
  );
  const socket = new FakeSocket();
  const internals = service as unknown as Record<string, unknown>;
  internals.socket = socket;
  internals.stopped = false;
  internals.awaitingHelloAck = true;
  (
    Object.getPrototypeOf(service) as Record<
      string,
      (...args: unknown[]) => unknown
    >
  ).registerSocketHandlers.call(service, socket);
  socket.emit("desktop.hello.ack", frame);
  return adapter.computeTargetId();
}
