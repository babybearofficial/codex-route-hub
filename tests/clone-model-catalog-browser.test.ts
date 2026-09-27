import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { defaultConfig } from "../src/config";
import { detectChatGptAccountCapabilities } from "../src/chatgpt-session";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { augmentNativeModelCatalog } from "../src/model-catalog";

const { BrowserHost } = require("../launcher/electron/browser-host.cjs");

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("isolated account inspection exposes the full Pro catalog without reloading or sharing entitlements", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    for (const pro of [true, false]) {
      const context = await browser.newContext();
      const userId = pro ? "clone-pro-user" : "independent-plus-user";
      let navigations = 0;
      await context.route("https://chatgpt.com/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/auth/session") {
          await route.fulfill({ json: { user: { id: userId }, expires: "2099-01-01T00:00:00Z" } });
          return;
        }
        navigations++;
        await route.fulfill({ contentType: "text/html", body: `<form data-chatgpt-composer>
          <div data-composer-markdown contenteditable="true" role="textbox">Unsent draft</div>
          <button type="button" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning"
            aria-haspopup="menu" aria-expanded="false" aria-controls="picker">Thinking effort</button>
          </form><div role="menu" id="picker" hidden><div data-model-picker-power-slider style="width:250px;height:30px">
            <span data-orientation="horizontal" aria-disabled="false">
              ${Array.from({ length: 5 }, (_, index) => `<span data-selected="${index === 0}" data-locked="${!pro && index >= 3}"></span>`).join("")}
              <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"></span>
            </span></div></div><script>
            const button=document.querySelector('button'), picker=document.querySelector('#picker');
            button.onclick=()=>{picker.hidden=false;button.setAttribute('aria-expanded','true')};
            document.addEventListener('keydown',event=>{if(event.key==='Escape'){picker.hidden=true;button.setAttribute('aria-expanded','false')}});
          </script>` });
      });
      const page = await context.newPage();
      await page.goto("https://chatgpt.com/?temporary-chat=true");
      const host = Object.assign(Object.create(BrowserHost.prototype), {
        state: { authenticated: false }, turnTabs: new Map(), manualOperation: "session inspection",
        expectedAccountKey: createHash("sha256").update(userId).digest("hex"), enforceAccountBinding: true,
        instanceName: userId, helper: {}, descriptorPath: `/isolated/${userId}/browser.json`,
        getConnectorName: () => "Codex Native2", logger: { info() {} },
        view: { webContents: { isDestroyed: () => false, getURL: () => page.url(),
          executeJavaScript: (script: string) => page.evaluate(script) } },
        setState(patch: object) { this.state = { ...this.state, ...patch }; },
        snapshot() { return this.state; },
        refreshChatGptHomeDocument() { throw new Error("A working authenticated composer must not be reloaded"); },
        runBrowserHelperOperation: async () => ({ value: {
          authenticated: true, temporary: true, url: page.url(), ...await detectChatGptAccountCapabilities(page),
        } }),
      });
      const capabilities = await host.runSessionInspection(true);
      expect(capabilities.proAvailable).toBe(pro);
      const config = { ...defaultConfig("full"), ...capabilities, subagentProtocol: "native" as const };
      const native = { models: [{ slug: "native-model", visibility: "list", tool_mode: "code_mode_only",
        multi_agent_version: "v2", supported_reasoning_levels: [{ effort: "high", description: "High" }] }] };
      const catalog = augmentNativeModelCatalog(native, config);
      const models = catalog.models as Array<{ slug: string }>;
      const expected = CHATGPT_WEB_MODEL_ROUTES.filter(route => pro || (!route.requiresPro && !route.requiresExtraHigh));
      expect(models.map(model => model.slug)).toEqual(["native-model", ...expected.map(route => route.slug)]);
      expect(navigations).toBe(1);
      expect(await page.locator('[data-composer-markdown]').innerText()).toBe("Unsent draft");
      await context.close();
    }
  } finally { await browser.close(); }
}, 60_000);
