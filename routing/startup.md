> 此目录是合并后的 macOS Python 兼容客户端。整合版原生 launcher 的关闭操作会保留控制面板，只停止代理、Tunnel 并恢复连接；详见 `../docs/integrated-routing.md`。

# 总控开关操作说明

在 `/Users/wickedmc/all_codes/codex_routing` 执行：

```sh
./scripts/codex-route gui     # 管理窗口
./scripts/codex-route on      # 后台启动、配置、验证完整运行时
./scripts/codex-route off     # 恢复开启前连接、关闭 Web GPT
./scripts/codex-route status  # 当前状态
./scripts/codex-route sync   # 按当前运行时状态对齐
./scripts/codex-route watch  # 持续对齐，不主动启动 GUI
```

GUI 启动会显示四阶段进度。首次版本迁移或浏览器登录刷新可能需要几分钟。操作期间再次点击会保留最后一次请求，自动同步不会覆盖它。关闭窗口会排队执行关闭；恢复失败时保留窗口显示错误。

## 成功标准

开启成功：`webgpt_process`、`bridge_listening`、`runtime_ready`、`route_active` 均为 true，官方 doctor 无 error。

关闭成功：项目路由不再活动、项目运行时进程清空。原有自定义 `openai_base_url` 可以仍然存在，不会被误认成 Web GPT 残留。重复关闭安全，不重置其它配置。

恢复依据是官方 integration journal 中记录的开启前值。成功关闭后旧 journal 移到 `~/.codex-chatgpt-web/codex/routing-history/`，仅作恢复记录，不再是活动连接；不删除用户登录数据或远端账号资源。

完整运行时准备就绪不等于已经证明 ChatGPT 插件绑定。本地 doctor 对这项会保留 warning；不要将它写成已验证的远端插件结果。

## Codex App

脚本不会退出或重启 Codex/ChatGPT App。配置恢复和进程内旧连接是两个状态：如已有会话缓存旧地址，在全部检查完成后再刷新会话或重启 Codex App；不要在修复过程中关闭正在工作的 Codex。

## 故障与资源控制

失败返回非零退出码并显示原因。端口可连、HTTP 500/502 都不代表可用。版本与 launcher 不一致时使用匹配版本配置，禁止用旧 serve 绕开 launcher 归属校验。

GUI 的日志、操作队列及线程数量有界；跨进程锁的文件描述符在每次操作结束释放。后台启动使用 `open -g`，不主动切换焦点。
