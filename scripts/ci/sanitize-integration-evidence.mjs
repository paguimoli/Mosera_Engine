import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const evidenceRoot =
  process.env.INTEGRATION_EVIDENCE_DIR ??
  path.join(process.env.RUNNER_TEMP ?? "/tmp", "mosera-integration-evidence");

const secretNames = [
  "DATABASE_URL",
  "LOCAL_DATABASE_URL",
  "RABBITMQ_URL",
  "REDIS_URL",
  "RABBITMQ_DIAGNOSTIC_PASSWORD",
  "CREDIT_WALLET_INTERNAL_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];

const literalSecrets = secretNames
  .map((name) => process.env[name])
  .filter((value) => typeof value === "string" && value.length >= 8)
  .sort((left, right) => right.length - left.length);

const secretKeyPattern =
  /("(?:accessToken|refreshToken|sessionToken|clientSecret|password|authorization|signatureValue|privateKey|seed)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
const connectionCredentialPattern = /\b(postgresql|postgres|amqps?|rediss?):\/\/[^@\s/"']+@/gi;
const bearerPattern = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;

function redact(content) {
  let sanitized = content;

  for (const secret of literalSecrets) {
    sanitized = sanitized.split(secret).join("[REDACTED]");
  }

  return sanitized
    .replace(secretKeyPattern, '$1"[REDACTED]"')
    .replace(connectionCredentialPattern, "$1://[REDACTED]@")
    .replace(bearerPattern, "$1[REDACTED]");
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

for (const file of await filesUnder(evidenceRoot)) {
  const content = await readFile(file, "utf8").catch(() => null);
  if (content !== null) {
    await writeFile(file, redact(content), "utf8");
  }
}
