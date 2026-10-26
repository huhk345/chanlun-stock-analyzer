"""Part 2 — the router exercised in-process (no sockets, no network).

``handle_request`` is the same function the HTTP handler calls, so these tests
cover routing, validation, error mapping and payload shapes without the flakiness
of a real socket. Part 3 then proves the socket layer itself.
"""

from __future__ import annotations

import time

import pytest

from conftest import fresh_klines, wave_klines

pytestmark = pytest.mark.integration

SYMBOL = "000001.SZ"


# ---------------------------------------------------------------------------
# 健康检查 / 行情
# ---------------------------------------------------------------------------


def test_health(api):
    status, body = api("GET", "/api/health")
    assert status == 200
    assert body["ok"] is True
    assert body["engine"] == "python"
    assert body["stepperSessions"] == 0
    assert body["strategies"] >= 3


def test_klines_served_from_cache(api, seeded_cache):
    seeded_cache(SYMBOL, fresh_klines(120))
    status, body = api("GET", "/api/klines", query={"symbol": SYMBOL})
    assert status == 200
    assert body["cached"] is True
    assert body["period"] == "1d"
    assert len(body["klines"]) == 120
    assert set(body["klines"][0]) == {"date", "open", "high", "low", "close", "volume", "amount"}


def test_klines_requires_symbol(api):
    status, body = api("GET", "/api/klines")
    assert status == 400
    assert "symbol" in body["error"]


def test_klines_period_and_adjust_are_echoed(api, seeded_cache):
    seeded_cache(SYMBOL, fresh_klines(60), period="1w", adjust="backward")
    status, body = api(
        "GET", "/api/klines", query={"symbol": SYMBOL, "period": "1w", "adjust": "backward"}
    )
    assert status == 200
    assert body["period"] == "1w"
    assert body["adjust"] == "backward"


# ---------------------------------------------------------------------------
# 缠论结构
# ---------------------------------------------------------------------------


def test_chanlun_analyze_returns_structures(api):
    bars = wave_klines(400)
    status, body = api("POST", "/api/chanlun/analyze", {"klines": [k.to_dict() for k in bars]})
    assert status == 200
    assert len(body["mergedKlines"]) == 399
    assert len(body["strokes"]) == 13
    assert len(body["hubs"]) == 2
    assert body["bsPoints"]


def test_chanlun_bspoints_skips_segments(api):
    bars = wave_klines(400)
    status, body = api("POST", "/api/chanlun/bspoints", {"klines": [k.to_dict() for k in bars]})
    assert status == 200
    assert set(body) == {"strokes", "bsPoints"}
    assert body["bsPoints"]


def test_chanlun_requires_klines(api):
    status, body = api("POST", "/api/chanlun/analyze", {"klines": []})
    assert status == 400
    assert "klines" in body["error"]


# ---------------------------------------------------------------------------
# 策略注册表
# ---------------------------------------------------------------------------


def test_strategy_list_exposes_metadata_only(api):
    status, body = api("GET", "/api/strategies")
    assert status == 200
    ids = [s["id"] for s in body["strategies"]]
    assert "ma-cross" in ids and "chanlun-weekly-daily-thermometer" in ids
    for summary in body["strategies"]:
        assert summary["source"] == "builtin"
        assert "decide" not in summary
        assert isinstance(summary["params"], list)


def test_builtin_strategy_source_is_readable(api):
    status, body = api("GET", "/api/strategies/ma-cross/source")
    assert status == 200
    assert body["source"] == "builtin"
    assert body["language"] == "python"
    assert "def decide" in body["code"]


def test_unknown_strategy_source_404(api):
    status, _body = api("GET", "/api/strategies/nope/source")
    assert status == 404


# ---------------------------------------------------------------------------
# 单标的回测
# ---------------------------------------------------------------------------


def test_backtest_run_returns_detail_view(api, seeded_cache):
    seeded_cache(SYMBOL, fresh_klines(200))
    status, body = api(
        "POST",
        "/api/backtest/run",
        {"symbol": SYMBOL, "strategyId": "ma-cross", "initialCash": 100_000},
    )
    assert status == 200
    assert set(body) == {
        "symbol",
        "period",
        "adjust",
        "klinesCount",
        "dateRange",
        "result",
        "diagnostics",
        "equityCurve",
        "equityDates",
        "klines",
    }
    assert body["klinesCount"] == 200
    assert len(body["equityCurve"]) == 200
    assert len(body["equityDates"]) == 200
    assert body["result"]["initialBalance"] == 100_000
    assert set(body["result"]) >= {"totalReturnPercent", "sharpeRatio", "trades", "winRate"}


def test_backtest_run_reports_progress(api, seeded_cache):
    seeded_cache(SYMBOL, fresh_klines(80))
    progress_id = "bt-test-progress-1"
    status, _body = api(
        "POST",
        "/api/backtest/run",
        {"symbol": SYMBOL, "strategyId": "ma-cross", "progressId": progress_id},
    )
    assert status == 200

    status, body = api("GET", f"/api/backtest/progress/{progress_id}")
    assert status == 200
    assert body["phase"] == "done"
    assert body["klines"] == 80


def test_backtest_run_validates_input(api, seeded_cache):
    seeded_cache(SYMBOL, fresh_klines(60))
    status, body = api("POST", "/api/backtest/run", {"symbol": SYMBOL})
    assert status == 400
    assert "strategyId" in body["error"]

    status, body = api("POST", "/api/backtest/run", {"symbol": SYMBOL, "strategyId": "ghost"})
    assert status == 400
    assert "策略未找到" in body["error"]


