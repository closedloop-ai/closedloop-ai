"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@repo/design-system/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { normalizedEventKey } from "@repo/design-system/lib/keyboard-event-key";
import { useNavigation } from "@repo/navigation/use-navigation";
import {
  ArrowDownUpIcon,
  CalendarDaysIcon,
  ChevronDownIcon,
  FileCode2Icon,
  FolderKanbanIcon,
  HistoryIcon,
  ListFilterIcon,
  MessageSquareTextIcon,
  NavigationIcon,
  SearchIcon,
  SparklesIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ArtifactTypeIcons,
  GenericArtifactIcon,
} from "../shared/artifact-icons";

type SearchCategory =
  | "Artifacts"
  | "Content and comments"
  | "Sessions"
  | "Code"
  | "Navigation and actions";

type SearchTarget = {
  category: SearchCategory;
  context: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  id: string;
  keywords: string;
  label: string;
  owner?: string;
  project?: string;
  status?: string;
  type: string;
  updatedDays: number;
};

type MultiFilterKey = "owner" | "project" | "status" | "type";

type SearchFilters = Record<MultiFilterKey, string[]> & {
  updated: string;
};

const EMPTY_FILTERS: SearchFilters = {
  owner: [],
  project: [],
  status: [],
  type: [],
  updated: "Any time",
};

const FILTER_OPTIONS: Record<MultiFilterKey, readonly string[]> = {
  owner: ["Ottilie Eastwick", "Pascoe Birchall", "Jordan Lee", "Alex Rivera"],
  project: ["Artifact foundations", "Platform engineering", "Design system"],
  status: ["Active", "In review", "Approved", "Completed"],
  type: [
    "Documents",
    "Issues",
    "Sessions",
    "Branches",
    "Agentic Components",
    "Prototypes",
  ],
};

const UPDATED_OPTIONS = ["Any time", "Today", "Past 7 days", "Past 30 days"];
const ORDER_OPTIONS = ["Relevance", "Updated recently", "Created recently"];

