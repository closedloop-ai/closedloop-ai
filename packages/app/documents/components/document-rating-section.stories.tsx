import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";
import { DocumentRatingSection } from "./document-rating-section";

function InteractiveDocumentRatingSection() {
  const [selectedScore, setSelectedScore] = useState<number | null>(4);
  const [commentDraft, setCommentDraft] = useState(
    "Clear acceptance criteria and good task breakdown."
  );

  return (
    <DocumentRatingSection
      commentDraft={commentDraft}
      currentDocumentVersion={6}
      onCancelComment={() =>
        setCommentDraft("Clear acceptance criteria and good task breakdown.")
      }
      onCommentChange={setCommentDraft}
      onSaveComment={() => undefined}
      onScoreChange={setSelectedScore}
      selectedScore={selectedScore}
      summary={{
        average: 4.4,
        count: 7,
        userRating: {
          score: 4,
          comment: "Clear acceptance criteria and good task breakdown.",
          documentVersion: 6,
        },
      }}
    />
  );
}

const meta = {
  title: "App Core/Documents/Document Rating Section",
  component: DocumentRatingSection,
  tags: ["autodocs"],
  argTypes: {
    summary: { control: "object", table: { category: "Data" } },
    currentDocumentVersion: {
      control: { type: "number", min: 1 },
      table: { category: "Data" },
    },
    selectedScore: {
      control: { type: "number", min: 0, max: 5 },
      table: { category: "State" },
    },
    commentDraft: { control: "text", table: { category: "State" } },
    isLoading: { control: "boolean", table: { category: "State" } },
    isSaving: { control: "boolean", table: { category: "State" } },
    onScoreChange: { control: false, table: { category: "Events" } },
    onCommentChange: { control: false, table: { category: "Events" } },
    onCancelComment: { control: false, table: { category: "Events" } },
    onSaveComment: { control: false, table: { category: "Events" } },
  },
  parameters: {
    layout: "padded",
  },
  args: {
    commentDraft: "",
    currentDocumentVersion: 6,
    selectedScore: null,
    isLoading: false,
    isSaving: false,
    onScoreChange: fn(),
    onCommentChange: fn(),
    onCancelComment: fn(),
    onSaveComment: fn(),
    summary: {
      average: 4.4,
      count: 7,
      userRating: {
        score: 4,
        comment: "Clear acceptance criteria and good task breakdown.",
        documentVersion: 6,
      },
    },
  },
} satisfies Meta<typeof DocumentRatingSection>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Interactive: Story = {
  render: () => <InteractiveDocumentRatingSection />,
};

export const Loading: Story = {
  args: {
    isLoading: true,
    summary: null,
  },
};

export const StaleVersion: Story = {
  args: {
    commentDraft: "The plan is solid but needs rollback notes.",
    currentDocumentVersion: 8,
    selectedScore: 4,
    summary: {
      average: 4.1,
      count: 5,
      userRating: {
        score: 4,
        comment: "The plan is solid but needs rollback notes.",
        documentVersion: 6,
      },
    },
  },
};

export const EmptyState: Story = {
  args: {
    commentDraft: "",
    currentDocumentVersion: 2,
    selectedScore: null,
    summary: {
      average: 0,
      count: 0,
      userRating: null,
    },
  },
};
