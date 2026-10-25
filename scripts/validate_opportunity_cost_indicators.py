"""用同一套数据验证「机会成本/铁底」思路的 5 个相关指标。

数据：沪深300全收益(H00300)、中证全债(H11001)、10Y 国债、沪深300 PE（中证口径）
频率：月末采样（2004-12 ~ 2026-10）
检验：① 指标相关性 ② 分位分组的前瞻收益（单调性）③ 最便宜 10% 的事件研究 ④ 分时段稳定性
"""
import numpy as np
import pandas as pd

BASE = "/Users/lakerhoo/Documents/LakeR/chanlun-stock-analyzer"
OUT_MD = f"{BASE}/reports/opportunity-cost-indicators-data-appendix-2026-10-19.md"
OUT_TSV = f"{BASE}/reports/opportunity-cost-indicators-2026-10-19.tsv"

hs = pd.read_csv(f"{BASE}/data/external/hs300_tr.csv", parse_dates=["date"]).rename(
    columns={"close": "E", "pe": "PE"})[["date", "E", "PE"]]
bd = pd.read_csv(f"{BASE}/data/external/csi_allbond.csv", parse_dates=["date"]).rename(
    columns={"close": "B"})[["date", "B"]]
y10 = pd.read_csv(f"{BASE}/data/external/cn10y.csv", parse_dates=["date"])

df = hs.merge(bd, on="date", how="inner").merge(y10, on="date", how="left").sort_values("date")
df["y10"] = df["y10"].ffill()
darr, earr = df["date"].values, df["E"].values

m = df.set_index("date").resample("M").last().dropna(subset=["E", "B"])
m["y10"] = m["y10"].ffill()

E0, B0 = m["E"].iloc[0], m["B"].iloc[0]
m["en"] = m["E"] / E0 * 100
m["bn"] = m["B"] / B0 * 100

# 指标1：偏债混合代理（80% 中证全债 + 20% 沪深300全收益，月度再平衡）
re_ = m["E"].pct_change().fillna(0)
rb = m["B"].pct_change().fillna(0)
m["proxy"] = (1 + (0.8 * rb + 0.2 * re_)).cumprod() * 100
m["prem_proxy"] = m["en"] / m["proxy"]

# 指标2：纯债比 z（60 月滚动标准化）
m["ratio_bond"] = m["en"] / m["bn"]
m["logratio"] = np.log(m["ratio_bond"])
m["z_bond"] = (m["logratio"] - m["logratio"].rolling(60).mean()) / m["logratio"].rolling(60).std()

# 指标3：ERP
m["erp"] = np.where(m["PE"].notna(), 100 / m["PE"] - m["y10"], np.nan)

# 指标4：3 年相对动量
m["mom3y"] = ((m["en"] / m["en"].shift(36)) ** (1 / 3) - 1) - ((m["bn"] / m["bn"].shift(36)) ** (1 / 3) - 1)

# 指标5：PE 绝对值
m["pe"] = m["PE"]


def pos_on(d):
    return int(np.searchsorted(darr, np.datetime64(d), side="right") - 1)


def fwd(months):
    out = []
    for d in m.index:
        p0, p1 = pos_on(d), pos_on(d + pd.DateOffset(months=months))
        out.append(earr[p1] / earr[p0] - 1 if p1 > p0 else np.nan)
    return pd.Series(out, index=m.index)


for h in (6, 12, 24):
    m[f"fwd{h}"] = fwd(h)


def mae(months=12):
    out = []
    for d in m.index:
        p0, p1 = pos_on(d), pos_on(d + pd.DateOffset(months=months))
        out.append(earr[p0 + 1:p1 + 1].min() / earr[p0] - 1 if p1 > p0 else np.nan)
    return pd.Series(out, index=m.index)


m["mae12"] = mae(12)

# 便宜度：越高越便宜（分位用全样本，仅作描述性检验，含轻微前视）
spec = {
    "溢价(偏债代理)": ("prem_proxy", -1),
    "纯债比z": ("z_bond", -1),
    "ERP": ("erp", 1),
    "3年相对动量": ("mom3y", -1),
    "PE": ("pe", -1),
}
cheap = pd.DataFrame(index=m.index)
for name, (col, sign) in spec.items():
    r = m[col].rank(pct=True) * 100
    cheap[name] = r if sign > 0 else 100 - r
cheap["综合"] = cheap.mean(axis=1)

lines = []
A = lines.append
A("# 用 5 个相关指标验证「机会成本 / 铁底」思路\n")
A(f"样本：{m.index.min():%Y-%m} ~ {m.index.max():%Y-%m}，月末 {len(m)} 期。"
  "数据：沪深300全收益 H00300、中证全债 H11001、10Y 国债收益率（东财）、沪深300 PE（中证口径，2011-06 起）。\n")

