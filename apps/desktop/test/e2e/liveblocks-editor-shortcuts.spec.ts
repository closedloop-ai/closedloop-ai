import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  DocumentStatus,
  DocumentType,
  SnapshotSource,
} from "@repo/api/src/types/document.ts";
import { UNDO_KEYBINDINGS_FLAG_KEY } from "@repo/api/src/types/undo-keybindings-flag.ts";
import { ApproverRole } from "@repo/api/src/types/user.ts";
import type * as ConnectedDocumentModule from "@repo/collaboration/server/test-support/connected-document.ts";
import type * as ConnectedDocumentFailureModule from "@repo/collaboration/shared/connected-document-failure.ts";
import { z } from "zod";
import {
  assertEditorCaret,
  assertEditorDurableReload,
  assertEditorUndoRedo,
  EditorFormatting,
  formatEditorSelection,
  pasteEditorReplacement,
  readyLiveblocksEditor,
  selectEditorText,
} from "../../../../e2e/helpers/liveblocks-editor-contract";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  closeServer,
  createAuthenticatedDesktopSessionRecord,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { readJsonBody } from "./helpers/branches-cloud-fixture";
import { gotoHash } from "./helpers/desktop-app";
import {
  launchShellSidebarApp,
  startNavigationCloudServer,
} from "./helpers/shell-navigation-cloud";

// Playwright resolves this non-ESM workspace package through its CommonJS loader.
const connectedDocumentModule: typeof ConnectedDocumentModule = createRequire(
  import.meta.url
)("@repo/collaboration/server/test-support/connected-document.ts");
const { connectedDocumentWitness } = connectedDocumentModule;
const connectedDocumentFailureModule: typeof ConnectedDocumentFailureModule =
  createRequire(import.meta.url)(
    "@repo/collaboration/shared/connected-document-failure.ts"
  );
const {
  connectedDocumentAuthorizationBoundary,
  connectedDocumentFailure,
  cleanupConnectedDocumentRoom,
} = connectedDocumentFailureModule;

const INITIAL_CONTENT = "alpha beta gamma";
const REPLACEMENT = "delta";
const FLAGS = {
  [UNDO_KEYBINDINGS_FLAG_KEY]: true,
  labsNav: true,
  "documents-nav": true,
  "shell-sidebar-v2": true,
  "documents-universal-list": true,
};
const AUTH_BODY = z.object({ room: z.string().optional() });
const AUTH_RESULT = z.object({ token: z.string().min(1) });
type Witness = Awaited<ReturnType<typeof connectedDocumentWitness>>;
type QualificationDocument = {
  id: string;
  slug: string;
  title: string;
  witness: Witness;
  created: boolean;
};

