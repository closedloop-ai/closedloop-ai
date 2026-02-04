import { writeFile } from "node:fs/promises";

const token = process.env.VERCEL_TOKEN;
const projectIdsRaw = process.env.VERCEL_PROJECT_IDS;
const teamId = process.env.VERCEL_TEAM_ID;
const target = process.env.VERCEL_TARGET || "production";
const sha = process.env.DEPLOY_SHA;
const timeoutSeconds = Number(process.env.VERCEL_TIMEOUT_SECONDS || 1200);
const intervalSeconds = Number(process.env.VERCEL_POLL_INTERVAL_SECONDS || 20);
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
    limit: "5",
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

while (Date.now() < deadline) {
  for (const projectId of projectIds) {
    if (results.get(projectId)?.done) {
      continue;
    }

    const deployment = await fetchLatestDeployment(projectId);
    if (!deployment) {
      results.set(projectId, {
        projectId,
        status: "PENDING",
        message: "Waiting for deployment to start...",
      });
      continue;
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
      continue;
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
      continue;
    }

    console.log(`${projectId}: ${state || "BUILDING"}...`);
    results.set(projectId, {
      projectId,
      status: state || "BUILDING",
      url,
      deploymentId: deployment.uid,
      message: "Deployment in progress",
    });
  }

  const allDone = projectIds.every(
    (id) => results.get(id)?.status === "READY" || results.get(id)?.failed
  );
  const anyFailed = projectIds.some((id) => results.get(id)?.failed);

  if (allDone) {
    break;
  }

  if (anyFailed) {
    console.log("One or more deployments failed.");
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
}

const summary = {
  ok: projectIds.every((id) => results.get(id)?.status === "READY"),
  deployments: projectIds.map((id) => results.get(id)),
};

await writeFile(outputPath, JSON.stringify(summary, null, 2));

if (!summary.ok) {
  console.error("Deployment verification failed.");
  process.exit(1);
}

console.log("All deployments ready!");