A("## 一、当前读数\n")
A("| 指标 | 当前值 | 全样本分位 | 便宜度(0-100) | 含义 |")
A("|---|---|---|---|---|")
cur = m.iloc[-1]
A(f"| 溢价(偏债代理) | {cur['prem_proxy']:.3f} | {100-cheap['溢价(偏债代理)'].iloc[-1]:.0f}% | {cheap['溢价(偏债代理)'].iloc[-1]:.0f} | 距铁底还有多远（1.0 = 贴底） |")
A(f"| 纯债比 z | {cur['z_bond']:.2f} | {100-cheap['纯债比z'].iloc[-1]:.0f}% | {cheap['纯债比z'].iloc[-1]:.0f} | 剔除趋势后的偏离 |")
A(f"| ERP | {cur['erp']:.2f}% | {cheap['ERP'].iloc[-1]:.0f}% | {cheap['ERP'].iloc[-1]:.0f} | 股债性价比 |")
A(f"| 3年相对动量 | {cur['mom3y']*100:.1f}% | {100-cheap['3年相对动量'].iloc[-1]:.0f}% | {cheap['3年相对动量'].iloc[-1]:.0f} | 股相对债强弱 |")
A(f"| PE | {cur['pe']:.2f} | {100-cheap['PE'].iloc[-1]:.0f}% | {cheap['PE'].iloc[-1]:.0f} | 绝对估值 |")
A(f"| **综合** | — | — | **{cheap['综合'].iloc[-1]:.0f}** | 5 项均值，50 = 历史中位 |")
A("")

A("## 二、指标相关性（Spearman，月度）\n")
A(cheap.corr(method="spearman").round(2).to_markdown())
A("")

A("## 三、分位分组检验：便宜的时候买，真的赚更多吗？\n")
A("按便宜度分 5 组（Q1 最便宜 20%，Q5 最贵 20%），看未来收益。**如果指标有效，Q1 应显著高于 Q5。**\n")
for name in list(spec) + ["综合"]:
    g = pd.qcut(-cheap[name], 5, labels=["Q1最便宜", "Q2", "Q3", "Q4", "Q5最贵"])
    t = m.groupby(g)[["fwd6", "fwd12", "fwd24", "mae12"]].agg(["mean", "count"])
    A(f"### {name}")
    A("| 分组 | 样本 | 6月 | 12月 | 24月 | 12月内最大回撤 |")
    A("|---|---|---|---|---|---|")
    for q in ["Q1最便宜", "Q2", "Q3", "Q4", "Q5最贵"]:
        try:
            row = t.loc[q]
        except KeyError:
            continue
        A(f"| {q} | {int(row[('fwd6','count')])} | {row[('fwd6','mean')]*100:.1f}% | "
          f"{row[('fwd12','mean')]*100:.1f}% | {row[('fwd24','mean')]*100:.1f}% | {row[('mae12','mean')]*100:.1f}% |")
    ic = cheap[name].corr(m["fwd12"], method="spearman")
    A(f"\nQ1−Q5（12月）：{(t.loc['Q1最便宜',('fwd12','mean')]-t.loc['Q5最贵',('fwd12','mean')])*100:.1f}pct；"
      f"信息系数 IC={ic:.2f}\n")

A("## 四、最便宜 10% 的事件研究\n")
A("便宜度进入历史最低 10% 视为一次信号，连续信号合并为一次事件（间隔 >12 个月才算新事件）。\n")


def episodes(sig, gap=12):
    out = []
    for d in sig[sig].index:
        if not out or (d - out[-1]).days > gap * 30:
            out.append(d)
    return out


for name in list(spec) + ["综合"]:
    s = cheap[name].dropna()
    eps = episodes(s >= 90)
    if not eps:
        A(f"### {name}：无信号\n")
        continue
    r = m.loc[eps, ["fwd6", "fwd12", "fwd24", "mae12"]]
    A(f"### {name} — {len(r)} 次，12 月胜率 {(r['fwd12']>0).mean()*100:.0f}%，"
      f"24 月胜率 {(r['fwd24']>0).mean()*100:.0f}%")
    A("| 触发月 | 6月 | 12月 | 24月 | 12月内最大回撤 |")
    A("|---|---|---|---|---|")
    for d, x in r.iterrows():
        A(f"| {d:%Y-%m} | {x['fwd6']*100:.1f}% | {x['fwd12']*100:.1f}% | {x['fwd24']*100:.1f}% | {x['mae12']*100:.1f}% |")
    A("")

base = m[["fwd6", "fwd12", "fwd24"]].dropna()
A("## 五、基准（任意月份买入）\n")
A(f"6月 {base['fwd6'].mean()*100:.1f}% / 12月 {base['fwd12'].mean()*100:.1f}% / "
  f"24月 {base['fwd24'].mean()*100:.1f}%；12月胜率 {(base['fwd12']>0).mean()*100:.0f}%，"
  f"12月中位 {base['fwd12'].median()*100:.1f}%\n")

A("## 六、分时段稳定性\n")
A("| 区间 | 样本 | 综合IC(12月) | Q1 12月 | Q5 12月 | Q1−Q5 |")
A("|---|---|---|---|---|---|")
for lo, hi in [("2004", "2012"), ("2013", "2018"), ("2019", "2026")]:
    seg = (cheap.index >= f"{lo}-01-01") & (cheap.index <= f"{hi}-12-31")
    c = cheap.loc[seg, "综合"]
    if c.dropna().empty:
        continue
    g = pd.qcut(-c, 5, labels=["Q1", "Q2", "Q3", "Q4", "Q5"], duplicates="drop")
    t = m.loc[seg].groupby(g)["fwd12"].mean()
    ic = c.corr(m.loc[seg, "fwd12"], method="spearman")
    A(f"| {lo}-{hi} | {seg.sum()} | {ic:.2f} | {t.get('Q1', np.nan)*100:.1f}% | "
      f"{t.get('Q5', np.nan)*100:.1f}% | {(t.get('Q1', np.nan)-t.get('Q5', np.nan))*100:.1f}pct |")
A("")

m.to_csv(OUT_TSV, sep="\t", float_format="%.6f")
with open(OUT_MD, "w") as f:
    f.write("\n".join(lines))
print("\n".join(lines))
