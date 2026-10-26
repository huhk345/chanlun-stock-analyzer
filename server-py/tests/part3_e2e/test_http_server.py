"""Part 3 — end-to-end: a real server process answering real HTTP requests.

Nothing here is mocked: the test spawns ``python -m chanlun_server serve`` on an
ephemeral port, points its cache at a temp directory seeded with synthetic bars,
and talks to it over a socket. This is what catches mistakes the in-process tests
cannot see (JSON encoding, CORS headers, HTTP status codes, request parsing,
process startup and the CLI).
"""

from __future__ import annotations

import json
import pathlib
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest

from conftest import fresh_klines, seed_cache, wave_klines

pytestmark = pytest.mark.e2e

SERVER_PY = pathlib.Path(__file__).resolve().parents[2]
SYMBOL = "000001.SZ"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _decode(raw: str):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw  # non-JSON error page from the stdlib server


def _request(method: str, url: str, body=None, timeout: float = 30.0):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, _decode(response.read().decode("utf-8")), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, _decode(exc.read().decode("utf-8")), dict(exc.headers)


def _wait_for_health(base_url: str, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            status, body, _headers = _request("GET", f"{base_url}/api/health", timeout=2.0)
            if status == 200:
                return body
        except Exception as exc:  # noqa: BLE001 - server may still be starting
            last_error = exc
        time.sleep(0.1)
    raise AssertionError(f"server did not become healthy: {last_error}")


def _spawn(workdir: pathlib.Path, cache_dir: pathlib.Path, user_dir: pathlib.Path, log_path: pathlib.Path):
    """Start the server; retry once on a port race (bind-then-close is not atomic)."""
    env = {
        **dict(__import__("os").environ),
        "HOST": "127.0.0.1",
        "KLINE_CACHE_DIR": str(cache_dir),
        "USER_STRATEGY_DIR": str(user_dir),
        "PYTHONPATH": str(SERVER_PY),
    }
    last_error: Exception | None = None
    for _attempt in range(3):
        port = _free_port()
        env["PORT"] = str(port)
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "chanlun_server",
                    "serve",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                ],
                cwd=str(SERVER_PY),
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        base_url = f"http://127.0.0.1:{port}"
        try:
            _wait_for_health(base_url, timeout=20.0)
            return process, base_url, env
        except AssertionError as exc:  # pragma: no cover - only on port races
            last_error = exc
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
            time.sleep(0.2)
    raise AssertionError(f"could not start the server: {last_error}")


@pytest.fixture(scope="module")
def live_server(tmp_path_factory):
    """Spawn the real server with an isolated cache and user-strategy dir."""
    workdir = tmp_path_factory.mktemp("e2e")
    cache_dir = workdir / "klines"
    cache_dir.mkdir()
    user_dir = workdir / "user-strategies"
    user_dir.mkdir()

    seed_cache(cache_dir, SYMBOL, fresh_klines(220))
    seed_cache(cache_dir, "600519.SH", fresh_klines(160))

    log_path = workdir / "server.log"
    process, base_url, env = _spawn(workdir, cache_dir, user_dir, log_path)
    try:
        yield {"base_url": base_url, "env": env, "cache_dir": cache_dir, "log": log_path}
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover
            process.kill()
        if process.returncode not in (0, -15):
            print(log_path.read_text(encoding="utf-8", errors="replace"))


# ---------------------------------------------------------------------------
# 基础端点
# ---------------------------------------------------------------------------


def test_health_over_http(live_server):
    status, body, headers = _request("GET", f"{live_server['base_url']}/api/health")
    assert status == 200
    assert body["ok"] is True
    assert body["engine"] == "python"
    assert headers.get("Content-Type", "").startswith("application/json")
    assert headers.get("Access-Control-Allow-Origin") == "*"


def test_cors_preflight(live_server):
    status, _body, headers = _request("OPTIONS", f"{live_server['base_url']}/api/health")
    assert status == 204
    assert "POST" in headers.get("Access-Control-Allow-Methods", "")


def test_klines_endpoint_uses_the_seeded_cache(live_server):
    status, body, _headers = _request(
        "GET", f"{live_server['base_url']}/api/klines?symbol={SYMBOL}"
    )
    assert status == 200
    assert body["cached"] is True
    assert len(body["klines"]) == 220
    assert body["klines"][0]["date"] <= body["klines"][-1]["date"]


def test_strategies_endpoint(live_server):
    status, body, _headers = _request("GET", f"{live_server['base_url']}/api/strategies")
    assert status == 200
    ids = {s["id"] for s in body["strategies"]}
    assert {"ma-cross", "macd-trend", "chanlun-weekly-daily-thermometer"} <= ids


def test_chanlun_analyze_over_http(live_server):
    bars = [k.to_dict() for k in wave_klines(400)]
    status, body, _headers = _request(
        "POST", f"{live_server['base_url']}/api/chanlun/analyze", {"klines": bars}
    )
    assert status == 200
    assert len(body["mergedKlines"]) == 399
    assert body["bsPoints"]
    assert body["hubs"][0]["zg"] > body["hubs"][0]["zd"]


