# Writing component descriptions

Every story file can carry a comment directly above `const meta`. That comment
becomes the paragraph at the top of the component's Docs page, and it is also
what the component manifest hands to an AI agent that asks what this thing is.

For most components it is the only prose anyone will ever read about them. Right
now 259 of 335 components have none at all.

```tsx
/**
 * The standard clickable control. Use it for anything that performs an action,
 * like saving a form or opening a dialog.
 */
const meta = {
  title: "Primitives/Actions/Button",
  component: Button,
```

## Who reads this

Designers, product managers, engineers who have never opened this part of the
codebase, and AI agents. Not the person who built it.

Write for someone who has never seen the component, does not know the ticket it
came from, and cannot read the source to fill in the gaps.

## What to write

**One sentence.** Roughly 100 to 170 characters, and never more than 190.

It says what the thing is and why you would reach for it, ideally naming the
nearest similar component as the contrast. That contrast is the most useful
thing you can write, because it is the one question a reader actually has:
*"there are three things that look like this, why would I pick this one?"*

> A side panel that slides in from a screen edge for filters or details,
> without interrupting the page the way a Dialog does.

That is the whole description. The prop table underneath covers the rest, and
every story below it is named for the state it shows.

### Why one sentence

An earlier pass wrote three or four. It averaged 543 characters, about seven
lines on screen, which pushed the controls below the fold on every Docs page.
Accurate, and nobody read it. A description that is skipped documents nothing.

So the gotchas, the edge cases and the "it also does X" all come out. If a
caveat genuinely has to be seen, it belongs on the story that shows it, not on
the page header.

## Plain English

Everyone reads this, not just engineering.

- Aim for the reading level of a good newspaper. Short sentences, one idea each.
- Product words like session, harness, pack, branch and compute target are fine
  to use. Write the sentence so the meaning is clear from context anyway.
- Explain any abbreviation the first time you use it.
- No em dashes or en dashes. Use a full stop, a colon, or brackets.
- No ticket numbers. "ISS-5451" tells a reader nothing.
- No words about how the code got here. Not "isolated", "extracted",
  "refactored", "now that", "this used to".
- Say "you", not "the consumer" or "the caller".

## What not to write

- **Do not restate the name.** "The Session Card is a card that shows a session"
  is a sentence that has said nothing.
- **Do not list the props.** The table underneath already does that, and it
  cannot go out of date the way your sentence can.
- **Do not describe where the file lives** or which package it is in. What a
  component is has nothing to do with where its code sits.
- **Do not describe each story.** Stories carry their own comments.

## The three failure modes already in this repo

**The tautology.** 62 components carry shadcn's stock text:

> Displays a button or a component that looks like a button.

It is true and it is useless. It tells a reader nothing they could not see, and
tells an agent nothing it could use to choose between four similar components.

**The ticket log.** 14 components carry something like:

> ISS-5451: the session provenance marker, isolated.

Written for the engineer who filed the ticket. A reader does not know what 5451
was, and "isolated" describes a refactor rather than a purpose.

**The wall.** Three or four accurate sentences that nobody finishes, and that
push the controls off the screen. This one is the easiest to write by accident,
because every sentence in it is true and worth saying. It is still wrong. Say the
one thing, and stop.

## Worked example

Take a status badge. There are several in this system, which is exactly when a
description matters.

Too little:

> Shows a status.

Aimed at the wrong reader:

> ISS-4823: the tone-driven badge, extracted from the dashboard so the variant
> system owns its colours rather than each call site restyling it.

Accurate, and too long to read:

> A small coloured label for a state like success, warning or error. Pick it by
> what the state means rather than by the colour you want, and the design system
> keeps the colours consistent everywhere. Each badge also carries a small shape
> beside the fill, so the meaning still comes through for someone who cannot
> distinguish the colours.

About right:

> A small coloured label for a state like success or error, picked by what the
> state means so the colour stays consistent everywhere it appears.

## Checking your work

Read it out loud. If it sounds like a changelog entry, a ticket title, or a
sentence that could describe forty other components, rewrite it.

Then two checks:

1. Is it one sentence, under 190 characters? `stories-have-descriptions.test.ts`
   fails the build if not.
2. Does it answer *"there are three things that look like this, why would I pick
   this one?"* If not, it is not finished, however accurate it is.
