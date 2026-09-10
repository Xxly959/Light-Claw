FROM alpine:latest

# 常用工具在构建阶段安装；运行时使用非 root 用户，Agent 不能修改系统环境。
RUN apk add --no-cache bash curl git jq python3 \
    && addgroup -g 1000 lightclaw \
    && adduser -D -u 1000 -G lightclaw lightclaw

WORKDIR /workspace
USER lightclaw

CMD ["tail", "-f", "/dev/null"]
