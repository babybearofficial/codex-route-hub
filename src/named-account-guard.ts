import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** Fail closed if a named desktop clone no longer has the Web account bound to its Hub. */
export function namedAccountIdentityReady(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.CODEX_ROUTE_HUB_INSTANCE?.trim()) return true;
  const coreHome = env.CODEX_CHATGPT_WEB_HOME;
  const codexHome = env.CODEX_HOME;
  if (!coreHome || !codexHome || !isAbsolute(coreHome) || !isAbsolute(codexHome)) return false;
  try {
    const registry = JSON.parse(readFileSync(join(dirname(coreHome), "launcher", "accounts.json"), "utf8")) as {
      activeProfileId?: unknown;
      profiles?: Array<{ id?: unknown; accountKey?: unknown }>;
    };
    if (!Array.isArray(registry.profiles) || registry.profiles.length !== 1) return false;
    const account = registry.profiles[0];
    if (account.id !== registry.activeProfileId
      || typeof account.accountKey !== "string"
      || !/^[a-f0-9]{64}$/.test(account.accountKey)) return false;
    const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as {
      tokens?: { id_token?: unknown };
    };
    const token = auth.tokens?.id_token;
    if (typeof token !== "string" || token.split(".").length !== 3) return false;
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const openaiAuth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const primary = openaiAuth?.chatgpt_user_id;
    const fallback = openaiAuth?.user_id;
    if (typeof primary === "string" && primary
      && typeof fallback === "string" && fallback && primary !== fallback) return false;
    const chatgptUserId = typeof primary === "string" && primary ? primary : fallback;
    if (typeof chatgptUserId !== "string" || !chatgptUserId) return false;
    const actual = createHash("sha256").update(chatgptUserId).digest();
    return timingSafeEqual(actual, Buffer.from(account.accountKey, "hex"));
  } catch {
    return false;
  }
}
