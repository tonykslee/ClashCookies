#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const broker = require("./rootful-deployment-broker");

const required = [
  "BROKER_PRIVATE_KEY", "BROKER_KEY_ID", "BROKER_APPROVED_BY", "BROKER_NONCE",
  "BROKER_SCOPE",
  "BROKER_REVIEWED_COMMIT", "BROKER_SESSION_ID", "BROKER_RELEASE_ID", "BROKER_OLD_SHA",
  "BROKER_NEW_SHA", "BROKER_MIGRATION_DIFF_DIGEST", "BROKER_MIGRATION_MANIFEST_DIGEST",
  "BROKER_AUTHORIZATION_DIGEST",
];
for (const name of required) {
  if (typeof process.env[name] !== "string" || process.env[name].length === 0) {
    throw new Error(`missing_${name.toLowerCase()}`);
  }
}
if (!broker.BROKER_APPROVAL_SCOPES.includes(process.env.BROKER_SCOPE)) {
  throw new Error("invalid_broker_scope");
}

const release = {
  sessionId: process.env.BROKER_SESSION_ID,
  releaseId: process.env.BROKER_RELEASE_ID,
  oldSha: process.env.BROKER_OLD_SHA,
  newSha: process.env.BROKER_NEW_SHA,
  migrationDiffDigest: process.env.BROKER_MIGRATION_DIFF_DIGEST,
  migrationManifestDigest: process.env.BROKER_MIGRATION_MANIFEST_DIGEST,
  authorizationDigest: process.env.BROKER_AUTHORIZATION_DIGEST,
  approvedBy: process.env.BROKER_APPROVED_BY,
};
const approval = {
  keyId: process.env.BROKER_KEY_ID,
  nonce: process.env.BROKER_NONCE,
  scope: process.env.BROKER_SCOPE,
  approvedBy: process.env.BROKER_APPROVED_BY,
  reviewedCommit: process.env.BROKER_REVIEWED_COMMIT,
};
const privateKey = crypto.createPrivateKey(process.env.BROKER_PRIVATE_KEY);
const signature = crypto.sign(
  null,
  Buffer.from(broker.approvalPayload(approval, release)),
  privateKey,
).toString("base64");

process.stdout.write(JSON.stringify({ ...approval, signature }));
