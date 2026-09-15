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
  await client.stop(); assert.equal(running, false);
  await client.reopen();
  assert.deepEqual(calls.find(([exe]) => exe.endsWith('/open'))[1], ['-g', '-a', '/Applications/ChatGPT.app']);
  assert.equal(client.previous, null);
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
