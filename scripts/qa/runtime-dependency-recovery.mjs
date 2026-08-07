import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import * as amqp from "amqplib";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const rabbitUrl = process.env.RABBITMQ_URL || "amqp://lottery:lottery_dev_password@127.0.0.1:5672";
const checks = [];

function fail(message, metadata = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, checks, metadata }, null, 2));
  process.exit(1);
}

function check(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
  if (!passed) fail(name, metadata);
}

function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
  });
  if (result.status !== 0) {
    fail(`docker ${args.join(" ")} failed`, {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
    });
  }
  return result.stdout.trim();
}

async function waitFor(label, operation, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(`${label} did not recover before timeout.`, {
    error: lastError instanceof Error ? lastError.message : String(lastError ?? ""),
  });
}

async function connectRabbit() {
  const connectAttempt = async () => {
    const pending = amqp.connect(rabbitUrl, { timeout: 5_000 });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("RabbitMQ connection attempt timed out.")), 5_000);
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (error) {
      pending.then((connection) => connection.close()).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return waitFor(
    "RabbitMQ",
    connectAttempt,
    120_000
  );
}

async function queryDatabase(statement, values = []) {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000, max: 1 });
  try {
    return await pool.query(statement, values);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (!databaseUrl) fail("DATABASE_URL is required.");

const rabbitVolumeBefore = JSON.parse(docker(["volume", "inspect", "lottery-app_rabbitmq_data"]))[0];
const workerServices = [
  "outbox-dispatcher",
  "worker-critical-financial",
  "worker-settlement",
  "worker-ticket-lifecycle",
  "worker-accounting",
  "worker-commission",
  "worker-reconciliation",
  "worker-operational-access",
  "worker-reporting",
];
const workerContainersBefore = new Map(
  workerServices.map((service) => [service, docker(["compose", "ps", "-q", service])])
);
check(
  "all canonical worker containers are running before restart injection",
  [...workerContainersBefore.values()].every(Boolean)
);

const suffix = randomUUID();
const queueName = `qa.rc12.persistence.${suffix}`;
const dlqName = `${queueName}.dlq`;
const message = Buffer.from(`persistent-message:${suffix}`);
const dlqMessage = Buffer.from(`persistent-dlq:${suffix}`);
let rabbit = await connectRabbit();
let channel = await rabbit.createConfirmChannel();
await channel.assertQueue(queueName, { durable: true });
await channel.assertQueue(dlqName, { durable: true });
channel.sendToQueue(queueName, message, { persistent: true, messageId: suffix });
channel.sendToQueue(dlqName, dlqMessage, { persistent: true, messageId: `dlq:${suffix}` });
await channel.waitForConfirms();
await channel.close();
await rabbit.close();

docker(["compose", "restart", "rabbitmq"], { timeout: 180_000 });
rabbit = await connectRabbit();
channel = await rabbit.createConfirmChannel();
const recovered = await channel.get(queueName, { noAck: false });
const recoveredDlq = await channel.get(dlqName, { noAck: false });
check(
  "durable RabbitMQ queue and persistent message survive restart",
  recovered?.content.equals(message) === true
);
check(
  "durable RabbitMQ DLQ evidence survives restart",
  recoveredDlq?.content.equals(dlqMessage) === true
);
if (recovered) channel.ack(recovered);
if (recoveredDlq) channel.ack(recoveredDlq);
await channel.waitForConfirms();
await channel.deleteQueue(queueName);
await channel.deleteQueue(dlqName);
await channel.close();
await rabbit.close();

const rabbitVolumeAfter = JSON.parse(docker(["volume", "inspect", "lottery-app_rabbitmq_data"]))[0];
check(
  "RabbitMQ restart preserves the configured named volume",
  rabbitVolumeAfter.Name === rabbitVolumeBefore.Name &&
    rabbitVolumeAfter.Mountpoint === rabbitVolumeBefore.Mountpoint,
  { volume: rabbitVolumeAfter.Name }
);

const heartbeatBefore = await queryDatabase(
  "select max(last_seen_at) as last_seen_at from public.worker_heartbeats"
);
const heartbeatBoundary = heartbeatBefore.rows[0]?.last_seen_at;
check("worker heartbeat evidence exists before PostgreSQL restart", Boolean(heartbeatBoundary));
docker(["compose", "restart", "local-postgres"], { timeout: 180_000 });
await waitFor("PostgreSQL", async () => {
  const result = await queryDatabase("select 1 as ready");
  return result.rows[0]?.ready === 1;
}, 120_000);
await waitFor("worker PostgreSQL heartbeat", async () => {
  const result = await queryDatabase(
    "select count(*)::int as count from public.worker_heartbeats where last_seen_at > $1",
    [heartbeatBoundary]
  );
  return Number(result.rows[0]?.count) > 0;
}, 120_000);
check("workers reconnect to PostgreSQL and resume heartbeat persistence", true);

for (const [service, containerId] of workerContainersBefore) {
  const currentId = docker(["compose", "ps", "-q", service]);
  const running = currentId ? docker(["inspect", "-f", "{{.State.Running}}", currentId]) : "false";
  check(`${service} survives PostgreSQL restart without container replacement`, currentId === containerId && running === "true");
}

const redisKey = `qa:rc12:${suffix}`;
docker(["compose", "exec", "-T", "redis", "redis-cli", "set", redisKey, suffix]);
docker(["compose", "restart", "redis"], { timeout: 120_000 });
await waitFor("Redis", async () => {
  try {
    return docker(["compose", "exec", "-T", "redis", "redis-cli", "ping"]) === "PONG";
  } catch {
    return false;
  }
}, 90_000);
check(
  "Redis AOF state survives restart",
  docker(["compose", "exec", "-T", "redis", "redis-cli", "get", redisKey]) === suffix
);
docker(["compose", "exec", "-T", "redis", "redis-cli", "del", redisKey]);

const finalWorkerFailures = await queryDatabase(
  "select count(*)::int as count from public.worker_failures where created_at >= now() - interval '10 minutes'"
);
check("structured worker failure evidence remains queryable after dependency restarts", Number.isInteger(Number(finalWorkerFailures.rows[0]?.count)));

console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