def test_backtest_run_over_http(live_server):
    status, body, _headers = _request(
        "POST",
        f"{live_server['base_url']}/api/backtest/run",
        {"symbol": SYMBOL, "strategyId": "ma-cross", "initialCash": 200_000, "progressId": "e2e-progress-1"},
    )
    assert status == 200
    assert body["klinesCount"] == 220
    assert len(body["equityCurve"]) == 220
    assert body["result"]["initialBalance"] == 200_000
    assert body["dateRange"]["start"] < body["dateRange"]["end"]

    status, progress, _headers = _request(
        "GET", f"{live_server['base_url']}/api/backtest/progress/e2e-progress-1"
    )
    assert status == 200
    assert progress["phase"] == "done"


def test_stepper_over_http(live_server):
    base = live_server["base_url"]
    status, created, _headers = _request(
        "POST", f"{base}/api/backtest/stepper", {"symbol": SYMBOL, "strategyId": "macd-trend"}
    )
    assert status == 201
    session_id = created["sessionId"]
    assert created["totalSteps"] == 220

    status, stepped, _headers = _request(
        "POST", f"{base}/api/backtest/stepper/{session_id}/step", {"action": "jump", "index": 100}
    )
    assert status == 200
    assert stepped["state"]["currentStepIndex"] == 100

    status, ran, _headers = _request(
        "POST", f"{base}/api/backtest/stepper/{session_id}/run-all"
    )
    assert status == 200
    assert ran["result"]["totalTrades"] >= 0

    status, closed, _headers = _request("DELETE", f"{base}/api/backtest/stepper/{session_id}")
    assert status == 200 and closed["closed"] is True


def test_user_strategy_roundtrip_over_http(live_server):
    base = live_server["base_url"]
    payload = {
        "id": "e2e-strategy",
        "name": "E2E 策略",
        "code": (
            "def decide(ctx):\n"
            "    if ctx.position.shares == 0 and ctx.current_index == 30:\n"
            "        return {'action': 'BUY', 'amount': {'unit': 'percent', 'value': 100}}\n"
            "    if ctx.position.shares > 0 and ctx.current_index == 60:\n"
            "        return {'action': 'SELL', 'amount': {'unit': 'shares', 'value': ctx.position.shares}}\n"
            "    return {'action': 'HOLD'}\n"
        ),
    }
    status, created, _headers = _request("POST", f"{base}/api/strategies", payload)
    assert status == 201

    status, body, _headers = _request(
        "POST", f"{base}/api/backtest/run", {"symbol": SYMBOL, "strategyId": "e2e-strategy"}
    )
    assert status == 200
    assert body["result"]["totalTrades"] == 2

    status, deleted, _headers = _request("DELETE", f"{base}/api/strategies/e2e-strategy")
    assert status == 200 and deleted["deleted"] == "e2e-strategy"


def test_pool_over_http(live_server):
    base = live_server["base_url"]
    status, created, _headers = _request(
        "POST",
        f"{base}/api/backtest/pool",
        {"strategyId": "ma-cross", "indexes": [], "custom": [SYMBOL], "initialCash": 100_000},
    )
    assert status == 202
    job_id = created["jobId"]

    view = created["job"]
    deadline = time.time() + 60
    while view["state"] == "running" and time.time() < deadline:
        time.sleep(0.1)
        _status, view, _headers = _request("GET", f"{base}/api/backtest/pool/{job_id}")

    assert view["state"] == "done"
    assert view["result"]["tested"] == 1
    assert view["result"]["rows"][0]["symbol"] == SYMBOL


def test_error_contracts(live_server):
    base = live_server["base_url"]

    status, body, _headers = _request("GET", f"{base}/api/does-not-exist")
    assert status == 404 and body["error"] == "not found"

    status, body, _headers = _request("PUT", f"{base}/api/health")
    assert status == 405

    status, body, _headers = _request("POST", f"{base}/api/backtest/run", {"symbol": SYMBOL})
    assert status == 400 and "strategyId" in body["error"]

    # malformed JSON must be rejected by the socket layer, not crash the worker
    request = urllib.request.Request(
        f"{base}/api/backtest/run",
        data=b"{oops",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with pytest.raises(urllib.error.HTTPError) as excinfo:
        urllib.request.urlopen(request, timeout=10)
    assert excinfo.value.code == 400


def test_server_survives_bad_requests(live_server):
    """The worker thread must not take the process down."""
    base = live_server["base_url"]
    for _ in range(3):
        _request("POST", f"{base}/api/chanlun/analyze", {"klines": "nope"})
    status, body, _headers = _request("GET", f"{base}/api/health")
    assert status == 200 and body["ok"] is True


def test_concurrent_requests_are_served(live_server):
    import concurrent.futures

    base = live_server["base_url"]

    def hit(_):
        return _request("GET", f"{base}/api/health", timeout=10)[0]

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        statuses = list(pool.map(hit, range(16)))
    assert statuses == [200] * 16


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_cli_backtest_reads_the_same_cache(live_server):
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "chanlun_server",
            "backtest",
            "--symbol",
            SYMBOL,
            "--strategy",
            "ma-cross",
        ],
        cwd=str(SERVER_PY),
        env=live_server["env"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["symbol"] == SYMBOL
    assert payload["klinesCount"] == 220
    assert "result" in payload and "equityCurve" not in payload


def test_cli_lists_strategies(live_server):
    result = subprocess.run(
        [sys.executable, "-m", "chanlun_server", "strategies"],
        cwd=str(SERVER_PY),
        env=live_server["env"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0
    ids = {row["id"] for row in json.loads(result.stdout)}
    assert "chanlun-weekly-daily-thermometer" in ids
