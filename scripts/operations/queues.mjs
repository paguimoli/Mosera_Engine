const appUrl = process.env.OPS_APP_URL || process.env.QA_APP_URL || "http://localhost:3000";
const sessionToken =
  process.env.OPS_ADMIN_SESSION_TOKEN || process.env.QA_ADMIN_SESSION_TOKEN;

function fail(message, metadata = {}) {
  console.error(message);

  for (const [key, value] of Object.entries(metadata)) {
    console.error(`${key}: ${value}`);
  }

  process.exit(1);
}

async function main() {
  if (!sessionToken) fail("OPS_ADMIN_SESSION_TOKEN or QA_ADMIN_SESSION_TOKEN is required.");

  const response = await fetch(`${appUrl}/api/operations/queues`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.success) {
    fail("Queue observability endpoint failed.", {
      status: response.status,
      error: payload.error ?? "unknown",
    });
  }

  const { queues } = payload;

  console.log(`generatedAt: ${queues.generatedAt}`);
  console.log(`exchange: ${queues.exchange}`);

  for (const queue of queues.rabbitmq) {
    console.log(
      [
        queue.category,
        `status=${queue.status}`,
        `queue=${queue.queueName}`,
        `ready=${queue.messagesReady ?? "unavailable"}`,
        `unacked=${queue.messagesUnacked ?? "unavailable"}`,
        `consumers=${queue.consumerCount ?? "unavailable"}`,
        `dlqReady=${queue.deadLetterMessagesReady ?? "unavailable"}`,
      ].join(" ")
    );
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Queue observability failed.");
});
