#!/usr/bin/env node
/* Turns a password into the value PLAYER_PASSWORD_HASH holds.
 *
 * Run it, paste the line it prints into the Vercel project's environment
 * variables, and the password itself never leaves your machine — what is
 * stored cannot be turned back into it.
 *
 *   node scripts/make-password.mjs 'the password'
 */
import crypto from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error("usage: node scripts/make-password.mjs '<password>'");
  process.exit(1);
}

const ITERATIONS = 210000;            // OWASP's floor for PBKDF2-SHA256
const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");

console.log("\nPLAYER_PASSWORD_HASH=" +
  `pbkdf2$${ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`);
console.log("PLAYER_SECRET=" + crypto.randomBytes(32).toString("base64url") + "\n");
console.log("Add both to the Vercel project, then redeploy.\n");
