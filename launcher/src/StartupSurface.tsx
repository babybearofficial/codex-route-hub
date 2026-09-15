import { useCallback, useEffect, useRef, useState } from "react";
import type { LogRecord, OperationState, RoutingStatus } from "./types";

const api = window.codexWebLauncher;

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

  const change = async (enabled: boolean) => {
    if (changing.current) return;
    changing.current = true;
    setPending(true);
    setError(null);
    try { await api!.setRouting(enabled); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    finally {
      changing.current = false;
      // Read after completion: the operation result itself still has busy=true.
      try { const next = await api!.routingStatus(); if (mounted.current) setStatus(next); } catch { /* retain action error */ }
      if (mounted.current) setPending(false);
    }
  };
  const busy = pending || status?.busy === true || operation?.status === "running";
  const route = status?.last?.status === "off" ? "已恢复开启前配置"
    : status?.last?.status === "ready" ? "最近一次验证通过"
    : status?.last?.status === "failed" ? "操作失败，请查看日志" : "尚未验证";

  return <section className="content-surface startup-surface"><div className="content-scroll startup-content">
    <header className="surface-header"><h1>启动配置</h1>
      <p>应用内管理 Codex 路由。启动时先验证登录态，再退出 ChatGPT.app（Codex），等待路由就绪后重新打开。停止时恢复本次启动前的配置。</p>
    </header>
    {disabled ? <p role="alert">启动配置仅在正式运行模式可用。</p> : null}
    <div className="routing-cards" aria-live="polite">
      <article><h2>Codex Route Hub</h2><strong>应用运行中</strong><p>停止路由后仍可在此重新启动</p></article>
      <article><h2>本地桥 / Tunnel</h2><strong>{status?.runtimeReady ? "运行时就绪" : ({ stopped: "已停止", failed: "运行失败", starting: "启动中", "needs-setup": "需要配置", draining: "正在停止" } as Record<string, string>)[status?.runtimeStatus || ""] || status?.runtimeStatus || "读取中…"}</strong><p>由应用统一管理进程</p></article>
      <article><h2>Codex 路由</h2><strong>{status?.busy ? "正在切换…" : status?.enabled ? "已启用" : "已停用"}</strong><p>{route}</p></article>
    </div>
    <div className="routing-actions">
      <button className="button-primary" disabled={disabled || busy || !status} onClick={() => void change(true)}>启动路由并重启 Codex</button>
      <button className="button-secondary" disabled={disabled || busy || !status} onClick={() => void change(false)}>停止路由</button>
    </div>
    <p>停止路由会结束本应用管理的代理和隧道，并恢复配置。Codex App 和当前会话保持打开。</p>
    <div className="routing-refresh">
      <button className="button-secondary" disabled={busy} onClick={onConfigure}>模型与连接设置</button>
      <button className="button-secondary" disabled={disabled || busy} onClick={() => void refresh()}>立即同步</button>
      <label><input type="checkbox" checked={automatic} onChange={event => {
        setAutomatic(event.target.checked);
        localStorage.setItem("routing-auto-refresh", String(event.target.checked));
      }} /> 自动同步状态</label>
    </div>
    <p className="routing-note">自动同步只刷新状态；运行时自动恢复由应用管理，不会重新开启已关闭的路由。</p>
    <div role="status" aria-live="polite">{busy ? operation?.message || "正在执行，请稍候…" : status?.last?.message}</div>
    {error ? <p role="alert" className="routing-error">{error}</p> : null}
    <h2>日志</h2>
    <pre className="routing-log" aria-label="启动配置日志">{logs.slice(-300).map(record =>
      `[${record.at}] ${record.level} ${record.event} ${typeof record.detail?.message === "string" ? record.detail.message.slice(0, 2000) : ""}`).join("\n") || "就绪。等待操作。"}</pre>
  </div></section>;
}