// The local API principal is synthetic; room auth, Y.Doc and the native editor are real.
test("connected Electron document preserves native formatting, paste and Yjs undo", async () => {
  test.setTimeout(180_000);
  const documents: QualificationDocument[] = [];
  const routeErrors: unknown[] = [];
  const authorizationBoundary = connectedDocumentAuthorizationBoundary();
  const authorizedRooms = new Set<string>();
  let activeDocument: QualificationDocument | undefined;
  let launched: Awaited<ReturnType<typeof launchShellSidebarApp>> | undefined;
  let server:
    | Awaited<ReturnType<typeof startNavigationCloudServer>>
    | undefined;
  let clipboardBefore:
    | {
        text: string;
        html: string;
        rtf: string;
        image: string;
      }
    | undefined;
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "liveblocks-shortcuts-")
  );
  const failures: unknown[] = [];
  try {
    const formatting = await createQualificationDocument(
      "formatting",
      documents
    );
    const pasting = await createQualificationDocument("pasting", documents);
    activeDocument = formatting;
    server = await startNavigationCloudServer({
      featureFlags: FLAGS,
      extraRoutes: (request, response) =>
        routeEditorFixture({
          request,
          response,
          documents,
          activeDocument,
          routeErrors,
          authorizedRooms,
          authorizationFailed: authorizationBoundary.fail,
        }),
    });
    launched = await launchShellSidebarApp({
      apiOrigin: server.origin,
      flags: FLAGS,
      profileId: "liveblocks-shortcuts",
      profileName: "Liveblocks shortcuts qualification",
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      userDataDir,
    });
    const { app, page, pageErrors } = launched;
    clipboardBefore = await app.evaluate(({ clipboard }) => ({
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: clipboard.readImage().toDataURL(),
    }));
    await authorizationBoundary.run(() =>
      gotoHash(page, `/documents/${formatting.slug}`)
    );
    const editor = await authorizationBoundary.run(() =>
      readyLiveblocksEditor(page)
    );
    await expect.poll(() => editor.innerText()).toBe(INITIAL_CONTENT);
    await expect
      .poll(() => authorizedRooms.has(formatting.witness.roomId))
      .toBe(true);
    const selections = [
      { from: 0, to: 5, text: "alpha", mark: EditorFormatting.Bold },
      { from: 6, to: 10, text: "beta", mark: EditorFormatting.Italic },
      { from: 11, to: 16, text: "gamma", mark: EditorFormatting.Underline },
    ];
    for (const selection of selections) {
      await selectEditorText(
        page,
        editor,
        INITIAL_CONTENT,
        selection.from,
        selection.to
      );
      await formatEditorSelection(page, editor, selection.mark, selection.text);
      if (selection.mark === EditorFormatting.Bold) {
        await page.keyboard.press("ControlOrMeta+z");
        await expect(editor.locator("strong")).toHaveCount(0);
        await expect(editor).toHaveText(INITIAL_CONTENT);
        await page.keyboard.press("ControlOrMeta+Shift+z");
        await expect(editor.locator("strong")).toHaveText("alpha");
        await expect(editor).toHaveText(INITIAL_CONTENT);
      }
    }
    await expect
      .poll(async () => {
        const snapshot = await formatting.witness.snapshot();
        return selections.every((selection) =>
          snapshot.marks.some(
            (mark) =>
              mark.text === selection.text &&
              mark.types.includes(selection.mark)
          )
        );
      })
      .toBe(true);
    await expect
      .poll(async () => (await formatting.witness.snapshot()).text)
      .toBe(INITIAL_CONTENT);
    const reloaded = await authorizationBoundary.run(() =>
      assertEditorDurableReload({
        page,
        reload: async () => {
          await page.reload();
        },
        content: INITIAL_CONTENT,
      })
    );
    await expect(reloaded.locator("strong")).toHaveText("alpha");
    await expect(reloaded.locator("em")).toHaveText("beta");
    await expect(reloaded.locator("u")).toHaveText("gamma");

    // A full renderer navigation opens a separate seeded room with fresh Yjs history.
    const nextUrl = new URL(page.url());
    nextUrl.hash = `/documents/${pasting.slug}`;
    await page.goto("about:blank");
    activeDocument = pasting;
    await authorizationBoundary.run(() => page.goto(nextUrl.href));
    const pasteEditor = await authorizationBoundary.run(() =>
      readyLiveblocksEditor(page)
    );
    await expect.poll(() => pasteEditor.innerText()).toBe(INITIAL_CONTENT);
    await expect
      .poll(() => authorizedRooms.has(pasting.witness.roomId))
      .toBe(true);
    const after = await pasteEditorReplacement({
      page,
      editor: pasteEditor,
      content: INITIAL_CONTENT,
      from: 6,
      to: 10,
      replacement: REPLACEMENT,
      clipboard: (text) =>
        app.evaluate(({ clipboard }, value) => {
          clipboard.writeText(value);
          return clipboard.readText();
        }, text),
    });
    await expect
      .poll(async () => (await pasting.witness.snapshot()).text)
      .toBe(after);
    await assertEditorUndoRedo({
      page,
      editor: pasteEditor,
      before: INITIAL_CONTENT,
      after,
    });
    await assertEditorCaret(pasteEditor, 6 + REPLACEMENT.length);
    await expect
      .poll(async () => (await pasting.witness.snapshot()).text)
      .toBe(after);
    await expect
      .poll(async () =>
        (await pasting.witness.snapshot()).marks.every(
          (mark) => mark.types.length === 0
        )
      )
      .toBe(true);
    await authorizationBoundary.run(() =>
      assertEditorDurableReload({
        page,
        reload: async () => {
          await page.reload();
        },
        content: after,
      })
    );
    expect(routeErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  } catch (error) {
    failures.push(error);
  } finally {
    if (launched) {
      if (clipboardBefore !== undefined) {
        try {
          await launched.app.evaluate(
            ({ clipboard, nativeImage }, previous) =>
              clipboard.write({
                text: previous.text,
                html: previous.html,
                rtf: previous.rtf,
                image: nativeImage.createFromDataURL(previous.image),
              }),
            clipboardBefore
          );
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await launched.cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (server) {
      try {
        await closeServer(server.server);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const document of documents) {
      try {
        await cleanupConnectedDocumentRoom(document.witness, document.created);
      } catch (error) {
        failures.push(error);
      }
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  failures.push(...routeErrors);
  if (launched && launched.pageErrors.length > 0) {
    failures.push(
      new Error("The native renderer recorded qualification errors")
    );
  }
  if (failures.length > 0) {
    throw connectedDocumentFailure(
      failures,
      "Connected Electron editor qualification failed"
    );
  }
});

async function createQualificationDocument(
  label: string,
  documents: QualificationDocument[]
): Promise<QualificationDocument> {
  const id = randomUUID();
  const slug = `DOC-iss12432-${label}-${id}`;
  const witness = await connectedDocumentWitness({
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    slug,
    documentId: id,
  });
  const document = {
    id,
    slug,
    title: `ISS-12432 ${label}`,
    witness,
    created: false,
  };
  documents.push(document);
  await witness.create();
  document.created = true;
  await witness.seed(INITIAL_CONTENT);
  return document;
}

function routeEditorFixture(options: {
  request: IncomingMessage;
  response: ServerResponse;
  documents: QualificationDocument[];
  activeDocument: QualificationDocument | undefined;
  routeErrors: unknown[];
  authorizationFailed: (error: unknown) => void;
  authorizedRooms: Set<string>;
}): boolean {
  const {
    request,
    response,
    documents,
    activeDocument,
    routeErrors,
    authorizedRooms,
    authorizationFailed,
  } = options;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/collaboration/auth") {
    authorizeFixtureRoom(
      request,
      response,
      activeDocument,
      routeErrors,
      authorizedRooms,
      authorizationFailed
    ).catch((error: unknown) => {
      routeErrors.push(error);
      authorizationFailed(error);
      response.destroy();
    });
    return true;
  }
  if (request.method !== "GET") {
    return false;
  }
  if (url.pathname === "/desktop/identity") {
    writeApiResult(response, {
      userId: AUTHENTICATED_USER_ID,
      organizationId: AUTHENTICATED_ORGANIZATION_ID,
      email: "rich-text@example.test",
      firstName: "Rich",
      lastName: "Text",
      organizationName: "Qualification",
      organizationSlug: "qualification",
    });
    return true;
  }
  const user = {
    id: AUTHENTICATED_USER_ID,
    clerkId: "iss12432-test-principal",
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    email: "rich-text@example.test",
    firstName: "Rich",
    lastName: "Text",
    avatarUrl: null,
    phoneNumber: null,
    role: ApproverRole.Engineer,
    linearId: null,
    slackId: null,
    githubUsername: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (url.pathname === "/me" || url.pathname === "/users") {
    writeApiResult(response, url.pathname === "/me" ? user : [user]);
    return true;
  }
  const document = documents.find(
    (entry) => url.pathname === `/documents/by-slug/${entry.slug}`
  );
  if (document) {
    writeApiResult(response, documentResponse(document));
    return true;
  }
  if (
    url.pathname === "/artifact-links/resolved" ||
    url.pathname === "/projects" ||
    documents.some(
      (entry) =>
        url.pathname.startsWith(`/documents/${entry.id}/versions`) ||
        url.pathname.startsWith(`/documents/${entry.id}/pull-request`)
    )
  ) {
    writeApiResult(response, []);
    return true;
  }
  return false;
}

async function authorizeFixtureRoom(
  request: IncomingMessage,
  response: ServerResponse,
  document: QualificationDocument | undefined,
  errors: unknown[],
  authorizedRooms: Set<string>,
  authorizationFailed: (error: unknown) => void
): Promise<void> {
  try {
    if (
      request.headers.authorization !==
        `Bearer ${AUTHENTICATED_ACCESS_TOKEN}` ||
      !document
    ) {
      throw new Error("Local qualification principal is absent");
    }
    const body = AUTH_BODY.parse(await readJsonBody(request));
    if (body.room !== undefined && body.room !== document.witness.roomId) {
      throw new Error("Requested room is outside this qualification document");
    }
    const authorization = await document.witness.authorize(
      AUTHENTICATED_USER_ID
    );
    if (authorization.status !== 200) {
      throw new Error("Real Liveblocks authorization was rejected");
    }
    AUTH_RESULT.parse(JSON.parse(authorization.body));
    authorizedRooms.add(document.witness.roomId);
    response.statusCode = authorization.status;
    response.setHeader("Content-Type", "application/json");
    response.end(authorization.body);
  } catch (error) {
    errors.push(error);
    authorizationFailed(error);
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ error: "Qualification room authorization failed" })
    );
  }
}

function documentResponse(document: QualificationDocument) {
  const now = new Date().toISOString();
  return {
    id: document.id,
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    projectId: null,
    type: DocumentType.Doc,
    title: document.title,
    slug: document.slug,
    fileName: null,
    status: DocumentStatus.Draft,
    priority: null,
    latestVersion: 1,
    createdById: AUTHENTICATED_USER_ID,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    repositorySnapshot: { source: SnapshotSource.None, repositories: [] },
    templateForType: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    version: {
      id: `version-${document.id}`,
      documentId: document.id,
      version: 1,
      content: "",
      createdAt: now,
      createdById: AUTHENTICATED_USER_ID,
    },
    latestVersionContent: "",
  };
}
