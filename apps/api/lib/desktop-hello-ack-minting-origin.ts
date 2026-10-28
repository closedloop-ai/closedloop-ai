import {
  type DesktopHelloAckMintingOrigin,
  toMintingApiOrigin,
} from "@repo/api/src/types/compute-target";

/**
 * ISS-9152: the direct-connect gateway server answers `desktop.hello` itself and
 * never passes through the relay that stamps the relayed acks, so each of its
 * two ack emissions states its own minting origin — the API it IS, from its
 * configured `NEXT_PUBLIC_API_URL`, never anything read off the connection.
 *
 * Read from `process.env`, NOT through `keys()`: that schema resolves an unset
 * `NEXT_PUBLIC_API_URL` to the `http://localhost:3002` dev default
 * (`getDynamicUrl`, `packages/next-config/keys.ts`), and a deployed API stating
 * localhost as established fact makes every desktop pointed at it refuse the
 * target it was just handed (whitlockk, #7085). Only an operator-configured value
 * is an origin this server can establish; `toMintingApiOrigin` reduces unset,
 * `""`, and unparseable alike to nothing to state.
 *
 * Per emission rather than a module snapshot: `start-api-server.ts` loads the
 * socket server, and this module with it, before `next()` loads `.env*`.
 *
 * Omitted, never `null`, when it does not reduce to an origin: the receiver
 * reads the key's presence, and an absent field is what an older API sends.
 */
export function statedMintingOrigin(): DesktopHelloAckMintingOrigin {
  const mintingApiOrigin = toMintingApiOrigin(process.env.NEXT_PUBLIC_API_URL);
  return mintingApiOrigin ? { mintingApiOrigin } : {};
}
