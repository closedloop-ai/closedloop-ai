import type { Page } from "@playwright/test";

export const CONTROL_STABILITY_ATTRIBUTE = "data-e2e-stable";
const stableValue = "yes";

/** Observe identity during an existing wait; any intervening removal or mutation refuses reuse. */
export async function observeControlIdentity(
  page: Pick<Page, "evaluateHandle">,
  label: string
) {
  const observation = await page.evaluateHandle(
    createControlIdentityObservation,
    { name: label, attribute: CONTROL_STABILITY_ATTRIBUTE, value: stableValue }
  );
  return {
    finish: () => observation.evaluate((state) => state.finish()),
    async dispose() {
      try {
        await observation.evaluate((state) => state.dispose());
      } finally {
        await observation.dispose();
      }
    },
  };
}

/** Serializable DOM owner shared by the real Page adapter and lifecycle tests. */
export function createControlIdentityObservation({
  name,
  attribute,
  value,
}: {
  name: string;
  attribute: string;
  value: string;
}) {
  const findControl = () =>
    Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === name
    );
  const node = findControl();
  let invalidated = node === undefined || !node.isConnected;
  const inspect = (records: MutationRecord[]) => {
    for (const record of records) {
      const target = record.target;
      const touchesNode =
        node !== undefined &&
        (target === node || node.contains(target) || target.contains(node));
      const removedNode =
        node !== undefined &&
        Array.from(record.removedNodes).some(
          (removed) => removed === node || removed.contains(node)
        );
      if (
        (record.type !== "childList" && touchesNode) ||
        removedNode ||
        (record.type === "childList" &&
          node !== undefined &&
          node.contains(target))
      ) {
        invalidated = true;
      }
    }
  };
  const observer = new MutationObserver(inspect);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    finish() {
      inspect(observer.takeRecords());
      observer.disconnect();
      const retained =
        !invalidated &&
        node !== undefined &&
        node.isConnected &&
        findControl() === node;
      if (retained) {
        node.setAttribute(attribute, value);
      } else if (node !== undefined) {
        node.removeAttribute(attribute);
      }
      return retained;
    },
    dispose() {
      observer.disconnect();
    },
  };
}
