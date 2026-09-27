# 5.0.14：旧运行时被清理后无法迁移配置

## 本机证据

- 已安装应用为 5.0.13，版本目录仅剩 5.0.13-darwin-arm64，其中 runtime/bun 存在。
- 两个独立账号的配置均仍为 releaseVersion 5.0.12，runtimeCommand 指向已不存在的 5.0.12 目录。
- 截图报错准确对应 src/config.ts 的可执行文件存在性校验。

## 原因

ensurePackagedRuntime 安装并校验新版后清理旧版本。随后账号升级 setup 通过 loadConfigForSetup 读取旧配置，旧实现与正常启动共用严格的文件存在性校验。因此还没运行到 baseConfig 替换 runtimeCommand 的步骤，就因旧 bun 不存在而退出。这是本项目运行时清理与配置迁移衔接的缺陷。

```mermaid
flowchart TD
  A[安装新版并清理旧运行时] --> B[账号配置仍引用旧版]
  B --> C[升级读取配置]
  C --> D[旧行为：要求旧文件存在，迁移失败]
  C --> E[修复：迁移读取只校验路径结构和持久性]
  E --> F[用当前运行时生成配置，正常启动继续检查文件存在]
```

## 修复范围

- 仅 setup 迁移读取允许旧可执行文件缺失，仍拒绝空命令、相对路径和临时目录路径。
- 正常 loadConfig 和 assertDurableRuntimeCommand 保持严格校验。
- baseConfig 继续使用 currentRuntimeCommand 校验并写入实际运行的新版命令。
- 不改账号、端口、浏览器分区、应用分身、多桥接或 Pro 权限逻辑。
- 不复制旧运行时，不添加备份目录，不改变磁盘清理策略。
- 本次为本项目缺陷修复，没有移植新的上游 feature。

## 验证

- runtime-layout 与 setup-lifecycle：28 项通过；包含旧运行时已消失时的迁移读取、正常启动拒绝、非法路径拒绝、新命令替换旧命令。
- 根目录 TypeScript 检查通过。
- 本轮不修改真实账号配置、不停止或重启现有路由。安装包与本机实际激活验证分别记录，源码验证不代表真实账号已经迁移成功。

## 5.0.14 打包结果

- 两个真实账号配置均以只读方式验证：普通启动复现旧文件缺失，修复后的迁移读取成功；未写回真实配置。
- macOS arm64 DMG/ZIP 已生成；打包过程的 codesign --verify --deep --strict 与 runtime manifest 校验通过。
- hdiutil verify：DMG checksum VALID。
- 隔离启动输出 PACKAGED_LAUNCHER_SMOKE_OK darwin/arm64；测试脚本最后删除临时目录遇到 ENOTEMPTY，整体退出码为 1。确认无关联测试进程后已手工删除本次临时目录。启动断言通过，不能将脚本整体记为成功。
- 未安装新版、未重启真实客户端；真实账号的迁移和桥接恢复仍待新版实际激活验证。
- DMG SHA256：ef9edde4834e3fb60b33a8750a848b8a977b2288260bf6611f318fd6d5e1aa26
- ZIP SHA256：897f19b6f7bb5baa58ae73ae336703160adb81190f38663cb3e6923ca59bd2a5
