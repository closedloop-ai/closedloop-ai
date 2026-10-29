import {
  DOCUMENT_ROUTE_PREFIX,
  DocumentType,
} from "@repo/api/src/types/document";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { DocumentHostProvider } from "../document-host-context";
import { useCommentPermalinkBuilder } from "../use-comment-permalink-builder";

const target = {
  documentType: DocumentType.ImplementationPlan,
  documentSlug: "PLN-2171",
  orgSlug: "closedloop-ai",
};

describe("document comment permalink host origin", () => {
  it("uses the configured Web origin on native Desktop", () => {
    const { result } = renderHook(() => useCommentPermalinkBuilder(target), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DocumentHostProvider
          orgSlug="closedloop-ai"
          webOrigin="https://app.closedloop.ai"
        >
          {children}
        </DocumentHostProvider>
      ),
    });
    expect(result.current?.("thread-1")).toBe(
      `https://app.closedloop.ai/closedloop-ai/${DOCUMENT_ROUTE_PREFIX}/PLN-2171?thread=thread-1`
    );
  });

  it("holds Copy Link while a native Web origin is unavailable", () => {
    const { result } = renderHook(() => useCommentPermalinkBuilder(target), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <DocumentHostProvider orgSlug="closedloop-ai" webOrigin={null}>
          {children}
        </DocumentHostProvider>
      ),
    });
    expect(result.current).toBeUndefined();
  });
});
