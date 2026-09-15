/* The password check, on the server.
 *
 * A gate written in the page is a sign, not a lock: the browser has to be told
 * what to compare against, and whatever it is told can be read out of the
 * source or stepped over with the console. Encrypting it there changes
 * nothing — the key has to ship too.
 *
 * So the password is never sent to the browser in any form. It is not even
 * stored here: what is stored is a PBKDF2 hash of it, and the only thing that
 * crosses the wire is the attempt, which is hashed with the same salt and
 * compared. A signed token comes back, and that is what the page keeps.
 *
 *   POST /api/gate          { password }   → { token, exp }
 *   GET  /api/gate?token=…                 → { ok, exp }
 *
 * SETUP — two environment variables on the Vercel project:
 *
 *   PLAYER_PASSWORD_HASH   generate with `node scripts/make-password.mjs`
 *   PLAYER_SECRET          any long random string; signs the tokens
 *
 * With neither set the gate stays open, so deploying this file alone locks
 * nobody out by surprise.
 */
import crypto from "node:crypto";

const TOKEN_HOURS = 12;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Cache-Control", "no-store");
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/* Constant time, so the comparison cannot be timed a character at a time.
   Lengths are compared first because timingSafeEqual throws on a mismatch,
   and that throw would itself be the giveaway. */
function sameSecret(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function verifyPassword(attempt, stored) {
  // pbkdf2$<iterations>$<salt b64>$<hash b64>
  const [scheme, iters, salt, hash] = String(stored).split("$");
  if (scheme !== "pbkdf2" || !iters || !salt || !hash) return false;
  const got = crypto.pbkdf2Sync(
    String(attempt), Buffer.from(salt, "base64"), Number(iters), 32, "sha256",
  );
  return sameSecret(got.toString("base64"), hash);
}

function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verifyToken(token, secret) {
  const [body, mac] = String(token || "").split(".");
  if (!body || !mac) return null;
  const expect = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!sameSecret(mac, expect)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const stored = process.env.PLAYER_PASSWORD_HASH || "";
  const secret = process.env.PLAYER_SECRET || "";

  /* Unconfigured means open. A half-set gate that rejects everyone is worse
     than no gate: it locks the owner out of their own player. */
  if (!stored || !secret) {
    return res.status(200).json({ ok: true, open: true, reason: "not configured" });
  }

  if (req.method === "GET") {
    const payload = verifyToken(req.query.token, secret);
    return res.status(payload ? 200 : 401).json(
      payload ? { ok: true, exp: payload.exp } : { ok: false },
    );
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const attempt = (body && body.password) || "";
  if (!attempt) return res.status(400).json({ ok: false, error: "no password" });

  if (!verifyPassword(attempt, stored)) {
    /* One second, so a script guessing cannot try thousands. Not a rate limit
       — a deterrent — and the wrong answer looks the same however it is wrong. */
    await new Promise((r) => setTimeout(r, 1000));
    return res.status(401).json({ ok: false, error: "wrong password" });
  }

  const exp = Math.floor(Date.now() / 1000) + TOKEN_HOURS * 3600;
  return res.status(200).json({ ok: true, token: sign({ exp }, secret), exp });
}
