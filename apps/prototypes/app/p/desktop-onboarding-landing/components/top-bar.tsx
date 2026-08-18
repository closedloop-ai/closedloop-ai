import { ClosedloopMark } from "./brand-icons";

/** Fixed top bar: just the brand mark and wordmark. */
export const TopBar = () => (
  <header className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-6 py-5 md:px-10">
    <ClosedloopMark className="size-7" />
    <span className="font-semibold text-lg tracking-tight">Closedloop.ai</span>
  </header>
);
