/**
 * Shared mock HTTP server factory for relay suites that need to prevent
 * startRelayServer() from binding a real port.
 *
 * Use inside vi.mock("node:http", ...) to avoid EADDRINUSE across test reloads.
 * Named without ".test" so vitest does not collect it as a suite.
 */

import { vi } from "vitest";

type Listener = (...args: unknown[]) => void;

export type MockHttpServer = {
  listening: boolean;
  listen: () => MockHttpServer;
  close: (cb?: () => void) => MockHttpServer;
  on: (evt: string, fn: Listener) => MockHttpServer;
  once: (evt: string, fn: Listener) => MockHttpServer;
  off: (evt: string, fn: Listener) => MockHttpServer;
  /**
   * Test-only: dispatch to the listeners currently registered for `evt` and
   * report how many ran. Lets a suite drive a server event (e.g. a post-bind
   * "error") instead of only asserting that a listener was registered.
   */
  emitServerEvent: (evt: string, ...args: unknown[]) => number;
};

export function createMockHttpServerFactory(): () => MockHttpServer {
  return () => {
    const listeners = new Map<string, Set<Listener>>();
    const addListener = (evt: string, fn: Listener) => {
      let set = listeners.get(evt);
      if (!set) {
        set = new Set();
        listeners.set(evt, set);
      }
      set.add(fn);
    };
    const mockServer: MockHttpServer = {
      listening: false,
      listen: vi.fn(function listen() {
        mockServer.listening = true;
        // Emit "listening" on next tick so the Promise in startRelayServer resolves.
        queueMicrotask(() => {
          for (const fn of listeners.get("listening") ?? []) {
            fn();
          }
        });
        return mockServer;
      }),
      close: vi.fn((cb?: () => void) => {
        mockServer.listening = false;
        cb?.();
        return mockServer;
      }),
      on: vi.fn((evt: string, fn: Listener) => {
        addListener(evt, fn);
        return mockServer;
      }),
      once: vi.fn((evt: string, fn: Listener) => {
        const wrapper: Listener = (...args) => {
          listeners.get(evt)?.delete(wrapper);
          fn(...args);
        };
        addListener(evt, wrapper);
        return mockServer;
      }),
      off: vi.fn((evt: string, fn: Listener) => {
        listeners.get(evt)?.delete(fn);
        return mockServer;
      }),
      emitServerEvent: (evt: string, ...args: unknown[]) => {
        const registered = [...(listeners.get(evt) ?? [])];
        for (const fn of registered) {
          fn(...args);
        }
        return registered.length;
      },
    };
    return mockServer;
  };
}
