"""Part 2 — pool universe loading and equal-weight aggregation maths."""

from __future__ import annotations

import pytest

from chanlun_server.pool import (
    _mean,
    _median,
    build_portfolio_curve,
    build_universe,
    load_index_members,
    load_stock_meta,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# 股票池
# ---------------------------------------------------------------------------


def test_index_members_are_a_share_symbols_only():
    members = load_index_members("hs300")
    assert len(members) > 100
    assert all(m.endswith((".SH", ".SZ")) and m[:6].isdigit() for m in members)
    assert len(set(members)) == len(members)


def test_unknown_index_raises():
    with pytest.raises(ValueError):
        load_index_members("nasdaq")


def test_build_universe_dedupes_and_keeps_custom():
    members = load_index_members("hs300")
    first = members[0]
    universe = build_universe(["hs300"], [first, "000001.SZ", "not-a-symbol"])
    assert universe[0] == first
    assert universe.count(first) == 1
    assert "000001.SZ" in universe
    assert "not-a-symbol" not in universe


def test_build_universe_requires_a_range():
    with pytest.raises(ValueError):
        build_universe([], [])


def test_stock_meta_maps_codes_to_names():
    meta = load_stock_meta()
    if not meta:  # fixture file is optional in some checkouts
        pytest.skip("public/merged_stock_data.json not available")
    sample = next(iter(meta.items()))
    assert len(sample[0]) == 6
    assert set(sample[1]) == {"name", "industry"}


# ---------------------------------------------------------------------------
# 等权组合曲线
# ---------------------------------------------------------------------------


def test_portfolio_curve_averages_and_forward_fills():
    series = [
        (["2024-01-01", "2024-01-02", "2024-01-03"], [1.0, 1.1, 1.2]),
        (["2024-01-02", "2024-01-03"], [1.0, 0.9]),
    ]
    curve, dates = build_portfolio_curve(series, 100_000)

    assert dates == ["2024-01-01", "2024-01-02", "2024-01-03"]
    assert curve[0] == pytest.approx(100_000)  # B has not started -> treated as cash (1.0)
    assert curve[1] == pytest.approx(105_000)  # (1.1 + 1.0) / 2
    assert curve[2] == pytest.approx(105_000)  # (1.2 + 0.9) / 2


def test_portfolio_curve_handles_empty_input():
    assert build_portfolio_curve([], 100_000) == ([], [])
    assert build_portfolio_curve([([], [])], 100_000) == ([], [])


def test_portfolio_curve_carries_last_value_through_gaps():
    series = [
        (["2024-01-01", "2024-01-05"], [1.0, 1.5]),
        (["2024-01-01", "2024-01-02"], [1.0, 1.2]),
    ]
    curve, dates = build_portfolio_curve(series, 100_000)
    assert dates == ["2024-01-01", "2024-01-02", "2024-01-05"]
    assert curve[1] == pytest.approx(110_000)  # (1.0 + 1.2) / 2
    assert curve[2] == pytest.approx(135_000)  # (1.5 + 1.2 carried) / 2


def test_mean_and_median_helpers():
    assert _mean([]) == 0.0
    assert _mean([1, 2, 3]) == pytest.approx(2.0)
    assert _median([3, 1, 2]) == pytest.approx(2.0)
    assert _median([4, 1, 3, 2]) == pytest.approx(2.5)
    assert _median([]) == 0.0
