// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import AppError from "next/dist/client/components/builtin/app-error";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectStatic500,
  measurementDriftFindings,
} from "@/scripts/check-static-500.mjs";

const SUBMIT = '<button type="submit"';
const FORM = "<form ";
const BODY_END = "</body>";
const ONLY_CONTROL = "expected one enabled submit button inside one form";
const SYNTHETIC_MANIFEST = { "/500": "pages/500.html" };

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Next's own built-in 500 markup, rendered from the installed component, with
 * one unnonced and one nonced script so the count is exercised both ways.
 */
function builtInMarkup(): string {
  return renderToStaticMarkup(AppError()).replace(
    BODY_END,
    `<script src="/_next/static/chunks/a.js" async=""></script><script nonce="n">self.x=1</script>${BODY_END}`
  );
}

function serverDir({
  page = builtInMarkup(),
  globalError = page,
  manifest = SYNTHETIC_MANIFEST,
}: ServerDirOptions = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "static-500-"));
  created.push(dir);
  mkdirSync(path.join(dir, "pages"));
  mkdirSync(path.join(dir, "app"));
  writeFileSync(
    path.join(dir, "pages-manifest.json"),
    JSON.stringify(manifest)
  );
  writeFileSync(path.join(dir, "pages", "500.html"), page);
  writeFileSync(path.join(dir, "app", "_global-error.html"), globalError);
  return dir;
}

describe("inspectStatic500", () => {
  it("accepts Next's built-in 500 document and measures its scripts", () => {
    expect(inspectStatic500(serverDir())).toEqual({
      findings: [],
      scripts: 2,
      noncedScripts: 1,
    });
  });

  it.each([
    [
      "an inline handler",
      SUBMIT,
      '<button onclick="retry()" type="submit"',
      'carries onclick="retry()"',
    ],
    [
      "a submit that needs a script",
      SUBMIT,
      '<button type="button"',
      ONLY_CONTROL,
    ],
    [
      "a disabled submit",
      SUBMIT,
      '<button disabled="" type="submit"',
      ONLY_CONTROL,
    ],
    ["a second control", FORM, '<a href="/">home</a><form ', ONLY_CONTROL],
    [
      "a form that stops retrying the url",
      FORM,
      '<form method="post" ',
      "<form> sets method",
    ],
    [
      "a javascript: url",
      FORM,
      '<form action="javascript:retry()" ',
      'carries action="javascript:retry()"',
    ],
    [
      "a submit whose form attribute names a different form",
      SUBMIT,
      '<button form="not-this-form" type="submit"',
      ONLY_CONTROL,
    ],
  ])("refuses %s", (_label, from, to, finding) => {
    const page = builtInMarkup().replace(from, to);
    expect(page).toContain(to);

    const { findings } = inspectStatic500(serverDir({ page }));

    expect(findings.join("\n")).toContain(finding);
  });

  it("refuses a submit disabled only by an ancestor fieldset", () => {
    // `button.disabled` reflects the element's own attribute, not a
    // disabled ancestor `<fieldset>` — the retry is dead either way.
    const page = builtInMarkup()
      .replace(SUBMIT, `<fieldset disabled>${SUBMIT}`)
      .replace("</button>", "</button></fieldset>");
    expect(page).toContain("<fieldset disabled>");

    const { findings } = inspectStatic500(serverDir({ page }));

    expect(findings.join("\n")).toContain(ONLY_CONTROL);
  });

  it.each([
    ["pages-manifest.json", "pages-manifest.json"],
    ["the 500 page", path.join("pages", "500.html")],
    ["the global-error copy", path.join("app", "_global-error.html")],
  ])(
    "reports %s missing as a finding instead of throwing",
    (_label, relativePath) => {
      const dir = serverDir();
      rmSync(path.join(dir, relativePath));

      const { findings } = inspectStatic500(dir);

      expect(findings.join("\n")).toContain(
        `${path.join(dir, relativePath)} no longer exists`
      );
    }
  );

  it("refuses a pages-router entry that would let next start serve it", () => {
    const { findings } = inspectStatic500(
      serverDir({
        manifest: { ...SYNTHETIC_MANIFEST, "/_document": "pages/_document.js" },
      })
    );

    expect(findings).toEqual([
      'pages-manifest.json is {"/500":"pages/500.html","/_document":"pages/_document.js"}, expected {"/500":"pages/500.html"}',
    ]);
  });

  it("refuses a 500 page that is no longer the synthetic global-error copy", () => {
    const { findings } = inspectStatic500(
      serverDir({ globalError: `${builtInMarkup()}<!-- rebuilt -->` })
    );

    expect(findings).toEqual([
      "pages/500.html is no longer a copy of app/_global-error.html",
    ]);
  });
});

describe("measurementDriftFindings", () => {
  it("accepts the measured counts (ISS-11059, re-measured by ISS-12054 and ISS-12940)", () => {
    expect(measurementDriftFindings(19, 0)).toEqual([]);
  });

  it("flags a script-count drift", () => {
    expect(measurementDriftFindings(18, 0)).toEqual([
      "script count is 18, expected 19 — re-measure before changing this check",
    ]);
  });

  it("flags a nonced-script-count drift", () => {
    expect(measurementDriftFindings(19, 1)).toEqual([
      "nonced script count is 1, expected 0 — re-measure before changing this check",
    ]);
  });
});

type ServerDirOptions = {
  page?: string;
  globalError?: string;
  manifest?: Record<string, string>;
};
