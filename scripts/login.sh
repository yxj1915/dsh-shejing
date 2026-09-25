#!/bin/sh
# 登录 npm。**只有你能跑这一步**——它要交互式 2FA（浏览器 / 一次性验证码）。
#
# 为什么不用 npm：这台机器 PATH 上没有 npm，DSH 自带的 node 发行版里也没带它。
# 但 DSH 自带的 pnpm 11.7 自带 login 与 publish，够用。
#
# 用法：./scripts/login.sh          # 登录
#       ./scripts/login.sh whoami   # 看当前登录的是谁
set -e

NODE="${SHEJING_NODE:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
PNPM="${SHEJING_PNPM:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs}"

if [ ! -x "$NODE" ]; then
  echo "找不到 DSH 自带的 node：$NODE" >&2
  echo "可以用 SHEJING_NODE 指定一个。" >&2
  exit 1
fi

if [ "$1" = "whoami" ]; then
  echo "当前 npm 身份：$("$NODE" "$PNPM" whoami 2>&1 || echo '（未登录）')"
  echo "npmrc：$([ -f "$HOME/.npmrc" ] && echo "$HOME/.npmrc 存在" || echo '尚未创建')"
  exit 0
fi

echo "即将启动 npm 登录（走浏览器 + 2FA）。"
echo "完成后凭据写在 ~/.npmrc。"
echo
exec "$NODE" "$PNPM" login "$@"
