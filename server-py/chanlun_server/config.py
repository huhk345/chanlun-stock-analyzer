"""Runtime configuration (env-var driven, same names as the Node server)."""

from __future__ import annotations

import os
import pathlib
from typing import Optional


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


#: repository root (``server-py/chanlun_server/config.py`` -> up two levels)
ROOT_DIR = pathlib.Path(__file__).resolve().parents[2]

CACHE_DIR = pathlib.Path(
    os.environ.get("KLINE_CACHE_DIR") or (ROOT_DIR / ".cache" / "klines")
).resolve()
USER_STRATEGY_DIR = pathlib.Path(
    os.environ.get("USER_STRATEGY_DIR") or (ROOT_DIR / "data" / "user-strategies")
).resolve()
PUBLIC_DIR = ROOT_DIR / "public"
DATA_DIR = ROOT_DIR / "data"

PORT = int(os.environ.get("PORT") or 8899)
HOST = os.environ.get("HOST") or "127.0.0.1"

#: ``tencent`` (default, no key) or ``tickflow`` (legacy fallback)
KLINE_SOURCE = (os.environ.get("KLINE_SOURCE") or "tencent").lower()

TICKFLOW_API_KEY = os.environ.get("TICKFLOW_API_KEY") or os.environ.get(
    "VITE_TICKFLOW_API_KEY", ""
)
TICKFLOW_BASE_URL = (
    "https://api.tickflow.org" if TICKFLOW_API_KEY else "https://free-api.tickflow.org"
)

#: 腾讯全局限速 (次/秒); 实测持续 ~25/s 会触发 WAF
TENCENT_RPS = max(1.0, _float_env("TENCENT_RPS", 15.0))

#: 增量 K 线复权校验阈值 (相对偏差)
ADJUST_MISMATCH_TOLERANCE = max(1e-9, _float_env("KLINE_ADJUST_TOLERANCE", 0.0005))

#: 回测默认参数
DEFAULT_INITIAL_CASH = 100_000.0
DEFAULT_COMMISSION_RATE = 0.00025
DEFAULT_MIN_COMMISSION = 5.0


def env_flag(name: str) -> Optional[bool]:
    raw = os.environ.get(name)
    if raw is None:
        return None
    return raw.strip().lower() in {"1", "true", "yes", "on"}
