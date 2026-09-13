> 此目录是合并后的 macOS Python 兼容客户端。整合版原生 launcher 的关闭操作会保留控制面板，只停止代理、Tunnel 并恢复连接；详见 `../docs/integrated-routing.md`。

# Codex 路由同步

Codex Web GPT 的 Python 总控开关。`on` 接入 Web GPT，`off` 恢复本次开启前的 Codex 连接配置，**不是恢复出厂默认配置**。

```sh
./scripts/codex-route gui
./scripts/codex-route on
./scripts/codex-route off
./scripts/codex-route status
```

- 启动按已安装 GUI 的版本选择 CLI，等待启动器自己的升级/登录刷新，必要时运行官方 setup；不在 launcher 模式下另起无归属的 serve。
- 成功需要代理归属、登录与 Tunnel 的官方 doctor 检查通过，仅端口监听不算成功。外部 ChatGPT 插件绑定仍以 ChatGPT 端实际使用为准。
- 关闭先停 Web GPT 写入进程，再用官方 journal 恢复路由、Voice 和受管理设置。成功后归档失效 journal，下次开启重新记录基线。失败保留 journal 并返回非零退出码。
- GUI、CLI、watch 使用同一把进程锁；清理进程不会终止 route/setup/doctor 命令或 Codex/ChatGPT App。
- GUI 主线程更新界面，只允许一个操作线程及一个待执行请求；日志最多 400 行，关闭清理定时器和回调引用。
- 不自动退出或重启 Codex App。已运行的会话可能仍保留旧连接，待全部验证完成再安排需要的刷新。

详细操作见 [startup.md](startup.md)。

```sh
PYTHONPATH=. python3 -m unittest discover -s tests -v
```
