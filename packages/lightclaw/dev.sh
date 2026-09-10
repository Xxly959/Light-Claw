#!/usr/bin/env bash
set -e

CONTAINER_NAME="lightclaw-sandbox"
DATA_DIR="$(pwd)/lightclaw-data"

# 确保数据目录存在。
mkdir -p "$DATA_DIR"

# 复用已有沙箱，不存在时再创建。
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "正在启动已有容器：$CONTAINER_NAME"
        docker start "$CONTAINER_NAME"
    else
        echo "容器 $CONTAINER_NAME 已在运行"
    fi
else
    echo "正在创建容器：$CONTAINER_NAME"
    docker run -d \
        --name "$CONTAINER_NAME" \
        -v "$DATA_DIR:/workspace" \
        alpine:latest \
        tail -f /dev/null
fi

# 使用 tsx 监听源码并启动 LightClaw。
echo "正在以开发模式启动 LightClaw..."
npx tsx --watch-path src --watch src/main.ts --sandbox=docker:$CONTAINER_NAME ./lightclaw-data
