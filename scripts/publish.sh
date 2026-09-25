#!/bin/sh
# 发布到 npm。用法：./scripts/publish.sh <6位验证码>
#
# 为什么要包一层：
#   · 这台机器 PATH 上没有 node（DSH 自带的 node 发行版里也不含 npm），
#     而 prepublishOnly 要跑 node scripts/build-client.mjs —— 脚本里把 shim 目录
#     加进 PATH。
#   · 发布必须有 2FA 验证码：registry 的规则是「2FA 验证码，或带 bypass-2FA 的
#     token」。后者正被 npm 逐步废除（见 docs/PUBLISHING.md 第 5 节），所以走验证码。
#   · 验证码 30 秒过期，所以参数直接传给 pnpm，不做别的消耗时间的事。
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${SHEJING_NODE:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node}"
PNPM="${SHEJING_PNPM:-$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs}"

OTP="$1"
TAG="${2:-latest}"

if [ -z "$OTP" ]; then
  echo "用法：./scripts/publish.sh <6位验证码> [dist-tag]" >&2
  echo "验证码在 30 秒内有效，过期了重跑一次即可。" >&2
  exit 2
fi

# prepublishOnly 会跑 node，所以让 shim 里的 node 可见
PATH="$ROOT/.dev/bin:$PATH"
export PATH

cd "$ROOT"
echo "包：$(grep -m1 '"name"' package.json | sed 's/.*: *"//; s/".*//')@$(grep -m1 '"version"' package.json | sed 's/.*: *"//; s/".*//')"
echo "tag：$TAG"
echo

exec "$NODE" "$PNPM" publish --no-git-checks --tag "$TAG" --otp "$OTP"
