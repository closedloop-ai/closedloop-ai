"use client";

import { useEffect, useRef, useState } from "react";
import { type TerminalMessage, terminalBus } from "@/lib/engineer/terminal-bus";

/** How long each status message stays visible (ms). */
const DISPLAY_DURATION = 3000;
/** Delay between each character being typed (ms). */
const TYPE_SPEED = 30;
/** Delay between each character being erased (ms). */
const ERASE_SPEED = 20;

type Phase = "entering" | "visible" | "exiting" | "idle";

/**
 * Manages the terminal status queue.
 *
 * - Default: slide-up enter, hold, slide-up + fade-out exit.
 * - typewriter: types in char by char, hold, then clears instantly.
 *
 * Returns displayText, prefix, typewriter flag, and current phase.
 */
export function useTerminalStatus() {
  const [displayText, setDisplayText] = useState<string | null>(null);
  const [prefix, setPrefix] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [isTypewriter, setIsTypewriter] = useState(false);
  const [persistentMsg, setPersistentMsg] = useState<TerminalMessage | null>(
    null
  );
  const queueRef = useRef<TerminalMessage[]>([]);
  const showingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function cleanup() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    function eraseText(fullText: string) {
      setPhase("exiting");
      let charIndex = fullText.length;
      intervalRef.current = setInterval(() => {
        charIndex--;
        if (charIndex <= 0) {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          setDisplayText("");
          showNext();
        } else {
          setDisplayText(fullText.slice(0, charIndex));
        }
      }, ERASE_SPEED);
    }

    function showNext() {
      cleanup();
      const next = queueRef.current.shift();
      if (!next) {
        showingRef.current = false;
        setDisplayText(null);
        setPrefix(undefined);
        setPhase("idle");
        setIsTypewriter(false);
        return;
      }

      showingRef.current = true;
      setPrefix(next.prefix);
      setIsTypewriter(!!next.typewriter);

      if (next.typewriter) {
        // Typewriter: type in char by char
        setPhase("entering");
        setDisplayText("");
        let charIndex = 0;
        intervalRef.current = setInterval(() => {
          charIndex++;
          if (charIndex >= next.text.length) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current);
              intervalRef.current = null;
            }
            setDisplayText(next.text);
            setPhase("visible");
            // Hold, then reverse-typewrite out
            timerRef.current = setTimeout(() => {
              eraseText(next.text);
            }, DISPLAY_DURATION);
          } else {
            setDisplayText(next.text.slice(0, charIndex));
          }
        }, TYPE_SPEED);
      } else {
        // Default: show instantly, let CSS handle slide-up enter
        setDisplayText(next.text);
        setPhase("entering");
        // Brief delay to let the enter animation play, then mark visible
        timerRef.current = setTimeout(() => {
          setPhase("visible");
          // Hold, then exit
          timerRef.current = setTimeout(() => {
            setPhase("exiting");
            // Wait for exit animation to finish, then show next
            timerRef.current = setTimeout(showNext, 300);
          }, DISPLAY_DURATION);
        }, 200);
      }
    }

    const unsub = terminalBus.subscribe((message) => {
      if (message.persistId) {
        setPersistentMsg(message);
        return;
      }
      queueRef.current.push(message);

      if (!showingRef.current) {
        showNext();
      }
    });

    const unsubClear = terminalBus.onClear(() => {
      setPersistentMsg(null);
    });

    return () => {
      unsub();
      unsubClear();
      cleanup();
    };
  }, []);

  return { displayText, prefix, phase, isTypewriter, persistentMsg };
}
