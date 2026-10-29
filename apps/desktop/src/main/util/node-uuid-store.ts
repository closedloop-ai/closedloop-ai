import { randomUUID } from "node:crypto";
// ISS-10503: the v4 pattern moved to the canonical constants module
// (`@repo/api/src/types/onboarding-analytics`) so the API schema's injection
// control and this store validate with one declaration.
import { isUuidV4 } from "@repo/api/src/types/onboarding-analytics";
import Store from "electron-store";

export const DESKTOP_NODE_IDENTITY_STORE_NAME = "desktop-node-identity";
export const NODE_UUID_STORE_KEY = "nodeUuid";

type NodeUuidStoreSchema = {
  nodeUuid?: string;
};

export type NodeUuidStoreOptions = {
  cwd?: string;
  name?: string;
};

export class NodeUuidStore {
  private readonly store: Store<NodeUuidStoreSchema>;

  constructor(options?: NodeUuidStoreOptions) {
    this.store = new Store<NodeUuidStoreSchema>({
      name: options?.name ?? DESKTOP_NODE_IDENTITY_STORE_NAME,
      cwd: options?.cwd,
    });
  }

  getOrCreateNodeUuid(): string {
    const persisted = this.store.get(NODE_UUID_STORE_KEY);
    if (isUuidV4(persisted)) {
      return persisted;
    }

    const fresh = randomUUID();
    this.store.set(NODE_UUID_STORE_KEY, fresh);
    return fresh;
  }
}
