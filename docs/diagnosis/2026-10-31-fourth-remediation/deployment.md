# 第四批部署与打包验收：2026-10-31

结论：**当前源码库入口与本地源码交付工具已补齐；编译发行、干净运行时安装与真实部署仍未验收。** 未执行 build/dev/npm test、替代编译、生命周期、平台连接、付费模型或发布。

## 问题与修改

既有 `packages/lightclaw/package.json` 声明 `main=dist/index.js`、`types=dist/index.d.ts`，但没有 `src/index.ts`。仅在工作区运行源码不能发现消费者入口缺失。本次先回归复现，再增加有意的公开库入口，保留运行时、配置、存储和平台契约能力。实际导入入口在离线测试中通过，不加载凭证或启动平台。

既有 dist 只有历史模块，不能作为本次源码交付证据；因此新增原生 Node `scripts/local-release.mjs`，按明确范围采集 git tracked 与 untracked 当前源码，排除 dist/node_modules/隐藏文件，记录每个文件的 SHA-256、字节数和 git 类别。校验器不依赖原仓库，拒绝缺失、篡改、多余文件和符号链接。TDD 中还发现 `existsSync` 会把悬空链接视为不存在并静默跳过，已改为 lstat 并补 RED→GREEN。评估资产保留在 `packages/lightclaw/evals/`，未复制到 Agent 工作目录。

package.json 增加源码工具脚本及部署文档的 files 项；已有 bin、Python 资产、Node 版本和本地未提交功能全部保留。工程记录与包 CHANGELOG 由主代理统一汇总。

## 实际证据

不可变快照在 `/tmp/lightclaw-batch4-20261031/deploy/`。该目录含原始 RED/GREEN 日志、源码材料和显式清单、pack 文件列表、tgz、离线 install 日志、全新解压目录及命令日志。此快照发生于其他实现域仍在修改源码期间，只证明该快照；不把它冒充整批最终源码。最终整批清单由主代理另行生成。

| 验收项 | 实际结果 | 证明范围 |
| --- | --- | --- |
| `test/packaging.test.ts` 初次 RED | 6/6 失败 | 缺失 src/index.ts 与源码工具可复现 |
| 悬空符号链接 RED | 1 失败 / 6 通过 | 原先静默跳过悬空链接确有缺陷 |
| 定向 GREEN | 7/7 通过 | 入口导入、原生命令、tracked/untracked、篡改与多余文件拒绝、链接拒绝、dist 缺失拒绝 |
| prepare + verify | 680 文件，578 tracked / 102 untracked，0 symlink | 新目录源码材料完整性；不包含 dist/node_modules |
| `npm pack --offline --ignore-scripts` | 成功，16 文件，43731 bytes | 从源码快照打包；归档有 Python 资产与原生工具，**无 dist** |
| 全新解压目录原生工具 `--help` | exit 0 | 仅交付工具无需工作区 node_modules/凭证即可运行 |
| `verify-dist`，源码快照与解压目录 | exit 1，NOT VERIFIED | 所有声明的 dist main/types/bin 都不存在，拒绝伪成功 |
| 全新目录 `npm install --offline --ignore-scripts` | exit 1，ENOTCACHED | 本机缓存缺 `@anthropic-ai/sandbox-runtime` 元数据；依赖安装未完成 |

源码 manifest SHA-256：`7e5fdb7a0d301e7fa12a488697319981c635dba292c7744caf8292d453d4a560`。
归档 SHA-256：`3bf206d6bef5c5ac548947a6a611b86a68be2de44fe3efffe2578b09ebd4e1e1`。

初次 tsx 在 sandbox 内创建本地 IPC socket 遇到 EPERM，使用用户已授权的升级执行重新运行；没有开放测试网络。初次 pack 默认尝试写用户 npm 缓存被文件系统限制拒绝；将既有 `_cacache` 复制到 `/tmp`，指定该缓存并清空继承环境后成功，未修改原用户缓存。离线 install 缺缓存后停止，没有切换在线安装。

## 精确命令

测试从 `packages/lightclaw/` 执行，完整输出分别保存为 red.log、symlink-red.log、green.log：

```sh
rtk proxy env PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npx tsx ../../node_modules/vitest/dist/cli.js --run test/packaging.test.ts
```

源码材料从仓库根执行，分别保存 prepare.log、verify.log、verify-dist.log：

```sh
rtk node packages/lightclaw/scripts/local-release.mjs prepare --output /tmp/lightclaw-batch4-20261031/deploy/source-material
rtk node packages/lightclaw/scripts/local-release.mjs verify /tmp/lightclaw-batch4-20261031/deploy/source-material
rtk node packages/lightclaw/scripts/local-release.mjs verify-dist /tmp/lightclaw-batch4-20261031/deploy/source-material/packages/lightclaw
```

打包从 `deploy/source-material/packages/lightclaw/` 执行；运行日志为 npm-pack.json 与 npm-pack.stderr。`npm-cache/_cacache` 由本机现有 `/Users/x/.npm/_cacache` 复制，只用于离线读取和临时写入：

```sh
rtk proxy env -i PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npm pack --offline --ignore-scripts --userconfig=/dev/null --cache=/tmp/lightclaw-batch4-20261031/deploy/npm-cache --json --pack-destination /tmp/lightclaw-batch4-20261031/deploy
```

安装从全新 `deploy/clean-install/` 执行，完整输出 npm-install.log。无工作区依赖链接，无用户 npm 配置，无 lifecycle：

```sh
rtk proxy env -i PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin npm install --offline --ignore-scripts --no-audit --no-fund --package-lock=false --omit=dev --userconfig=/dev/null --cache=/tmp/lightclaw-batch4-20261031/deploy/npm-cache /tmp/lightclaw-batch4-20261031/deploy/lightclaw-0.70.6.tgz
```

解压目录 `deploy/clean-unpacked/` 是新目录，unpacked-help.log 与 unpacked-dist.log 保存原始结果：

```sh
rtk tar -xzf /tmp/lightclaw-batch4-20261031/deploy/lightclaw-0.70.6.tgz -C /tmp/lightclaw-batch4-20261031/deploy/clean-unpacked
rtk proxy env -i PATH=/Users/x/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/opt/homebrew/bin:/usr/bin:/bin node /tmp/lightclaw-batch4-20261031/deploy/clean-unpacked/package/scripts/local-release.mjs --help
rtk node packages/lightclaw/scripts/local-release.mjs verify-dist /tmp/lightclaw-batch4-20261031/deploy/clean-unpacked/package
```

未声称缓存安装、编译产物、bin 可执行、平台或模型健康、真实 Docker 或生产备份恢复通过。Node v24.22.1 用于定向测试与 npm pack/install；原生源码材料命令使用系统 Node v22.23.0。根级完整 check 与整批测试由主代理在汇总后执行。