const SEARCH_TARGETS: readonly SearchTarget[] = [
  {
    category: "Artifacts",
    context: "Generic artifact · Artifact foundations",
    href: "/p/web-master/generic-artifact/FEA-2481?tab=artifact",
    icon: GenericArtifactIcon,
    id: "FEA-2481",
    keywords:
      "unified artifact experience foundations comments related sessions",
    label: "Unified artifact experience",
    owner: "Ottilie Eastwick",
    project: "Artifact foundations",
    status: "In review",
    type: "Issues",
    updatedDays: 0,
  },
  {
    category: "Artifacts",
    context: "Document · PRD · Artifact foundations",
    href: "/p/web-master/documents/DOC-184?tab=artifact",
    icon: ArtifactTypeIcons.Document,
    id: "DOC-184",
    keywords: "artifact interaction principles requirements common grammar prd",
    label: "Artifact interaction principles",
    owner: "Pascoe Birchall",
    project: "Artifact foundations",
    status: "Approved",
    type: "Documents",
    updatedDays: 12,
  },
  {
    category: "Artifacts",
    context: "Agentic component · Multiple harnesses · Design system",
    href: "/p/web-master/agents/subagent-design-critic?tab=artifact",
    icon: ArtifactTypeIcons.Agent,
    id: "AGT-DC01",
    keywords: "design critic prototype review production vqa agent definition",
    label: "design-critic",
    owner: "Ottilie Eastwick",
    project: "Design system",
    status: "Active",
    type: "Agentic Components",
    updatedDays: 0,
  },
  {
    category: "Artifacts",
    context: "Branch · closedloop-ai · Platform engineering",
    href: "/p/web-master/branches/br_1284?tab=artifact",
    icon: ArtifactTypeIcons.Branch,
    id: "BR-1284",
    keywords: "synthetic seed generator pull request files changed repository",
    label: "agent/synthetic-seed-generator",
    owner: "Alex Rivera",
    project: "Platform engineering",
    status: "In review",
    type: "Branches",
    updatedDays: 0,
  },
  {
    category: "Artifacts",
    context: "Prototype · Visual review · Artifact foundations",
    href: "/p/web-master/prototypes/branches-v2?tab=artifact",
    icon: ArtifactTypeIcons.Prototype,
    id: "PRT-108",
    keywords: "hello world app prototype browser visual review anchors",
    label: "Hello world app",
    owner: "Jordan Lee",
    project: "Artifact foundations",
    status: "Active",
    type: "Prototypes",
    updatedDays: 2,
  },
  {
    category: "Content and comments",
    context: "DOC-184 · Problem and opportunity · document text",
    href: "/p/web-master/documents/DOC-184?tab=artifact",
    icon: ArtifactTypeIcons.Document,
    id: "DOC-184",
    keywords: "predictable artifact grammar flattening content useful",
    label: "Teams need one predictable artifact grammar…",
    owner: "Pascoe Birchall",
    project: "Artifact foundations",
    status: "Approved",
    type: "Documents",
    updatedDays: 12,
  },
  {
    category: "Content and comments",
    context: "DOC-184 · anchored comment by Ottilie Eastwick",
    href: "/p/web-master/documents/DOC-184?tab=artifact&comments=open&comment=comment-1",
    icon: MessageSquareTextIcon,
    id: "DOC-184 comment",
    keywords: "general artifact comment anchored review behavior",
    label: "This is a general artifact comment…",
    owner: "Ottilie Eastwick",
    project: "Artifact foundations",
    status: "Approved",
    type: "Documents",
    updatedDays: 0,
  },
  {
    category: "Sessions",
    context: "SES_9F31 · conversation trace · Claude",
    href: "/p/web-master/sessions/ses_9f31?tab=sessions&traceRow=4",
    icon: ArtifactTypeIcons.Session,
    id: "SES_9F31",
    keywords: "closedloop electron conversation trace claude opus fixture",
    label: "closedloop-electron",
    owner: "Jordan Lee",
    project: "Platform engineering",
    status: "Completed",
    type: "Sessions",
    updatedDays: 0,
  },
  {
    category: "Sessions",
    context: "SES_9F31 · turn 4 · session text",
    href: "/p/web-master/sessions/ses_9f31?tab=sessions&traceRow=4",
    icon: HistoryIcon,
    id: "SES_9F31 turn 4",
    keywords: "added variant focused unit test branchless path round trips",
    label: "Added the variant and a focused unit test",
    owner: "Jordan Lee",
    project: "Platform engineering",
    status: "Completed",
    type: "Sessions",
    updatedDays: 0,
  },
  {
    category: "Code",
    context: "BR-1284 · closedloop-ai · +214 −4",
    href: "/p/web-master/branches/br_1284?tab=artifact&file=packages%2Fdatabase%2Fseed%2Fsynthetic-generator.ts",
    icon: FileCode2Icon,
    id: "synthetic-generator.ts",
    keywords: "packages database seed synthetic generator typescript diff",
    label: "packages/database/seed/synthetic-generator.ts",
    owner: "Alex Rivera",
    project: "Platform engineering",
    status: "In review",
    type: "Branches",
    updatedDays: 0,
  },
  {
    category: "Navigation and actions",
    context: "Go to artifact list",
    href: "/p/web-master/documents",
    icon: NavigationIcon,
    id: "Go to Documents",
    keywords: "go navigate open documents list",
    label: "Documents",
    type: "Documents",
    updatedDays: 0,
  },
  {
    category: "Navigation and actions",
    context: "Open the shared issue composer",
    href: "/p/web-master/issues-v2?create=open",
    icon: SparklesIcon,
    id: "Create issue",
    keywords: "create add new issue feature",
    label: "Create issue…",
    type: "Issues",
    updatedDays: 0,
  },
];

