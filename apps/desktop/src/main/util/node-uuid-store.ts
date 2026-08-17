import { randomUUID } from "node:crypto";
import Store from "electron-store";

export const DESKTOP_NODE_IDENTITY_STORE_NAME = "desktop-node-identity";
export const NODE_UUID_STORE_KEY = "nodeUuid";

export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}
