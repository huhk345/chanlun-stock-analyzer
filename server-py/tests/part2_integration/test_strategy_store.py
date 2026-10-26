"""Part 2 — user strategy persistence and the registry merge path."""

from __future__ import annotations

import pytest

from chanlun_server import strategy_store
from chanlun_server.strategies import find_strategy, load_strategies
from conftest import fresh_klines

pytestmark = pytest.mark.integration

VALID_CODE = """
def decide(ctx):
    if ctx.position.shares == 0 and ctx.current_index == 10:
        return {"action": "BUY", "amount": {"unit": "percent", "value": 50}, "reason": "user-buy"}
    if ctx.position.shares > 0 and ctx.current_index == 20:
        return {"action": "SELL", "amount": {"unit": "shares", "value": ctx.position.shares}}
    return {"action": "HOLD"}
"""


@pytest.fixture
def store_dir(tmp_path, monkeypatch):
    path = tmp_path / "user-strategies"
    path.mkdir()
    monkeypatch.setattr(strategy_store, "STORE_DIR", path)
    return path


def _payload(**overrides):
    payload = {
        "id": "my-test-strategy",
        "name": "测试策略",
        "description": "unit test",
        "code": VALID_CODE,
        "language": "python",
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# 存储
# ---------------------------------------------------------------------------


def test_save_list_get_delete(store_dir):
    record = strategy_store.save_stored_strategy(_payload())
    assert record["id"] == "my-test-strategy"
    assert (store_dir / "my-test-strategy.json").is_file()

    assert [r["id"] for r in strategy_store.list_stored_strategies()] == ["my-test-strategy"]
    assert strategy_store.get_stored_strategy("my-test-strategy")["name"] == "测试策略"

    assert strategy_store.delete_stored_strategy("my-test-strategy") is True
    assert strategy_store.list_stored_strategies() == []
    assert strategy_store.delete_stored_strategy("my-test-strategy") is False


def test_save_rejects_builtin_id_collision(store_dir):
    with pytest.raises(strategy_store.StrategyStoreError) as excinfo:
        strategy_store.save_stored_strategy(_payload(id="ma-cross"), reserved_ids={"ma-cross"})
    assert excinfo.value.status_code == 409


def test_save_rejects_non_python_language(store_dir):
    with pytest.raises(strategy_store.StrategyStoreError) as excinfo:
        strategy_store.save_stored_strategy(_payload(language="javascript"))
    assert "Python" in str(excinfo.value)


def test_save_rejects_broken_code(store_dir):
    with pytest.raises(strategy_store.StrategyStoreError):
        strategy_store.save_stored_strategy(_payload(code="def decide(ctx)\n  return None\n"))


def test_save_rejects_unsafe_code(store_dir):
    with pytest.raises(strategy_store.StrategyStoreError):
        strategy_store.save_stored_strategy(_payload(code="import os\n\ndef decide(ctx):\n    pass\n"))


def test_save_requires_id_name_and_code(store_dir):
    for broken in (_payload(id=""), _payload(name=""), _payload(code="")):
        with pytest.raises(strategy_store.StrategyStoreError):
            strategy_store.save_stored_strategy(broken)


def test_import_reports_per_item_errors(store_dir):
    result = strategy_store.import_stored_strategies(
        {"strategies": [_payload(), _payload(id="bad id with spaces")]}
    )
    assert result["imported"] == ["my-test-strategy"]
    assert len(result["errors"]) == 1


# ---------------------------------------------------------------------------
# 注册表合并
# ---------------------------------------------------------------------------


def test_user_strategy_joins_the_registry(store_dir):
    strategy_store.save_stored_strategy(_payload())
    ids = [s.id for s in load_strategies()]
    assert "my-test-strategy" in ids

    strategy = find_strategy("my-test-strategy")
    assert strategy is not None
    assert strategy.source == "user"


def test_user_strategy_runs_in_a_backtest(store_dir):
    from chanlun_server.runner import run_backtest

    strategy_store.save_stored_strategy(_payload())
    strategy = find_strategy("my-test-strategy")
    bars = fresh_klines(40)

    output = run_backtest(klines=bars, symbol="000001.SZ", strategy=strategy, initial_cash=100_000)
    assert output.result.total_trades == 2
    assert output.result.trades[0].date == bars[10].date
    assert output.result.trades[0].signal_type == "my-test-strategy"
    assert output.result.trades[1].date == bars[20].date


def test_broken_record_is_skipped_not_fatal(store_dir):
    (store_dir / "broken.json").write_text(
        '{"id": "broken", "name": "Broken", "code": "def nope(): pass"}', encoding="utf-8"
    )
    ids = [s.id for s in load_strategies()]
    assert "broken" not in ids
    assert "ma-cross" in ids  # builtins still load


def test_non_python_record_is_skipped(store_dir):
    (store_dir / "legacy.json").write_text(
        '{"id": "legacy", "name": "Legacy", "language": "javascript", "code": "export const x = 1"}',
        encoding="utf-8",
    )
    assert "legacy" not in [s.id for s in load_strategies()]


# ---------------------------------------------------------------------------
# HTTP 层
# ---------------------------------------------------------------------------


def test_strategy_crud_over_the_router(api, store_dir):
    status, body = api("POST", "/api/strategies", _payload())
    assert status == 201
    assert body["strategy"]["id"] == "my-test-strategy"

    status, body = api("GET", "/api/strategies/user")
    assert status == 200
    assert len(body["strategies"]) == 1

    status, body = api("GET", "/api/strategies")
    assert status == 200
    user_rows = [s for s in body["strategies"] if s["source"] == "user"]
    assert [s["id"] for s in user_rows] == ["my-test-strategy"]

    status, body = api("GET", "/api/strategies/my-test-strategy/source")
    assert status == 200
    assert body["source"] == "user"
    assert "def decide" in body["code"]

    status, body = api("DELETE", "/api/strategies/my-test-strategy")
    assert status == 200
    assert body["deleted"] == "my-test-strategy"

    status, _body = api("DELETE", "/api/strategies/my-test-strategy")
    assert status == 404


def test_router_rejects_builtin_override(api, store_dir):
    status, body = api("POST", "/api/strategies", _payload(id="ma-cross"))
    assert status == 409
    assert "内置策略" in body["error"]


def test_router_rejects_bad_code(api, store_dir):
    status, body = api("POST", "/api/strategies", _payload(code="import os"))
    assert status == 400
    assert "校验" in body["error"]