const RECENT_SEARCHES = ["artifact comments", "ISS-6155", "design critic"];
const RECENT_TARGET_IDS = new Set(["FEA-2481", "DOC-184", "SES_9F31"]);
const CATEGORY_ORDER: readonly SearchCategory[] = [
  "Artifacts",
  "Content and comments",
  "Sessions",
  "Code",
  "Navigation and actions",
];
const OPEN_UNIVERSAL_SEARCH_EVENT = "web-master:open-search";

function matchesUpdatedFilter(days: number, filter: string) {
  if (filter === "Today") {
    return days === 0;
  }
  if (filter === "Past 7 days") {
    return days <= 7;
  }
  if (filter === "Past 30 days") {
    return days <= 30;
  }
  return true;
}

function scoreTarget(target: SearchTarget, rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return 1;
  }
  const id = target.id.toLowerCase();
  const label = target.label.toLowerCase();
  const searchable =
    `${id} ${label} ${target.context} ${target.keywords}`.toLowerCase();
  if (id === query) {
    return 100;
  }
  if (label === query) {
    return 95;
  }
  if (id.startsWith(query) || label.startsWith(query)) {
    return 85;
  }
  if (id.includes(query) || label.includes(query)) {
    return 75;
  }
  return searchable.includes(query) ? 55 : 0;
}

function matchesMultiFilter(
  values: readonly string[],
  targetValue: string | undefined
) {
  return (
    values.length === 0 || Boolean(targetValue && values.includes(targetValue))
  );
}

function targetMatchesFilters(target: SearchTarget, filters: SearchFilters) {
  return (
    matchesMultiFilter(filters.type, target.type) &&
    matchesMultiFilter(filters.project, target.project) &&
    matchesMultiFilter(filters.owner, target.owner) &&
    matchesMultiFilter(filters.status, target.status) &&
    matchesUpdatedFilter(target.updatedDays, filters.updated)
  );
}

