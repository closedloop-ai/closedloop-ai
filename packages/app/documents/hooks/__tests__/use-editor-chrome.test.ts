import { DocumentType } from "@repo/api/src/types/document";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useEditorChrome } from "../use-editor-chrome";

const PANEL_KEY = `panel:chat:${DocumentType.ImplementationPlan}`;

afterEach(() => {
  localStorage.removeItem(PANEL_KEY);
});

/**
 * ISS-8533. The metadata panel's persisted preference defaults to `true`, so the two
 * halves below are not interchangeable: a coercion that collapsed everything to the
 * fallback would still pass the malformed case and fail the stored-`false` one.
 */
describe("useEditorChrome persisted metadata panel (ISS-8533)", () => {
  it("PIN: a stored false is still honoured against a true default", () => {
    localStorage.setItem(PANEL_KEY, "false");

    const { result } = renderHook(() =>
      useEditorChrome({ documentType: DocumentType.ImplementationPlan })
    );

    expect(result.current.showMetadataPanel).toBe(false);
  });

  it("coerces a non-boolean to the default rather than reading it as truthy", () => {
    localStorage.setItem(PANEL_KEY, '"open"');

    const { result } = renderHook(() =>
      useEditorChrome({ documentType: DocumentType.ImplementationPlan })
    );

    expect(result.current.showMetadataPanel).toBe(true);
  });

  it("toggles from a coerced value in the direction the default implies", () => {
    localStorage.setItem(PANEL_KEY, "5");

    const { result } = renderHook(() =>
      useEditorChrome({ documentType: DocumentType.ImplementationPlan })
    );

    act(() => {
      result.current.toggleMetadataPanel();
    });

    // Pre-fix `prev` is the number 5, so `!prev` is false either way and the write
    // path happens to agree; the read is what differs. Pinned so a future validator
    // cannot diverge the two.
    expect(result.current.showMetadataPanel).toBe(false);
  });
});
