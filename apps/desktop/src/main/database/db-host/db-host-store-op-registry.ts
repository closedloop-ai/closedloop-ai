import {
  readRepositoryDefaultAuthorities,
  readRepositoryDefaultAuthoritiesByNames,
  repositoryDefaultAuthorityReadArgsSchema,
  repositoryDefaultAuthorityReadByRepositoryNamesArgsSchema,
  repositoryDefaultAuthorityWriteArgsSchema,
  writeRepositoryDefaultAuthorities,
} from "../repository-default-authority-store.js";
import type { SqliteAgentDatabase } from "../sqlite.js";

export type DbHostStoreOpRegistry = Record<
  string,
  (db: SqliteAgentDatabase, args: unknown[]) => Promise<unknown>
>;

/** Prefix for clone-safe store operations sent through DB-host invoke IPC. */
export const DB_HOST_STORE_OP_PREFIX = "store:";

/** Side-effect-free authority operations installed into the DB-host registry. */
export const repositoryDefaultAuthorityStoreOps: DbHostStoreOpRegistry = {
  "repositoryDefaultAuthorities.readByRepositoryNames": (db, args) => {
    const [identityKey, repositories] =
      repositoryDefaultAuthorityReadByRepositoryNamesArgsSchema.parse(args);
    return readRepositoryDefaultAuthoritiesByNames(
      db.prisma,
      identityKey,
      repositories
    );
  },
  "repositoryDefaultAuthorities.read": (db, args) => {
    const [identityKey, repositories] =
      repositoryDefaultAuthorityReadArgsSchema.parse(args);
    return readRepositoryDefaultAuthorities(
      db.prisma,
      identityKey,
      repositories
    );
  },
  "repositoryDefaultAuthorities.write": (db, args) => {
    const [identityKey, observations] =
      repositoryDefaultAuthorityWriteArgsSchema.parse(args);
    return writeRepositoryDefaultAuthorities(
      db.prisma,
      identityKey,
      observations
    );
  },
};

/**
 * Execute a production `store:` IPC operation, including authority operations
 * owned by this side-effect-free child registry.
 */
export function dispatchDbHostStoreOp(
  registry: DbHostStoreOpRegistry,
  db: SqliteAgentDatabase,
  op: string,
  args: unknown[]
): Promise<unknown> {
  if (!op.startsWith(DB_HOST_STORE_OP_PREFIX)) {
    throw new Error(`db-host store op must use ${DB_HOST_STORE_OP_PREFIX}`);
  }
  const storeKey = op.slice(DB_HOST_STORE_OP_PREFIX.length);
  const storeOp =
    repositoryDefaultAuthorityStoreOps[storeKey] ?? registry[storeKey];
  if (!storeOp) {
    throw new Error(`db-host store op not found: ${op}`);
  }
  return storeOp(db, args);
}
