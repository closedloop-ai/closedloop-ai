"use client";

import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { useOrganizationUsers } from "@repo/app/users/hooks/use-users";
import { useMemo } from "react";
import { useProjects } from "../../projects/hooks/use-projects";

/**
 * FEA-3930 Slice 5, dynamic value sources for the search intellisense overlay.
 * The `@owner` and `:project` grammars resolve their values from existing
 * org-scoped endpoints; these hooks map those responses into the flat
 * {@link SuggestionOption} shape the overlay renders, and gate the fetch on the
 * overlay actually needing it (`enabled`) so an idle search box issues no
 * request. Static enum values (status/priority) live in the shared contract and
 * need no fetch, the intellisense module supplies them synchronously.
 */

/** A rendered dynamic-value suggestion row. */
export type SuggestionOption = {
  /**
   * The token the parser resolves against when committed into the query, a
   * GitHub username / email for a member, a project slug/name for a project.
   */
  value: string;
  /** Primary label shown in the overlay row. */
  label: string;
  /** Secondary muted line (email / slug), omitted when it equals the label. */
  detail?: string;
};

/** The async state the overlay renders around a dynamic-value list. */
export type SuggestionsResult = {
  options: SuggestionOption[];
  isLoading: boolean;
  isError: boolean;
};

/**
 * Org members for the `@owner` mention typeahead, mapped to the token the search
 * parser resolves by. The parser matches a mention against email / GitHub
 * username / first / last name, so a member with a GitHub username commits that
 * (the stable handle); otherwise it falls back to the email, which the parser
 * also matches exactly. Fetches only when `enabled` (the `@` surface is open).
 */
export function useMemberSuggestions(enabled: boolean): SuggestionsResult {
  const { data, isLoading, isError } = useOrganizationUsers({ enabled });

  const options = useMemo<SuggestionOption[]>(() => {
    if (!data) {
      return [];
    }
    return data.map((user) => {
      const name = getUserDisplayName(user);
      const value = user.githubUsername ?? user.email;
      return {
        value,
        label: name,
        detail: value === name ? undefined : value,
      };
    });
  }, [data]);

  return { options, isLoading, isError };
}

/**
 * Projects for the `:project=` value typeahead, mapped to the slug the parser
 * resolves by (falling back to the name when a project has no slug, which the
 * parser also matches). Fetches only when `enabled` (the `:project` surface is
 * open).
 */
export function useProjectSuggestions(enabled: boolean): SuggestionsResult {
  const { data, isLoading, isError } = useProjects(undefined, { enabled });

  const options = useMemo<SuggestionOption[]>(() => {
    if (!data) {
      return [];
    }
    return data.map((project) => {
      const value = project.slug ?? project.name;
      return {
        value,
        label: project.name,
        detail: value === project.name ? undefined : value,
      };
    });
  }, [data]);

  return { options, isLoading, isError };
}

/**
 * Typeahead-filter a dynamic {@link SuggestionOption} list by the partial the
 * user typed, matching against both the label and the resolvable value so
 * `@ali` finds "Alice" (name) and `alice-gh` (username) alike. Empty filter
 * returns the whole list.
 */
export function filterSuggestionOptions(
  options: SuggestionOption[],
  filter: string
): SuggestionOption[] {
  const lower = filter.trim().toLowerCase();
  if (lower.length === 0) {
    return options;
  }
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(lower) ||
      option.value.toLowerCase().includes(lower) ||
      (option.detail?.toLowerCase().includes(lower) ?? false)
  );
}
