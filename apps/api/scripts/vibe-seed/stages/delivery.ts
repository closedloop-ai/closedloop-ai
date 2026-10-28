import { seedDeliveryPoints } from "../domain/delivery-points";
import type { VibeSeedStage } from "../stage";

/**
 * Delivery points match pull requests by repository, so they run after the
 * GitHub stage has given the seeded pull requests their repositories; run
 * earlier, every point is stored unmatched and none reach a Branch page.
 */
export const STAGES: readonly VibeSeedStage[] = [
  {
    name: "delivery-points",
    models: ["DeliveryPoint"],
    run: seedDeliveryPoints,
  },
];
