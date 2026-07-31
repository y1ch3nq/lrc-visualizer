#!/bin/zsh
set -e

cd -- "$(dirname "$0")"

node_bin="/Users/qianyichen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

if [[ ! -x "$node_bin" ]]; then
  echo "Codex bundled Node runtime was not found. Install Node.js LTS, then run: npm run dev"
  exit 1
fi

if [[ ! -f "./node_modules/vite/bin/vite.js" ]]; then
  echo "Project dependencies are missing. Install Node.js LTS, then run: npm install"
  exit 1
fi

exec "$node_bin" ./node_modules/vite/bin/vite.js --host 127.0.0.1
