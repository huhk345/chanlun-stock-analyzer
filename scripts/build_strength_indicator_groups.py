"""构建并验证 4 组「强弱指示器」：大小盘风格 / 市场宽度 / 行业轮动 / 利率流动性。

输出：reports/strength-indicator-groups-2026-10-20.md
      reports/strength-indicator-groups-2026-10-20.tsv
"""
import numpy as np
import pandas as pd
from scipy import stats

BASE = "/Users/lakerhoo/Documents/LakeR/chanlun-stock-analyzer"
EXT = f"{BASE}/data/external"
OUT_MD = f"{BASE}/reports/strength-indicator-groups-2026-10-20.md"
OUT_TSV = f"{BASE}/reports/strength-indicator-groups-2026-10-20.tsv"


def load(name):
    d = pd.read_csv(f"{EXT}/idx_{name}.csv", parse_dates=["date"])
    return d.set_index("date")[name]


px = pd.DataFrame({n: load(n) for n in
                   ["hs300", "zz500", "zz1000", "ind_energy", "ind_material", "ind_industrial",
                    "ind_disc", "ind_staple", "ind_health", "ind_finance", "ind_tech",
                    "ind_telecom", "ind_utility"]})
px = px.ffill()
bond = pd.read_csv(f"{EXT}/csi_allbond.csv", parse_dates=["date"]).set_index("date")["close"]
yld = pd.read_csv(f"{EXT}/cn_yield.csv", parse_dates=["date"]).set_index("date")
br = pd.read_csv(f"{EXT}/breadth_daily.csv", parse_dates=["date"]).set_index("date")

# 周频（周五收盘）
w = px.resample("W-FRI").last().ffill()
w = w[w.index <= px.index.max()]
wb = bond.resample("W-FRI").last().ffill()
wb = wb[wb.index <= bond.index.max()]
wy = yld.resample("W-FRI").last().ffill()
wy = wy[wy.index <= yld.index.max()]
wbr = br.resample("W-FRI").last().ffill()
wbr = wbr[wbr.index <= br.index.max()]

INDS = [c for c in w.columns if c.startswith("ind_")]
lines = []
A = lines.append


def ic_table(df, target, label):
    rows = []
    for c in df.columns:
        s = pd.concat([df[c], target], axis=1).dropna()
        if len(s) < 60:
            continue
        ic, p = stats.spearmanr(s.iloc[:, 0], s.iloc[:, 1])
        rows.append({"指标": c, "IC": ic, "p值": p, "样本": len(s)})
    return pd.DataFrame(rows)


def quint(df, score, target, label, n=5):
    s = pd.concat([score.rename("s"), target.rename("t")], axis=1).dropna()
    s["g"] = pd.qcut(s["s"], n, labels=[f"第{i+1}组" for i in range(n)])
    return s.groupby("g")["t"].agg(["mean", "median", "count"])


# ============ 组1：大小盘风格 ============
ratio = w["zz1000"] / w["hs300"]
g1 = pd.DataFrame(index=w.index)
g1["小盘/大盘 比值z(60周)"] = (ratio - ratio.rolling(60).mean()) / ratio.rolling(60).std()
g1["小盘13周动量差"] = (w["zz1000"].pct_change(13) - w["hs300"].pct_change(13))
g1["小盘52周动量差"] = (w["zz1000"].pct_change(52) - w["hs300"].pct_change(52))
g1["比值52周变化率"] = ratio.pct_change(52)
t1 = (w["zz1000"].shift(-13) / w["zz1000"] - 1) - (w["hs300"].shift(-13) / w["hs300"] - 1)

# ============ 组2：市场宽度 ============
g2 = pd.DataFrame(index=wbr.index)
g2["MA60上方占比"] = wbr["pct_ma60"].rolling(4).mean()
g2["MA200上方占比"] = wbr["pct_ma200"].rolling(4).mean()
g2["新高新低差(4周累计)"] = wbr["nh_nl_ratio"].rolling(4).sum()
g2["上涨家数占比(4周均)"] = wbr["adv_ratio"].rolling(4).mean()
g2["宽度结构差"] = g2["MA60上方占比"] - g2["MA200上方占比"]
t2 = w["hs300"].shift(-13) / w["hs300"] - 1

# ============ 组3：行业轮动 ============
ind = w[INDS]
rs = ind.div(w["hs300"], axis=0)                      # 相对沪深300的强弱
rs_mom13 = rs.pct_change(13)
rs_fwd4 = rs.shift(-4) / rs - 1

