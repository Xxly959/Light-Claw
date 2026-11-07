#!/usr/bin/env bash
# LightClaw 启动封装：从仓库根的 .env 载入凭证，然后启动 Node Agent。
#
# 为什么需要它：packages/lightclaw/src/main.ts 不会自动加载 .env，
# loadConfig() 直接读 process.env，缺 LIGHTCLAW_FEISHU_APP_ID 就退出。
# 直接把凭证 export 在当前终端里只对那个进程有效，换终端即失效，
# 所以用本脚本把「读 .env -> 校验 -> 启动」固定下来。
#
# 用法：
#   ./scripts/start-lightclaw.sh              # 用 .env 里的默认工作目录与沙箱
#   ./scripts/start-lightclaw.sh --sandbox=host
#   额外参数会原样透传给 main.ts。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
else
	echo "未找到 $ENV_FILE" >&2
	echo "先执行：cp packages/lightclaw/config.env.example .env，然后填入飞书应用凭证" >&2
	exit 1
fi

TRANSPORT="${LIGHTCLAW_TRANSPORT:-feishu}"
missing=""
if [[ "$TRANSPORT" == "feishu" ]]; then
	[[ -n "${LIGHTCLAW_FEISHU_APP_ID:-}" ]] || missing="$missing LIGHTCLAW_FEISHU_APP_ID"
	[[ -n "${LIGHTCLAW_FEISHU_APP_SECRET:-}" ]] || missing="$missing LIGHTCLAW_FEISHU_APP_SECRET"
elif [[ "$TRANSPORT" == "slack" ]]; then
	[[ -n "${LIGHTCLAW_SLACK_APP_TOKEN:-}" ]] || missing="$missing LIGHTCLAW_SLACK_APP_TOKEN"
	[[ -n "${LIGHTCLAW_SLACK_BOT_TOKEN:-}" ]] || missing="$missing LIGHTCLAW_SLACK_BOT_TOKEN"
else
	echo "LIGHTCLAW_TRANSPORT 只支持 feishu 或 slack，当前：$TRANSPORT" >&2
	exit 1
fi

if [[ -n "$missing" ]]; then
	echo "缺少环境变量：$missing" >&2
	echo "请在 $ENV_FILE 中补齐（格式参考 packages/lightclaw/config.env.example）" >&2
	exit 1
fi

TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
	echo "tsx 不可执行：$TSX_BIN" >&2
	echo "先在仓库根执行 npm install" >&2
	exit 1
fi

WORK_DIR="${LIGHTCLAW_WORK_DIR:-$REPO_ROOT/lightclaw-data}"
SANDBOX="${LIGHTCLAW_SANDBOX:-host}"

case "$WORK_DIR" in
/*) ;;
*) WORK_DIR="$REPO_ROOT/$WORK_DIR" ;;
esac

echo "启动：transport=$TRANSPORT sandbox=$SANDBOX workdir=$WORK_DIR" >&2

cd "$REPO_ROOT"
exec "$TSX_BIN" "$REPO_ROOT/packages/lightclaw/src/main.ts" "--sandbox=$SANDBOX" "$WORK_DIR" "$@"
