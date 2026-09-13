const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserControlServer } = require('../electron/control-server.cjs');

test('routing API authenticates, validates input and releases its server', async () => {
  const calls = [];
  const server = await new BrowserControlServer({
    logger: { info() {}, error() {} }, getBrowserHost: () => null, getPreferences: () => ({}),
    getRouting: () => ({ status: () => ({ protocol: 'codex-routing-v1', busy: false }),
      setEnabled: async enabled => { calls.push(enabled); return { enabled }; } }),
  }).start();
  const { endpoint, token } = server.descriptor();
  const request = (action, body, authorized = true) => fetch(endpoint + '/v1/routing/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await request('set', { enabled: false }, false)).status, 401);
    assert.equal((await request('set', { enabled: 'false' })).status, 409);
    assert.equal((await (await request('status', {})).json()).protocol, 'codex-routing-v1');
    assert.equal((await request('set', { enabled: false })).status, 200);
    assert.deepEqual(calls, [false]);
  } finally { await server.close(); }
  assert.equal(server.server.listening, false);
});