g3 = pd.DataFrame(index=w.index)
g3["行业RS离散度(13周)"] = rs_mom13.std(axis=1)
g3["前3行业RS之和"] = rs_mom13.apply(lambda r: r.nlargest(3).sum(), axis=1)
# 已实现的动量效应（只用过去数据）：过去4周的横截面动量IC
rs_past4 = rs / rs.shift(4) - 1
g3["行业动量IC(过去4周)"] = rs_mom13.shift(4).corrwith(rs_past4, axis=1)
g3["领涨行业集中度"] = rs_mom13.apply(lambda r: r.nlargest(3).sum() - r.nlargest(6).tail(3).sum(), axis=1)

# 动量策略：每期按过去13周RS选最强3个行业，持有未来4周（无前视）
top3 = pd.Series(index=w.index, dtype=float)
for d in w.index:
    m_, f_ = rs_mom13.loc[d], rs_fwd4.loc[d]
    if m_.notna().sum() >= 5:
        sel = m_.dropna().nlargest(3).index
        top3[d] = f_.reindex(sel).mean()
t3 = top3

# ============ 组4：利率与流动性 ============
g4 = pd.DataFrame(index=w.index)
g4["期限利差(10Y-2Y)"] = wy["spread10_2"]
g4["10Y13周变化(bp)"] = (wy["y10"].diff(13)) * 100
g4["债券13周动量"] = wb.pct_change(13)
pe = pd.read_csv(f"{EXT}/hs300_tr.csv", parse_dates=["date"]).set_index("date")["pe"].resample("W-FRI").last()
g4["ERP"] = (100 / pe - wy["y10"]).reindex(w.index)
t4 = w["hs300"].shift(-13) / w["hs300"] - 1

# ============ 组5：趋势与动量 ============
g5 = pd.DataFrame(index=w.index)
for n_ in (20, 60, 120):
    g5[f"距MA{n_}"] = w["hs300"] / w["hs300"].rolling(n_).mean() - 1
g5["12周动量"] = w["hs300"].pct_change(12)
g5["52周动量"] = w["hs300"].pct_change(52)
g5["距52周高点回撤"] = w["hs300"] / w["hs300"].rolling(52).max() - 1
t5 = w["hs300"].shift(-13) / w["hs300"] - 1

# ============ 组6：波动与风险 ============
ret = w["hs300"].pct_change()
g6 = pd.DataFrame(index=w.index)
g6["20周已实现波动"] = ret.rolling(20).std() * np.sqrt(52)
g6["波动率13周变化"] = g6["20周已实现波动"] - g6["20周已实现波动"].shift(13)
g6["下行波动占比"] = ret.where(ret < 0).rolling(20, min_periods=8).std() / ret.rolling(20, min_periods=8).std()
g6["20周平均振幅"] = ret.abs().rolling(20).mean()
t6 = w["hs300"].shift(-13) / w["hs300"] - 1

GROUPS = [
    ("组1 · 大小盘风格", g1, t1, "未来13周（中证1000 − 沪深300）收益差",
     "判断该买大盘还是小盘"),
    ("组2 · 市场宽度", g2, t2, "未来13周沪深300收益",
     "判断大盘上涨有没有地基、还能走多久"),
    ("组3 · 行业轮动", g3, t3, "未来4周领涨3行业组合（相对沪深300）超额",
     "判断板块强弱能不能追、轮动是否有效"),
    ("组4 · 利率与流动性", g4, t4, "未来13周沪深300收益",
     "判断大盘的方向性beta"),
    ("组5 · 趋势与动量", g5, t5, "未来13周沪深300收益",
     "判断大盘趋势能不能延续"),
    ("组6 · 波动与风险", g6, t6, "未来13周沪深300收益",
     "判断当前风险补偿够不够"),
]

A("# 四组「强弱指示器」：构建与验证\n")
A(f"数据：中证指数官网（沪深300/中证500/中证1000 + 10 个中证一级行业）、中证全债、"
  f"10Y/2Y 国债、本地 782 只成分股算的市场宽度。周频（周五），"
  f"指数区间 {w.index.min():%Y-%m} ~ {w.index.max():%Y-%m}，宽度区间 {wbr.index.min():%Y-%m} ~ {wbr.index.max():%Y-%m}。\n")
