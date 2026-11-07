# LightClaw Docker 沙箱

LightClaw 主进程在宿主机连接飞书和大模型，`bash/read/write/edit` 等工具在 Docker 容器中执行。容器只挂载指定的数据目录，不会自动获得宿主机其他文件或 API Key。

## 创建沙箱

在仓库根目录运行：

```bash
mkdir -p lightclaw-data
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

脚本会构建本地最小镜像，并默认施加以下边界：

- 1 个 CPU
- 512 MB 内存，禁止额外 swap
- 最多 128 个进程
- 默认网络 `none`，工具不能联网
- 删除全部 Linux capabilities
- 禁止获取新权限
- 使用当前宿主机用户的 UID/GID，而不是 root
- `/tmp` 使用独立的 64 MB 临时文件系统

镜像已经包含 bash、curl、git、jq 和 Python 3。运行中的 Agent 无权执行 `apk add`；需要新系统工具时，应修改 `Dockerfile` 并重建容器，这样环境才能复现。

## 调整限制

在执行 `create` 前设置环境变量：

```bash
export LIGHTCLAW_SANDBOX_CPUS=2
export LIGHTCLAW_SANDBOX_MEMORY=1g
export LIGHTCLAW_SANDBOX_PIDS_LIMIT=256
export LIGHTCLAW_SANDBOX_NETWORK=none
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

`LIGHTCLAW_SANDBOX_NETWORK=none` 会阻止工具访问网络，但宿主机上的飞书连接和大模型请求不受影响。需要 git、curl 等联网工具时，在创建容器前显式设置 `LIGHTCLAW_SANDBOX_NETWORK=bridge`。

## 频道文件访问边界

共享容器挂载整个工作区；频道专用容器只挂载该频道目录，以及可选的只读 `.shared` 和 `/tmp` 临时文件系统。配置方式见[项目首页](../../../README.md#权限与执行配置)。未配置专用容器的频道默认回落共享容器，可用 `LIGHTCLAW_SANDBOX_FALLBACK=deny` 拒绝回落。

专用容器限制工具访问的文件范围，但宿主 Agent 仍会读取全局 `MEMORY.md` 并注入模型上下文，也会加载全局技能元数据。容器挂载隔离不等于完整的频道信息或多租户隔离。

## 管理命令

```bash
bash packages/lightclaw/docker.sh status
bash packages/lightclaw/docker.sh stop
bash packages/lightclaw/docker.sh start
bash packages/lightclaw/docker.sh shell
bash packages/lightclaw/docker.sh remove
```

旧容器不会自动获得新限制。升级后需要执行一次：

```bash
bash packages/lightclaw/docker.sh remove
bash packages/lightclaw/docker.sh create ./lightclaw-data
```

Docker 沙箱能显著缩小影响范围，但不是绝对安全边界。不要挂载敏感目录；给 GitHub 等外部服务使用最小权限的专用凭证。
