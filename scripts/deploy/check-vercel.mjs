import { writeFile } from "node:fs/promises";

const token = process.env.VERCEL_TOKEN;
const projectIdsRaw = process.env.VERCEL_PROJECT_IDS;
const teamId = process.env.VERCEL_TEAM_ID;
const target = process.env.VERCEL_TARGET || "production";
const sha = process.env.DEPLOY_SHA;
const timeoutSeconds = Number(process.env.VERCEL_TIMEOUT_SECONDS || 1200);
const intervalSeconds = Number(process.env.VERCEL_POLL_INTERVAL_SECONDS || 20);
const fetchLimitRaw = Number(process.env.VERCEL_FETCH_LIMIT || 20);
const fetchLimit = Number.isFinite(fetchLimitRaw) && fetchLimitRaw > 0 ? fetchLimitRaw : 20;
const outputPath = process.env.VERCEL_STATUS_PATH || "vercel-status.json";

if (!token) {
  throw new Error("VERCEL_TOKEN is required to check deployment status.");
}

if (!projectIdsRaw) {
  throw new Error("VERCEL_PROJECT_IDS is required to check deployment status.");
}

if (!sha) {
  throw new Error("DEPLOY_SHA is required to check deployment status.");
}

const projectIds = projectIdsRaw
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

if (projectIds.length === 0) {
  throw new Error("VERCEL_PROJECT_IDS must contain at least one project ID.");
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
};

async function fetchLatestDeployment(projectId) {
  const params = new URLSearchParams({
    projectId,
    target,
    limit: String(fetchLimit),
  });

  if (teamId) {
    params.set("teamId", teamId);
  }

  const response = await fetch(
    `https://api.vercel.com/v6/deployments?${params.toString()}`,
    { headers }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Vercel API error (${projectId}): ${response.status} ${text}`
    );
  }

  const data = await response.json();
  const deployments = Array.isArray(data.deployments) ? data.deployments : [];

  // Find deployment matching our SHA - don't fall back to unrelated deployments
  return deployments.find((d) => d.meta?.githubCommitSha === sha) ?? null;
}

function isSuccessState(state) {
  return state === "READY";
}

function isErrorState(state) {
  return state === "ERROR" || state === "CANCELED";
}

const deadline = Date.now() + timeoutSeconds * 1000;
const results = new Map();

console.log(`Waiting for Vercel deployments for SHA: ${sha}`);
console.log(`Projects: ${projectIds.join(", ")}`);
console.log(`Timeout: ${timeoutSeconds}s, Poll interval: ${intervalSeconds}s`);
console.log(`Fetch limit: ${fetchLimit}`);

let iteration = 0;
while (Date.now() < deadline) {
  iteration++;
  console.log(`\n--- Poll iteration ${iteration} ---`);

  await Promise.all(projectIds.map(async (projectId) => {
    if (results.get(projectId)?.done) {
      return;
    }

    let deployment;
    try {
      deployment = await fetchLatestDeployment(projectId);
    } catch (error) {
      console.log(`${projectId}: API error while fetching deployment (${error.message || error})`);
      results.set(projectId, {
        projectId,
        status: "ERROR",
        error: error.message || String(error),
        done: true,
        failed: true,
      });
      return;
    }
    if (!deployment) {
      console.log(`${projectId}: PENDING (no deployment yet)`);
      results.set(projectId, {
        projectId,
        status: "PENDING",
        message: "Waiting for deployment to start...",
      });
      return;
    }

    const state = deployment.readyState || deployment.state;
    const url = deployment.url ? `https://${deployment.url}` : deployment.url;

    if (isSuccessState(state)) {
      console.log(`${projectId}: READY - ${url}`);
      results.set(projectId, {
        projectId,
        status: "READY",
        url,
        deploymentId: deployment.uid,
        done: true,
      });
      return;
    }

    if (isErrorState(state)) {
      console.log(`${projectId}: ${state}`);
      results.set(projectId, {
        projectId,
        status: state,
        url,
        deploymentId: deployment.uid,
        error: deployment.errorMessage || deployment.error,
        done: true,
        failed: true,
      });
      return;
    }

    console.log(`${projectId}: ${state || "BUILDING"}...`);
    results.set(projectId, {
      projectId,
      status: state || "BUILDING",
      url,
      deploymentId: deployment.uid,
      message: "Deployment in progress",
    });
  }));

  const allReady = projectIds.every((id) => results.get(id)?.status === "READY");
  const anyFailed = projectIds.some((id) => results.get(id)?.failed);

  if (allReady) {
    console.log("\nAll deployments ready!");
    break;
  }

  if (anyFailed) {
    console.log("\nOne or more deployments failed, stopping early.");
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
}

for (const projectId of projectIds) {
  const current = results.get(projectId);
  if (!current || current.status === "PENDING") {
    results.set(projectId, {
      projectId,
      status: "NOT_FOUND",
      error: `No deployment found for SHA ${sha} within ${timeoutSeconds}s`,
      done: true,
      failed: true,
    });
    continue;
  }

  if (current.status !== "READY" && !current.failed) {
    results.set(projectId, {
      ...current,
      status: current.status || "TIMEOUT",
      error: `Timed out waiting for deployment to reach READY within ${timeoutSeconds}s`,
      done: true,
      failed: true,
    });
  }
}

const summary = {
  ok: projectIds.every((id) => results.get(id)?.status === "READY"),
  deployments: projectIds.map((id) => results.get(id)),
};

await writeFile(outputPath, JSON.stringify(summary, null, 2));

console.log(`\n--- Final Status (after ${iteration} iterations) ---`);
for (const d of summary.deployments) {
  console.log(`${d.projectId}: ${d.status}${d.url ? ` - ${d.url}` : ""}${d.error ? ` (${d.error})` : ""}`);
}

if (!summary.ok) {
  console.error("\nDeployment verification failed.");
  process.exit(1);
}

console.log("\nAll deployments verified successfully!");
