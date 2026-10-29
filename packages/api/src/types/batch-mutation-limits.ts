/**
 * How many entity ids one batch-mutation request may name.
 *
 * Owned here because more than one place has to agree on it and they cannot
 * import each other: the `apps/api` validators that enforce it
 * (`batchMoveDocumentsValidator`, `batchUpdateStatusValidator`,
 * `batchDeleteValidator`, `batchEntityTagValidator`) and the undo registry,
 * which must not build a request longer than the route will accept. Kept in its
 * own module so a bundle-sensitive client can read the number without pulling
 * in a validator.
 */
export const BATCH_MUTATION_ENTITY_LIMIT = 500;
