import type { Args, ReactRenderer, StoryObj } from "@storybook/react";
import { createElement } from "react";
import type {
  ComponentAnnotations,
  DecoratorFunction,
  StoryAnnotations,
} from "storybook/internal/types";
import { combineParameters } from "storybook/preview-api";

// Surfaces (ISS-11361) arranges existing stories into the target page
// tree. One v2 page often draws on several source files (Session Detail takes
// its states from the detail view, the desktop view and the states file), so
// a v2 story cannot inherit a single source meta. `fromSource` folds the
// source meta's annotations into the story itself, in the order Storybook
// applies them: story decorators inside meta decorators, meta loaders and
// beforeEach first.
//
// The story name is NOT set here: Storybook reads names and tags from the
// source text, not at runtime, so the export name (`NoMatches` → "No
// Matches") is the name, and a planned story writes `tags: ["planned"]`
// out in its own export.

const toArray = <T,>(value: T | readonly T[] | undefined): T[] => {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? [...value] : [value as T];
};

// A source file's meta is typed for its component's props while its stories
// are typed for the merged args, and the two do not assign to each other.
// Storybook's own `composeStory(story, meta)` widens the meta for the same
// reason. This helper only re-arranges stories that are already type-checked
// in their own files, so the meta, the story and the result are widened to
// Storybook's open `Args` here.
type AnySourceMeta = ComponentAnnotations<ReactRenderer, Args>;
type AnySourceStory = StoryAnnotations<ReactRenderer, Args>;
type AnySourceDecorator = DecoratorFunction<ReactRenderer, Args>;

export function fromSource(
  meta: AnySourceMeta,
  source: AnySourceStory
): AnySourceStory {
  // The source story's own `name` is dropped so the runtime name agrees
  // with the one the sidebar reads from the v2 export, and the CSF2-only
  // `story` field (unused by CSF3 files) is dropped with it.
  const { name: _sourceName, story: _legacyStory, ...rest } = source;
  const args: Args = { ...meta.args, ...source.args };
  const component = meta.component;
  const render =
    rest.render ??
    meta.render ??
    (component ? (args: Args) => createElement(component, args) : undefined);

  return {
    ...rest,
    ...(render ? { render } : {}),
    args,
    argTypes: { ...meta.argTypes, ...source.argTypes },
    globals: { ...meta.globals, ...source.globals },
    parameters: combineParameters(
      meta.parameters ?? {},
      source.parameters ?? {}
    ),
    decorators: [
      ...toArray<AnySourceDecorator>(source.decorators),
      ...toArray<AnySourceDecorator>(meta.decorators),
    ],
    loaders: [...toArray(meta.loaders), ...toArray(source.loaders)],
    beforeEach: [...toArray(meta.beforeEach), ...toArray(source.beforeEach)],
  };
}

export type PlannedPageProps = {
  page: string;
  pageType: string;
  state: string;
  note: string;
};

export const PlannedPage = ({
  page,
  pageType,
  state,
  note,
}: PlannedPageProps) => (
  <div className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
    <p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.2em]">
      {pageType}
    </p>
    <h1 className="font-semibold text-2xl tracking-tight">
      {page} · {state}
    </h1>
    <div className="space-y-2 rounded-lg border border-dashed p-4 text-sm">
      <p className="font-medium">Planned. No story renders this yet.</p>
      <p className="text-muted-foreground">{note}</p>
    </div>
  </div>
);

// A slot in the ISS-11361 tree that nothing renders yet. Each export adds
// `tags: ["planned"]` so the sidebar's tag filter can show or hide every gap.
export function planned(props: PlannedPageProps): StoryObj {
  return {
    parameters: { controls: { disable: true } },
    render: () => <PlannedPage {...props} />,
  };
}
