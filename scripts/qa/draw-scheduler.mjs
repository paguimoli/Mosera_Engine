import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import "./load-session-env.mjs";

const appUrl = process.env.QA_APP_URL || "http://localhost:3000";
const gameEngineUrl =
  process.env.QA_GAME_ENGINE_URL ||
  (existsSync("/.dockerenv") || appUrl.includes("app:3000")
    ? "http://game-engine:8080"
    : "http://localhost:5500");
let sessionToken = process.env.QA_ADMIN_SESSION_TOKEN || process.env.OPS_ADMIN_SESSION_TOKEN;
const adminUsername = process.env.QA_ADMIN_USERNAME || "admin2";
const adminPassword = process.env.QA_ADMIN_PASSWORD || "";

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function pass(message, metadata = {}) {
  console.log(JSON.stringify({ status: "PASS", message, ...metadata }, null, 2));
}

function assert(condition, message, metadata = {}) {
  if (!condition) fail(message, metadata);
}

function run(command, args, metadata = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });

  assert(result.status === 0, `${command} ${args.join(" ")} failed.`, {
    ...metadata,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

async function ensureSessionToken() {
  if (!adminPassword) return;

  const login = await requestJson(`${appUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: adminUsername,
      password: adminPassword,
    }),
  });

  assert(login.response.status === 200 && login.body?.success === true && login.body.sessionToken, "Admin login failed.", {
    status: login.response.status,
    body: login.body,
  });

  sessionToken = login.body.sessionToken;
}

run("npm", ["run", "game-engine:build"]);
run("npm", ["run", "game-engine:test"]);
run("npm", ["run", "game-engine:draw-scheduler-test"]);

for (const path of [
  "services/game-engine/src/GameEngine.Domain/Model/DrawSchedulerModels.cs",
  "services/game-engine/src/GameEngine.Application/Services/DrawSchedulerService.cs",
  "docs/architecture/phase-22-6f-draw-scheduler-lifecycle.md",
  "docs/architecture/adr/ADR-013-draw-scheduler-owned-by-game-engine.md",
]) {
  assert(existsSync(path), "Required draw scheduler artifact missing.", { path });
}

const schedulesResult = await requestJson(`${gameEngineUrl}/api/game-engine/draw-schedules`);
assert(schedulesResult.response.status === 200 && schedulesResult.body?.success === true, "Draw schedules endpoint failed.", {
  status: schedulesResult.response.status,
  body: schedulesResult.body,
});
assert(schedulesResult.body.productionActivationEnabled === false, "Production scheduler activation must remain disabled.", {
  body: schedulesResult.body,
});
const schedules = schedulesResult.body.drawSchedules;
assert(Array.isArray(schedules) && schedules.length >= 2, "Fixed interval and daily schedules must be visible.", { schedules });

const intervalSchedule = schedules.find((schedule) => schedule.scheduleKind === "FixedInterval");
const dailySchedule = schedules.find((schedule) => schedule.scheduleKind === "FixedDailyTime");
assert(intervalSchedule, "Fixed interval schedule missing.", { schedules });
assert(dailySchedule, "Daily schedule missing.", { schedules });
assert(intervalSchedule.timeZoneId === "UTC" && dailySchedule.timeZoneId === "UTC", "Schedules must expose time-zone metadata.", {
  intervalSchedule,
  dailySchedule,
});

const scheduleDetail = await requestJson(`${gameEngineUrl}/api/game-engine/draw-schedules/${intervalSchedule.id}`);
assert(scheduleDetail.response.status === 200 && scheduleDetail.body?.success === true, "Draw schedule detail endpoint failed.", {
  status: scheduleDetail.response.status,
  body: scheduleDetail.body,
});

const previewResult = await requestJson(`${gameEngineUrl}/api/game-engine/draw-schedules/${intervalSchedule.id}/preview`, {
  method: "POST",
});
assert(previewResult.response.status === 202 && previewResult.body?.success === true, "Draw schedule preview endpoint failed.", {
  status: previewResult.response.status,
  body: previewResult.body,
});
assert(previewResult.body.mutationPerformed === false, "Schedule preview must not mutate production state.", {
  body: previewResult.body,
});
const previewDraws = previewResult.body.preview.upcomingDraws;
assert(Array.isArray(previewDraws) && previewDraws.length >= 3, "Schedule preview must include upcoming draws.", {
  preview: previewResult.body.preview,
});
assert(previewDraws.every((draw) => draw.internalGenerationEligible === false), "Future internal draws must not be generated before sales close.", {
  previewDraws,
});

const lifecycleResult = await requestJson(`${gameEngineUrl}/api/game-engine/draw-lifecycle`);
assert(lifecycleResult.response.status === 200 && lifecycleResult.body?.success === true, "Draw lifecycle endpoint failed.", {
  status: lifecycleResult.response.status,
  body: lifecycleResult.body,
});
assert(lifecycleResult.body.settlementIntegrationEnabled === false, "Settlement integration must remain disabled.", {
  body: lifecycleResult.body,
});
const lifecycle = lifecycleResult.body.drawLifecycle;
assert(Array.isArray(lifecycle) && lifecycle.length > 0, "Lifecycle diagnostics must be visible.", { lifecycle });
assert(lifecycle.every((draw) => !(draw.salesAllowed && Date.now() >= Date.parse(draw.salesCutoffAt))), "Sales must be blocked after cutoff.", {
  lifecycle,
});
assert(
  lifecycle.some((draw) => draw.resultSource === "ManualCertified" && ["AwaitingResult", "ManualReviewRequired", "Scheduled", "SalesOpen", "SalesClosed"].includes(draw.status)),
  "Official/manual draw lifecycle state must be represented.",
  { lifecycle }
);

const lifecycleDetail = await requestJson(`${gameEngineUrl}/api/game-engine/draw-lifecycle/${lifecycle[0].drawId}`);
assert(lifecycleDetail.response.status === 200 && lifecycleDetail.body?.success === true, "Lifecycle detail endpoint failed.", {
  status: lifecycleDetail.response.status,
  body: lifecycleDetail.body,
});

const markMissed = await requestJson(`${gameEngineUrl}/api/game-engine/draw-lifecycle/${lifecycle[0].drawId}/mark-missed`, {
  method: "POST",
});
assert(markMissed.response.status === 202 && markMissed.body?.success === true, "Mark missed endpoint failed.", {
  status: markMissed.response.status,
  body: markMissed.body,
});
assert(markMissed.body.productionMutationPerformed === false && markMissed.body.settlementIntegrationTriggered === false, "Mark missed must remain diagnostic-only.", {
  body: markMissed.body,
});
assert(markMissed.body.drawLifecycle.status === "ManualReviewRequired", "Mark missed must move only to manual review.", {
  body: markMissed.body,
});

const schedulerStatus = await requestJson(`${gameEngineUrl}/api/game-engine/scheduler-status`);
assert(schedulerStatus.response.status === 200 && schedulerStatus.body?.success === true, "Scheduler status endpoint failed.", {
  status: schedulerStatus.response.status,
  body: schedulerStatus.body,
});
assert(schedulerStatus.body.schedulerStatus.productionActivationEnabled === false, "Scheduler status must report production disabled.", {
  schedulerStatus: schedulerStatus.body.schedulerStatus,
});
assert(schedulerStatus.body.schedulerStatus.settlementIntegrationEnabled === false, "Scheduler status must report settlement disabled.", {
  schedulerStatus: schedulerStatus.body.schedulerStatus,
});

const randomness = await requestJson(`${gameEngineUrl}/api/game-engine/randomness`);
assert(randomness.response.status === 200 && randomness.body?.productionRngImplemented === false, "Production RNG must remain disabled.", {
  body: randomness.body,
});

const status = await requestJson(`${gameEngineUrl}/api/game-engine/status`);
assert(status.response.status === 200 && status.body?.data?.productionGameLogicEnabled === false, "Production game logic must remain disabled.", {
  body: status.body,
});
assert(status.body.data.settlementIntegrationEnabled === false, "Game Engine settlement integration must remain disabled.", {
  body: status.body,
});

await ensureSessionToken();
if (sessionToken) {
  const authority = await requestJson(`${appUrl}/api/authority/status`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert(authority.response.status === 200 && authority.body?.success === true, "Authority status failed.", {
    status: authority.response.status,
    body: authority.body,
  });
  assert(authority.body.authority.settlement.authority === "SERVICE", "Settlement authority changed.", {
    authority: authority.body.authority,
  });
  assert(authority.body.authority.ledger.authority === "SERVICE", "Ledger authority changed.", {
    authority: authority.body.authority,
  });
  assert(authority.body.authority.credit.authority === "SERVICE", "Credit authority changed.", {
    authority: authority.body.authority,
  });
}

pass("Draw scheduler and lifecycle QA completed.", {
  gameEngineUrl,
  scheduleCount: schedules.length,
  lifecycleCount: lifecycle.length,
  missedDrawCount: schedulerStatus.body.schedulerStatus.missedDrawCount,
});
