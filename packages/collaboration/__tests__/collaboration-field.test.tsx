// @vitest-environment jsdom

import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { describe, expect, it, vi } from "vitest";
import {
  findExtension,
  resolveLiveblocksExtensions,
} from "./support/liveblocks-extension-harness";

vi.mock("@liveblocks/react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import("./support/liveblocks-extension-harness"))
    .liveblocksReactOverrides,
}));

vi.mock("@liveblocks/react/_private", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import("./support/liveblocks-extension-harness"))
    .liveblocksReactPrivateOverrides,
}));

describe("DOCUMENT_FRAGMENT_FIELD", () => {
  it("is the fragment Liveblocks binds the editor to by default", async () => {
    const extensions = await resolveLiveblocksExtensions();
    const collaboration = findExtension(extensions, "collaboration");

    expect(collaboration.options.field).toBe(DOCUMENT_FRAGMENT_FIELD);
  });
});
