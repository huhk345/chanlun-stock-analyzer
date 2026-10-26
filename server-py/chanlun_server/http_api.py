"""HTTP surface — same routes and payloads as the Node server.

The router is a pure function :func:`handle_request` (method, path, query, body)
-> (status, payload) so integration tests can exercise the whole API in-process
without opening a socket. :func:`create_server` wraps it in a
``ThreadingHTTPServer`` for real traffic.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import config, progress
from .chanlun import compute_strokes_and_bs_points, run_chanlun_pipeline
from .klines import get_klines
from .models import klines_from_raw
from .pool import get_pool_backtest_job, request_pool_backtest
from .service import (
    ApiError,
    active_stepper_sessions,
    close_stepper_session,
    create_stepper_session,
    run_all_stepper_session,
    run_server_backtest,
    step_stepper_session,
    stepper_session_trades,
)
from .strategy_store import (
    StrategyStoreError,
    builtin_ids,
    delete_stored_strategy,
    get_stored_strategy,
    import_stored_strategies,
    list_stored_strategies,
    save_stored_strategy,
    user_strategy_source,
)
from .strategies import list_strategy_summaries, load_strategies

MAX_BODY_BYTES = 64 * 1024 * 1024

Response = Tuple[int, Any]


# ---------------------------------------------------------------------------
# 路由表
# ---------------------------------------------------------------------------


def _route_health(query: Dict[str, str], body: Any) -> Response:
    return 200, {
        "ok": True,
        "uptime": _uptime(),
        "stepperSessions": active_stepper_sessions(),
        "engine": "python",
        "strategies": len(load_strategies()),
    }


_START_TIME = __import__("time").time()


def _uptime() -> float:
    return round(__import__("time").time() - _START_TIME, 3)


def _route_klines(query: Dict[str, str], body: Any) -> Response:
    symbol = query.get("symbol")
    if not symbol:
        raise ApiError("symbol required", 400)
    period = "1w" if query.get("period") == "1w" else "1d"
    try:
        count = int(query.get("count") or 400)
    except ValueError:
        count = 400
    count = min(max(count, 30), 5000)
    adjust = query.get("adjust") or "forward"
    force = query.get("refresh") == "1" or query.get("force") == "1"

    result = get_klines(symbol, period, count, adjust, force)
    return 200, {
        "symbol": result.symbol,
        "period": result.period,
        "adjust": result.adjust,
        "klines": [k.to_dict() for k in result.klines],
        "cached": result.cached,
        "updatedAt": int(result.updated_at),
    }


def _route_strategies(query: Dict[str, str], body: Any) -> Response:
    return 200, {"strategies": list_strategy_summaries()}


def _route_strategies_user(query: Dict[str, str], body: Any) -> Response:
    return 200, {"strategies": list_stored_strategies()}


def _route_strategy_create(query: Dict[str, str], body: Any) -> Response:
    strategy = save_stored_strategy(body, reserved_ids=builtin_ids())
    return 201, {"strategy": strategy}


def _route_strategy_import(query: Dict[str, str], body: Any) -> Response:
    return 200, import_stored_strategies(body)


def _route_strategy_source(strategy_id: str, query: Dict[str, str], body: Any) -> Response:
    from .strategies import find_strategy

    builtin = find_strategy(strategy_id)
    if builtin is not None and builtin.source == "builtin":
        module_name = _builtin_module_for(strategy_id)
        return 200, {
            "id": builtin.id,
            "name": builtin.name,
            "language": "python",
            "source": "builtin",
            "module": module_name,
            "code": _read_module_source(module_name),
        }
    stored = get_stored_strategy(strategy_id)
    if stored is not None:
        return 200, user_strategy_source(stored)
    raise ApiError(f"策略源码未找到: {strategy_id}", 404)


def _builtin_module_for(strategy_id: str) -> str:
    return strategy_id.replace("-", "_")


def _read_module_source(module_name: str) -> str:
    import pathlib

    path = pathlib.Path(__file__).with_name("strategies") / f"{module_name}.py"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return f"# 源码文件不可读: {path.name}"


def _route_strategy_delete(strategy_id: str, query: Dict[str, str], body: Any) -> Response:
    if not delete_stored_strategy(strategy_id):
        raise ApiError(f"用户策略不存在: {strategy_id} (内置策略不可删除)", 404)
    return 200, {"deleted": strategy_id}


def _route_scan_cache(query: Dict[str, str], body: Any) -> Response:
    timeframe = "weekly" if query.get("timeframe") == "weekly" else "daily"
    return 200, {
        "timeframe": timeframe,
        "rows": [],
        "flows": {},
        "updatedAt": None,
        "note": "Python 服务端未实现缠论买卖点全市场扫描 (见 README 的移植说明)",
    }


def _route_chanlun_analyze(query: Dict[str, str], body: Any) -> Response:
    klines = klines_from_raw((body or {}).get("klines"))
    if not klines:
        raise ApiError("klines: Kline[] required", 400)
    return 200, run_chanlun_pipeline(klines)


def _route_chanlun_bspoints(query: Dict[str, str], body: Any) -> Response:
    klines = klines_from_raw((body or {}).get("klines"))
    if not klines:
        raise ApiError("klines: Kline[] required", 400)
    strokes, points = compute_strokes_and_bs_points(klines)
    return 200, {
        "strokes": [s.to_dict() for s in strokes],
        "bsPoints": [p.to_dict() for p in points],
    }


def _route_backtest_run(query: Dict[str, str], body: Any) -> Response:
    payload = body or {}
    progress_id = payload.get("progressId")
    progress_id = progress_id if progress.is_progress_id(progress_id) else None
    if progress_id:
        progress.begin(progress_id)

    def report(update: Dict[str, Any]) -> None:
        if progress_id:
            progress.update(progress_id, **update)

    try:
        output = run_server_backtest(payload, report if progress_id else None)
    except Exception as exc:  # noqa: BLE001
        if progress_id:
            progress.update(progress_id, phase="error", message="回测失败", error=str(exc))
        raise

    if progress_id:
        progress.update(
            progress_id,
            phase="done",
            message=f"回测完成 ({output['klinesCount']} 根 K 线)",
            klines=output["klinesCount"],
        )
    return 200, output


def _route_backtest_progress(progress_id: str, query: Dict[str, str], body: Any) -> Response:
    if not progress.is_progress_id(progress_id):
        raise ApiError("进度不存在或已过期", 404)
    entry = progress.get(progress_id)
    if entry is None:
        raise ApiError("进度不存在或已过期", 404)
    return 200, entry.to_dict()


def _route_stepper_create(query: Dict[str, str], body: Any) -> Response:
    return 201, create_stepper_session(body or {})


def _route_stepper_step(session_id: str, query: Dict[str, str], body: Any) -> Response:
    payload = body or {}
    action = str(payload.get("action") or "forward")
    index = payload.get("index")
    index = int(index) if isinstance(index, (int, float)) and not isinstance(index, bool) else None
    return 200, step_stepper_session(session_id, action, index)


def _route_stepper_run_all(session_id: str, query: Dict[str, str], body: Any) -> Response:
    return 200, run_all_stepper_session(session_id)


def _route_stepper_trades(session_id: str, query: Dict[str, str], body: Any) -> Response:
    return 200, stepper_session_trades(session_id)


def _route_stepper_close(session_id: str, query: Dict[str, str], body: Any) -> Response:
    return 200, {"closed": close_stepper_session(session_id)}


def _route_pool_create(query: Dict[str, str], body: Any) -> Response:
    job, attached = request_pool_backtest(body or {})
    return (200 if attached else 202), {"jobId": job.id, "attached": attached, "job": job.view()}


def _route_pool_view(job_id: str, query: Dict[str, str], body: Any) -> Response:
    job = get_pool_backtest_job(job_id)
    if job is None:
        raise ApiError("任务不存在或已过期", 404)
    return 200, job.view()


def _route_pool_cancel(job_id: str, query: Dict[str, str], body: Any) -> Response:
    job = get_pool_backtest_job(job_id)
    if job is None:
        raise ApiError("任务不存在或已过期", 404)
    job.cancel()
    return 200, job.view()


def _route_pool_symbol(job_id: str, symbol: str, query: Dict[str, str], body: Any) -> Response:
    job = get_pool_backtest_job(job_id)
    if job is None:
        raise ApiError("任务不存在或已过期", 404)
    detail = job.symbol_detail(symbol)
    if detail is None:
        raise ApiError(f"任务中不存在标的 {symbol} 的结果", 404)
    return 200, detail


def _route_pool_trades(job_id: str, query: Dict[str, str], body: Any) -> Response:
    job = get_pool_backtest_job(job_id)
    if job is None:
        raise ApiError("任务不存在或已过期", 404)
    return 200, job.all_trades()


def _route_simulation_health(query: Dict[str, str], body: Any) -> Response:
    return 200, {
        "ok": False,
        "engine": "python",
        "note": (
            "共享资金逐日组合模拟仍由 backtrader 引擎执行 "
            "(scripts/backtrader/runner.py + Node 服务端 /api/simulation/*); "
            "Python 服务端未移植该接口"
        ),
    }


# (method, regex, handler) — regex groups are passed as positional args after match
ROUTES: List[Tuple[str, re.Pattern[str], Callable[..., Response]]] = [
    ("GET", re.compile(r"^/api/health$"), _route_health),
    ("GET", re.compile(r"^/api/klines$"), _route_klines),
    ("GET", re.compile(r"^/api/strategies$"), _route_strategies),
    ("POST", re.compile(r"^/api/strategies$"), _route_strategy_create),
    ("POST", re.compile(r"^/api/strategies/import$"), _route_strategy_import),
    ("GET", re.compile(r"^/api/strategies/user$"), _route_strategies_user),
    ("GET", re.compile(r"^/api/strategies/([^/]+)/source$"), _route_strategy_source),
    ("DELETE", re.compile(r"^/api/strategies/([^/]+)$"), _route_strategy_delete),
    ("GET", re.compile(r"^/api/scan/cache$"), _route_scan_cache),
    ("POST", re.compile(r"^/api/chanlun/analyze$"), _route_chanlun_analyze),
    ("POST", re.compile(r"^/api/chanlun/bspoints$"), _route_chanlun_bspoints),
    ("POST", re.compile(r"^/api/backtest/run$"), _route_backtest_run),
    ("GET", re.compile(r"^/api/backtest/progress/([^/]+)$"), _route_backtest_progress),
    ("POST", re.compile(r"^/api/backtest/stepper$"), _route_stepper_create),
    ("POST", re.compile(r"^/api/backtest/stepper/([^/]+)/step$"), _route_stepper_step),
    ("POST", re.compile(r"^/api/backtest/stepper/([^/]+)/run-all$"), _route_stepper_run_all),
    ("GET", re.compile(r"^/api/backtest/stepper/([^/]+)/trades$"), _route_stepper_trades),
    ("DELETE", re.compile(r"^/api/backtest/stepper/([^/]+)$"), _route_stepper_close),
    ("POST", re.compile(r"^/api/backtest/pool$"), _route_pool_create),
    ("GET", re.compile(r"^/api/backtest/pool/([^/]+)$"), _route_pool_view),
    ("POST", re.compile(r"^/api/backtest/pool/([^/]+)/cancel$"), _route_pool_cancel),
    ("GET", re.compile(r"^/api/backtest/pool/([^/]+)/trades$"), _route_pool_trades),
    ("GET", re.compile(r"^/api/backtest/pool/([^/]+)/symbol/([^/]+)$"), _route_pool_symbol),
    ("GET", re.compile(r"^/api/simulation/health$"), _route_simulation_health),
]


def handle_request(
    method: str, path: str, query: Optional[Dict[str, str]] = None, body: Any = None
) -> Response:
    """Pure router: never raises, always returns ``(status, payload)``."""
    query = query or {}
    method = method.upper()

    for route_method, pattern, handler in ROUTES:
        if route_method != method:
            continue
        match = pattern.match(path)
        if not match:
            continue
        groups = [urllib.parse.unquote(g) for g in match.groups()]
        try:
            return handler(*groups, query, body)
        except ApiError as exc:
            return exc.status, {"error": exc.message}
        except StrategyStoreError as exc:
            return exc.status_code, {"error": str(exc)}
        except ValueError as exc:
            return 400, {"error": str(exc)}
        except Exception as exc:  # noqa: BLE001
            return 500, {"error": str(exc)}

    allowed = [m for m, pattern, _ in ROUTES if pattern.match(path)]
    if allowed:
        return 405, {"error": "method not allowed"}
    return 404, {"error": "not found"}


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "chanlun-py/1.0"
    protocol_version = "HTTP/1.1"

    def _send(self, status: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        if status != 204:
            self.wfile.write(raw)

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        body: Any = None
        if method in ("POST", "PUT", "PATCH"):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY_BYTES:
                self._send(413, {"error": "request body too large"})
                return
            raw = self.rfile.read(length) if length else b""
            if raw:
                try:
                    body = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._send(400, {"error": "invalid JSON body"})
                    return
        status, payload = handle_request(method, parsed.path, query, body)
        self._send(status, payload)

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def do_PUT(self) -> None:  # noqa: N802
        # Routed (not rejected by BaseHTTPRequestHandler) so the client gets the
        # same JSON 405 contract as every other unsupported method.
        self._dispatch("PUT")

    def do_PATCH(self) -> None:  # noqa: N802
        self._dispatch("PATCH")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, {})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[chanlun-py] {self.address_string()} {fmt % args}")


def create_server(host: str = config.HOST, port: int = config.PORT) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), ApiHandler)
    server.daemon_threads = True
    return server


def serve(host: str = config.HOST, port: int = config.PORT) -> None:
    server = create_server(host, port)
    print(f"[chanlun-server-py] listening on http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[chanlun-server-py] shutting down")
    finally:
        server.server_close()
