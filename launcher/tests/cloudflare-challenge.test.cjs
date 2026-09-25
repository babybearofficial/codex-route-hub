const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { WIDGET_RECT_SCRIPT, challengeWidgetPoint, clickChallengeInOwnedPage } = require("../electron/cloudflare-challenge.cjs");

test("widget geometry accepts only an on-screen Cloudflare iframe in the owned ChatGPT page", () => {
  const frame = {
    getAttribute: () => "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget",
    getBoundingClientRect: () => ({ left: 80, top: 120, width: 300, height: 65, right: 380, bottom: 185 }),
  };
  const document = { querySelectorAll: selector => selector === "iframe" ? [frame] : [] };
  const context = { document, location: { origin: "https://chatgpt.com", href: "https://chatgpt.com/" },
    URL, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    innerWidth: 800, innerHeight: 600 };
  assert.deepEqual({ ...vm.runInNewContext(WIDGET_RECT_SCRIPT, context) }, { x: 108, y: 150 });
  context.location.origin = "https://example.com";
  assert.equal(vm.runInNewContext(WIDGET_RECT_SCRIPT, context), null);
  context.location.origin = "https://chatgpt.com";
  frame.getAttribute = () => "https://other.example/widget";
  assert.equal(vm.runInNewContext(WIDGET_RECT_SCRIPT, context), null);
});

test("only a visible ChatGPT challenge receives account-local CDP input", async () => {
  const commands = [];
  let visible = true;
  let attached = false;
  const contents = {
    isDestroyed: () => false,
    getURL: () => "https://chatgpt.com/",
    executeJavaScript: async code => {
      assert.match(code, /challenges\.cloudflare\.com/);
      return visible ? { x: 50, y: 75 } : null;
    },
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      sendCommand: async (command, input) => {
        commands.push([command, input.type, input.x, input.y]);
        if (input.type === "mouseReleased") visible = false;
      },
    },
  };
  assert.deepEqual(await challengeWidgetPoint(contents), { x: 50, y: 75 });
  assert.deepEqual(await clickChallengeInOwnedPage(contents, { timeoutMs: 100 }), { clicked: true, cleared: true });
  assert.deepEqual(commands.map(command => command[1]), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(attached, false);
  contents.getURL = () => "https://example.com/";
  assert.equal(await challengeWidgetPoint(contents), null);
});
