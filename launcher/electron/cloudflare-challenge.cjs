// The local cloudflare-bypass-2026 project uses CDP to click a Turnstile widget.
// Route Hub adapts that interaction to its existing Electron page: starting another
// browser or copying cf_clearance would lose the account's isolated session.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WIDGET_RECT_SCRIPT = `(() => {
  if (location.origin !== "https://chatgpt.com") return null;
  const roots = [document];
  for (let i = 0; i < roots.length && roots.length < 16; i++) {
    for (const node of roots[i].querySelectorAll("*")) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (roots.length >= 16) break;
    }
  }
  for (const root of roots) for (const frame of root.querySelectorAll("iframe")) {
    let source;
    try { source = new URL(frame.getAttribute("src") || "", location.href); } catch { continue; }
    if (source.protocol !== "https:" || source.hostname !== "challenges.cloudflare.com") continue;
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0
      || rect.width < 180 || rect.height < 40 || rect.width > 500 || rect.height > 150
      || rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) continue;
    return { x: rect.left + 28, y: rect.top + Math.min(30, rect.height / 2) };
  }
  return null;
})()`;

async function challengeWidgetPoint(contents) {
  if (!contents || contents.isDestroyed() || !contents.getURL().startsWith("https://chatgpt.com/")) return null;
  const point = await contents.executeJavaScript(WIDGET_RECT_SCRIPT, true).catch(() => null);
  return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

async function clickChallengeInOwnedPage(contents, { timeoutMs = 30_000 } = {}) {
  const started = Date.now();
  let point = null;
  while (Date.now() - started < timeoutMs) {
    point = await challengeWidgetPoint(contents);
    if (point) break;
    await sleep(500);
  }
  if (!point) return { clicked: false, reason: "No visible Cloudflare checkbox in the selected ChatGPT browser" };

  const debuggerApi = contents.debugger;
  if (!debuggerApi || debuggerApi.isAttached()) {
    return { clicked: false, reason: "Browser CDP input is unavailable" };
  }
  debuggerApi.attach("1.3");
  try {
    // CDP sends input to this webContents without raising/focusing the Route Hub window.
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y,
    });
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
    });
    await debuggerApi.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
    });
  } finally {
    debuggerApi.detach();
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (contents.isDestroyed() || !(await challengeWidgetPoint(contents))) return { clicked: true, cleared: true };
    await sleep(500);
  }
  return { clicked: true, cleared: false };
}

module.exports = { WIDGET_RECT_SCRIPT, challengeWidgetPoint, clickChallengeInOwnedPage };
