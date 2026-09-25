const test = require('node:test');
const assert = require('node:assert/strict');
const { appServerPids, refreshCodexBackend } = require('../electron/codex-backend-refresh.cjs');

test('backend matcher requires the exact GUI parent and executable', () => {
  const appPath = '/Applications/Codex Account.app';
  const output = [
    '101 50 /Applications/Codex Account.app/Contents/Resources/codex app-server',
    '102 51 /Applications/Codex Account.app/Contents/Resources/codex app-server',
    '103 50 /Applications/ChatGPT.app/Contents/Resources/codex app-server',
    '104 50 /Applications/Codex Account.app/Contents/Resources/codex exec',
  ].join('\n');
  assert.deepEqual(appServerPids(output, 50, appPath), [101]);
});

test('backend refresh signals only its matching child and waits for GUI respawn', async () => {
  if (process.platform !== 'darwin') return;
  const appPath = '/Applications/Codex Account.app';
  const calls = [];
  let backend = 101;
  const run = async (command) => {
    if (command === '/usr/bin/osascript') return { stdout: '50\n' };
    if (command === '/bin/ps') return { stdout: [
      `${backend} 50 ${appPath}/Contents/Resources/codex app-server`,
      '102 51 /Applications/Other.app/Contents/Resources/codex app-server',
    ].join('\n') };
    throw new Error(`Unexpected command ${command}`);
  };
  const result = await refreshCodexBackend({ appPath, bundleId: 'local.multicodex.account', run,
    signal: (pid, name) => { calls.push([pid, name]); backend = 201; }, wait: async () => {} });
  assert.deepEqual(calls, [[101, 'SIGTERM']]);
  assert.deepEqual(result, { status: 'refreshed', previousPid: 101, pid: 201, appPid: 50 });
});
