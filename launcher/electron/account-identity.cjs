const fs = require("node:fs");
const path = require("node:path");
const { createHash, timingSafeEqual } = require("node:crypto");

function authAccountKey(codexHome) {
  const authFile = path.join(codexHome, "auth.json");
  if (!fs.existsSync(authFile)) throw new Error("Codex account is not signed in in its isolated home");
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const token = auth?.tokens?.id_token;
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new Error("Codex login has no ChatGPT account identity token");
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { throw new Error("Codex account identity token is invalid"); }
  const openaiAuth = claims?.["https://api.openai.com/auth"];
  const chatgptUserId = openaiAuth?.chatgpt_user_id;
  const userId = openaiAuth?.user_id;
  if (chatgptUserId !== undefined && (typeof chatgptUserId !== "string" || !chatgptUserId.trim())) {
    throw new Error("Codex login has an invalid ChatGPT user identity claim");
  }
  if (userId !== undefined && (typeof userId !== "string" || !userId.trim())) {
    throw new Error("Codex login has an invalid ChatGPT user identity claim");
  }
  if (chatgptUserId !== undefined && userId !== undefined && chatgptUserId !== userId) {
    throw new Error("Codex login has conflicting ChatGPT user identity claims");
  }
  const identity = chatgptUserId ?? userId;
  if (typeof identity !== "string" || !identity) {
    throw new Error("Codex login has no ChatGPT user identity claim");
  }
  return createHash("sha256").update(identity).digest("hex");
}

function assertMatchingAccount(codexHome, expectedAccountKey, label = "Codex") {
  if (typeof expectedAccountKey !== "string" || !/^[a-f0-9]{64}$/.test(expectedAccountKey)) {
    throw new Error("Verify this instance's ChatGPT Web account before enabling routing");
  }
  const actual = Buffer.from(authAccountKey(codexHome), "hex");
  const expected = Buffer.from(expectedAccountKey, "hex");
  if (!timingSafeEqual(actual, expected)) {
    throw new Error(`${label} login belongs to a different ChatGPT account than this Route Hub instance`);
  }
  return true;
}

module.exports = { assertMatchingAccount, authAccountKey };
