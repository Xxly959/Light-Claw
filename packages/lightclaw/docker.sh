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
# 默认不联网。需要访问内部 registry 或代理时显式设置 LIGHTCLAW_SANDBOX_NETWORK。
SANDBOX_NETWORK="${LIGHTCLAW_SANDBOX_NETWORK:-none}"

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
    if [ "$SANDBOX_NETWORK" != "none" ]; then
      echo "  警告：网络模式 ${SANDBOX_NETWORK} 允许容器出网，Agent 可把数据发往外部地址。"
    fi

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
    
  create-channel)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "用法：$0 create-channel <数据目录> <频道ID>"
      echo "示例：$0 create-channel ./lightclaw-data C0123ABCD"
      exit 1
    fi
    DATA_DIR=$(cd "$2" && pwd) || exit 1
    CHANNEL_ID="$3"
    if ! printf '%s' "$CHANNEL_ID" | grep -Eq '^[A-Za-z0-9_-]{1,128}$'; then
      echo "频道 ID 只能包含字母、数字、下划线和连字符，最长 128 个字符。"
      exit 1
    fi

    CHANNEL_DIR="${DATA_DIR}/${CHANNEL_ID}"
    mkdir -p "$CHANNEL_DIR"
    CHANNEL_CONTAINER="lightclaw-chan-${CHANNEL_ID}"

    if docker ps -a --format '{{.Names}}' | grep -q "^${CHANNEL_CONTAINER}$"; then
      echo "容器 '${CHANNEL_CONTAINER}' 已存在。请先执行：$0 remove-channel ${CHANNEL_ID}"
      exit 1
    fi

    echo "正在创建频道容器 '${CHANNEL_CONTAINER}'..."
    echo "  频道目录：${CHANNEL_DIR} -> /workspace/${CHANNEL_ID}"
    echo "  限额：CPU ${SANDBOX_CPUS}，内存 ${SANDBOX_MEMORY}，进程 ${SANDBOX_PIDS}，网络 ${SANDBOX_NETWORK}"
    if [ "$SANDBOX_NETWORK" != "none" ]; then
      echo "  警告：网络模式 ${SANDBOX_NETWORK} 允许容器出网，Agent 可把数据发往外部地址。"
    fi

    echo "正在构建最小权限镜像..."
    docker build -q -t "$IMAGE" -f "${SCRIPT_DIR}/Dockerfile" "$SCRIPT_DIR" || exit 1

    MOUNTS=(-v "${CHANNEL_DIR}:/workspace/${CHANNEL_ID}")
    if [ -d "${DATA_DIR}/.shared" ]; then
      MOUNTS+=(-v "${DATA_DIR}/.shared:/workspace/.shared:ro")
      echo "  共享目录：${DATA_DIR}/.shared -> /workspace/.shared（只读）"
    fi

    docker run -d \
      --name "$CHANNEL_CONTAINER" \
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
      "${MOUNTS[@]}" \
      "$IMAGE" \
      tail -f /dev/null

    if [ $? -eq 0 ]; then
      echo "频道容器已创建并正在运行。"
      echo ""
      echo "在环境中登记：export LIGHTCLAW_CHANNEL_CONTAINERS_JSON='{\"${CHANNEL_ID}\":\"${CHANNEL_CONTAINER}\"}'"
    else
      echo "频道容器创建失败。"
      exit 1
    fi
    ;;

  remove-channel)
    if [ -z "$2" ]; then
      echo "用法：$0 remove-channel <频道ID>"
      exit 1
    fi
    CHANNEL_CONTAINER="lightclaw-chan-$2"
    echo "正在删除频道容器 '${CHANNEL_CONTAINER}'..."
    docker rm -f "$CHANNEL_CONTAINER"
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
    echo "  create <数据目录>  - 创建并启动共享容器"
    echo "  create-channel <数据目录> <频道ID> - 创建只挂该频道目录的专属容器"
    echo "  remove-channel <频道ID> - 删除频道容器"
    echo "  start              - 启动容器"
    echo "  stop               - 停止容器"
    echo "  remove             - 删除容器"
    echo "  status             - 查看容器状态"
    echo "  shell              - 进入容器终端"
    ;;
esac
