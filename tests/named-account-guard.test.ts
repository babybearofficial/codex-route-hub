import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namedAccountIdentityReady } from "../src/named-account-guard";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(webUser: string, claims: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "route-hub-named-guard-"));
  roots.push(root);
  const coreHome = join(root, "core");
  const userData = join(root, "launcher");
  const codexHome = join(root, "desktop");
  mkdirSync(coreHome);
  mkdirSync(userData);
  mkdirSync(codexHome);
  writeFileSync(join(userData, "accounts.json"), JSON.stringify({
    activeProfileId: "default",
    profiles: [{ id: "default", accountKey: createHash("sha256").update(webUser).digest("hex") }],
  }));
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    tokens: { id_token: `header.${payload}.signature` },
  }));
  return { CODEX_ROUTE_HUB_INSTANCE: "work", CODEX_CHATGPT_WEB_HOME: coreHome, CODEX_HOME: codexHome };
}

test("default runtime is unaffected by named account checks", () => {
  expect(namedAccountIdentityReady({})).toBe(true);
});

test("named runtime accepts only the desktop account bound to its Web profile", () => {
  const claim = "https://api.openai.com/auth";
  const matching = fixture("user-work", { sub: "oauth-subject-is-different", [claim]: {
    chatgpt_user_id: "user-work", user_id: "user-work",
  } });
  const different = fixture("user-work", { sub: "user-work", [claim]: {
    chatgpt_user_id: "user-personal", user_id: "user-personal",
  } });
  expect(namedAccountIdentityReady(matching)).toBe(true);
  expect(namedAccountIdentityReady(different)).toBe(false);
  rmSync(join(matching.CODEX_HOME, "auth.json"));
  expect(namedAccountIdentityReady(matching)).toBe(false);
});

test("named runtime accepts a matching fallback user_id but never OAuth sub alone", () => {
  expect(namedAccountIdentityReady(fixture("user-work", {
    sub: "different-oauth-subject", "https://api.openai.com/auth": { user_id: "user-work" },
  }))).toBe(true);
  expect(namedAccountIdentityReady(fixture("user-work", { sub: "user-work" }))).toBe(false);
});

test("named runtime rejects missing, malformed, or conflicting ChatGPT user claims", () => {
  const claim = "https://api.openai.com/auth";
  expect(namedAccountIdentityReady(fixture("user-work", {}))).toBe(false);
  expect(namedAccountIdentityReady(fixture("user-work", { [claim]: {} }))).toBe(false);
  expect(namedAccountIdentityReady(fixture("user-work", { [claim]: { chatgpt_user_id: "" } }))).toBe(false);
  expect(namedAccountIdentityReady(fixture("user-work", { [claim]: { chatgpt_user_id: 123 } }))).toBe(false);
  expect(namedAccountIdentityReady(fixture("user-work", {
    [claim]: { chatgpt_user_id: "user-work", user_id: "user-other" },
  }))).toBe(false);
});
