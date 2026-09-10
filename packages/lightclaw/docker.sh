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
IMAGE="lightclaw-sandbox:local"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SANDBOX_CPUS="${LIGHTCLAW_SANDBOX_CPUS:-1.0}"
SANDBOX_MEMORY="${LIGHTCLAW_SANDBOX_MEMORY:-512m}"
SANDBOX_PIDS="${LIGHTCLAW_SANDBOX_PIDS_LIMIT:-128}"
SANDBOX_NETWORK="${LIGHTCLAW_SANDBOX_NETWORK:-bridge}"

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
    echo "  限额：CPU ${SANDBOX_CPUS}，内存 ${SANDBOX_MEMORY}，进程 ${SANDBOX_PIDS}，网络 ${SANDBOX_NETWORK}"

    echo "正在构建最小权限镜像..."
    docker build -q -t "$IMAGE" -f "${SCRIPT_DIR}/Dockerfile" "$SCRIPT_DIR" || exit 1
    
    docker run -d \
      --name "$CONTAINER_NAME" \
      --cpus "$SANDBOX_CPUS" \
      --memory "$SANDBOX_MEMORY" \
      --memory-swap "$SANDBOX_MEMORY" \
      --pids-limit "$SANDBOX_PIDS" \
      --network "$SANDBOX_NETWORK" \
      --user "$(id -u):$(id -g)" \
      -e HOME=/tmp/lightclaw \
      --cap-drop ALL \
      --security-opt no-new-privileges:true \
      --tmpfs /tmp:rw,nosuid,nodev,size=64m \
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
