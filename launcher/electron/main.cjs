const languages = require("./languages.json");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
  Tray,
} = require("electron");
const { BrowserHost, navigationErrorForLog } = require("./browser-host.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { assertActiveTunnelBinding, createAccountStore } = require("./accounts.cjs");
const { HubContexts, partitionForInstance, profileIdForInstance } = require("./hub-contexts.cjs");
const { namedRoutingControl, routingStatuses, setRoutingBatch } = require("./hub-routing-batch.cjs");
const { stageNamedTunnel } = require("./hub-tunnel-stage.cjs");
const { instancePaths, instanceRoot, listInstances, readInstance } = require("./named-instance.cjs");
const { assertMatchingAccount } = require("./account-identity.cjs");
const { BrowserControlServer } = require("./control-server.cjs");
const { getAutostart, setAutostart } = require("./autostart.cjs");
const {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
} = require("./logging.cjs");
const { CodexClientLifecycle } = require("./codex-client-lifecycle.cjs");
const { RoutingSwitch } = require("./routing-switch.cjs");
const { RuntimeHost } = require("./runtime.cjs");
const { ensurePackagedRuntime, waitForPackagedRuntimeSource } = require("./runtime-install.cjs");
const { RuntimeSupervisor } = require("./runtime-supervisor.cjs");
const { startRouteExitGuard } = require("./route-exit-guard.cjs");
const { DEVELOPMENT_PROFILE, resolveLauncherProfile } = require("./profile.cjs");
const { runtimeBundlePaths, runtimeInvocation } = require("./runtime-command.cjs");
const { createUpdateController } = require("./update.cjs");
const {
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("./state.cjs");
const {
  MIN_WINDOW_BOUNDS,
  readWindowState,
  trackWindowState,
} = require("./window-state.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const SOURCE_ROOT = path.resolve(__dirname, "../..");
const LAUNCHER_PROFILE = resolveLauncherProfile({ appData: app.getPath("appData") });
const IS_DEV_PROFILE = LAUNCHER_PROFILE.kind === DEVELOPMENT_PROFILE;
const CORE_HOME = LAUNCHER_PROFILE.coreHome;
const BROWSER_DESCRIPTOR_PATH = path.join(CORE_HOME, "runtime", "launcher-browser.json");
const BROWSER_HELPER_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "runtime", "app", "browser-helper.cjs")
  : path.join(SOURCE_ROOT, ".launcher-runtime", "browser-helper.cjs");
const GITHUB_URL = "https://github.com/babybearofficial/codex-route-hub";
const X_URL = "https://x.com/miu21590";
const CONNECTORS_URL = "https://chatgpt.com/#settings/Plugins";
const TUNNELS_URL = "https://platform.openai.com/settings/organization/tunnels";
const KEYS_URL = "https://platform.openai.com/settings/organization/api-keys";
const ALLOWED_EXTERNAL_URLS = new Set([GITHUB_URL, X_URL, CONNECTORS_URL, TUNNELS_URL, KEYS_URL]);
const PACKAGED_RENDERER_URL = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
const APP_ICON_PATH = path.join(__dirname, "..", "assets", "icon.png");

const launchEnvironment = {
  CODEX_CHATGPT_WEB_HOME: process.env.CODEX_CHATGPT_WEB_HOME,
  CODEX_HOME: process.env.CODEX_HOME,
};
process.env.CODEX_CHATGPT_WEB_HOME = CORE_HOME;
process.env.CODEX_HOME = LAUNCHER_PROFILE.codexHome;
app.setName(LAUNCHER_PROFILE.displayName);
if (process.platform === "win32") {
  app.setAppUserModelId(IS_DEV_PROFILE ? "dev.babybear.codexroutehub.dev" : "dev.babybear.codexroutehub");
}
const launcherUserData = LAUNCHER_PROFILE.userData;
fs.mkdirSync(launcherUserData, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") fs.chmodSync(launcherUserData, 0o700);
app.setPath("userData", launcherUserData);
app.setAppLogsPath(path.join(launcherUserData, "logs"));
installProcessDiagnosticGuards({
  filePath: path.join(launcherUserData, "logs", "process-stream-errors.log"),
});

let mainWindow = null;
let mainWindowReadyToShow = false;
let mainWindowShowRequested = false;
let startupFailed = false;
let browserHost = null;
let accountStore = null;
let createAccountBrowserHost = null;
let runtimeHost = null;
let browserControl = null;
let runtimeSupervisor = null;
let routingSwitch = null;
let routeExitGuard = null;
let hubContexts = null;
let sharedLauncherStateStore = null;
let addNamedContext = null;
let activateNamedContext = null;
let tray = null;
let quitting = false;
let shutdownInProgress = false;
let exitCommitted = false;
let smokePassedThisSession = false;
let cdpPort = 0;
let lastOperation = null;
let catalogVerificationTimer = null;
let catalogVerificationInFlight = false;
let updateController = null;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function createManagedProfile(name) {
  const managerPath = app.isPackaged
    ? path.join(process.resourcesPath, "profile-manager", "profile-manager.cjs")
    : path.join(__dirname, "profile-manager.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [managerPath, "create", name, "--json"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", chunk => { output = `${output}${chunk}`.slice(-64 * 1024); });
    child.stderr.on("data", chunk => { errorOutput = `${errorOutput}${chunk}`.slice(-8 * 1024); });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) return reject(new Error(errorOutput.trim() || `Account creation failed (${code})`));
      try {
        const created = JSON.parse(output.trim());
        if (created.name !== name || !created.coreHome || !created.codexHome) {
          throw new Error("Profile manager returned an invalid account context");
        }
        resolve(created);
      } catch (error) { reject(error); }
    });
  });
}

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function publishOperation(operation) {
  lastOperation = operation;
  send("launcher:operation", operation);
}

function stopCatalogVerificationMonitor() {
  if (catalogVerificationTimer) clearInterval(catalogVerificationTimer);
  catalogVerificationTimer = null;
}