A("> 方法：每个指标与目标的 Spearman 秩相关（IC）、分 5 组的未来收益、组内相关性。IC 为正表示指标越高、未来越强。\n")

summary = []
for title, g, t, tgt, use in GROUPS:
    A(f"## {title}\n")
    A(f"**用途**：{use} ｜ **目标**：{tgt}\n")
    A("### 组内相关性\n")
    A(g.corr(method="spearman").round(2).to_markdown())
    A("")
    ic = ic_table(g, t, title)
    A("### 单指标预测力\n")
    A("| 指标 | IC | p 值 | 样本 | 方向 |")
    A("|---|---|---|---|---|")
    for _, r in ic.sort_values("IC", ascending=False).iterrows():
        d = "正向" if r["IC"] > 0 else "反向"
        A(f"| {r['指标']} | {r['IC']:+.2f} | {r['p值']:.3f} | {int(r['样本'])} | {d} |")
    A("")
    # 只用统计上站得住（p<0.10）的成员做合成，方向按 IC 符号统一
    keep = ic[(ic["p值"] < 0.10) & (ic["IC"].abs() >= 0.05)]
    if len(keep) < 2:
        A("### 合成指标\n可用成员不足 2 个（p<0.10 且 |IC|≥0.05），该组不构成稳定合成信号。\n")
        summary.append((title, np.nan, np.nan, np.nan, np.nan))
        cur = g.iloc[-1].dropna()
        A("### 当前读数\n")
        A("| 指标 | 最新值 | 近5年分位 |")
        A("|---|---|---|")
        for c in g.columns:
            ss = g[c].dropna()
            if ss.empty:
                continue
            pp = (ss.tail(260) < ss.iloc[-1]).mean() * 100
            A(f"| {c} | {ss.iloc[-1]:+.3f} | {pp:.0f}% |")
        A(f"\n*数据截至 {g.index[-1]:%Y-%m-%d}*\n")
        continue
    sgn = np.sign(keep.set_index("指标")["IC"])
    comp = (g[keep["指标"]] * sgn).mean(axis=1)
    q = quint(g, comp, t, title)
    A("### 合成指标分组（方向已按 IC 统一）\n")
    A("| 分组 | 平均 | 中位 | 样本 |")
    A("|---|---|---|---|")
    for i, r in q.iterrows():
        A(f"| {i} | {r['mean']*100:+.1f}% | {r['median']*100:+.1f}% | {int(r['count'])} |")
    icc, pcc = stats.spearmanr(*pd.concat([comp, t], axis=1).dropna().values.T)
    A(f"\n合成 IC = **{icc:+.2f}**（p={pcc:.3f}），Q1−Q5 = "
      f"{(q['mean'].iloc[-1]-q['mean'].iloc[0])*100:+.1f}pct（最高−最低）\n")
    summary.append((title, icc, pcc, q['mean'].iloc[0], q['mean'].iloc[-1]))
    # 当前读数
    cur = g.iloc[-1].dropna()
    A("### 当前读数\n")
    A("| 指标 | 最新值 | 近5年分位 |")
    A("|---|---|---|")
    for c in g.columns:
        s = g[c].dropna()
        if s.empty:
            continue
        p = (s.tail(260) < s.iloc[-1]).mean() * 100
        A(f"| {c} | {s.iloc[-1]:+.3f} | {p:.0f}% |")
    A(f"\n*数据截至 {g.index[-1]:%Y-%m-%d}*\n")

A("## 汇总\n")
A("| 指标组 | 合成 IC | p 值 | 最低分位组 | 最高分位组 |")
A("|---|---|---|---|---|")
for t_, i_, p_, q1, q5 in summary:
    if np.isnan(i_):
        A(f"| {t_} | 无稳定信号 | — | — | — |")
    else:
        A(f"| {t_} | {i_:+.2f} | {p_:.3f} | {q1*100:+.1f}% | {q5*100:+.1f}% |")

panel = pd.concat([g1.add_prefix("G1_"), g2.add_prefix("G2_"), g3.add_prefix("G3_"), g4.add_prefix("G4_"), g5.add_prefix("G5_"), g6.add_prefix("G6_")], axis=1)
panel.to_csv(OUT_TSV, sep="\t", float_format="%.6f")
with open(OUT_MD, "w") as f:
    f.write("\n".join(lines))
print("\n".join(lines))
