/**
 * Protocol and factory types for content-key-driven transaction handlers.
 *
 * Follows Open-Closed Principle: new content types are persisted by adding a
 * ContentTransactionHandler and registering it in the registry — planSuccessHandler
 * is closed for modification.
 *
 * Architecture:
 * - ContentTransactionHandler<T>  — protocol each handler implements
 * - makeContentHandlerSelector()  — factory closure: given a ContentKey<T>,
 *                                   returns the matching typed handler
 * - makeContentDispatcher()       — convenience dispatcher that runs every
 *                                   registered handler whose bag value is present
 */

import type { TransactionClient } from "@repo/database/generated/internal/prismaNamespace";
import type { ContentKey, ZipContentBag } from "../../../extractors/types";
import type { WorkflowContext } from "../../../types";

/**
 * Protocol for content-key-driven transaction handlers.
 *
 * Each implementation is responsible for persisting one content type
 * extracted from the zip artifact into the database within the outer
 * transaction.
 *
 * To add persistence for a new content type:
 * 1. Add its ContentKey to CONTENT_KEYS in ../../extractors/keys.ts
 * 2. Create a handler file implementing ContentTransactionHandler<T>
 * 3. Add it to CONTENT_TRANSACTION_HANDLERS in ./registry.ts
 *
 * planSuccessHandler is closed for modification — it dispatches via the
 * registry and never references individual content types.
 */
export type ContentTransactionHandler<T> = {
  /** The content key this handler responds to. */
  readonly key: ContentKey<T>;
  /**
   * Persist the extracted content value within the outer transaction.
   * Called only when bag.get(key) is non-null.
   */
  handle(tx: TransactionClient, ctx: WorkflowContext, value: T): Promise<void>;
};

// biome-ignore lint/suspicious/noExplicitAny: registry stores handlers for heterogeneous T
export type AnyContentTransactionHandler = ContentTransactionHandler<any>;

/**
 * Factory closure that binds a registry and returns a typed selector function.
 *
 * Usage:
 *   const selectHandler = makeContentHandlerSelector(CONTENT_TRANSACTION_HANDLERS);
 *   const handler = selectHandler(CONTENT_KEYS.judgesReport);
 *   // handler is typed as ContentTransactionHandler<JudgesReport> | undefined
 */
export function makeContentHandlerSelector(
  handlers: AnyContentTransactionHandler[]
) {
  const map = new Map(handlers.map((h) => [h.key as string, h]));
  return <T>(key: ContentKey<T>): ContentTransactionHandler<T> | undefined =>
    map.get(key as string) as ContentTransactionHandler<T> | undefined;
}

/**
 * Dispatcher closure that runs every registered handler whose bag value is
 * present.
 *
 * Consumes makeContentHandlerSelector internally, so the iteration loop stays
 * here rather than in the caller.
 *
 * Usage:
 *   const dispatchContent = makeContentDispatcher(CONTENT_TRANSACTION_HANDLERS);
 *   await dispatchContent(tx, ctx, bag);
 */
export function makeContentDispatcher(
  handlers: AnyContentTransactionHandler[]
) {
  return async (
    tx: TransactionClient,
    ctx: WorkflowContext,
    bag: ZipContentBag
  ): Promise<void> => {
    for (const handler of handlers) {
      const value = bag.get(handler.key);
      if (value !== null) {
        await handler.handle(tx, ctx, value);
      }
    }
  };
}
