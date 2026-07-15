"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import {
  CHAT_MODEL_OPTIONS,
  type ChatProviderName,
  DEFAULT_CHAT_MODELS,
} from "@repo/app/chat/lib/default-models";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";

/**
 * PostHog flag gating the in-composer model picker (FEA: emergent). First slice
 * surfaces in apps/app's chat composer only; ships dark until the flag is on.
 */
export const CHAT_MODEL_SELECT_FLAG = "emergent";

type ChatModelSelectProps = {
  /** Provider the chat is bound to; determines which models are offered. */
  provider: ChatProviderName;
  /** Currently selected model id, or undefined to fall back to the default. */
  value: string | undefined;
  onChange: (model: string) => void;
  disabled?: boolean;
};

/**
 * In-composer model picker rendered in the chat-input footer slot. Lets a user
 * switch model *within* the bound provider (provider stays pinned per chat via
 * the existing "clear chat to switch providers" rule). Returns null unless the
 * `emergent` flag is enabled.
 */
export function ChatModelSelect({
  provider,
  value,
  onChange,
  disabled = false,
}: Readonly<ChatModelSelectProps>) {
  const enabled = useFeatureFlag(CHAT_MODEL_SELECT_FLAG)?.enabled === true;
  if (!enabled) {
    return null;
  }

  const options = CHAT_MODEL_OPTIONS[provider];
  // Fall back to the provider default when no value is set, or when the value
  // isn't one of this provider's offered options (e.g. a chat bound to a model
  // outside the curated list) — otherwise the trigger would render blank.
  const current =
    value && options.some((option) => option.value === value)
      ? value
      : DEFAULT_CHAT_MODELS[provider];

  return (
    <div className="mt-2 flex items-center justify-end">
      <Select disabled={disabled} onValueChange={onChange} value={current}>
        <SelectTrigger
          aria-label="Model"
          className="h-7 border-none bg-transparent px-2 py-0 font-mono text-[11px] text-muted-foreground uppercase tracking-wide hover:bg-muted hover:text-foreground"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