// `baseline` is the catalog request count (and time) recorded before a controlled Codex
// restart; only a newer request proves the restarted client re-read the catalog through the
// proxy. Without one, the first health read becomes the baseline, so a request that predates
// the change that required a restart is never accepted as evidence. The routing keeper shares
// the same baseline.
function startCatalogVerificationMonitor({ logger, stateStore, baseline = null, supervisor = runtimeSupervisor }) {
  stopCatalogVerificationMonitor();
  let reference = baseline;
  let reportedFailure = null;
  const check = async () => {
    const current = stateStore.read();
    if (current.coreSetupComplete !== true || current.codexCatalogVerified === true) {
      stopCatalogVerificationMonitor();
      return;
    }
    if (catalogVerificationInFlight || !supervisor) return;
    catalogVerificationInFlight = true;
    try {
      const config = supervisor.readConfig();
      const health = await supervisor.proxyHealthPayload(config);
      if (!reference && Number.isInteger(health?.successful_model_catalog_requests)) {
        reference = { requests: health.successful_model_catalog_requests, atMs: Date.now() };
        if (routingSwitch) routingSwitch.catalogBaseline = { ...reference };
      }
      if (!Number.isInteger(health?.successful_model_catalog_requests)
        || health.successful_model_catalog_requests < 1) {
        const result = health?.last_model_catalog_result;
        if (!result || !Number.isInteger(result.status) || result.status < 400 || result.status > 599
          || !Number.isInteger(result.request) || result.request < 1 || lastOperation?.status === "running") return;
        const identity = `${health.pid}:${result.request}:${result.at}`;
        if (identity === reportedFailure) return;
        reportedFailure = identity;
        const reason = typeof result.failure?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(result.failure.code)
          ? result.failure.code
          : ["config", "request", "transport", "upstream", "catalog"].includes(result.failure?.stage) ? result.failure.stage : "catalog";
        const state = stateStore.update({ codexRestartRequired: false });
        send("launcher:state-changed", state);
        logger.warn("codex.model_catalog_failed", { status: result.status, reason, request: result.request });
        publishOperation({
          name: "catalog-verification", status: "failed",
          message: nativeCopyFor(current.language).catalogFailure
            .replace("{status}", String(result.status)).replace("{reason}", reason),
        });
        return;
      }
      const lastAt = Date.parse(health.last_successful_model_catalog_request_at ?? "");
      const verified = health.successful_model_catalog_requests > reference.requests
        || (Number.isFinite(lastAt) && lastAt > reference.atMs);
      if (!verified) return;
      const state = stateStore.update({
        codexCatalogVerified: true,
        codexRestartRequired: false,
      });
      logger.info("codex.model_catalog_verified", {
        requests: health.successful_model_catalog_requests,
        at: health.last_successful_model_catalog_request_at,
      });
      send("launcher:state-changed", state);
      stopCatalogVerificationMonitor();
    } catch (error) {
      logger.debug("codex.model_catalog_verification_pending", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      catalogVerificationInFlight = false;
    }
  };
  catalogVerificationTimer = setInterval(() => { void check(); }, 2_000);
  catalogVerificationTimer.unref?.();
  void check();
}

async function restoreCodexRouteAfterRuntimeFailure({ logger, stateStore }) {
  try {
    const route = await runtimeHost.restoreBridgeRoute("runtime-start-fail-safe");
    if (!route.installed || route.active) return { restored: false };
    const state = stateStore.update({
      codexCatalogVerified: false,
      codexRestartRequired: true,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    logger.warn("bridge.route_restored_after_runtime_failure", {
      changed: route.changed === true,
    });
    return { restored: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("bridge.route_restore_after_runtime_failure_failed", { message });
    return { restored: false, error: message };
  }
}

function trayImage() {
  if (process.platform !== "darwin") {
    return nativeImage.createFromPath(APP_ICON_PATH).resize({ width: 18, height: 18 });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M4.1 3.4h6.4l3.4 3.4v7.8H7.5l-3.4-3.4V3.4Z" fill="none" stroke="white" stroke-width="1.5" stroke-linejoin="round"/><path d="m7 7 2-2 2 2M7 11l2 2 2-2" fill="none" stroke="white" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(true);
  return image;
}

const NATIVE_COPY = Object.freeze({
  "en": Object.freeze({
    openLauncher: "Open Codex Route Hub",
    quit: "Quit",
    exportDiagnostics: "Export privacy-safe diagnostics",
    cancel: "Cancel",
    remove: "Remove",
    removeTitle: "Remove Codex Route Hub",
    removeMessage: "Remove the ChatGPT Web models from Codex and restore the previous model route?",
    removeDetail: "The launcher's ChatGPT login profile will be preserved. Codex must be restarted once.",
    retry: "Retry",
    startupTitle: "Codex Route Hub could not start",
    startupDetail: "Retry starts the launcher again without changing your saved settings or ChatGPT profile.",
    startupCleanupFailed: "Startup cleanup failed",
    catalogFailure: "Codex reached the launcher, but loading its model catalog failed (HTTP {status}; {reason}). Check Activity for details and export a safe log if it persists.",
  }),
  "zh-CN": Object.freeze({
    openLauncher: "打开 Codex Route Hub",
    quit: "退出",
    exportDiagnostics: "导出隐私安全诊断",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Route Hub",
    removeMessage: "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？",
    removeDetail: "启动器中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。",
    retry: "重试",
    startupTitle: "Codex Web GPT 无法启动",
    startupDetail: "重试会重新启动应用，不会更改已保存的设置或 ChatGPT 登录配置。",
    startupCleanupFailed: "启动清理失败",
    catalogFailure: "Codex 已连接到启动器，但模型列表加载失败（HTTP {status}；{reason}）。请查看“活动”了解详情；若问题持续，请导出安全日志。",
  }),
  "zh-TW": Object.freeze({
    openLauncher: "開啟 Codex Route Hub",
    quit: "結束",
    exportDiagnostics: "匯出隱私安全診斷",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Route Hub",
    removeMessage: "從 Codex 中移除 ChatGPT Web 模型並還原先前的模型路由？",
    removeDetail: "啟動器中的 ChatGPT 登入設定檔會保留。Codex 需要重新啟動一次。",
    retry: "重試",
    startupTitle: "Codex Route Hub 無法啟動",
    startupDetail: "重試會重新啟動應用程式，不會變更已儲存的設定或 ChatGPT 登入設定檔。",
    startupCleanupFailed: "啟動清理失敗",
    catalogFailure: "Codex 已連線到啟動器，但模型清單載入失敗（HTTP {status}；{reason}）。請查看「活動」了解詳情；若問題持續，請匯出安全日誌。",
  }),
  "ja": Object.freeze({
    openLauncher: "Codex Route Hub を開く",
    quit: "終了",
    exportDiagnostics: "プライバシー保護済みの診断情報をエクスポート",
    cancel: "キャンセル",
    remove: "削除",
    removeTitle: "Codex Route Hub を削除",
    removeMessage: "Codex から ChatGPT Web モデルを削除し、以前のモデルルートを復元しますか？",
    removeDetail: "ランチャーの ChatGPT ログインプロファイルは保持されます。Codex を一度再起動する必要があります。",
    retry: "再試行",
    startupTitle: "Codex Route Hub を起動できませんでした",
    startupDetail: "保存済みの設定と ChatGPT プロファイルを変更せずに、ランチャーを再起動します。",
    startupCleanupFailed: "起動後のクリーンアップに失敗しました",
    catalogFailure: "Codex はランチャーに接続しましたが、モデル一覧を読み込めませんでした（HTTP {status}、{reason}）。「アクティビティ」で詳細を確認し、問題が続く場合は安全なログをエクスポートしてください。",
  }),
  "ko": Object.freeze({
    openLauncher: "Codex Route Hub 열기",
    quit: "종료",
    exportDiagnostics: "개인정보가 보호된 진단 정보 내보내기",
    cancel: "취소",
    remove: "제거",
    removeTitle: "Codex Route Hub 제거",
    removeMessage: "Codex에서 ChatGPT Web 모델을 제거하고 이전 모델 경로를 복원할까요?",
    removeDetail: "런처의 ChatGPT 로그인 프로필은 유지됩니다. Codex를 한 번 다시 시작해야 합니다.",
    retry: "다시 시도",
    startupTitle: "Codex Route Hub를 시작할 수 없습니다",
    startupDetail: "저장된 설정이나 ChatGPT 프로필을 변경하지 않고 런처를 다시 시작합니다.",
    startupCleanupFailed: "시작 정리에 실패했습니다",
    catalogFailure: "Codex가 런처에 연결했지만 모델 목록을 불러오지 못했습니다(HTTP {status}; {reason}). 활동에서 세부 정보를 확인하고 문제가 계속되면 안전한 로그를 내보내 주세요.",
  }),
});

function nativeCopyFor(language) {
  return NATIVE_COPY[language] || NATIVE_COPY.en;
}

function updateTrayMenu(language) {
  if (!tray) return;
  const copy = nativeCopyFor(language);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: copy.openLauncher, click: () => showMainWindow() },
    { type: "separator" },
    { label: copy.quit, click: () => { void requestQuit(); } },
  ]));
}

function createTray(logger, language) {
  try {
    tray = new Tray(trayImage());
    tray.setToolTip(LAUNCHER_PROFILE.displayName);
    updateTrayMenu(language);
    tray.on("click", () => showMainWindow());
    return true;
  } catch (error) {
    tray = null;
    logger.warn("launcher.tray_unavailable", { message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function showMainWindow() {
  // A Windows login launch may still be materializing the packaged runtime when the user opens
  // the desktop shortcut. Electron delivers `second-instance` immediately, before `createWindow`
  // has produced anything to show. Preserve that foreground request until the real window reaches
  // `ready-to-show`; otherwise the already-running `--hidden` instance silently consumes it.
  mainWindowShowRequested = true;
  if ((!mainWindowReadyToShow && !startupFailed) || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindowShowRequested = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openWebUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to open a non-web URL: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.toString());
}

function rendererNavigationAllowed(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    return false;
  }
  if (isDev) {
    try {
      return target.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin;
    } catch {
      return false;
    }
  }
  target.hash = "";
  target.search = "";
  return target.href === PACKAGED_RENDERER_URL;
}

function windowStateSnapshot(window) {
  return {
    fullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
    maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()),
  };
}

function createWindow({ logger, stateStore, windowStatePath, startHidden }) {
  const isMac = process.platform === "darwin";
  const state = stateStore.read();
  const windowState = readWindowState(windowStatePath, screen.getAllDisplays());
  const window = new BrowserWindow({
    width: windowState.bounds.width,
    height: windowState.bounds.height,
    ...(Number.isFinite(windowState.bounds.x) && Number.isFinite(windowState.bounds.y)
      ? { x: windowState.bounds.x, y: windowState.bounds.y }
      : {}),
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    title: LAUNCHER_PROFILE.displayName,
    icon: APP_ICON_PATH,
    show: false,
    backgroundColor: isMac ? "#00000000" : "#181818",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    transparent: isMac,
    ...(isMac ? {
      trafficLightPosition: { x: 16, y: 17 },
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {
      titleBarOverlay: {
        color: "#181818",
        symbolColor: "#a8a8a8",
        height: 46,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile",
    },
  });
  window.setMenuBarVisibility(false);
  const guardRendererNavigation = (event, url) => {
    if (rendererNavigationAllowed(url)) return;
    event.preventDefault();
    let destination = "invalid URL";
    try { destination = new URL(url).origin; } catch {}
    logger.warn("launcher.renderer_navigation_blocked", { destination });
  };
  window.webContents.on("will-navigate", guardRendererNavigation);
  window.webContents.on("will-redirect", guardRendererNavigation);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openWebUrl(url).catch((error) => {
      logger.warn("launcher.external_url_rejected", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { action: "deny" };
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (stateStore.read().keepRunningOnClose && tray) window.hide();
    else void requestQuit();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      mainWindowReadyToShow = false;
    }
  });
  for (const event of ["enter-full-screen", "leave-full-screen", "maximize", "unmaximize"]) {
    window.on(event, () => send("launcher:window-state-changed", windowStateSnapshot(window)));
  }
  window.once("ready-to-show", () => {
    if (!state.onboardingComplete && !Number.isFinite(windowState.bounds.x)) window.center();
    if (windowState.maximized) window.maximize();
    if (windowState.fullscreen) window.setFullScreen(true);
    if (mainWindow === window) mainWindowReadyToShow = true;
    if (mainWindowShowRequested) showMainWindow();
    else if (!startHidden) window.show();
  });
  trackWindowState(window, windowStatePath, (error) => {
    logger.warn("launcher.window_state_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });
  logger.info("launcher.window_created", { platform: process.platform, cdpPort });
  return window;
}

async function loadRenderer(window) {
  if (isDev) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }
  await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

function validateLanguage(value) {
  if (typeof value !== "string" || !Object.hasOwn(languages, value)) {
    throw new Error(`Language must be one of: ${Object.keys(languages).join(", ")}`);
  }
  return value;
}

function validateBrowserInteractionMode(value) {
  if (value !== "automatic" && value !== "manual") {
    throw new Error("Browser interaction mode must be automatic or manual");
  }
  return value;
}

function validateInstanceInteractionMode(value) {
  const mode = validateBrowserInteractionMode(value);
  if ((hubContexts || LAUNCHER_PROFILE.instanceName) && mode !== "automatic") {
    throw new Error("Named account instances require Automatic browser interaction for account/Tunnel binding");
  }
  return mode;
}

function validateBounds(value) {
  if (!value || typeof value !== "object") throw new Error("Browser bounds are required");
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(value[key])) throw new Error(`Browser bounds ${key} must be finite`);
  }
  return value;
}

function smokePassedForCurrentVersion(state) {
  return state.browserSmokePassed === true && state.browserSmokeVersion === app.getVersion();
}

function registerIpc({ logger, stateStore }) {
  let routingBatchInFlight = false;
  const stagingAccounts = new Set();
  const routingContextMap = () => hubContexts?.contexts ?? new Map(
    routingSwitch && accountStore ? [[accountStore.active().id, { routingSwitch }]] : [],
  );
  const updateSharedPreference = patch => {
    if (!hubContexts) return stateStore.update(patch);
    sharedLauncherStateStore.update(patch);
    for (const ctx of hubContexts.contexts.values()) ctx.stateStore.update(patch);
    return stateStore.read();
  };
  const lifecycleChannels = new Set([
    "launcher:setup-core", "launcher:setup-mcp", "launcher:uninstall-integration",
    "launcher:account-create", "launcher:account-select", "launcher:tunnel-stage",
    "launcher:bigger-context", "launcher:zero-risk-pro", "launcher:browser-interaction-mode",
    "launcher:doctor", "launcher:mcp-verify", "launcher:browser-smoke", "launcher:browser-logout",
  ]);
  const handle = (channel, handler) => registerLoggedIpc(ipcMain, logger, channel, (...args) => {
    if (routingBatchInFlight && (lifecycleChannels.has(channel)
      || channel === "launcher:routing-set" || channel === "launcher:routing-sync"
      || channel === "launcher:routing-batch-set")) {
      throw new Error("Wait for the account routing batch to finish");
    }
    if (stagingAccounts.size > 0 && channel === "launcher:routing-batch-set") {
      throw new Error("Wait for Tunnel credentials to be saved before starting a bridge");
    }
    if (routingSwitch?.inFlight && lifecycleChannels.has(channel)) {
      throw new Error("Wait for the routing operation to finish");
    }
    if ((channel === "launcher:account-create" || channel === "launcher:account-select")
      && runtimeHost?.currentOperation()) {
      throw new Error("Wait for the selected account setup operation to finish");
    }
    return handler(...args);
  });
  handle("launcher:routing-status", () => routingSwitch?.status());
  handle("launcher:routing-statuses", () => routingStatuses(routingContextMap()));
  handle("launcher:routing-batch-set", async (_event, profileIds, enabled) => {
    if (IS_DEV_PROFILE) throw new Error("Routing is unavailable in DEV mode");
    routingBatchInFlight = true;
    try { return await setRoutingBatch(routingContextMap(), profileIds, enabled); }
    finally { routingBatchInFlight = false; }
  });
  handle("launcher:routing-set", (_event, enabled) => {
    if (!routingSwitch) throw new Error("Routing switch is unavailable in DEV mode");
    return routingSwitch.setEnabled(enabled);
  });
  handle("launcher:routing-sync", () => {
    if (!routingSwitch) throw new Error("Routing switch is unavailable in DEV mode");
    return routingSwitch.sync();
  });
  const currentSnapshot = () => ({
    profile: LAUNCHER_PROFILE.kind,
    instanceName: hubContexts ? null : LAUNCHER_PROFILE.instanceName ?? null,
    profilePaths: {
      coreHome: hubContexts ? hubContexts.selected().profile.coreHome : CORE_HOME,
      codexHome: hubContexts ? hubContexts.selected().profile.codexHome : LAUNCHER_PROFILE.codexHome,
      userData: hubContexts ? hubContexts.selected().profile.userData : launcherUserData,
    },
    state: stateStore.read(),
    accounts: accountStore.snapshot(),
    browser: browserHost?.snapshot() ?? null,
    connectorName: runtimeHost.browserConnectorName(),
    connectorNames: {
      automatic: runtimeHost.setupConnectorName(),
      manual: "Codex Zero Risk",
    },
    mcpCredentialsConfigured: stateStore.read().browserInteractionMode === "automatic"
      ? Boolean(accountStore.binding(accountStore.active().id))
      : runtimeHost?.mcpCredentialsConfigured() ?? false,
    logs: logger.recent(),
    urls: { github: GITHUB_URL, x: X_URL, connectors: CONNECTORS_URL, tunnels: TUNNELS_URL, keys: KEYS_URL },
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    smokePassed: smokePassedThisSession || smokePassedForCurrentVersion(stateStore.read()),
    operation: lastOperation,
    update: updateController?.getState() ?? { status: "disabled" },
  });
  handle("launcher:snapshot", async () => currentSnapshot());

  const connectSelectedAccountTunnel = async () => {
    if (!routingSwitch || !browserHost.snapshot().authenticated) return false;
    const binding = accountStore.binding(accountStore.active().id);
    if (!binding) return false;
    await browserHost.assertBoundAccountIdentity();
    await routingSwitch.install(() => runtimeHost.setupMcp({
      tunnelId: binding.tunnelId,
      trustedRuntimeKeyFile: binding.runtimeKeyFile,
      replace: true,
      interactionMode: "automatic",
    }));
    assertActiveTunnelBinding(accountStore, accountStore.active().id, runtimeHost.runtimeConfigSnapshot().config);
    return true;
  };

  const selectAccount = async profileId => {
    const previous = accountStore.active();
    if (previous.id === profileId) return accountStore.snapshot();
    if (stateStore.read().browserInteractionMode !== "automatic") {
      throw new Error("Account switching requires Automatic browser interaction");
    }
    if (hubContexts) {
      activateNamedContext(profileId);
      // Recheck the selected account in its own partition without replacing its page.
      // The renderer receives a complete account-context snapshot after this check.
      await browserHost.refreshAuthentication().catch(error => {
        logger.warn("account.session_refresh_failed", {
          instance: profileId, ...navigationErrorForLog(error),
        });
      });
      return accountStore.snapshot();
    }
    if (browserHost.activeTraceId || browserHost.currentOperation()) {
      throw new Error("Finish the active browser task before switching accounts");
    }
    if (routingSwitch && stateStore.read().routingDisabled !== true) {
      await routingSwitch.setEnabled(false);
    }
    const candidate = createAccountBrowserHost(profileId);
    try {
      await candidate.ready();
      await browserHost.persistSession();
    } catch (error) {
      candidate.destroy();
      throw error;
    }
    const old = browserHost;
    old.hide();
    old.destroy();
    accountStore.select(profileId);
    browserHost = candidate;
    candidate.writeDescriptor();
    const state = stateStore.update({ mcpSetupComplete: false, browserSmokePassed: false });
    send("launcher:state-changed", state);
    send("launcher:accounts-changed", accountStore.snapshot());
    send("launcher:browser-state", candidate.snapshot());
    await candidate.refreshAuthentication().catch(error => {
      logger.warn("account.session_refresh_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (candidate.snapshot().authenticated) await connectSelectedAccountTunnel();
    return accountStore.snapshot();
  };
  handle("launcher:account-create", async () => {
    if (hubContexts) {
      let number = hubContexts.contexts.size + 1;
      while (hubContexts.contexts.has(`account-${number}`)) number += 1;
      const name = `account-${number}`;
      await createManagedProfile(name);
      const accounts = await addNamedContext(name);
      send("launcher:account-context-changed", currentSnapshot());
      return accounts;
    }
    const created = accountStore.create();
    send("launcher:accounts-changed", accountStore.snapshot());
    await selectAccount(created.id);
    send("launcher:account-context-changed", currentSnapshot());
    return accountStore.snapshot();
  });
  handle("launcher:account-select", async (_event, profileId) => {
    const accounts = await selectAccount(profileId);
    send("launcher:account-context-changed", currentSnapshot());
    return accounts;
  });
  handle("launcher:tunnel-stage", async (_event, input) => {
    if (!hubContexts) throw new Error("Tunnel staging requires a named Route Hub account");
    const profileId = input?.profileId;
    if (typeof profileId !== "string" || !hubContexts.contexts.has(profileId)) {
      throw new Error("Choose a registered Route Hub account before saving Tunnel credentials");
    }
    const ctx = hubContexts.get(profileId);
    if (stagingAccounts.has(profileId)) throw new Error("Tunnel credentials are already being saved for this account");
    stagingAccounts.add(profileId);
    try {
      const result = await stageNamedTunnel(ctx, input);
      send("launcher:accounts-changed", hubContexts.snapshot());
      return { profileId, ...result };
    } finally {
      stagingAccounts.delete(profileId);
    }
  });

  handle("launcher:set-language", (_event, language) => {
    const state = updateSharedPreference({ language: validateLanguage(language) });
    updateTrayMenu(state.language);
    return state;
  });
  handle("launcher:open-social", async (_event, target) => {
    const url = target === "github" ? GITHUB_URL : target === "x" ? X_URL : null;
    if (!url) throw new Error("Unknown social target");
    await openWebUrl(url);
    const patch = target === "github" ? { githubOpened: true } : { xOpened: true };
    return stateStore.update(patch);
  });
  handle("launcher:complete-onboarding", (_event, language, rawInteractionMode) => {
    const current = stateStore.read();
    if (!current.githubOpened || !current.xOpened) throw new Error("Open the GitHub and X pages before continuing");
    if (current.autoStart && !LAUNCHER_PROFILE.instanceName) setAutostart(app, true);
    const next = stateStore.update({
      language: validateLanguage(language),
      browserInteractionMode: validateInstanceInteractionMode(rawInteractionMode),
      onboardingComplete: true,
    });
    updateTrayMenu(next.language);
    logger.info("launcher.onboarding_completed", {
      language: next.language,
      browserInteractionMode: next.browserInteractionMode,
    });
    return next;
  });

  handle("launcher:open-external", async (_event, url) => {
    if (!ALLOWED_EXTERNAL_URLS.has(url)) throw new Error("External URL is not allowlisted");
    await openWebUrl(url);
    return true;
  });

  handle("launcher:browser-bounds", (event, bounds) => {
    browserHost?.setBounds(validateBounds(bounds), event.sender.getZoomFactor());
    return true;
  });
  handle("launcher:browser-surface-active", (_event, active) => browserHost.setSurfaceActive(active === true));
  handle("launcher:browser-show", () => browserHost.reveal(
    stateStore.read().browserInteractionMode === "automatic",
  ));
  handle("launcher:browser-hide", () => { browserHost?.hide(); return browserHost?.snapshot(); });
  handle("launcher:browser-navigate", (_event, action) => browserHost.navigate(action));
  handle("launcher:browser-zoom", (_event, action) => browserHost.zoom(action));
  handle("launcher:browser-tab-select", (_event, tabId) => browserHost.selectTab(tabId));
  handle("launcher:browser-tab-close", (_event, tabId) => browserHost.closeTab(tabId));
  handle("launcher:manual-prompt-copy", (_event, tabId) => browserHost.copyManualPrompt(tabId));
  handle("launcher:manual-prompt-sent", (_event, tabId) => browserHost.confirmManualSent(tabId));
  handle("launcher:browser-login", async () => {
    const browser = await browserHost.openLogin();
    if (browser.authenticated) {
      if (!hubContexts && accountStore.binding(accountStore.active().id)
        && stateStore.read().routingDisabled === true) await connectSelectedAccountTunnel();
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-passkey-login", async () => {
    const browser = await browserHost.openPasskeyLogin();
    if (browser.authenticated) {
      if (!hubContexts && accountStore.binding(accountStore.active().id)
        && stateStore.read().routingDisabled === true) await connectSelectedAccountTunnel();
      const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
      send("launcher:state-changed", state);
    }
    return browser;
  });
  handle("launcher:browser-passkey-login-continue", () => runtimeHost.continuePasskeyLogin());
  handle("launcher:browser-logout", async () => {
    const browser = await browserHost.logout();
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return { browser, state };
  });
  handle("launcher:session-reminder-dismiss", () => {
    const state = stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:browser-smoke", async () => {
    if (stateStore.read().browserInteractionMode === "manual") {
      throw new Error("Browser smoke testing is disabled in Zero Risk mode");
    }
    const result = await browserHost.smokeTest();
    stateStore.update({ browserSmokePassed: true, browserSmokeVersion: app.getVersion() });
    smokePassedThisSession = true;
    return result;
  });
  handle("launcher:mcp-verify", async (event) => {
    const operationName = "mcp-verification";
    const activeTraceId = browserHost.activeTraceId;
    logger.info("mcp.verification_requested", {
      activeTraceId,
      launcherFocused: mainWindow?.isFocused() === true,
      rendererFocused: event.sender.isFocused(),
    });
    if (activeTraceId) {
      const report = {
        ok: false,
        checks: [{
          id: "connector",
          status: "error",
          message: "Finish the active Codex task before verifying the ChatGPT connector",
          detail: `Active browser turn: ${activeTraceId}`,
        }],
      };
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message: report.checks[0].message });
      return report;
    }
    publishOperation({ name: operationName, status: "running", message: "Checking local runtime" });
    const report = IS_DEV_PROFILE ? await runtimeHost.devDoctor() : await runtimeHost.doctor();
    if (!report.ok) {
      const message = report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.message)
        .filter(Boolean)
        .join("; ") || "The local MCP runtime is not healthy";
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return report;
    }
    if (stateStore.read().browserInteractionMode === "manual") {
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = "Local Zero Risk runtime is healthy; connector selection remains a manual turn step";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          {
            id: "connector",
            status: "warning",
            message: `Select ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} manually for every Zero Risk turn`,
          },
        ],
      };
    }
    try {
      publishOperation({ name: operationName, status: "running", message: "Checking ChatGPT connector" });
      await browserHost.verifyConnector(runtimeHost.mcpConnectorName());
      const state = stateStore.update({ mcpSetupComplete: true });
      send("launcher:state-changed", state);
      const successMessage = IS_DEV_PROFILE
        ? "DEV harness and connector verified"
        : "Runtime and connector verified";
      publishOperation({ name: operationName, status: "completed", message: successMessage });
      return {
        ...report,
        checks: report.checks.map((check) => check.id === "connector"
          ? {
              id: "connector",
              status: "ok",
              message: `ChatGPT connector ${JSON.stringify(runtimeHost.mcpConnectorName())} is available`,
            }
          : check),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = stateStore.update({ mcpSetupComplete: false });
      send("launcher:state-changed", state);
      publishOperation({ name: operationName, status: "failed", message });
      return {
        ...report,
        ok: false,
        checks: [
          ...report.checks.filter((check) => check.id !== "connector"),
          { id: "connector", status: "error", message },
        ],
      };
    }
  });

  handle("launcher:doctor", () => IS_DEV_PROFILE ? runtimeHost.devDoctor() : runtimeHost.doctor());
  handle("launcher:cancel-turns", () => {
    if (IS_DEV_PROFILE) throw new Error("DEV chat turns are owned by the repository CLI process");
    return runtimeHost.cancelActiveTurns();
  });
  handle("launcher:uninstall-integration", async () => {
    if (IS_DEV_PROFILE) throw new Error("DEV profile has no Codex integration to remove");
    const copy = nativeCopyFor(stateStore.read().language);
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      buttons: [copy.cancel, copy.remove],
      defaultId: 0,
      cancelId: 0,
      title: copy.removeTitle,
      message: copy.removeMessage,
      detail: copy.removeDetail,
      noLink: true,
    });
    if (confirmation.response !== 1) return { cancelled: true };
    try {
      await runtimeHost.uninstallIntegration();
    } finally {
      browserHost.writeDescriptor();
    }
    const state = stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      mcpSetupComplete: false,
      mcpRuntimeInstalled: false,
      mcpGuideStep: 0,
      codexRestartRequired: true,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      experimentalSkillAttachments: false,
      zeroRiskProEnabled: false,
    });
    send("launcher:state-changed", state);
    stopCatalogVerificationMonitor();
    return { cancelled: false, state };
  });
  handle("launcher:setup-core", async () => {
    const setupState = stateStore.read();
    if (setupState.browserInteractionMode === "automatic") {
      const browser = await browserHost.probeAuthentication();
      if (!browser.authenticated) {
        if (browser.status === "error") throw new Error(browser.message);
        throw new Error(
          IS_DEV_PROFILE
            ? "Sign in to the isolated DEV ChatGPT profile before configuring the harness"
            : "Sign in to ChatGPT before installing the Codex integration",
        );
      }
    }
    if (setupState.browserInteractionMode === "automatic"
      && !setupState.coreSetupComplete
      && !(smokePassedThisSession || smokePassedForCurrentVersion(setupState))) {
      throw new Error(
        IS_DEV_PROFILE
          ? "Run the browser smoke test before configuring the DEV harness"
          : "Run the browser smoke test before installing the Codex integration",
      );
    }
    const result = IS_DEV_PROFILE ? await runtimeHost.setupDevCore() : await routingSwitch.install(() => runtimeHost.setupCore());
    stateStore.update({
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
      zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
      ...(result.mode === "full" ? {
        mcpRuntimeInstalled: true,
        mcpSetupComplete: false,
        mcpGuideStep: 2,
      } : {
        mcpSetupComplete: false,
        mcpRuntimeInstalled: false,
        mcpGuideStep: 0,
      }),
    });
    await browserHost.returnToIdle().catch((error) => {
      logger.warn("browser.idle_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout, restartRequired: !IS_DEV_PROFILE };
  });
  handle("launcher:setup-mcp", async (_event, input) => {
    const currentMode = stateStore.read().browserInteractionMode;
    const interactionMode = input?.interactionMode === undefined
      ? currentMode
      : validateInstanceInteractionMode(input.interactionMode);
    const interactionModeChange = interactionMode !== currentMode;
    const setup = IS_DEV_PROFILE
      ? runtimeHost.setupDevMcp.bind(runtimeHost)
      : runtimeHost.setupMcp.bind(runtimeHost);
    let releaseTunnelReservation = null;
    const runSetup = async afterRuntimeReady => {
      let selectedBinding = null;
      if (interactionMode === "automatic" && !IS_DEV_PROFILE) {
        await browserHost.assertBoundAccountIdentity();
        selectedBinding = accountStore.binding(accountStore.active().id);
        if (input?.replace !== true && !selectedBinding) {
          throw new Error("Set a Tunnel ID and runtime key for this ChatGPT account first");
        }
        if (hubContexts || LAUNCHER_PROFILE.instanceName) {
          const requestedTunnelId = input?.replace === true
            ? (typeof input?.tunnelId === "string" ? input.tunnelId.trim() : "")
            : selectedBinding?.tunnelId;
          releaseTunnelReservation = accountStore.reserveTunnel(
            accountStore.active().id, "automatic", requestedTunnelId,
          );
        }
      }
      return setup({
        tunnelId: input?.replace === true
          ? (typeof input?.tunnelId === "string" ? input.tunnelId.trim() : "")
          : selectedBinding?.tunnelId || (typeof input?.tunnelId === "string" ? input.tunnelId.trim() : ""),
        runtimeKey: typeof input?.runtimeKey === "string" ? input.runtimeKey : "",
        ...(selectedBinding && input?.replace !== true
          ? { trustedRuntimeKeyFile: selectedBinding.runtimeKeyFile }
          : {}),
        replace: interactionMode === "automatic" && !IS_DEV_PROFILE ? true : input?.replace === true,
        interactionMode,
      }, afterRuntimeReady);
    };
    if (!interactionModeChange && interactionMode === "automatic") await browserHost.reveal();
    const prepare = () => interactionModeChange
      ? browserHost.withInteractionModeChange(interactionMode, runSetup)
      : runSetup();
    let result;
    try {
      result = IS_DEV_PROFILE ? await prepare() : await routingSwitch.install(prepare);
      if (interactionMode === "automatic" && !IS_DEV_PROFILE) {
        const config = runtimeHost.runtimeConfigSnapshot().config;
        const tunnel = config?.automaticTunnel || config?.tunnel;
        accountStore.saveTunnel(accountStore.active().id, "automatic", tunnel);
        releaseTunnelReservation = null;
        assertActiveTunnelBinding(accountStore, accountStore.active().id, config);
        send("launcher:accounts-changed", accountStore.snapshot());
      }
    } catch (error) {
      releaseTunnelReservation?.();
      throw error;
    }
    const state = stateStore.update({
      browserInteractionMode: interactionMode,
      ...(interactionMode === "manual" ? { experimentalBiggerContext: false, experimentalSkillAttachments: false } : {}),
      zeroRiskProEnabled: runtimeHost.runtimeConfigSnapshot().config?.zeroRiskProEnabled === true,
      coreSetupComplete: true,
      codexCatalogVerified: IS_DEV_PROFILE,
      mcpRuntimeInstalled: true,
      mcpSetupComplete: false,
      mcpGuideStep: 2,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (interactionModeChange) send("launcher:browser-state", browserHost.snapshot());
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return { ok: true, stdout: result.stdout };
  });
  handle("launcher:set-mcp-step", (_event, step) => {
    if (!Number.isInteger(step) || step < 0 || step > 2) throw new Error("Invalid MCP guide step");
    return stateStore.update({ mcpGuideStep: step });
  });

  handle("launcher:autostart", (_event, enabled) => {
    if (IS_DEV_PROFILE) throw new Error("The isolated DEV launcher is started explicitly from the repository CLI");
    if (LAUNCHER_PROFILE.instanceName) throw new Error("Named Route Hub instances are started with the profile manager");
    const desired = enabled === true;
    const autostart = setAutostart(app, desired);
    return {
      state: updateSharedPreference({ autoStart: desired }),
      ...autostart,
    };
  });
  handle("launcher:bigger-context", async (_event, enabled) => {
    const result = await runtimeHost.setBiggerContext(enabled === true);
    const state = stateStore.update({
      experimentalBiggerContext: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE ? true : false,
      codexRestartRequired: IS_DEV_PROFILE ? false : true,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:skill-attachments", async (_event, enabled) => {
    if (browserHost.activeTraceId || browserHost.currentOperation()) {
      throw new Error("Finish or cancel active ChatGPT turns before changing Skills as files");
    }
    const result = await runtimeHost.setSkillAttachments(enabled === true);
    const state = stateStore.update({ experimentalSkillAttachments: result.enabled });
    send("launcher:state-changed", state);
    return state;
  });
  handle("launcher:zero-risk-pro", async (_event, enabled) => {
    const browserOperation = browserHost.currentOperation();
    if (browserHost.activeTraceId || browserOperation) {
      throw new Error(
        browserHost.activeTraceId
          ? "Finish or cancel active ChatGPT turns before changing Zero Risk model profiles"
          : `Finish ${browserOperation} before changing Zero Risk model profiles`,
      );
    }
    const result = await runtimeHost.setZeroRiskPro(enabled === true);
    const state = stateStore.update({
      zeroRiskProEnabled: result.enabled,
      codexCatalogVerified: IS_DEV_PROFILE,
      codexRestartRequired: !IS_DEV_PROFILE,
    });
    send("launcher:state-changed", state);
    if (!IS_DEV_PROFILE) startCatalogVerificationMonitor({ logger, stateStore });
    return state;
  });
  handle("launcher:browser-interaction-mode", async (_event, rawMode) => {
    const mode = validateInstanceInteractionMode(rawMode);
    const current = stateStore.read();
    if (current.browserInteractionMode === mode) {
      return { state: current, credentialsRequired: false, targetMode: mode };
    }
    const browserOperation = browserHost.currentOperation();
    if (browserHost.activeTraceId || browserOperation) {
      throw new Error(
        browserHost.activeTraceId
          ? "Finish or cancel active ChatGPT turns before changing browser interaction mode"
          : `Finish ${browserOperation} before changing browser interaction mode`,
      );
    }
    if (!runtimeHost.mcpCredentialsConfigured(mode)) {
      return { state: current, credentialsRequired: true, targetMode: mode };
    }
    const result = await browserHost.withInteractionModeChange(
      mode,
      afterRuntimeReady => runtimeHost.setBrowserInteractionMode(mode, afterRuntimeReady),
    );
    const state = stateStore.update({
      browserInteractionMode: mode,
      ...(mode === "manual" ? { experimentalBiggerContext: false, experimentalSkillAttachments: false } : {}),
      ...(result.configured ? {
        codexCatalogVerified: IS_DEV_PROFILE,
        codexRestartRequired: !IS_DEV_PROFILE,
      } : {}),
    });
    send("launcher:state-changed", state);
    send("launcher:browser-state", browserHost.snapshot());
    if (!IS_DEV_PROFILE && result.configured) startCatalogVerificationMonitor({ logger, stateStore });
    return { state, credentialsRequired: false, targetMode: mode };
  });
  handle("launcher:set-preference", (_event, key, value) => {
    const ordinary = key === "keepRunningOnClose" || key === "showBrowserDuringTurns";
    if (!ordinary) throw new Error("Unknown preference");
    return updateSharedPreference({ [key]: value === true });
  });
  handle("launcher:sidebar-state", (_event, value) => updateSharedPreference(validateSidebarState(value)));
  handle("launcher:logs", (_event, limit) => logger.recent(limit));
  handle("launcher:export-logs", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const copy = nativeCopyFor(stateStore.read().language);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: copy.exportDiagnostics,
      defaultPath: path.join(app.getPath("documents"), `codex-web-gpt-diagnostics-${date}.jsonl`),
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const recordCount = exportSanitizedLogs({
      filePath: logger.filePath,
      destinationPath: result.filePath,
    });
    logger.info("launcher.logs_exported", { recordCount });
    return result.filePath;
  });
  handle("launcher:update-install", async () => {
    if (!updateController) throw new Error("Launcher updates are unavailable");
    const launch = await updateController.beginInstall();
    const result = await requestQuit();
    if (!result.ok) {
      updateController.cancelInstall(launch);
      throw new Error(result.message);
    }
    return true;
  });
  handle("launcher:window-state", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return windowStateSnapshot(window);
  });
  ipcMain.on("launcher:window-control", (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return;
    if (action === "close") window.close();
    else if (action === "minimize") window.minimize();
    else if (action === "zoom") window.isMaximized() ? window.unmaximize() : window.maximize();
  });
}

async function requestQuit() {
  if (shutdownInProgress || exitCommitted) {
    return { ok: false, message: "Launcher shutdown is already in progress" };
  }
  shutdownInProgress = true;
  try {
    if (hubContexts) {
      const failures = [];
      for (const ctx of hubContexts.contexts.values()) {
        try {
          if (ctx.routingSwitch.inFlight) await ctx.routingSwitch.inFlight.catch(() => {});
          await ctx.runtimeSupervisor.cancelActiveTurns().catch(() => {});
          await ctx.routingSwitch.setEnabled(false, { client: false, restoreBeforeStop: true,
            refreshBackend: true });
          ctx.routingSwitch.stopKeeper();
          await ctx.runtimeSupervisor.shutdown({ cancelActiveTurns: true, force: true });
        } catch (error) {
          failures.push(`${ctx.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length) throw new Error(`Could not restore every account route: ${failures.join("; ")}`);
      stopCatalogVerificationMonitor();
      quitting = true;
      for (const ctx of hubContexts.contexts.values()) {
        await ctx.browserHost.persistSession();
        ctx.browserHost.destroy();
        ctx.parkingWindow?.destroy();
        await ctx.browserControl.close();
      }
      exitCommitted = true;
      for (const ctx of hubContexts.contexts.values()) ctx.guard?.release();
      app.quit();
      return { ok: true };
    }
    const activeOperation = runtimeHost?.currentOperation() || browserHost?.currentOperation()
      || (browserHost?.activeTraceId ? "ChatGPT turn" : null)
      || (routingSwitch?.inFlight ? "routing" : null);
    if (activeOperation) {
      throw new Error(`Wait for ${activeOperation} to finish before quitting Codex Route Hub`);
    }
    // An ordinary Route Hub quit restores the route without controlling ChatGPT.app.
    // Explicit routing controls retain their own stop/reopen lifecycle.
    if (routingSwitch) await routingSwitch.setEnabled(false, { client: false, restoreBeforeStop: true,
      refreshBackend: true });
    routingSwitch?.stopKeeper();
    await runtimeSupervisor?.shutdown({ cancelActiveTurns: true, force: true });
    stopCatalogVerificationMonitor();
    quitting = true;
    await browserHost?.persistSession();
    browserHost?.destroy();
    await browserControl?.close();
    exitCommitted = true;
    routeExitGuard?.release();
    app.quit();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    quitting = false;
    showMainWindow();
    publishOperation({ name: "launcher-quit", status: "failed", message });
    return { ok: false, message };
  } finally {
    shutdownInProgress = false;
  }
}

async function start() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", (_event, commandLine) => {
    if (!commandLine.includes("--profile-manager-launch")) showMainWindow();
  });
  app.on("activate", () => showMainWindow());

  await waitForPackagedRuntimeSource({ app, resourcesPath: process.resourcesPath });
  let installedRuntimeRoot = null;
  let runtimeRootResolved = false;
  const runtimeRootProvider = () => {
    const packagedRuntimeWasRemoved = app.isPackaged
      && (!installedRuntimeRoot || !fs.existsSync(installedRuntimeRoot));
    if (!runtimeRootResolved || packagedRuntimeWasRemoved) {
      installedRuntimeRoot = ensurePackagedRuntime({
        app,
        coreHome: CORE_HOME,
        resourcesPath: process.resourcesPath,
      });
      runtimeRootResolved = true;
    }
    return installedRuntimeRoot;
  };
  installedRuntimeRoot = runtimeRootProvider();

  cdpPort = await findFreePort();
  if (process.platform === "linux") {
    app.commandLine.appendSwitch("class", IS_DEV_PROFILE ? "codex-web-gpt-dev" : "codex-web-gpt");
  }
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));

  await app.whenReady();

  const primaryStateStore = createStateStore(path.join(app.getPath("userData"), "launcher-state.json"));
  sharedLauncherStateStore = primaryStateStore;
  let selectedStateStore = primaryStateStore;
  const stateStore = {
    read: () => selectedStateStore.read(),
    update: patch => selectedStateStore.update(patch),
  };
  const registeredInstances = !IS_DEV_PROFILE && !LAUNCHER_PROFILE.instanceName
    ? listInstances(instanceRoot()) : [];
  if (registeredInstances.length > 0) hubContexts = new HubContexts();
  else accountStore = createAccountStore({
    userData: launcherUserData,
    launcherProfile: LAUNCHER_PROFILE.kind,
    singleAccount: Boolean(LAUNCHER_PROFILE.instanceName),
    instanceRoot: LAUNCHER_PROFILE.instanceRoot,
    instanceName: LAUNCHER_PROFILE.instanceName,
  });
  if (IS_DEV_PROFILE && !stateStore.read().onboardingComplete) {
    stateStore.update({
      language: stateStore.read().language || "en",
      onboardingComplete: true,
      autoStart: false,
    });
  }
  if (stateStore.read().sessionRefreshReminderAt === null) {
    stateStore.update({ sessionRefreshReminderAt: nextSessionRefreshReminderAt() });
  }
  const persistedState = stateStore.read();
  if (persistedState.coreSetupComplete === true && persistedState.codexCatalogVerified === undefined) {
    stateStore.update({
      coreSetupComplete: false,
      codexCatalogVerified: false,
      codexRestartRequired: false,
    });
  }
  const autostart = IS_DEV_PROFILE || LAUNCHER_PROFILE.instanceName
    ? { supported: false, enabled: false } : getAutostart(app);
  if (!IS_DEV_PROFILE
    && stateStore.read().onboardingComplete
    && autostart.supported
    && stateStore.read().autoStart !== autostart.enabled) {
    setAutostart(app, stateStore.read().autoStart);
  }
  const logger = createLogger({
    filePath: path.join(app.getPath("logs"), "launcher.jsonl"),
    publish: (record) => send("launcher:log", record),
  });
  if (!IS_DEV_PROFILE && !hubContexts) {
    let guardGeneration = 0;
    const cliInvocation = runtimeInvocation({
      app, sourceRoot: SOURCE_ROOT, installedRuntimeRoot: runtimeRootProvider(), args: [],
    });
    const guardPath = app.isPackaged
      ? path.join(process.resourcesPath, "route-exit-guard.cjs")
      : path.join(__dirname, "route-exit-guard.cjs");
    const armGuard = async () => {
      const generation = ++guardGeneration;
      const guard = await startRouteExitGuard({
        coreHome: CORE_HOME, codexHome: LAUNCHER_PROFILE.codexHome,
        ...(process.platform === "darwin" && process.env.CODEX_ROUTE_HUB_TEST_NO_CLIENT_RESTART !== "1" ? {
          clientAppPath: LAUNCHER_PROFILE.clientAppPath || "/Applications/ChatGPT.app",
          clientBundleId: LAUNCHER_PROFILE.clientBundleId || "com.openai.codex",
        } : {}),
        cliInvocation, guardPath, logger,
        onUnexpectedExit: () => {
          if (generation !== guardGeneration || exitCommitted) return;
          routeExitGuard = null;
          const retry = () => {
            if (exitCommitted) return;
            if (shutdownInProgress) {
              setTimeout(retry, 1_000).unref?.();
              return;
            }
            void armGuard().catch(error => {
              logger.error("routing.exit_guard_restart_failed", { message: error.message });
              setTimeout(retry, 5_000).unref?.();
            });
          };
          setTimeout(retry, 1_000).unref?.();
        },
      });
      routeExitGuard = guard;
    };
    await armGuard();
  }
  const startHidden = process.argv.includes("--hidden")
    && (stateStore.read().onboardingComplete || process.argv.includes("--profile-manager-launch"));
  nativeTheme.themeSource = "system";
  mainWindow = createWindow({
    logger,
    stateStore,
    windowStatePath: path.join(app.getPath("userData"), "window-state.json"),
    startHidden,
  });
  const createNamedContext = async (manifest) => {
    const root = instanceRoot();
    const paths = instancePaths(root, manifest.name, {
      multicodexRoot: manifest.multicodexRoot,
      desktopKind: manifest.desktopKind,
    });
    fs.mkdirSync(paths.coreHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.userData, { recursive: true, mode: 0o700 });
    const localStateStore = createStateStore(path.join(paths.userData, "launcher-state.json"));
    const primary = primaryStateStore.read();
    localStateStore.update({ language: primary.language, autoStart: primary.autoStart,
      keepRunningOnClose: primary.keepRunningOnClose,
      showBrowserDuringTurns: primary.showBrowserDuringTurns,
      sidebarOpen: primary.sidebarOpen, sidebarWidth: primary.sidebarWidth });
    if (!localStateStore.read().onboardingComplete && primary.onboardingComplete) {
      localStateStore.update({
        onboardingComplete: true,
        githubOpened: primary.githubOpened,
        xOpened: primary.xOpened,
      });
    }
    if (localStateStore.read().browserInteractionMode !== "automatic") {
      localStateStore.update({ browserInteractionMode: "automatic" });
    }
    const localAccountStore = createAccountStore({
      userData: paths.userData, launcherProfile: "production", singleAccount: true,
      instanceRoot: root, instanceName: manifest.name,
    });
    const ctx = {
      id: manifest.name,
      profile: { ...paths, kind: "production", instanceName: manifest.name, instanceRoot: root,
        port: manifest.port, multicodexRoot: manifest.multicodexRoot },
      partition: partitionForInstance(manifest.name),
      stateStore: localStateStore,
      accountStore: localAccountStore,
      browserHost: null,
      browserControl: null,
      runtimeSupervisor: null,
      runtimeHost: null,
      routingSwitch: null,
      guard: null,
      parkingWindow: null,
    };
    const descriptorPath = path.join(paths.coreHome, "runtime", "launcher-browser.json");
    let lastReportedAuthentication = null;
    const publishForContext = operation => {
      if (hubContexts?.activeId === ctx.id) publishOperation(operation);
    };
    ctx.browserControl = await new BrowserControlServer({
      logger,
      getBrowserHost: () => ctx.browserHost,
      getPreferences: () => localStateStore.read(),
      getRouting: () => namedRoutingControl(ctx),
      resolveProxy: url => session.fromPartition(ctx.partition).resolveProxy(url),
    }).start();
    ctx.runtimeSupervisor = new RuntimeSupervisor({
      app, logger, sourceRoot: SOURCE_ROOT, installedRuntimeRoot, runtimeRootProvider,
      coreHome: paths.coreHome, codexHome: paths.codexHome,
      instanceName: manifest.name,
      browserDescriptorPath: descriptorPath, launcherProfile: "production",
      publishOperation: publishForContext,
    });
    ctx.runtimeHost = new RuntimeHost({
      app, logger, sourceRoot: SOURCE_ROOT, installedRuntimeRoot, runtimeRootProvider,
      coreHome: paths.coreHome, codexHome: paths.codexHome, userData: paths.userData,
      proxyPort: manifest.port, instanceName: manifest.name,
      browserDescriptorPath: descriptorPath, launcherProfile: "production",
      publishOperation: publishForContext, supervisor: ctx.runtimeSupervisor,
      getBrowserInteractionMode: () => localStateStore.read().browserInteractionMode,
    });
    ctx.routingSwitch = new RoutingSwitch({
      host: ctx.runtimeHost, supervisor: ctx.runtimeSupervisor, store: localStateStore, logger,
      preflight: async () => { await ctx.browserHost.inspectSession(true); },
      client: process.platform === "darwin"
        && process.env.CODEX_ROUTE_HUB_TEST_NO_CLIENT_RESTART !== "1"
        ? new CodexClientLifecycle({
          appPath: paths.clientAppPath,
          bundleId: paths.clientBundleId,
          multicodexRoot: manifest.desktopKind === "official" ? null : manifest.multicodexRoot,
        }) : null,
      onClientRestarted: baseline => {
        if (hubContexts?.activeId === ctx.id) {
          startCatalogVerificationMonitor({ logger, stateStore: localStateStore,
            baseline, supervisor: ctx.runtimeSupervisor });
        }
      },
      refreshSession: () => ctx.browserHost.refreshAuthentication(),
      publishState: state => {
        if (hubContexts?.activeId === ctx.id) send("launcher:state-changed", state);
      },
      publishOperation: publishForContext,
    });
    // Each account owns a native window for its browser views even while another account is
    // selected. Only the selected account lends those same views to the visible Hub shell.
    const [parkingWidth, parkingHeight] = mainWindow.getContentSize();
    ctx.parkingWindow = new BaseWindow({
      width: Math.max(800, parkingWidth), height: Math.max(600, parkingHeight),
      show: false, skipTaskbar: true, frame: false, focusable: false,
    });
    ctx.browserHost = new BrowserHost({
      window: ctx.parkingWindow, descriptorPath, cdpPort,
      control: ctx.browserControl.descriptor(),
      cancelTurn: (traceId, reason) => ctx.runtimeSupervisor.cancelBrowserTurn(traceId, reason),
      getConnectorName: () => ctx.runtimeHost.browserConnectorName(),
      helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
      logger,
      loginWithPasskey: () => ctx.runtimeHost.capturePasskeyLogin(),
      partition: ctx.partition,
      profile: "production", profileId: profileIdForInstance(manifest.name),
      instanceName: manifest.name,
      expectedAccountKey: localAccountStore.active().accountKey,
      enforceAccountBinding: true,
      assertTunnelBinding: () => assertActiveTunnelBinding(
        localAccountStore, "default", ctx.runtimeHost.runtimeConfigSnapshot().config,
      ),
      onIdentity: user => {
        localAccountStore.bindIdentity("default", user);
        send("launcher:accounts-changed", hubContexts.snapshot());
      },
      isActive: () => true,
      publishState: state => {
        if (hubContexts?.activeId === ctx.id) send("launcher:browser-state", state);
        if (lastReportedAuthentication !== state.authenticated) {
          lastReportedAuthentication = state.authenticated;
          send("launcher:accounts-changed", hubContexts.snapshot());
        }
      },
      showWindow: () => {
        if (hubContexts?.activeId === ctx.id) showMainWindow();
      },
      getBrowserInteractionMode: () => localStateStore.read().browserInteractionMode,
    });
    hubContexts.add(ctx);
    await ctx.browserHost.ready();
    ctx.browserHost.hide();
    ctx.browserHost.setSurfaceActive(false);
    fs.mkdirSync(path.join(paths.coreHome, "runtime"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths.coreHome, "runtime", "routing-control.json"),
      JSON.stringify({ protocol: "codex-routing-v1" }), { mode: 0o600 });
    if (powerMonitor && typeof powerMonitor.on === "function") {
      for (const event of ["resume", "unlock-screen"]) {
        powerMonitor.on(event, () => ctx.routingSwitch.onSystemResume({ event }));
      }
    }
    let guardGeneration = 0;
    const guardPath = app.isPackaged
      ? path.join(process.resourcesPath, "route-exit-guard.cjs")
      : path.join(__dirname, "route-exit-guard.cjs");
    const armGuard = async () => {
      const generation = ++guardGeneration;
      const guard = await startRouteExitGuard({
        coreHome: paths.coreHome, codexHome: paths.codexHome,
        ...(ctx.routingSwitch.client ? {
          clientAppPath: paths.clientAppPath,
          clientBundleId: paths.clientBundleId,
        } : {}),
        cliInvocation: runtimeInvocation({
          app, sourceRoot: SOURCE_ROOT, installedRuntimeRoot: runtimeRootProvider(), args: [],
        }),
        guardPath, logger,
        onUnexpectedExit: () => {
          if (generation !== guardGeneration || exitCommitted) return;
          ctx.guard = null;
          setTimeout(() => {
            if (!exitCommitted && !shutdownInProgress) {
              void armGuard().catch(error => logger.error("routing.exit_guard_restart_failed", {
                instance: ctx.id, message: error.message,
              }));
            }
          }, 1_000).unref?.();
        },
      });
      ctx.guard = guard;
    };
    await armGuard();
    ctx.startupAuthenticationRefresh = process.argv.includes("--launcher-smoke-test")
      ? Promise.resolve()
      : ctx.browserHost.refreshAuthentication().catch(error => {
      logger.warn("browser.session_refresh_failed", {
        instance: ctx.id, ...navigationErrorForLog(error),
      });
      });
    ctx.routingSwitch.ready = async () => {
      await ctx.startupAuthenticationRefresh;
      assertMatchingAccount(paths.codexHome, localAccountStore.active().accountKey, "Desktop Codex");
    };
    return ctx;
  };
  if (hubContexts) {
    accountStore = hubContexts;
    for (const manifest of registeredInstances) await createNamedContext(manifest);
    const activeInstancePath = path.join(launcherUserData, "active-instance.json");
    try {
      const saved = JSON.parse(fs.readFileSync(activeInstancePath, "utf8"));
      if (saved?.version === 1 && hubContexts.contexts.has(saved.name)) {
        hubContexts.select(saved.name);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") logger.warn("account.saved_selection_invalid", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    activateNamedContext = id => {
      const previous = hubContexts.selected();
      if (previous.id !== id) {
        const next = hubContexts.get(id);
        stopCatalogVerificationMonitor();
        previous.browserHost.hide();
        previous.browserHost.setSurfaceActive(false);
        previous.browserHost.attachWindow(previous.parkingWindow);
        next.browserHost.attachWindow(mainWindow);
        hubContexts.select(id);
      } else if (previous.browserHost.window !== mainWindow) {
        previous.browserHost.attachWindow(mainWindow);
      }
      const current = hubContexts.selected();
      writePrivateFileAtomic(activeInstancePath,
        `${JSON.stringify({ version: 1, name: current.id })}\n`);
      selectedStateStore = current.stateStore;
      browserHost = current.browserHost;
      browserControl = current.browserControl;
      runtimeSupervisor = current.runtimeSupervisor;
      runtimeHost = current.runtimeHost;
      routingSwitch = current.routingSwitch;
      lastOperation = null;
      send("launcher:accounts-changed", hubContexts.snapshot());
      send("launcher:state-changed", current.stateStore.read());
      send("launcher:browser-state", current.browserHost.snapshot());
      return hubContexts.snapshot();
    };
    activateNamedContext(hubContexts.activeId);
    addNamedContext = async name => {
      const manifest = readInstance(instanceRoot(), name);
      const ctx = await createNamedContext(manifest);
      ctx.routingSwitch.startup().catch(error => logger.error("runtime.startup_failed", {
        instance: ctx.id, message: error.message,
      }));
      return activateNamedContext(name);
    };
  } else {
  browserControl = await new BrowserControlServer({
    logger,
    getBrowserHost: () => browserHost,
    getPreferences: () => stateStore.read(),
    getRouting: () => routingSwitch,
    resolveProxy: url => session.fromPartition(accountStore.partition(accountStore.active().id)).resolveProxy(url),
  }).start();
  runtimeSupervisor = new RuntimeSupervisor({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome: CORE_HOME,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
  });
  runtimeHost = new RuntimeHost({
    app,
    logger,
    sourceRoot: SOURCE_ROOT,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath: BROWSER_DESCRIPTOR_PATH,
    coreHome: CORE_HOME,
    codexHome: LAUNCHER_PROFILE.codexHome,
    proxyPort: LAUNCHER_PROFILE.port ?? null,
    instanceName: LAUNCHER_PROFILE.instanceName ?? null,
    launcherProfile: LAUNCHER_PROFILE.kind,
    publishOperation,
    supervisor: runtimeSupervisor,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
  });
  if (!IS_DEV_PROFILE) routingSwitch = new RoutingSwitch({
    host: runtimeHost, supervisor: runtimeSupervisor, store: stateStore, logger,
    preflight: async () => {
      if (stateStore.read().browserInteractionMode === "automatic") await browserHost.inspectSession(true);
    },
    client: process.platform === "darwin"
      && !(process.env.CODEX_ROUTE_HUB_TEST_NO_CLIENT_RESTART === "1"
        && LAUNCHER_PROFILE.codexHome !== path.join(require("node:os").homedir(), ".codex"))
      ? new CodexClientLifecycle({
        appPath: LAUNCHER_PROFILE.clientAppPath,
        bundleId: LAUNCHER_PROFILE.clientBundleId,
        multicodexRoot: LAUNCHER_PROFILE.multicodexRoot,
      }) : null,
    // A controlled Codex restart resets catalog evidence: only a request newer than this
    // baseline proves the reopened client reads models through the proxy.
    onClientRestarted: baseline => startCatalogVerificationMonitor({ logger, stateStore, baseline }),
    refreshSession: async () => {
      if (stateStore.read().browserInteractionMode === "automatic") await browserHost.refreshAuthentication();
    },
    publishState: state => send("launcher:state-changed", state), publishOperation,
  });
  if (routingSwitch && powerMonitor && typeof powerMonitor.on === "function") {
    // Sleep/wake and screen lock are where the user sees routing "drop". The switch probes the
    // owned runtime immediately and re-observes once the network has settled.
    for (const event of ["resume", "unlock-screen"]) {
      powerMonitor.on(event, () => {
        logger.info("launcher.system_resumed", { event });
        routingSwitch.onSystemResume({ event });
      });
    }
  }
  if (routingSwitch) {
    fs.mkdirSync(path.join(CORE_HOME, "runtime"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(CORE_HOME, "runtime", "routing-control.json"),
      JSON.stringify({ protocol: "codex-routing-v1" }), { mode: 0o600 });
  }
  const configuredInteractionMode = runtimeHost.runtimeConfigSnapshot().config?.browserInteractionMode;
  if ((configuredInteractionMode === "automatic" || configuredInteractionMode === "manual")
    && stateStore.read().browserInteractionMode !== configuredInteractionMode) {
    stateStore.update({ browserInteractionMode: configuredInteractionMode });
  }
  createAccountBrowserHost = profileId => new BrowserHost({
    window: mainWindow,
    descriptorPath: BROWSER_DESCRIPTOR_PATH,
    cdpPort,
    control: browserControl.descriptor(),
    cancelTurn: IS_DEV_PROFILE ? undefined : (traceId, reason) => runtimeSupervisor.cancelBrowserTurn(traceId, reason),
    getConnectorName: () => runtimeHost.browserConnectorName(),
    helper: { executable: process.execPath, script: BROWSER_HELPER_PATH },
    logger,
    loginWithPasskey: () => runtimeHost.capturePasskeyLogin(),
    partition: accountStore.partition(profileId),
    profile: LAUNCHER_PROFILE.kind,
    profileId,
    instanceName: LAUNCHER_PROFILE.instanceName ?? null,
    expectedAccountKey: accountStore.profile(profileId).accountKey,
    enforceAccountBinding: !IS_DEV_PROFILE,
    assertTunnelBinding: () => assertActiveTunnelBinding(
      accountStore, profileId, runtimeHost.runtimeConfigSnapshot().config,
    ),
    onIdentity: user => {
      accountStore.bindIdentity(profileId, user);
      send("launcher:accounts-changed", accountStore.snapshot());
    },
    isActive: () => accountStore.active().id === profileId,
    publishState: state => {
      if (accountStore.active().id === profileId) send("launcher:browser-state", state);
    },
    showWindow: showMainWindow,
    getBrowserInteractionMode: () => stateStore.read().browserInteractionMode,
  });
  browserHost = createAccountBrowserHost(accountStore.active().id);
  await browserHost.ready();
  }
  const updaterRuntimeRoot = runtimeRootProvider();
  updateController = createUpdateController({
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged && !IS_DEV_PROFILE && !require("../package.json").integratedRouting,
    executablePath: process.execPath,
    runtimeExecutable: updaterRuntimeRoot
      ? runtimeBundlePaths(updaterRuntimeRoot, process.platform).executable
      : null,
    logsDirectory: app.getPath("logs"),
    publish: (state) => send("launcher:update-state", state),
    logger,
  });
  registerIpc({ logger, stateStore });
  const trayAvailable = createTray(logger, stateStore.read().language);
  if (startHidden && !trayAvailable) mainWindow.once("ready-to-show", () => showMainWindow());
  const launcherSmokeTest = process.argv.includes("--launcher-smoke-test");
  let startupAuthenticationRefresh = Promise.resolve();
  if (hubContexts) {
    startupAuthenticationRefresh = hubContexts.selected().startupAuthenticationRefresh;
  } else if (!launcherSmokeTest && stateStore.read().browserInteractionMode === "automatic") {
    startupAuthenticationRefresh = browserHost.refreshAuthentication().catch((error) => {
      logger.warn("browser.session_refresh_failed", {
        ...navigationErrorForLog(error),
      });
    });
  }
  await loadRenderer(mainWindow);
  if (!launcherSmokeTest) void updateController.checkOnce();
  if (launcherSmokeTest) {
    const smokeRuntimeRoot = runtimeRootProvider();
    if (app.isPackaged && !smokeRuntimeRoot) {
      throw new Error("Packaged launcher smoke test could not install its durable runtime");
    }
    const versionInvocation = runtimeSupervisor.runtimeCommand(["--version"]);
    const versionResult = spawnSync(versionInvocation.executable, versionInvocation.args, {
      cwd: versionInvocation.cwd,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (versionResult.error) throw versionResult.error;
    if (versionResult.status !== 0 || versionResult.stdout.trim() !== app.getVersion()) {
      throw new Error(
        `Installed launcher runtime is not executable`
        + ` (status=${versionResult.status ?? "unknown"}, stdout=${JSON.stringify(versionResult.stdout.trim())},`
        + ` stderr=${JSON.stringify(versionResult.stderr.trim())})`,
      );
    }
    const markerPath = process.env.CODEX_WEB_GPT_SMOKE_FILE?.trim();
    if (!markerPath || !path.isAbsolute(markerPath)) {
      throw new Error("Packaged launcher smoke test requires an absolute CODEX_WEB_GPT_SMOKE_FILE");
    }
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, `${JSON.stringify({
      ok: true,
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      runtimeVerified: true,
    })}\n`);
    if (hubContexts) {
      for (const ctx of hubContexts.contexts.values()) {
        ctx.browserHost.destroy();
        ctx.parkingWindow?.destroy();
        await ctx.browserControl.close();
        ctx.guard?.release();
      }
    } else {
      browserHost.destroy();
      await browserControl.close();
      routeExitGuard?.release();
    }
    mainWindow.destroy();
    app.quit();
    return;
  }
  if (IS_DEV_PROFILE) {
    let config = null;
    try {
      config = runtimeSupervisor.readConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("dev_profile.config_invalid", { message });
      publishOperation({ name: "dev-profile", status: "failed", message });
    }
    const state = stateStore.update({
      coreSetupComplete: Boolean(config),
      codexCatalogVerified: Boolean(config),
      mcpRuntimeInstalled: config?.mode === "full",
      ...(config?.mode !== "full" ? { mcpSetupComplete: false, mcpGuideStep: 0 } : {}),
      codexRestartRequired: false,
      autoStart: false,
      experimentalBiggerContext: config?.experimentalBiggerContext === true,
      experimentalSkillAttachments: config?.experimentalSkillAttachments === true,
      zeroRiskProEnabled: config?.zeroRiskProEnabled === true,
    });
    send("launcher:state-changed", state);
    logger.info("dev_profile.ready", {
      configured: Boolean(config),
      mode: config?.mode || null,
      coreHome: CORE_HOME,
      userData: launcherUserData,
    });
    if (config?.mode === "full") {
      void startupAuthenticationRefresh.then(() => runtimeSupervisor.startIfConfigured()).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("dev_profile.runtime_start_failed", { message });
        const failed = stateStore.update({ mcpSetupComplete: false });
        send("launcher:state-changed", failed);
      });
    }
  } else if (hubContexts) {
    for (const ctx of hubContexts.contexts.values()) {
      void ctx.routingSwitch.startup().catch(error => {
        logger.error("runtime.startup_failed", { instance: ctx.id, message: error.message });
      });
    }
  } else {
    routingSwitch.ready = async () => {
      await startupAuthenticationRefresh;
      if (LAUNCHER_PROFILE.instanceName) {
        if (stateStore.read().browserInteractionMode !== "automatic") {
          throw new Error("Named account instances require Automatic browser interaction");
        }
        assertMatchingAccount(
          LAUNCHER_PROFILE.codexHome,
          accountStore.active().accountKey,
          "Desktop Codex",
        );
      }
    };
    // Startup reconciles the saved intent: on keeps or re-establishes the route (restarting
    // Codex only when the route changes), off finishes any interrupted restore. Catalog
    // evidence is observed by the routing keeper and the restart hook above.
    void routingSwitch.startup().catch(error => {
      logger.error("runtime.startup_failed", { message: error.message });
    });
  }

  app.on("before-quit", (event) => {
    if (exitCommitted) return;
    event.preventDefault();
    void requestQuit();
  });
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
}

void start().catch(async (error) => {
  startupFailed = true;
  const message = error instanceof Error ? error.message : String(error);
  try {
    fs.appendFileSync(path.join(app.getPath("logs"), "launcher-fatal.log"), `${new Date().toISOString()} ${error?.stack || error}\n`);
  } catch {}
  try {
    // Browser bootstrap can fail before the renderer is loaded. Keep the error reachable
    // through the existing instance, and release browser resources before a user retry.
    const cleanupErrors = [];
    if (hubContexts) {
      for (const ctx of hubContexts.contexts.values()) {
        try { ctx.browserHost?.destroy(); } catch (caught) { cleanupErrors.push(String(caught)); }
        try { ctx.parkingWindow?.destroy(); } catch (caught) { cleanupErrors.push(String(caught)); }
        try { await ctx.browserControl?.close(); } catch (caught) { cleanupErrors.push(String(caught)); }
      }
    } else {
      try { browserHost?.destroy(); } catch (caught) { cleanupErrors.push(String(caught)); }
      try { await browserControl?.close(); } catch (caught) { cleanupErrors.push(String(caught)); }
    }
    if (process.argv.includes("--launcher-smoke-test")
      || process.argv.includes("--profile-manager-launch")) return;
    await app.whenReady();
    quitting = true;
    showMainWindow();
    const copy = nativeCopyFor(createStateStore(path.join(app.getPath("userData"), "launcher-state.json")).read().language);
    const options = {
      type: "error",
      title: copy.startupTitle,
      message,
      detail: [copy.startupDetail,
        ...cleanupErrors.map(detail => `${copy.startupCleanupFailed}: ${detail}`)].join("\n"),
      buttons: [copy.retry, copy.quit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      // Internal child commands use the resolved profile. A fresh launcher must instead
      // resolve the original launch environment, especially for the isolated DEV profile.
      for (const [key, value] of Object.entries(launchEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      app.relaunch({ args: process.argv.slice(1).filter(argument => argument !== "--hidden") });
    }
  } finally {
    // A failed dialog or relaunch must not leave a headless single-instance owner behind.
    app.exit(1);
  }
});
