#!/bin/sh
# 发布到 npm。
#
#   用法 1（推荐）：./scripts/publish.sh <6位验证码> [dist-tag]
#   用法 2（自己在终端里跑，让 pnpm 交互式提示验证码）：
#                   ./scripts/publish.sh
#
# 为什么要包一层：
#   · 这台机器 PATH 上没有 node（DSH 自带的 node 发行版里也不含 npm），
#     而 prepublishOnly 要跑 node scripts/build-client.mjs —— 脚本里把 shim 目录
#     加进 PATH。
#   · 发布必须有 2FA 验证码：registry 的规则是「2FA 验证码，或带 bypass-2FA 的
#     token」。后者正被 npm 逐步废除（见 docs/PUBLISHING.md 第 5 节），所以走验证码。
#   · 验证码 30 秒过期。用法 1 适合「码已经在你手里」；用法 2 让 pnpm 自己提示，
#     适合码还没拿到、或者不想来回粘贴。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${SHEJING_NODE:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
PNPM="${SHEJING_PNPM:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs}"

OTP="$1"
TAG="${2:-latest}"

# prepublishOnly 会跑 node，所以让 shim 里的 node 可见
PATH="$ROOT/.dev/bin:$PATH"
export PATH

cd "$ROOT"
NAME="$("$NODE" -e 'process.stdout.write(require("./package.json").name)')"
VERSION="$("$NODE" -e 'process.stdout.write(require("./package.json").version)')"
echo "包：$NAME@$VERSION    tag：$TAG"
if [ -z "$OTP" ]; then
  echo "未给验证码 —— 交给 pnpm 自己提示（需要终端可交互）。"
  echo "如果你在非交互环境里跑（比如被脚本调用），请改用：./scripts/publish.sh <验证码>"
  echo
  exec "$NODE" "$PNPM" publish --no-git-checks --tag "$TAG"
fi
echo

exec "$NODE" "$PNPM" publish --no-git-checks --tag "$TAG" --otp "$OTP"
