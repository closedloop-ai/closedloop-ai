import type { IpcMainInvokeEvent, WebContents } from "electron";
import {
  type CloudApiFetchDeps,
  registerCloudApiFetchIpcHandler,
} from "../src/main/ipc/cloud-api-fetch-ipc.js";
import {
  CLOUD_API_FETCH_CHANNEL,
  type CloudApiFetchResult,
} from "../src/shared/cloud-api-fetch-contract.js";

const trustedSender = { id: 1 } as unknown as WebContents;
const trustedEvent = { sender: trustedSender } as IpcMainInvokeEvent;

export const API_ORIGIN = "https://api.closedloop.test";
export const UNTRUSTED_EVENT = {
  sender: { id: 2 } as unknown as WebContents,
} as IpcMainInvokeEvent;

type FetchCall = { url: URL; init: RequestInit };

/** Register the production handler with deterministic auth/network test ports. */
export function createHarness(
  overrides: Partial<CloudApiFetchDeps> = {},
  fetchResponse: Response = new Response(
    JSON.stringify({ success: true, data: [] }),
    {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    }
  )
) {
  const fetchCalls: FetchCall[] = [];
  let handler:
    | ((
        event: IpcMainInvokeEvent,
        request: unknown
      ) => Promise<CloudApiFetchResult>)
    | undefined;
  registerCloudApiFetchIpcHandler(
    {
      handle: (channel, listener) => {
        if (channel !== CLOUD_API_FETCH_CHANNEL) {
          throw new Error(`unexpected channel: ${channel}`);
        }
        handler = listener;
      },
    },
    {
      isTrustedSender: (sender) => sender === trustedSender,
      getAccessToken: () => Promise.resolve("real-access-token"),
      getIdentity: () => ({ userId: "user-1", organizationId: "org-1" }),
      resolveApiOrigin: () => API_ORIGIN,
      fetchImpl: (url, init) => {
        fetchCalls.push({ url, init });
        return Promise.resolve(fetchResponse);
      },
      ...overrides,
    }
  );
  if (!handler) {
    throw new Error("handler must be registered");
  }
  const registered = handler;
  const invoke = (request: unknown, event: IpcMainInvokeEvent = trustedEvent) =>
    registered(event, request);
  return { invoke, fetchCalls };
}
