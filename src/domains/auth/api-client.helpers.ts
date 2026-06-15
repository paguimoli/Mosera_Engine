import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_ACCESS_TOKEN_BYTES,
  CLIENT_SECRET_BYTES,
  SESSION_HASH_ALGORITHM,
} from "./auth.constants";

const API_SECRET_HASH_PREFIX = `${SESSION_HASH_ALGORITHM}:`;
const API_CLIENT_ID_PREFIX = "api_client";

function hashOpaqueValue(value: string) {
  const digest = createHash(SESSION_HASH_ALGORITHM).update(value).digest("hex");

  return `${API_SECRET_HASH_PREFIX}${digest}`;
}

function getHashBuffer(hash: string) {
  const digest = hash.startsWith(API_SECRET_HASH_PREFIX)
    ? hash.slice(API_SECRET_HASH_PREFIX.length)
    : hash;

  if (!/^[a-f0-9]{64}$/i.test(digest)) {
    return null;
  }

  return Buffer.from(digest, "hex");
}

export function generateClientId() {
  return `${API_CLIENT_ID_PREFIX}_${randomBytes(16).toString("hex")}`;
}

export function generateClientSecret() {
  return randomBytes(CLIENT_SECRET_BYTES).toString("base64url");
}

export function hashClientSecret(clientSecret: string) {
  return hashOpaqueValue(clientSecret);
}

export function verifyClientSecret(
  clientSecret: string,
  clientSecretHash: string
) {
  if (!clientSecret || !clientSecretHash) {
    return false;
  }

  const expectedHashBuffer = getHashBuffer(hashClientSecret(clientSecret));
  const actualHashBuffer = getHashBuffer(clientSecretHash);

  if (
    !expectedHashBuffer ||
    !actualHashBuffer ||
    expectedHashBuffer.length !== actualHashBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(expectedHashBuffer, actualHashBuffer);
}

export function generateApiAccessToken() {
  return randomBytes(API_ACCESS_TOKEN_BYTES).toString("base64url");
}

export function hashApiAccessToken(accessToken: string) {
  return hashOpaqueValue(accessToken);
}
