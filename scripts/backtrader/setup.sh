#!/usr/bin/env bash
# 安装组合模拟执行层依赖 (Python 3.10+)
# 用法: npm run sim:setup  或  bash scripts/backtrader/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="$ROOT/scripts/backtrader/.venv"

PYTHON_BIN="${PYTHON_BIN:-python3}"
"$PYTHON_BIN" -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip >/dev/null
"$VENV/bin/pip" install -r "$ROOT/scripts/backtrader/requirements.txt"

"$VENV/bin/python" - <<'PY'
import backtrader as bt
print(f"backtrader {bt.__version__} ready")
PY