def test_backtest_range_filter_is_applied(api, seeded_cache):
    bars = fresh_klines(200)
    seeded_cache(SYMBOL, bars)
    status, body = api(
        "POST",
        "/api/backtest/run",
        {
            "symbol": SYMBOL,
            "strategyId": "ma-cross",
            "rangeStart": bars[50].date,
            "rangeEnd": bars[149].date,
        },
    )
    assert status == 200
    assert body["dateRange"] == {"start": bars[50].date, "end": bars[149].date}
    assert body["klinesCount"] == 100


# ---------------------------------------------------------------------------
# 逐步回测会话
# ---------------------------------------------------------------------------


def test_stepper_session_lifecycle(api, seeded_cache):
    seeded_cache(SYMBOL, fresh_klines(60))

    status, created = api(
        "POST", "/api/backtest/stepper", {"symbol": SYMBOL, "strategyId": "ma-cross"}
    )
    assert status == 201
    session_id = created["sessionId"]
    assert created["totalSteps"] == 60
    assert created["state"]["currentStepIndex"] == 0
    assert created["tradeCount"] == 0

    status, stepped = api(
        "POST", f"/api/backtest/stepper/{session_id}/step", {"action": "forward"}
    )
    assert status == 200
    assert stepped["state"]["currentStepIndex"] == 1

    status, jumped = api(
        "POST", f"/api/backtest/stepper/{session_id}/step", {"action": "jump", "index": 30}
    )
    assert status == 200
    assert jumped["state"]["currentStepIndex"] == 30

    status, back = api(
        "POST", f"/api/backtest/stepper/{session_id}/step", {"action": "backward"}
    )
    assert status == 200
    assert back["state"]["currentStepIndex"] == 29

    status, ran = api("POST", f"/api/backtest/stepper/{session_id}/run-all")
    assert status == 200
    assert ran["totalSteps"] == 60
    assert "result" in ran and "equityCurve" in ran

    status, ledger = api("GET", f"/api/backtest/stepper/{session_id}/trades")
    assert status == 200
    assert len(ledger["trades"]) == len(ran["trades"])

    status, closed = api("DELETE", f"/api/backtest/stepper/{session_id}")
    assert status == 200 and closed["closed"] is True

    status, _body = api("GET", f"/api/backtest/stepper/{session_id}/trades")
    assert status == 404


def test_stepper_requires_index_for_jump(api, seeded_cache):
    seeded_cache(SYMBOL, fresh_klines(40))
    _status, created = api(
        "POST", "/api/backtest/stepper", {"symbol": SYMBOL, "strategyId": "ma-cross"}
    )
    status, body = api(
        "POST", f"/api/backtest/stepper/{created['sessionId']}/step", {"action": "jump"}
    )
    assert status == 400
    assert "index" in body["error"]


def test_stepper_unknown_session_404(api):
    status, _body = api("POST", "/api/backtest/stepper/deadbeef/step", {"action": "forward"})
    assert status == 404


# ---------------------------------------------------------------------------
# 选股池
# ---------------------------------------------------------------------------


def test_pool_job_completes_with_single_custom_symbol(api, seeded_cache):
    seeded_cache(SYMBOL, fresh_klines(120))

    status, created = api(
        "POST",
        "/api/backtest/pool",
        {"strategyId": "ma-cross", "indexes": [], "custom": [SYMBOL], "initialCash": 100_000},
    )
    assert status == 202
    job_id = created["jobId"]

    deadline = time.time() + 30
    view = created["job"]
    while view["state"] == "running" and time.time() < deadline:
        time.sleep(0.05)
        _status, view = api("GET", f"/api/backtest/pool/{job_id}")

    assert view["state"] == "done", view
    summary = view["result"]
    assert summary["tested"] == 1
    assert summary["universeSize"] == 1
    assert len(summary["rows"]) == 1
    assert summary["rows"][0]["symbol"] == SYMBOL
    assert summary["dateRange"]["start"]

    status, detail = api("GET", f"/api/backtest/pool/{job_id}/symbol/{SYMBOL}")
    assert status == 200
    assert detail["klinesCount"] == 120

    status, trades = api("GET", f"/api/backtest/pool/{job_id}/trades")
    assert status == 200
    assert trades["total"] == len(trades["trades"])


def test_pool_rejects_unknown_strategy(api):
    status, body = api(
        "POST", "/api/backtest/pool", {"strategyId": "ghost", "indexes": [], "custom": [SYMBOL]}
    )
    assert status == 400
    assert "策略未找到" in body["error"]


# ---------------------------------------------------------------------------
# 路由杂项
# ---------------------------------------------------------------------------


def test_unknown_path_404(api):
    status, body = api("GET", "/api/nope")
    assert status == 404
    assert body["error"] == "not found"


def test_wrong_method_405(api):
    status, body = api("PUT", "/api/health")
    assert status == 405
    assert body["error"] == "method not allowed"


def test_simulation_health_reports_not_ported(api):
    status, body = api("GET", "/api/simulation/health")
    assert status == 200
    assert body["ok"] is False
    assert "backtrader" in body["note"]


def test_scan_cache_is_an_explicit_stub(api):
    status, body = api("GET", "/api/scan/cache", query={"timeframe": "weekly"})
    assert status == 200
    assert body["timeframe"] == "weekly"
    assert body["rows"] == []
    assert "未实现" in body["note"]
