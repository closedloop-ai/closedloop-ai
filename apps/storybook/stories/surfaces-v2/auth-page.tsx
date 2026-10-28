import { useClerk, useSignIn } from "@repo/auth/client";
import type { Decorator } from "@storybook/react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import AuthLayout from "@/app/(unauthenticated)/layout";

/**
 * A Surfaces auth screen: the live route's page inside the live
 * `(unauthenticated)/layout.tsx` (the two-pane auth layout: wordmark and the
 * page on the left, the product showcase on the right). These screens are
 * outside the authenticated shell, so there is no Global Nav.
 *
 * The layout's brand images are root paths (`/logo.svg`, ...) served from
 * `apps/app/public`, which this Storybook mounts at `/app-public` (see
 * `staticDirs` in `.storybook/main.ts`), so their URLs are re-pointed there
 * once rendered. Nothing else about the layout is touched.
 */
export function AuthPage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    for (const image of ref.current?.querySelectorAll("img") ?? []) {
      for (const attribute of ["src", "srcset"]) {
        const value = image.getAttribute(attribute);
        if (value) {
          image.setAttribute(
            attribute,
            value.replace(/(^|\s|,)\/(?!app-public\/)/g, "$1/app-public/")
          );
        }
      }
    }
  });
  return (
    <div className="contents" ref={ref}>
      <AuthLayout>{children}</AuthLayout>
    </div>
  );
}

type ClerkState = {
  /** `false`: Clerk's script has not finished loading. */
  loaded?: boolean;
  /** `"error"`: Clerk reported a load failure. */
  status?: string;
  /** `true`: nobody is signed in. */
  signedOut?: boolean;
  /** How the redirect sign-in `signIn.sso(...)` answers. */
  sso?: () => Promise<unknown>;
  /** Fields of the signed-in user (`externalAccounts`, ...). */
  user?: Record<string, unknown>;
};

type Mutable = Record<string, unknown>;

/** The stand-in's objects are plain records; this is how a story edits one. */
function asMutable(value: object): Mutable {
  return value as Mutable;
}

/**
 * Puts Storybook's Clerk stand-in in the state an auth screen meets, for the
 * life of the story, and puts every touched field back on unmount so the next
 * story sees the default signed-in Clerk.
 */
function ClerkStateScope({
  state,
  children,
}: {
  state: ClerkState;
  children: ReactNode;
}) {
  const clerk = asMutable(useClerk());
  const signIn = asMutable(useSignIn().signIn ?? {});
  const [restore] = useState(() => {
    const undo: Array<() => void> = [];
    const set = (target: Mutable, key: string, value: unknown) => {
      const had = Object.hasOwn(target, key);
      const previous = target[key];
      target[key] = value;
      undo.push(() => {
        if (had) {
          target[key] = previous;
        } else {
          delete target[key];
        }
      });
    };
    if (state.loaded !== undefined) {
      set(clerk, "loaded", state.loaded);
    }
    if (state.status !== undefined) {
      set(clerk, "status", state.status);
    }
    if (state.sso) {
      set(signIn, "sso", state.sso);
    }
    if (state.signedOut) {
      set(clerk, "user", null);
    } else if (state.user) {
      set(clerk, "user", { ...(clerk.user as Mutable), ...state.user });
    }
    return () => {
      for (const step of undo.reverse()) {
        step();
      }
    };
  });
  useEffect(() => restore, [restore]);
  return <>{children}</>;
}

export function withClerkState(state: ClerkState): Decorator {
  return (Story) => (
    <ClerkStateScope state={state}>
      <Story />
    </ClerkStateScope>
  );
}

/**
 * Fires the screen's own timers with these exact delays at once, so a story
 * shows the state the live screen reaches after waiting that long (a stalled
 * redirect, an unanswered request). Other timers are untouched.
 */
function FastForwardScope({
  delays,
  children,
}: {
  delays: readonly number[];
  children: ReactNode;
}) {
  const [restore] = useState(() => {
    const original = globalThis.setTimeout;
    const patched = ((
      handler: TimerHandler,
      timeout?: number,
      ...rest: unknown[]
    ) =>
      original(
        handler,
        timeout !== undefined && delays.includes(timeout) ? 0 : timeout,
        ...rest
      )) as typeof setTimeout;
    globalThis.setTimeout = patched;
    return () => {
      if (globalThis.setTimeout === patched) {
        globalThis.setTimeout = original;
      }
    };
  });
  useEffect(() => restore, [restore]);
  return <>{children}</>;
}

export function withFastForward(delays: readonly number[]): Decorator {
  return (Story) => (
    <FastForwardScope delays={delays}>
      <Story />
    </FastForwardScope>
  );
}

/** A request that never answers: the live screen is still waiting on it. */
export function pending(): Promise<never> {
  return new Promise<never>(() => {
    // Never settles.
  });
}
