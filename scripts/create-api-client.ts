import {
  API_CLIENT_SCOPES,
  API_CLIENT_STATUSES,
} from "../src/domains/auth/auth.constants";
import {
  generateClientId,
  generateClientSecret,
  hashClientSecret,
} from "../src/domains/auth/api-client.helpers";
import { supabaseServerAdmin } from "../src/lib/supabase/server-admin-client";

const DEFAULT_CLIENT_NAME = "Development Integration Client";
const DEVELOPMENT_SCOPES = [
  API_CLIENT_SCOPES.TICKETS_CREATE,
  API_CLIENT_SCOPES.TICKETS_READ,
  API_CLIENT_SCOPES.DRAWINGS_READ,
  API_CLIENT_SCOPES.RESULTS_READ,
  API_CLIENT_SCOPES.WALLETS_DEBIT,
  API_CLIENT_SCOPES.WALLETS_CREDIT,
  API_CLIENT_SCOPES.WALLETS_READ,
];

function getArgValue(args: string[], name: string) {
  const flagIndex = args.indexOf(name);

  if (flagIndex < 0) {
    return null;
  }

  return args[flagIndex + 1]?.trim() || null;
}

async function main() {
  const clientName =
    getArgValue(process.argv.slice(2), "--client-name") ||
    DEFAULT_CLIENT_NAME;
  const clientId = generateClientId();
  const clientSecret = generateClientSecret();
  const clientSecretHash = hashClientSecret(clientSecret);

  const { error } = await supabaseServerAdmin.from("oauth_clients").insert({
    client_id: clientId,
    client_name: clientName,
    client_secret_hash: clientSecretHash,
    status: API_CLIENT_STATUSES.ACTIVE,
    allowed_scopes: DEVELOPMENT_SCOPES,
  });

  if (error) {
    console.error("Supabase insert error:", error);
    throw new Error("Unable to create API client.");
  }

  console.log("API client created successfully.");
  console.log(`client_id: ${clientId}`);
  console.log(`client_secret: ${clientSecret}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "API client failed.");
  process.exit(1);
});
