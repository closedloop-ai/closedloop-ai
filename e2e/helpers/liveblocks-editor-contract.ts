import { expect, type Locator, type Page } from "@playwright/test";

const SINGLE_PARAGRAPH_ASCII = /^[\x20-\x7e]*$/;
const EDITOR_SELECTOR = ".ProseMirror";

export const EditorFormatting = {
  Bold: "bold",
  Italic: "italic",
  Underline: "underline",
} as const;
export type EditorFormatting =
  (typeof EditorFormatting)[keyof typeof EditorFormatting];

const FORMATTING_KEYS: Record<EditorFormatting, string> = {
  [EditorFormatting.Bold]: "ControlOrMeta+b",
  [EditorFormatting.Italic]: "ControlOrMeta+i",
  [EditorFormatting.Underline]: "ControlOrMeta+u",
};
const FORMATTING_ELEMENTS: Record<EditorFormatting, string> = {
  [EditorFormatting.Bold]: "strong",
  [EditorFormatting.Italic]: "em",
  [EditorFormatting.Underline]: "u",
};

/** Surface-owned real clipboard writer; return the OS clipboard's text readback. */
export type NativeEditorClipboard = (text: string) => Promise<string>;

/** The caller opens a real Liveblocks document; visibility follows Y.Doc readiness. */
export async function readyLiveblocksEditor(page: Page): Promise<Locator> {
  const editor = page.locator(EDITOR_SELECTOR);
  await expect(editor).toHaveCount(1);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await expect(editor).toBeFocused();
  return editor;
}

/**
 * Drive a native selection in a single-paragraph ASCII fixture. No DOM/model
 * selection is assigned; every requested offset is checked against native DOM.
 */
export async function selectEditorText(
  page: Page,
  editor: Locator,
  content: string,
  from: number,
  to: number
): Promise<void> {
  requireFixtureRange(content, from, to);
  await expect(editor.locator("p")).toHaveCount(1);
  await expect.poll(() => editor.innerText()).toBe(content);
  await expect(editor).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await expect
    .poll(async () => (await readEditorSelection(editor))?.text)
    .toBe(content);
  await page.keyboard.press("ArrowLeft");
  for (let index = 0; index < from; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
  for (let index = from; index < to; index += 1) {
    await page.keyboard.press("Shift+ArrowRight");
  }
  await expect
    .poll(() => readEditorSelection(editor))
    .toEqual({
      anchor: from,
      focus: to,
      text: content.slice(from, to),
    });
}

/** Toggle a native B/I/U chord and prove its selected text is rendered with the mark. */
export async function formatEditorSelection(
  page: Page,
  editor: Locator,
  formatting: EditorFormatting,
  selectedText: string
): Promise<void> {
  expect(selectedText.length).toBeGreaterThan(0);
  await expect(editor).toBeFocused();
  await expect
    .poll(async () => (await readEditorSelection(editor))?.text)
    .toBe(selectedText);
  await page.keyboard.press(FORMATTING_KEYS[formatting]);
  await expect(editor.locator(FORMATTING_ELEMENTS[formatting])).toHaveText(
    selectedText
  );
  await expect
    .poll(async () => (await readEditorSelection(editor))?.text)
    .toBe(selectedText);
}

/** Paste through the native clipboard/chord and prove replacement plus the new caret. */
export async function pasteEditorReplacement(options: {
  page: Page;
  editor: Locator;
  content: string;
  from: number;
  to: number;
  replacement: string;
  clipboard: NativeEditorClipboard;
}): Promise<string> {
  const { page, editor, content, from, to, replacement, clipboard } = options;
  requireFixtureRange(replacement, 0, replacement.length);
  await selectEditorText(page, editor, content, from, to);
  expect(await clipboard(replacement)).toBe(replacement);
  await expect(editor).toBeFocused();
  await expect
    .poll(() => readEditorSelection(editor))
    .toEqual({
      anchor: from,
      focus: to,
      text: content.slice(from, to),
    });
  await page.keyboard.press("ControlOrMeta+v");
  const expected = content.slice(0, from) + replacement + content.slice(to);
  await expect.poll(() => editor.innerText()).toBe(expected);
  await assertEditorCaret(editor, from + replacement.length);
  return expected;
}

/** Read-only native caret evidence, including containment in this editor. */
export async function assertEditorCaret(
  editor: Locator,
  position: number
): Promise<void> {
  await expect(editor).toBeFocused();
  await expect
    .poll(() => readEditorSelection(editor))
    .toEqual({
      anchor: position,
      focus: position,
      text: "",
    });
}

/**
 * Check real history against explicit fixture checkpoints. Yjs transaction
 * grouping is not forced; the caller must arrange the expected isolated edit.
 */
export async function assertEditorUndoRedo(options: {
  page: Page;
  editor: Locator;
  before: string;
  after: string;
}): Promise<void> {
  const { page, editor, before, after } = options;
  expect(before).not.toBe(after);
  await expect(editor).toBeFocused();
  await expect.poll(() => editor.innerText()).toBe(after);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => editor.innerText()).toBe(before);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => editor.innerText()).toBe(after);
}

/** The surface owns save completion and reload/navigation of the same durable document. */
export async function assertEditorDurableReload(options: {
  page: Page;
  reload: () => Promise<void>;
  content: string;
}): Promise<Locator> {
  await options.reload();
  const editor = await readyLiveblocksEditor(options.page);
  await expect.poll(() => editor.innerText()).toBe(options.content);
  return editor;
}

function requireFixtureRange(content: string, from: number, to: number): void {
  if (
    !(
      SINGLE_PARAGRAPH_ASCII.test(content) &&
      Number.isInteger(from) &&
      Number.isInteger(to)
    ) ||
    from < 0 ||
    to < from ||
    to > content.length
  ) {
    throw new Error(
      "Editor keyboard fixture requires one ASCII paragraph and valid offsets"
    );
  }
}

function readEditorSelection(editor: Locator) {
  return editor.evaluate((element) => {
    const selection = element.ownerDocument.getSelection();
    if (
      selection?.rangeCount !== 1 ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !element.contains(selection.anchorNode) ||
      !element.contains(selection.focusNode)
    ) {
      return null;
    }
    const anchorRange = element.ownerDocument.createRange();
    anchorRange.selectNodeContents(element);
    anchorRange.setEnd(selection.anchorNode, selection.anchorOffset);
    const focusRange = element.ownerDocument.createRange();
    focusRange.selectNodeContents(element);
    focusRange.setEnd(selection.focusNode, selection.focusOffset);
    return {
      anchor: anchorRange.toString().length,
      focus: focusRange.toString().length,
      text: selection.toString(),
    };
  });
}
