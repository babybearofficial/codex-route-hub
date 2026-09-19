# 启动配置桥接失败原因 — 2026-09-17

本报告记录本机启动配置点击后的失败链路。检查只读取日志、进程、配置和安装包内容；源码修复通过本地测试验证，未构建、替换或重启安装包。

## 结论

失败不是 Electron 浏览器进程退出。启动器窗口、CDP 和控制端口均已创建，ChatGPT 页面也曾报告 authenticated。真正的阻断是 ChatGPT 后端返回 Cloudflare security challenge，启动器的 session inspection 在手动维护操作期间禁止 challenge recovery，随后 doctor 的 30 秒控制请求超时并把它包装成 `Embedded launcher browser is unavailable`。

启动动作在 doctor 之前已经成功建立了本地链路：Responses 代理监听 `127.0.0.1:17841`，Tunnel 状态报告 ready，`route status` 返回 `installed:true, active:true`。doctor 只因 browser-host 检查失败后，旧版 `RoutingSwitch.enable()` 进入回滚，停止 daemon 并执行 `route disconnect`。因此 Codex 回到未指向本地代理的原始配置，模型选择器继续显示原生模型。

还有一个独立的交付问题：用户点击的是 `/Applications/Codex Route Hub.app`，其 `app.asar` 的修改时间为 2026-09-15；工作树中运行时和路由源码的修改时间为 2026-09-16/17。对安装包内文件和工作树文件计算 SHA-256 也不一致。因此前一轮连续运行时修复并没有进入用户实际点击的安装包。

## 现场证据

日志 `/Users/wickedmc/Library/Application Support/Codex Web GPT/logs/launcher.jsonl` 的关键顺序为：

1. `launcher.window_created`、`browser.control_started`、`browser.initialized`。
2. 多次 `browser.cloudflare_challenge_not_reloaded`，原因是 `manual-operation-active`。
3. `core-setup` 完成；随后记录 `browser.cloudflare_challenge_recovery_failed`。
4. `runtime.daemon_started`，代理在 `127.0.0.1:17841` 健康；`runtime.tunnel_adopted`；`bridge-connect` 返回 `installed:true, active:true`。
5. `doctor` 返回唯一 error 为 `browser-host`，详情为 `session inspection timed out after 30000ms`；proxy、tunnel-runtime 均为 ok。
6. 随后出现 `runtime.daemon_exited`，`bridge-route-restore` 返回 `active:true`，再执行 `route disconnect`；最终 `active:false`。

当前读回也与这条链一致：`~/.codex/config.toml` 没有受管的本地 `openai_base_url`，17841 没有监听，Tunnel cleanup/status 显示 `runtime_state=stopped` 和 `live_runtime.found=false`。这解释了截图中的原生模型列表；它不是 `/v1/models` 的新目录证据。

doctor 同时给出 connector warning：本地检查无法证明 ChatGPT 连接器 `Codex Native2` 已经挂到该 Tunnel；setup 输出也明确留下了在 ChatGPT `Plugins` 页面完成账号级绑定的步骤。这个远端绑定与本地 daemon/route 是两个独立门槛，不能用本地 Tunnel ready 代替。

## 源码修复

- [browser-host.cjs](/Users/wickedmc/all_codes/codex-chatgpt-web/launcher/electron/browser-host.cjs) 允许只读 session inspection/refresh 在 challenge 时做一次受控恢复，并等待已有恢复完成，避免检查请求和页面 reload 竞争。
- [routing-switch.cjs](/Users/wickedmc/all_codes/codex-chatgpt-web/launcher/electron/routing-switch.cjs) 在本地 runtime、代理和路由已经健康时，将单独的 browser-host doctor error 记为 `degraded`，保留 keeper、Tunnel 和 Codex 路由，不再因外部会话校验短暂失败而断路。
- [StartupSurface.tsx](/Users/wickedmc/all_codes/codex-chatgpt-web/launcher/src/StartupSurface.tsx) 对 degraded 状态给出明确提示。

验证结果：`node --test launcher/tests/*.test.cjs` 为 **345 tests，344 passed，0 failed，1 skipped**；`git diff --check` 通过。测试只证明工作树源码行为，不能替代安装包、真实 Codex 模型目录、ChatGPT connector 绑定或长时间睡眠唤醒验收。

## 仍需完成的交付步骤

当前安装包仍是旧版本，故本次源码修复尚未影响用户点击的应用。仓库约定要求在明确授权后才能执行 Node/Electron build/package；完成授权后，需要重新打包并替换安装包，再重新验证：启动后 route/config/17841、`/v1/models` 实际响应、Codex 模型选择器和 Tunnel connector 绑定。外部 Cloudflare challenge 或账号过期仍应显示为 degraded/待恢复，不应被伪报为模型目录成功。
