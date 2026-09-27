# 上游功能采用清单

更新日期：2026-09-27。适用源码版本：Codex Route Hub **5.0.12**。

上游为 [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)（Codex Web GPT）。本项目保留上游 MIT 许可证与作者署名，仓库、更新源和发布版本独立维护。

## 1. 比较基线与采用方式

- 已合入的历史基线：上游 5.0.8 及其后续提交 [eaf4f09](https://github.com/miuuyy/codex-chatgpt-web/commit/eaf4f09)。本项目通过 `e054e37` 合入；这是当前分支与上游 main 的共同祖先。
- 本轮比较终点：[6.1.1 / a13cd09](https://github.com/miuuyy/codex-chatgpt-web/commit/a13cd09)，主要功能变更在 [6.1.0 / 2933410](https://github.com/miuuyy/codex-chatgpt-web/commit/2933410) 和 [6.1.1 / 8d37291](https://github.com/miuuyy/codex-chatgpt-web/commit/8d37291)。
- 本轮按问题移植相关代码与测试，没有整体合并 6.x，也没有把本项目版本号改成上游版本号。
- 下列“继承”表示共同基线已包含该能力，不表示本轮重新实现或已对每项执行真实账号验收。源码、打包与实机验证分开记录。

## 2. 已继承的上游基础功能

| 功能 | Route Hub 中的用途与范围 | 主要代码或说明 |
| --- | --- | --- |
| ChatGPT Web 模型接入 Codex 模型目录 | 保留官方模型透传，追加账号实际具备的 Web 模型；Pro 需账号能力证据，不能强制解锁 | `src/model-catalog.ts`、`src/chatgpt-web-models.ts`、`src/chatgpt-session.ts` |
| Responses / SSE 桥接 | 把 Codex 请求交给网页模型，返回流式文本与状态；原生请求继续透传 | `src/server.ts`、`src/adapters/chatgpt-web/` |
| 内嵌浏览器、登录状态与 Temporary Chat | Electron 持有登录分区；任务使用独立、受租约管理的网页会话 | `launcher/electron/browser-host.cjs`、`src/launcher-browser-host.ts` |
| Browser-only / Full harness / Zero Risk 模式 | 自动网页调用；通过 MCP 使用当前任务工具；或由用户手动发送。命名账号当前按已有实现使用 automatic 模式 | [模式说明](architecture.md#modes)、`src/setup.ts` |
| MCP 与官方 Tunnel 客户端 | 将网页端工具调用绑定回对应 Codex 任务，验证连接器与运行时归属 | `src/adapters/chatgpt-web/mcp-server.ts`、[安全模型](security-model.md) |
| 任务绑定、图片、流式回复与续接 | 保留完整上下文和图片附件，校验当前任务/轮次；复用归属明确的网页会话 | `browser-worker.ts`、`environment.ts`、`thread-environment.ts` |
| 上下文压缩与 Bigger Context | 保留压缩交接、上下文预算与最多六段的大上下文传输；本轮未采用上游 6.x 的新预算 | `src/adapters/chatgpt-web/compaction-handoff.ts`、`prompt.ts` |
| 原生与 Compatibility V1 子代理协议 | 保留现有协议选项及工具调用约束；切换协议仍需按现有流程重启并新建任务 | [架构](architecture.md#installation-and-service-lifecycle) |
| Launcher 管理运行时、健康检查与取消 | 启停代理/Tunnel，检查归属，提供诊断、取消和有界资源清理 | `launcher/electron/runtime-supervisor.cjs`、`src/doctor.ts` |
| 独立 DEV 环境与跨平台运行包 | 开发测试使用隔离配置；应用内置 Electron/Bun 及校验过的运行时 | [DEV harness](dev-chat.md)、`launcher/scripts/` |

上表记录采用的功能范围；详细协议、安全约束与模式差异以对应代码和架构文档为准。

## 3. 本轮新增采用的 6.1.x 修复

| 上游变更 | 来源 | 本项目采用与适配 | 本项目提交 / 主要验证 |
| --- | --- | --- | --- |
| 新版输入框与发送控件 | 6.1.0 | 识别新版结构化输入框、发送及停止按钮；保留登录过期的独立错误 | 早期选择器修复 `822425d`；完整兼容 `ea4b211`；session/worker 测试 |
| 模型与推理档位检测 | 6.1.0、6.1.1 | 识别新版模型滑杆和所属菜单；一次读取档位、范围及锁定状态；等待完整检测窗口，避免把暂未加载误存成无 Pro | `ea4b211`；session 测试、真实 Chromium 档位测试 |
| 新版网页轮次绑定 | 6.1.0、6.1.1 | 支持 grouped-turn 结构，确认新用户消息与对应回复，保持稳定提交身份；不重复发送已接受的消息 | `ea4b211`；turn-binding 浏览器测试 |
| Activity、回复与完成状态解析 | 6.1.1 | 区分活动说明、回复内容、进行中与完成状态；避免用户消息的底部控件被当成助手已完成 | `ea4b211`；公开 DOM fixture 和 response 测试 |
| 附件与连接器选择兼容 | 6.1.0、6.1.1 | 支持两代附件/连接器控件，按当前账号配置的精确连接器名验证，保留账号独立绑定 | `ea4b211`；worker 合约测试 |
| 隐藏主浏览器的视口修复 | 6.1.0 | 后台视图设置明确视口；导航/尺寸变化后更新，显示或手动模式恢复原生尺寸；适配每个账号自己的 BrowserHost | `44c343b`；隐藏视口、导航、恢复测试 |

账号身份校验仍采用 Route Hub 的账号归属实现。本轮没有整体替换上游 6.1.1 的认证模块，以免退回单账号假设。

## 4. Route Hub 自有功能与本轮补充

这些内容属于本项目的二次开发，不能在升级上游时被覆盖：

| 功能 / 修复 | 必须保留的行为 | 相关代码 / 提交 |
| --- | --- | --- |
| 多开 Codex 应用 | 每个命名实例有自己的客户端路径、bundle 身份及 CODEX_HOME；操作一个账号只控制它自己的客户端 | `named-instance.cjs`、`profile-manager.cjs`、`codex-client-lifecycle.cjs` |
| 多账号登录与界面切换 | 独立浏览器分区、账号记录、配置和后台窗口；切换选中账号不停止其他账号 | `accounts.cjs`、`hub-contexts.cjs`、`main.cjs` |
| 多桥接与批量启停 | 独立端口、代理、Tunnel 和连接器；批量操作逐个报告结果，一个失败不阻断其他账号 | `hub-routing-batch.cjs`、`hub-tunnel-stage.cjs`、`routing-switch.cjs`；恢复提交 `b2d2f7a` |
| 路由连续性与恢复 | 临时 Tunnel 发现失败不能撤掉正常代理；停止时恢复启用前配置并保留无关设置 | `runtime-supervisor.cjs`、`route-exit-guard.cjs`、[路由说明](integrated-routing.md) |
| 模型同步重新检测账号能力 | 同步先重新检查当前账号能力，再更新代理和模型目录；失败恢复该客户端，其他账号不变 | 本轮 `3e6905e`；34 项 routing-switch 测试 |
| 容量失败后的原生重试验证 | 根据本地 canonical rollout 证明旧消息属于当前合法重试，避免误报 turn_id 冲突；保留伪造/陈旧请求拒绝条件 | 本轮 `f7ec9fb`；native-turn-resume 测试 |
| 独立项目及更新源 | 独立仓库与 bundle 标识；更新只来自 Route Hub 自身发布 | `d91709e`、[独立化记录](plans/2026-09-25-codex-route-hub-repair.md) |
| 安装副本与运行时空间管理 | 替换成功后清理同一项目的历史应用副本；验证新运行时后清理旧版本，临时回滚不永久堆积 | `42b194e`、`scripts/install-launcher.sh`、`runtime-install.cjs` |

## 5. 本轮未采用的上游更新

| 内容 | 当前决定 | 后续采用条件 |
| --- | --- | --- |
| 6.x 新模型家族、模型命名和上下文预算 | 保留现有模型 ID、任务绑定和预算；本轮修复能力识别 | 单独验证旧任务续接、账号能力与所有桥接实例 |
| 使用量 / Limits 展示与新限额解析 | 暂不引入 | 独立需求及真实账号验证 |
| Saved chats 持久会话功能 | 继续使用现有 Temporary Chat 生命周期 | 明确数据保留需求，再设计与多账号隔离的关系 |
| 上游单账号启动流程、账号认证替换 | 保留本项目实现；只移植所需 DOM 与视口修复 | 证明不会覆盖多实例归属和 Tunnel 绑定 |
| 其余 6.x 通知、界面、更新器和平台调整 | 本轮未整体移植 | 根据实际问题逐项比较、单独提交及验证 |

## 6. 本轮验证状态

- 源码完整 `bun run verify`：根测试 **767 通过 / 9 跳过**，Launcher **407 通过 / 1 跳过**，审计、版本一致性、类型检查、构建和可迁移运行时 smoke 通过。
- 随后新增后台主视口修复：browser-host + routing-switch 定向测试 **146 通过**。
- 真实无头 Chromium 的网页轮次/档位测试：**8 通过**。
- 两个现有账号的源码能力实测：均通过认证，均检测到 Sol、Extra High 和 Pro。
- 源码实际发送：选中账号成功收到测试回复；隐藏账号在旧 Launcher 上复现“控件位于视口之外”，采用明确视口后同样成功。此次临时视口验证已恢复，未重启运行中的应用。
- macOS arm64 5.0.12 安装包构建通过，签名校验与隔离启动检查通过（`PACKAGED_LAUNCHER_SMOKE_OK`）。
- 按用户最后要求，本轮只完成源码与编译，保持当前路由和运行中的 5.0.11 应用不变；5.0.12 **尚未安装激活**。安装后的模型目录同步与多账号整体验收待激活时执行，详见 [本轮比较记录](plans/2026-09-27-upstream-browser-repair.md)。

以后每次采用上游变更，继续补充来源提交、Route Hub 适配点、多实例影响和验证证据。
