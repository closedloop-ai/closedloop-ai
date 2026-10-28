#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  branchesListPlayResult,
  verifyBranchesListStories,
} from "./branches-list-play-result.mjs";

const storybookDir = fileURLToPath(new URL("..", import.meta.url));
const storyFile = "v2-branches-list.stories.tsx";
const narrowStoryIds = new Set([
  "surfaces-artifacts-branches-branches-list--narrow",
  "surfaces-artifacts-branches-branches-list--preview-adapter-narrow",
]);
const expectedStories = 25;
const startupTimeoutMs = 120_000;
const playTimeoutMs = 45_000;

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a local Storybook port");
  }
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForIndex(url, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (output.error) {
      throw output.error;
    }
    if (child.exitCode !== null) {
      throw new Error(`Storybook exited ${child.exitCode}: ${output.value}`);
    }
    try {
      const response = await fetch(`${url}/index.json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Storybook is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Storybook index timed out: ${output.value}`);
}

async function verifyStory(browser, url, story) {
  const viewport = narrowStoryIds.has(story.id)
    ? { width: 390, height: 844 }
    : { width: 1280, height: 720 };
  const page = await browser.newPage({
    viewport,
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.addInitScript(() => {
      const events = [];
      Object.defineProperty(window, "__branchesListPlayEvents", {
        value: events,
      });
      let preview;
      Object.defineProperty(window, "__STORYBOOK_PREVIEW__", {
        configurable: true,
        get: () => preview,
        set: (value) => {
          preview = value;
          const channel = value.channel;
          channel.on("playFunctionThrewException", (error) => {
            events.push({
              type: "playFunctionThrewException",
              message: String(error?.message ?? error).split("\n")[0],
            });
          });
          channel.on("unhandledErrorsWhilePlaying", (errors) => {
            events.push({
              type: "unhandledErrorsWhilePlaying",
              message: JSON.stringify(errors),
            });
          });
          channel.on("storyThrewException", (error) => {
            events.push({
              type: "storyThrewException",
              message: String(error?.message ?? error).split("\n")[0],
            });
          });
          channel.on("storyFinished", (result) => {
            events.push({ type: "storyFinished", ...result });
          });
        },
      });
    });
    await page.goto(`${url}/iframe.html?id=${story.id}&viewMode=story`, {
      waitUntil: "domcontentloaded",
      timeout: playTimeoutMs,
    });
    await page.waitForFunction(
      (storyId) =>
        window.__branchesListPlayEvents?.some(
          (event) => event.type === "storyFinished" && event.storyId === storyId
        ),
      story.id,
      { timeout: playTimeoutMs }
    );
    const events = await page.evaluate(() => window.__branchesListPlayEvents);
    const hasPlay = await page.evaluate(async (storyId) => {
      const story =
        await window.__STORYBOOK_PREVIEW__.storyStoreValue.loadStory({
          storyId,
        });
      return typeof story.playFunction === "function";
    }, story.id);
    if (!hasPlay) {
      return { passed: false, reason: "exported story has no play function" };
    }
    const result = branchesListPlayResult(events, story.id);
    if (pageErrors.length > 0) {
      return { passed: false, reason: `pageerror: ${pageErrors.join("; ")}` };
    }
    return result;
  } finally {
    await page.close();
  }
}

async function main() {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const output = { value: "", error: null };
  const child = spawn(
    "pnpm",
    [
      "exec",
      "storybook",
      "dev",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--ci",
      "--no-open",
      "--exact-port",
      "--disable-telemetry",
    ],
    { cwd: storybookDir, detached: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  child.once("error", (error) => {
    output.error = error;
    output.value = error.message;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.value = `${output.value}${chunk}`.slice(-4000);
    });
  }
  let browser;
  try {
    const index = await waitForIndex(url, child, output);
    const stories = Object.values(index.entries).filter(
      (entry) => entry.type === "story" && entry.importPath.endsWith(storyFile)
    );
    if (stories.length !== expectedStories) {
      throw new Error(
        `Expected ${expectedStories} Branches list stories; index has ${stories.length}`
      );
    }
    browser = await chromium.launch({ headless: true });
    const failures = await verifyBranchesListStories(
      stories,
      (story) => verifyStory(browser, url, story),
      (story, result) => {
        process.stdout.write(
          `${result.passed ? "PASS" : "FAIL"} ${story.id}${result.reason ? `: ${result.reason}` : ""}\n`
        );
      }
    );
    if (failures.length > 0) {
      throw new Error(`${failures.length}/${stories.length} plays failed`);
    }
    process.stdout.write(
      `PASS ${stories.length} exception-free Branches list plays\n`
    );
  } finally {
    await browser?.close();
    if (child.pid > 1) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") {
          process.stderr.write(`Could not stop Storybook: ${error}\n`);
          process.exitCode = 1;
        }
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
