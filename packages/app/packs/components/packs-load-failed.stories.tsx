import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { ApiError } from "../../shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "../../shared/api/api-timeout";
import { PacksLoadFailed } from "./packs-load-failed";

// wongk (PR #4321): the loading half of this event is already in Storybook as
// `packs-workspace-skeleton.stories.tsx`; this is the "it didn't load" half, so
// the two read side by side. The timeout branch in particular needs a client
// deadline to actually fire in the running app, which makes it exactly the
// branch a copy/icon regression could break silently.

const timeoutError = new ApiError(
  API_TIMEOUT_ERROR_MESSAGE,
  API_NO_RESPONSE_STATUS,
  { code: API_TIMEOUT_ERROR_CODE }
);

const meta = {
  title: "App Core/Packs/Packs Load Failed",
  component: PacksLoadFailed,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    // An ApiError instance, not editable data: the timeout branch keys off
    // `error.isTimeout()`, which a control-authored plain object would not carry.
    error: { control: false },
    onRetry: { control: false, table: { category: "Events" } },
  },
  args: {
    // Presentational story: the retry affordance is what's under review, not
    // what it refetches.
    onRetry: fn(),
  },
} satisfies Meta<typeof PacksLoadFailed>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A read the SERVER answered with a failure — the generic failed-read treatment. */
export const Default: Story = {};

/**
 * A read the CLIENT stopped waiting on. Distinct title, description, and icon
 * from `Default`: "we stopped waiting" and "the server said no" are different
 * facts, and blaming the user's connection for our own deadline is a lie.
 */
export const TimedOut: Story = {
  args: { error: timeoutError },
};

/** A surface with nowhere to retry to — the state renders without the affordance. */
export const NoRetry: Story = {
  args: { onRetry: undefined },
};
