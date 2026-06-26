import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
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
  parameters: {
    layout: "padded",
  },
  args: {
    commentDraft: "",
    currentDocumentVersion: 6,
    selectedScore: null,
    isLoading: false,
    isSaving: false,
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
