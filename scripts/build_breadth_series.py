"""从本地 792 只成分股（沪深300 + 中证500）计算市场宽度指标，日频。

输出 data/external/breadth_daily.csv
列：pct_ma60, pct_ma200, nh_nl_ratio(20日新高-新低占比), adv_ratio(上涨家数占比), n_stocks
"""
import glob
import os

import numpy as np
import pandas as pd

BASE = "/Users/lakerhoo/Documents/LakeR/chanlun-stock-analyzer"
files = sorted(glob.glob(f"{BASE}/data/hs300/*.csv")) + sorted(glob.glob(f"{BASE}/data/zz500/*.csv"))
print("files", len(files))

above60, above200, nh, nl, adv, cnt = {}, {}, {}, {}, {}, {}

for i, f in enumerate(files):
    try:
        d = pd.read_csv(f, usecols=["date", "close", "high", "low"])
    except Exception:
        continue
    if len(d) < 260:
        continue
    d["date"] = pd.to_datetime(d["date"])
    d = d.drop_duplicates("date").set_index("date").sort_index()
    c = d["close"]
    ma60 = c.rolling(60).mean()
    ma200 = c.rolling(200).mean()
    hh20 = d["high"].rolling(20).max()
    ll20 = d["low"].rolling(20).min() if "low" in d else d["high"].rolling(20).min()
    prev = c.shift(1)

    for series, store, val in [
        (ma60, above60, (c > ma60)),
        (ma200, above200, (c > ma200)),
        (hh20, nh, (d["high"] >= hh20)),
        (ll20, nl, (d["low"] <= ll20)),
        (prev, adv, (c > prev)),
    ]:
        for dt, v in val.dropna().items():
            store.setdefault(dt, 0)
            store[dt] += int(bool(v))

    for dt in c.dropna().index:
        cnt[dt] = cnt.get(dt, 0) + 1

idx = sorted(cnt)
out = pd.DataFrame(index=pd.DatetimeIndex(idx))
out["n_stocks"] = [cnt[d] for d in idx]
out["pct_ma60"] = [above60.get(d, 0) / cnt[d] for d in idx]
out["pct_ma200"] = [above200.get(d, 0) / cnt[d] for d in idx]
out["nh_nl_ratio"] = [(nh.get(d, 0) - nl.get(d, 0)) / cnt[d] for d in idx]
out["adv_ratio"] = [adv.get(d, 0) / cnt[d] for d in idx]
out = out[out["n_stocks"] >= 200]
out.index.name = "date"
out.to_csv(f"{BASE}/data/external/breadth_daily.csv")
print(out.tail(3))
print("range", out.index.min().date(), out.index.max().date(), len(out))