function FilterMenu({
  icon: Icon,
  label,
  onToggle,
  options,
  values,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onToggle: (value: string) => void;
  options: readonly string[];
  values: readonly string[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Filter search by ${label.toLowerCase()}`}
          className="h-7 gap-1 px-2 text-xs"
          variant={values.length > 0 ? "secondary" : "outline"}
        >
          <Icon className="size-3.5" />
          {label}
          {values.length > 0 ? (
            <Badge className="h-4 min-w-4 px-1 text-[10px]" variant="muted">
              {values.length}
            </Badge>
          ) : null}
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            checked={values.includes(option)}
            key={option}
            onCheckedChange={() => onToggle(option)}
            onSelect={(event) => event.preventDefault()}
          >
            {option}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UniversalCommandSearch() {
  const navigation = useNavigation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [ordering, setOrdering] = useState("Relevance");
  const [recentSearches, setRecentSearches] = useState(RECENT_SEARCHES);
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // ISS-7493: the listener is on `window`, so what it is handed is not
      // constrained by the DOM type — see `normalizedEventKey`.
      if (
        (event.metaKey || event.ctrlKey) &&
        normalizedEventKey(event) === "k"
      ) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    const onOpenRequest = () => setOpen(true);
    globalThis.window.addEventListener("keydown", onKeyDown);
    globalThis.window.addEventListener(
      OPEN_UNIVERSAL_SEARCH_EVENT,
      onOpenRequest
    );
    return () => {
      globalThis.window.removeEventListener("keydown", onKeyDown);
      globalThis.window.removeEventListener(
        OPEN_UNIVERSAL_SEARCH_EVENT,
        onOpenRequest
      );
    };
  }, []);

  const activeFilterCount =
    filters.owner.length +
    filters.project.length +
    filters.status.length +
    filters.type.length +
    (filters.updated === "Any time" ? 0 : 1);

  const results = useMemo(() => {
    const ranked = SEARCH_TARGETS.map((target, createdIndex) => ({
      createdIndex,
      score: scoreTarget(target, query),
      target,
    })).filter(
      ({ score, target }) => score > 0 && targetMatchesFilters(target, filters)
    );

    ranked.sort((left, right) => {
      if (ordering === "Updated recently") {
        return (
          left.target.updatedDays - right.target.updatedDays ||
          right.score - left.score
        );
      }
      if (ordering === "Created recently") {
        return (
          right.createdIndex - left.createdIndex || right.score - left.score
        );
      }
      return (
        right.score - left.score ||
        left.target.updatedDays - right.target.updatedDays
      );
    });
    return ranked.map(({ target }) => target);
  }, [filters, ordering, query]);

  const toggleFilter = (key: MultiFilterKey, value: string) => {
    setFilters((current) => ({
      ...current,
      [key]: current[key].includes(value)
        ? current[key].filter((item) => item !== value)
        : [...current[key], value],
    }));
  };

  const navigate = (target: SearchTarget) => {
    const trimmedQuery = query.trim();
    if (trimmedQuery) {
      setRecentSearches((current) =>
        [
          trimmedQuery,
          ...current.filter((item) => item !== trimmedQuery),
        ].slice(0, 5)
      );
    }
    setOpen(false);
    navigation.navigate(target.href);
  };

  const showInitialState = query.trim().length === 0 && activeFilterCount === 0;

  let resultContent: ReactNode;
  if (showInitialState) {
    const recentTargets = SEARCH_TARGETS.filter((target) =>
      RECENT_TARGET_IDS.has(target.id)
    ).filter(
      (target, index, targets) =>
        targets.findIndex((candidate) => candidate.href === target.href) ===
        index
    );

    resultContent = (
      <CommandGroup heading="Recent">
        {recentTargets.map((target) => {
          const Icon = target.icon;
          return (
            <CommandItem
              className="min-h-12"
              key={`recent-${target.href}`}
              onSelect={() => navigate(target)}
              value={`recent ${target.id} ${target.label}`}
            >
              <Icon className="size-4" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{target.label}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {target.id}
                  </span>
                </div>
                <p className="truncate text-muted-foreground text-xs">
                  {target.context}
                </p>
              </div>
            </CommandItem>
          );
        })}
        {recentSearches.slice(0, 2).map((recent) => (
          <CommandItem
            key={recent}
            onSelect={() => setQuery(recent)}
            value={`recent search ${recent}`}
          >
            <SearchIcon className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{recent}</span>
            <span className="text-muted-foreground text-xs">Search again</span>
          </CommandItem>
        ))}
      </CommandGroup>
    );
  } else if (results.length === 0) {
    resultContent = (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        <SearchIcon className="size-6 text-muted-foreground" />
        <p className="font-medium text-sm">No results found</p>
        <p className="max-w-sm text-muted-foreground text-xs">
          Keep the query and broaden the search by clearing one or more filters.
        </p>
        {activeFilterCount > 0 ? (
          <Button
            className="mt-1 h-8 text-xs"
            onClick={() => setFilters(EMPTY_FILTERS)}
            variant="outline"
          >
            Clear filters
          </Button>
        ) : null}
      </div>
    );
  } else {
    const populatedCategories = CATEGORY_ORDER.map((category) => ({
      category,
      targets: results.filter((target) => target.category === category),
    })).filter(({ targets }) => targets.length > 0);

    resultContent = populatedCategories.map(
      ({ category, targets: categoryResults }, index) => {
        return (
          <div key={category}>
            {index > 0 ? <CommandSeparator /> : null}
            <CommandGroup heading={category}>
              {categoryResults.map((target) => {
                const Icon = target.icon;
                return (
                  <CommandItem
                    key={`${target.category}-${target.href}-${target.label}`}
                    onSelect={() => navigate(target)}
                    value={`${target.category} ${target.id} ${target.label}`}
                  >
                    <Icon className="size-4" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {target.label}
                        </span>
                        <span className="shrink-0 text-muted-foreground text-xs">
                          {target.id}
                        </span>
                      </div>
                      <p className="truncate text-muted-foreground text-xs">
                        {target.context}
                      </p>
                    </div>
                    <span className="hidden shrink-0 text-muted-foreground text-xs sm:inline">
                      {target.type}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </div>
        );
      }
    );
  }

  return (
    <CommandDialog
      className="top-[12%] translate-y-0 overflow-hidden sm:max-w-xl"
      commandProps={{ loop: true, shouldFilter: false }}
      description="Search artifacts, content, comments, sessions, repository paths, and definitions."
      onOpenChange={setOpen}
      open={open}
      title="Search ClosedLoop"
    >
      <CommandInput
        onValueChange={setQuery}
        placeholder="Search ClosedLoop…"
        value={query}
      />
      {filtersExpanded ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/25 px-3 py-2">
          <FilterMenu
            icon={FolderKanbanIcon}
            label="Type"
            onToggle={(value) => toggleFilter("type", value)}
            options={FILTER_OPTIONS.type}
            values={filters.type}
          />
          <FilterMenu
            icon={NavigationIcon}
            label="Project"
            onToggle={(value) => toggleFilter("project", value)}
            options={FILTER_OPTIONS.project}
            values={filters.project}
          />
          <FilterMenu
            icon={UserRoundIcon}
            label="Owner"
            onToggle={(value) => toggleFilter("owner", value)}
            options={FILTER_OPTIONS.owner}
            values={filters.owner}
          />
          <FilterMenu
            icon={SparklesIcon}
            label="Status"
            onToggle={(value) => toggleFilter("status", value)}
            options={FILTER_OPTIONS.status}
            values={filters.status}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Filter search by updated time"
                className="h-7 gap-1 px-2 text-xs"
                variant={
                  filters.updated === "Any time" ? "outline" : "secondary"
                }
              >
                <CalendarDaysIcon className="size-3.5" />
                {filters.updated === "Any time" ? "Updated" : filters.updated}
                <ChevronDownIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel>Updated</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                onValueChange={(updated) =>
                  setFilters((current) => ({ ...current, updated }))
                }
                value={filters.updated}
              >
                {UPDATED_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    {option}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            aria-label="Hide search filters"
            className="ml-auto size-7 px-0"
            onClick={() => setFiltersExpanded(false)}
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <CommandList className="max-h-[min(60vh,32rem)]">
        {resultContent}
      </CommandList>
      <div className="flex min-h-11 items-center gap-2 border-t px-3 py-2">
        <Button
          className="h-7 gap-1.5 rounded-full px-2.5 text-xs"
          onClick={() => setFiltersExpanded((current) => !current)}
          variant={activeFilterCount > 0 ? "secondary" : "ghost"}
        >
          <ListFilterIcon className="size-3.5" />
          Filters
          {activeFilterCount > 0 ? (
            <Badge className="h-4 min-w-4 px-1 text-[10px]" variant="muted">
              {activeFilterCount}
            </Badge>
          ) : null}
        </Button>
        {activeFilterCount > 0 ? (
          <Button
            className="h-7 px-2 text-xs"
            onClick={() => setFilters(EMPTY_FILTERS)}
            variant="ghost"
          >
            Clear
          </Button>
        ) : null}
        {showInitialState ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="Order search results"
                className="ml-auto h-7 gap-1 px-2 text-xs"
                variant="ghost"
              >
                <ArrowDownUpIcon className="size-3.5" />
                {ordering}
                <ChevronDownIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel>Order results</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                onValueChange={setOrdering}
                value={ordering}
              >
                {ORDER_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    {option}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </CommandDialog>
  );
}

export function UniversalCommandSearchTrigger() {
  return (
    <div className="flex items-center px-2 pt-2.5">
      <Button
        className="h-8 w-full justify-start rounded-full px-3 text-muted-foreground text-xs shadow-none"
        onClick={() =>
          globalThis.window.dispatchEvent(
            new CustomEvent(OPEN_UNIVERSAL_SEARCH_EVENT)
          )
        }
        variant="outline"
      >
        <SearchIcon className="size-3.5" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[10px]">
          ⌘K
        </kbd>
      </Button>
    </div>
  );
}
