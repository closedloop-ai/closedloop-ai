import { CodeBlock } from "@repo/design-system/components/ui/primitives/code-block";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Code Block",
  component: CodeBlock,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    tone: {
      options: ["default", "danger", "success"],
      control: { type: "radio" },
    },
    compact: {
      control: "boolean",
    },
    showLineNumbers: {
      control: "boolean",
    },
  },
  args: {
    filename: "session-table.tsx",
    code: "export function SessionTable() {\n  return <div>Sessions</div>;\n}",
  },
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * Showcase all three tones together — `default`, `danger`, and `success` —
 * useful for eyeballing the tint contrast side by side.
 */
export const Tones: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <CodeBlock
        code="export function SessionTable() {\n  return <div>Sessions</div>;\n}"
        label="default"
        tone="default"
      />
      <CodeBlock
        code="- const stale = getStaleSessions();\n- await purge(stale);"
        label="removed"
        tone="danger"
      />
      <CodeBlock
        code="+ const fresh = getActiveSessions();\n+ await sync(fresh);"
        label="added"
        tone="success"
      />
    </div>
  ),
};

/**
 * Use the `danger` tone to surface failed tool calls or error output — it tints
 * the chrome and border red.
 */
export const Danger: Story = {
  args: {
    tone: "danger",
    filename: undefined,
    label: "error",
    code: 'Error: command failed with exit code 1\n  at run (session-table.tsx:42)\n  throw new Error("boom");',
  },
};

/**
 * Use the `success` tone to highlight successful results — it tints the chrome
 * and border emerald.
 */
export const Success: Story = {
  args: {
    tone: "success",
    filename: undefined,
    label: "result",
    code: '{\n  "status": "ok",\n  "sessions": 3\n}',
  },
};

/**
 * `compact` mode drops the header chrome (filename/label row and copy button),
 * rendering just the code — useful inline inside markdown or dense tool views.
 */
export const Compact: Story = {
  args: {
    compact: true,
    code: "pnpm turbo test --filter=app",
  },
};

/**
 * Provide a `label` as an alternative to `filename` to describe the block
 * without the file icon (e.g. "stdout", "result", "error").
 */
export const WithLabel: Story = {
  args: {
    filename: undefined,
    label: "stdout",
    code: "Listening on http://localhost:3000\nReady in 1.2s",
  },
};

/**
 * `showLineNumbers` forces the numbered gutter on. By default the gutter only
 * appears when the snippet has four or more lines.
 */
export const WithLineNumbers: Story = {
  args: {
    showLineNumbers: true,
    code: "const a = 1;\nconst b = 2;",
  },
};
