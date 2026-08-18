/**
 * IPC handlers for the desktop in-app Docs & Help bridge (FEA-3843 / PRD-555 M1).
 *
 * Registers `search` / `getPage` / `status`, each guarded by
 * `assertTrustedIpcSender` — only the trusted renderer window may query the
 * bundle. The handlers are thin: input is validated/normalized here, then the
 * pure {@link DocsHelpService} (the local index + bundle) does the work. No doc
 * content is authored here; it is the build-time snapshot of `apps/web/content/docs`.
 *
 * The Labs `docsHelp` flag gates the RENDERER surfaces (M2+). The IPC is a
 * read-only lookup over already-bundled public docs, so it is always registered
 * (a flag-off renderer simply never calls it); the sender-trust guard is the
 * security boundary.
 */
import {
  type DocsHelpGetPageRequest,
  type DocsHelpGetPageResult,
  DocsHelpIpcChannel,
  type DocsHelpNavResult,
  type DocsHelpSearchRequest,
  type DocsHelpSearchResult,
  type DocsHelpStatus,
} from "../../shared/docs-help-contract.js";
import type { DocsHelpService } from "../docs-help/docs-bundle.js";
import { assertTrustedIpcSender } from "./ipc-trusted-sender.js";

type IpcMainLike = {
  handle: (
    channel: DocsHelpIpcChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type DocsHelpIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  /** The main-process Docs & Help service (index + bundle). */
  docsHelp: DocsHelpService;
};

/** Coerce an unknown IPC payload to a normalized search request. */
function readSearchRequest(raw: unknown): DocsHelpSearchRequest {
  const payload = (raw && typeof raw === "object" ? raw : {}) as {
    query?: unknown;
    limit?: unknown;
  };
  const query = typeof payload.query === "string" ? payload.query : "";
  const limit =
    typeof payload.limit === "number" && Number.isFinite(payload.limit)
      ? payload.limit
      : undefined;
  return { query, ...(limit === undefined ? {} : { limit }) };
}

/** Coerce an unknown IPC payload to a normalized get-page request. */
function readGetPageRequest(raw: unknown): DocsHelpGetPageRequest {
  const payload = (raw && typeof raw === "object" ? raw : {}) as {
    path?: unknown;
  };
  const path = typeof payload.path === "string" ? payload.path : "";
  return { path };
}

export function registerDocsHelpIpcHandlers(
  ipcMainLike: IpcMainLike,
  deps: DocsHelpIpcDeps
): void {
  ipcMainLike.handle(
    DocsHelpIpcChannel.Search,
    (event, rawPayload): DocsHelpSearchResult => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const { query, limit } = readSearchRequest(rawPayload);
      return deps.docsHelp.search(query, limit);
    }
  );
  ipcMainLike.handle(
    DocsHelpIpcChannel.GetPage,
    (event, rawPayload): DocsHelpGetPageResult => {
      assertTrustedIpcSender(deps.isTrustedSender, event);
      const { path } = readGetPageRequest(rawPayload);
      return deps.docsHelp.getPage(path);
    }
  );
  ipcMainLike.handle(DocsHelpIpcChannel.Status, (event): DocsHelpStatus => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return deps.docsHelp.status();
  });
  ipcMainLike.handle(DocsHelpIpcChannel.Nav, (event): DocsHelpNavResult => {
    assertTrustedIpcSender(deps.isTrustedSender, event);
    return deps.docsHelp.nav();
  });
}
