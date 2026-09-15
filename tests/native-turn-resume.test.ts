import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNativeInterruptedTurnResume } from "../src/adapters/chatgpt-web/codex-rollout-environment";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";

const threadId = "01a0a367-f29a-7dc3-8a11-3f2591a7d56a";
const oldTurn = "01a0a367-f789-7f43-a9ab-49a9c78444e5";
const turnId = "01a0a37d-d642-7952-bc7f-a4d2decce253";
const message = { type: "message", role: "user", id: "msg_original", content: [{ type: "input_text", text: "Audit the project" }], internal_chat_message_metadata_passthrough: { turn_id: oldTurn, content_item_kinds: ["user.text"] } };
const source = { itemId: message.id, content: message.content, turnId: oldTurn };
const event = (type: string, turn_id: string) => ({ type: "event_msg", payload: { type, turn_id } });
const records = () => [
  { type: "session_meta", payload: { id: threadId, source: "vscode" } },
  event("task_started", oldTurn),
  { type: "response_item", payload: message },
  { type: "response_item", payload: { ...message, id: "abort", content: [{ type: "input_text", text: "<turn_aborted>Interrupted</turn_aborted>" }], internal_chat_message_metadata_passthrough: { turn_id: oldTurn, content_item_kinds: ["generic.turn_aborted"] } } },
  event("turn_aborted", oldTurn), event("task_started", turnId),
  { type: "turn_context", payload: { turn_id: turnId } },
];
function fixture(run: (home: string, write: (rows: unknown[]) => void) => void) {
  const home = mkdtempSync(join(tmpdir(), "route-resume-"));
  mkdirSync(join(home, "sessions", "2026", "09", "15"), { recursive: true });
  const file = join(home, "sessions", "2026", "09", "15", `rollout-2026-09-15T12-51-33-${threadId}.jsonl`);
  const write = (rows: unknown[]) => writeFileSync(file, rows.map(x => JSON.stringify(x)).join("\n") + "\n");
  try { write(records()); run(home, write); } finally { rmSync(home, { recursive: true, force: true }); }
}
test("native context-only recovery binds exact original instruction to the new active turn", () => fixture((home) => {
  expect(isNativeInterruptedTurnResume(home, { threadId, turnId }, source)).toBe(true);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const parsed = parseRequest({ model: "chatgpt-web/pro", input: [message], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) } });
    expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
}));
test("rejects altered prompts, wrong item ids, missing history and child claims", () => fixture(home => {
  expect(isNativeInterruptedTurnResume(home, { threadId, turnId }, { ...source, content: "altered" })).toBe(false);
  expect(isNativeInterruptedTurnResume(home, { threadId, turnId }, { ...source, itemId: "other" })).toBe(false);
  expect(isNativeInterruptedTurnResume(home, { threadId, turnId, parentThreadId: threadId }, source)).toBe(false);
  expect(isNativeInterruptedTurnResume(join(home, "missing"), { threadId, turnId }, source)).toBe(false);
}));
test("rejects completed, cancelled, superseded or unstarted recovery", () => fixture((home, write) => {
  for (const tail of [event("task_complete", turnId), event("turn_aborted", turnId), event("task_started", oldTurn), { type: "response_item", payload: { ...message, id: "new_instruction" } }]) {
    write([...records(), tail]);
    expect(isNativeInterruptedTurnResume(home, { threadId, turnId }, source)).toBe(false);
  }
  write(records().filter(x => !(x.type === "event_msg" && "type" in x.payload && x.payload.type === "turn_aborted")));
  expect(isNativeInterruptedTurnResume(home, { threadId, turnId }, source)).toBe(false);
}));
test("repeated checks release rollout descriptors and never retain an authorization cache", () => fixture((home, write) => {
  for (let i = 0; i < 50; i++) expect(isNativeInterruptedTurnResume(home, { threadId, turnId }, source)).toBe(true);
  write([...records(), event("turn_aborted", turnId)]);
  expect(isNativeInterruptedTurnResume(home, { threadId, turnId }, source)).toBe(false);
}));
