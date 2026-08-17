import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DOCUMENT_TITLE_SUFFIX, useDocumentTitle } from "../use-document-title";

function TitledPage({ title }: Readonly<{ title: string | null }>) {
  useDocumentTitle(title);
  return null;
}

const ROOT_LAYOUT_TITLE = DOCUMENT_TITLE_SUFFIX;

describe("ISS-5574: useDocumentTitle", () => {
  afterEach(() => {
    document.title = ROOT_LAYOUT_TITLE;
  });

  it("names the tab after the page, suffixed with the product", () => {
    document.title = ROOT_LAYOUT_TITLE;

    render(<TitledPage title="Sessions" />);

    expect(document.title).toBe(`Sessions | ${DOCUMENT_TITLE_SUFFIX}`);
  });

  it("leaves the title alone for null, so a flagged-off caller keeps the default", () => {
    document.title = ROOT_LAYOUT_TITLE;

    render(<TitledPage title={null} />);

    expect(document.title).toBe(ROOT_LAYOUT_TITLE);
  });

  it("restores the previous title on unmount", () => {
    document.title = ROOT_LAYOUT_TITLE;

    const page = render(<TitledPage title="Branches" />);
    expect(document.title).toBe(`Branches | ${DOCUMENT_TITLE_SUFFIX}`);
    page.unmount();

    // A titled page must not leave its name behind on whatever renders next.
    expect(document.title).toBe(ROOT_LAYOUT_TITLE);
  });

  // Review (closedloop-ai-stage on #4661): `previous` captures whatever the last
  // writer left in `document.title`, not the root layout's default — so a writer
  // that never restores would have its name handed BACK by this hook's cleanup,
  // one navigation later. The repo had exactly one such writer
  // (`loop-detail-container.tsx`); it now goes through this hook, which restores.
  // This case pins the mechanic the argument turns on: the restore is faithful to
  // whatever was there, so every writer must restore for the chain to hold.
  it("restores exactly what it found, including a title set outside React", () => {
    document.title = "Set by something that is not this hook";

    const page = render(<TitledPage title="Sessions" />);
    expect(document.title).toBe(`Sessions | ${DOCUMENT_TITLE_SUFFIX}`);
    page.unmount();

    expect(document.title).toBe("Set by something that is not this hook");
  });

  it("retitles when the record's name arrives", () => {
    document.title = ROOT_LAYOUT_TITLE;

    // The honest generic while the read is in flight...
    const page = render(<TitledPage title="Session" />);
    expect(document.title).toBe(`Session | ${DOCUMENT_TITLE_SUFFIX}`);

    // ...then the record itself, once it resolves.
    page.rerender(<TitledPage title="symphony-alpha-iss-5273" />);
    expect(document.title).toBe(
      `symphony-alpha-iss-5273 | ${DOCUMENT_TITLE_SUFFIX}`
    );
  });
});
