const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexClientLifecycle } = require('../electron/codex-client-lifecycle.cjs');

test('graceful shutdown readback precedes background reopening of exact target', async () => {
  const calls = []; let running = true;
  const client = new CodexClientLifecycle({ run: async (exe, args) => {
    calls.push([exe, args]);
    if (exe.endsWith('/open')) { running = true; return { stdout: '' }; }
    assert.match(args[3], /com\.openai\.codex/);
    assert.match(args[3], /Applications\/ChatGPT\.app/);
    if (args[3].includes('if(true)')) { running = false; return { stdout: '{"pid":123,"accepted":true}' }; }
    return { stdout: running ? '{"pid":123}' : 'null' };
  } });
  assert.deepEqual(await client.stop(), { wasRunning: true }); assert.equal(running, false);
  assert.deepEqual(await client.reopen(), { reopened: true });
  assert.deepEqual(calls.find(([exe]) => exe.endsWith('/open'))[1], ['-g', '-a', '/Applications/ChatGPT.app']);
  assert.equal(client.previous, null);
});

test('a client that was not running is reported and never launched by a recovery reopen', async () => {
  const calls = [];
  const client = new CodexClientLifecycle({ run: async (exe, args) => {
    calls.push(exe);
    if (exe.endsWith('/open')) return { stdout: '' };
    return { stdout: 'null' };
  } });
  assert.deepEqual(await client.stop(), { wasRunning: false });
  assert.equal(client.previous, null);
  assert.deepEqual(await client.reopen({ recovery: true }), { reopened: false });
  assert.ok(!calls.some(exe => exe.endsWith('/open')), 'recovery must not open Codex for a user who had it closed');
  assert.equal(await client.running(), false);
});

test('quit refusal never force-kills or opens the app', async () => {
  const client = new CodexClientLifecycle({ run: async (exe, args) => {
    assert.ok(exe.endsWith('/osascript'));
    return { stdout: args[3].includes('if(true)') ? '{"pid":123,"accepted":false}' : '{"pid":123}' };
  } });
  await assert.rejects(client.stop(), /declined to quit/);
});

test('quit timeout is bounded and does not terminate helpers', async () => {
  let now = 0;
  const client = new CodexClientLifecycle({ now: () => now, pause: async () => { now += 16000; },
    run: async () => ({ stdout: '{"pid":123,"accepted":true}' }) });
  await assert.rejects(client.stop(), /30 seconds/);
});
