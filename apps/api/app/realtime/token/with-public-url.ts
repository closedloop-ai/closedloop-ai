import type { IssuedRealtimeToken } from "@repo/realtime-contract/protocol";

/** ISS-11210 ask 3: the key is absent when `REALTIME_PUBLIC_URL` is unset, never null. */
export function withPublicUrl(
  issued: IssuedRealtimeToken,
  url: string | undefined
): IssuedRealtimeToken {
  return url === undefined ? issued : { ...issued, url };
}
