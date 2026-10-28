import { LoopsEndpointRemoval } from "@repo/api/src/types/endpoint-removal";
import { goneResponse } from "@/lib/route-utils";

/** The 410 every ISS-12435 Loops tombstone route answers with. */
export function loopsRemovedResponse() {
  return goneResponse(LoopsEndpointRemoval.Message, {
    code: LoopsEndpointRemoval.Code,
  });
}
