import { useCallback, useEffect, useRef, useState } from "react";
import type { LogRecord, OperationState, RoutingStatus } from "./types";

const api = window.codexWebLauncher;

const RUNTIME_LABELS: Record<string, string> = {
  stopped: "已停止",
  failed: "运行失败",
  starting: "启动中",
  "needs-setup": "需要配置",
  draining: "正在停止",
  stopping: "正在停止",
  degraded: "正在自动恢复",
  external: "被其他进程占用",
  "not-configured": "尚未配置",
};

// The cards report live evidence (Codex config, proxy health probe), never the saved intent
// alone. `enabled` is what the user asked for; `routeActive` is what Codex actually reads.
export function describeRouting(status: RoutingStatus | null): { runtime: string; route: string; routeDetail: string; catalog: string } {
  if (!status) return { runtime: "读取中…", route: "读取中…", routeDetail: "", catalog: "读取中…" };
  const runtimeLabel = status.runtimeReady
    ? "运行时就绪，代理响应正常"
    : status.runtimeStatus === "ready" && status.proxyHealthy === false
      ? "代理无响应，等待自动恢复"
      : RUNTIME_LABELS[status.runtimeStatus || ""] || status.runtimeStatus || "读取中…";
  const route = status.busy
    ? "正在切换…"
    : status.enabled
      ? status.routeActive === false ? "已启用，但路由未生效" : "已启用"
      : status.routeActive === true ? "已停用，但配置仍指向代理" : "已停用";
  const routeDetail = status.enabled
    ? status.routeActive === false
      ? "Codex 配置未指向本地代理。点击“启动路由并重启 Codex”重新建立。"
      : status.last?.status === "failed"
        ? "最近一次操作失败，请查看日志；路由保持生效时应用会自动恢复运行时。"
        : status.last?.status === "ready" || status.last?.status === "synced" || status.last?.status === "restarted"
          ? "最近一次验证通过；应用持续监测并自动恢复代理与 Tunnel。"
          : "应用持续监测并自动恢复代理与 Tunnel。"
    : status.routeActive === true
      ? "上次停止未完成，代理保持运行以免 Codex 断线；请再次点击“停止路由”。"
      : status.last?.status === "off"
        ? "已恢复开启前配置，Codex 使用原连接方式。"
        : "Codex 使用原连接方式。";
  const catalog = !status.enabled
    ? "—"
    : status.codexRestartRequired
      ? "需要重启 Codex 以重新读取"
      : status.catalogVerified
        ? "Codex 已通过代理读取模型目录"
        : "等待 Codex 读取模型目录";
  return { runtime: runtimeLabel, route, routeDetail, catalog };
}

export function StartupSurface({ operation, logs, disabled, onConfigure }: {
  operation: OperationState | null;
  logs: LogRecord[];
  disabled: boolean;
  onConfigure: () => void;
}) {
  const [status, setStatus] = useState<RoutingStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [automatic, setAutomatic] = useState(() => localStorage.getItem("routing-auto-refresh") !== "false");
  const mounted = useRef(false);
  const reading = useRef(false);
  const changing = useRef(false);
  const refresh = useCallback(async () => {
    if (reading.current || changing.current || disabled) return;
    reading.current = true;
    try {
      const next = await api!.routingStatus();
      if (mounted.current && !changing.current) { setStatus(next); setError(null); }
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally { reading.current = false; }
  }, [disabled]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refresh();
      if (!stopped && automatic) timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [automatic, refresh]);

  // One serialized action at a time; the status is re-read after completion because the
  // operation result itself still reports busy=true.
  const perform = async (action: () => Promise<RoutingStatus>) => {
    if (changing.current) return;
    changing.current = true;
    setPending(true);
    setError(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    finally {
      changing.current = false;
      try { const next = await api!.routingStatus(); if (mounted.current) setStatus(next); } catch { /* retain action error */ }
      if (mounted.current) setPending(false);
    }
  };
  const change = (enabled: boolean) => perform(() => api!.setRouting(enabled));
  const sync = () => perform(() => api!.syncRouting());
  const busy = pending || status?.busy === true || operation?.status === "running";
  const cards = describeRouting(status);

  return <section className="content-surface startup-surface"><div className="content-scroll startup-content">
    <header className="surface-header"><h1>启动配置</h1>
      <p>应用内管理 Codex 路由。启动时先验证登录态，再正常退出 ChatGPT.app（Codex），等待路由就绪后重新打开；启用期间应用持续监测代理与 Tunnel，休眠唤醒后自动恢复。停止时恢复本次启动前的配置，并重启 Codex 使其回到原连接方式。</p>
    </header>
    {disabled ? <p role="alert">启动配置仅在正式运行模式可用。</p> : null}
    <div className="routing-cards" aria-live="polite">
      <article><h2>Codex Route Hub</h2><strong>应用运行中</strong><p>停止路由后仍可在此重新启动</p></article>
      <article><h2>本地桥 / Tunnel</h2><strong>{cards.runtime}</strong>
        <p>{status?.runtimeDetail ? status.runtimeDetail : "由应用统一管理进程"}{status?.observedAt ? `（检测于 ${new Date(status.observedAt).toLocaleTimeString()}）` : ""}</p></article>
      <article><h2>Codex 路由</h2><strong>{cards.route}</strong><p>{cards.routeDetail}</p></article>
      <article><h2>模型目录</h2><strong>{cards.catalog}</strong><p>以 Codex 通过本地代理发出的模型目录请求为准</p></article>
    </div>
    <div className="routing-actions">
      <button className="button-primary" disabled={disabled || busy || !status} onClick={() => void change(true)}>启动路由并重启 Codex</button>
      <button className="button-secondary" disabled={disabled || busy || !status} onClick={() => void change(false)}>停止路由并恢复原连接（重启 Codex）</button>
      <button className="button-secondary" disabled={disabled || busy || !status || !status.enabled} onClick={() => void sync()}>同步模型到 Codex（重启 Codex 并验证）</button>
    </div>
    <p>停止路由会正常退出 Codex、结束本应用管理的代理和隧道并恢复配置，然后在后台重新打开 Codex。Codex 若正在执行任务并拒绝退出，则不会改动任何配置。</p>
    <div className="routing-refresh">
      <button className="button-secondary" disabled={busy} onClick={onConfigure}>模型与连接设置</button>
      <button className="button-secondary" disabled={disabled || busy} onClick={() => void refresh()}>刷新状态</button>
      <label><input type="checkbox" checked={automatic} onChange={event => {
        setAutomatic(event.target.checked);
        localStorage.setItem("routing-auto-refresh", String(event.target.checked));
      }} /> 自动刷新状态</label>
    </div>
    <p className="routing-note">刷新只重读状态。运行时自动恢复由应用管理，不会重新开启已停止的路由；“同步模型”会重启 Codex 并等待它通过代理重新读取模型目录。</p>
    <div role="status" aria-live="polite">{busy ? operation?.message || "正在执行，请稍候…" : status?.last?.message}</div>
    {error ? <p role="alert" className="routing-error">{error}</p> : null}
    <h2>日志</h2>
    <pre className="routing-log" aria-label="启动配置日志">{logs.slice(-300).map(record =>
      `[${record.at}] ${record.level} ${record.event} ${typeof record.detail?.message === "string" ? record.detail.message.slice(0, 2000) : ""}`).join("\n") || "就绪。等待操作。"}</pre>
  </div></section>;
}
