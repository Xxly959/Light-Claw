#!/usr/bin/env bash

# LightClaw Docker 沙箱管理脚本
# 用法：
#   ./docker.sh create <数据目录>   - 创建并启动容器
#   ./docker.sh start               - 启动容器
#   ./docker.sh stop                - 停止容器
#   ./docker.sh remove              - 删除容器
#   ./docker.sh status              - 查看容器状态
#   ./docker.sh shell               - 进入容器终端

CONTAINER_NAME="lightclaw-sandbox"
IMAGE="alpine:latest"

case "$1" in
  create)
    if [ -z "$2" ]; then
      echo "用法：$0 create <数据目录>"
      echo "示例：$0 create ./lightclaw-data"
      exit 1
    fi
    
    DATA_DIR=$(cd "$2" && pwd)
    
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "容器 '${CONTAINER_NAME}' 已存在。请先执行：$0 remove"
      exit 1
    fi
    
    echo "正在创建容器 '${CONTAINER_NAME}'..."
    echo "  数据目录：${DATA_DIR} -> /workspace"
    
    docker run -d \
      --name "$CONTAINER_NAME" \
      -v "${DATA_DIR}:/workspace" \
      "$IMAGE" \
      tail -f /dev/null
    
    if [ $? -eq 0 ]; then
      echo "容器已创建并正在运行。"
      echo ""
      echo "运行 LightClaw：npx tsx packages/lightclaw/src/main.ts --sandbox=docker:${CONTAINER_NAME} $2"
    else
      echo "容器创建失败。"
      exit 1
    fi
    ;;
    
  start)
    echo "正在启动容器 '${CONTAINER_NAME}'..."
    docker start "$CONTAINER_NAME"
    ;;
    
  stop)
    echo "正在停止容器 '${CONTAINER_NAME}'..."
    docker stop "$CONTAINER_NAME"
    ;;
    
  remove)
    echo "正在删除容器 '${CONTAINER_NAME}'..."
    docker rm -f "$CONTAINER_NAME"
    ;;
    
  status)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "容器 '${CONTAINER_NAME}' 正在运行。"
      docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.ID}}\t{{.Image}}\t{{.Status}}"
    elif docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "容器 '${CONTAINER_NAME}' 已存在，但没有运行。"
      echo "执行以下命令启动：$0 start"
    else
      echo "容器 '${CONTAINER_NAME}' 不存在。"
      echo "执行以下命令创建：$0 create <数据目录>"
    fi
    ;;
    
  shell)
    echo "正在进入容器 '${CONTAINER_NAME}'..."
    docker exec -it "$CONTAINER_NAME" /bin/sh
    ;;
    
  *)
    echo "LightClaw Docker 沙箱管理"
    echo ""
    echo "用法：$0 <命令> [参数]"
    echo ""
    echo "命令："
    echo "  create <数据目录>  - 创建并启动容器"
    echo "  start              - 启动容器"
    echo "  stop               - 停止容器"
    echo "  remove             - 删除容器"
    echo "  status             - 查看容器状态"
    echo "  shell              - 进入容器终端"
    ;;
esac
