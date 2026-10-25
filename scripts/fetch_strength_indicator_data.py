"""抓取风格 / 行业 / 利率数据，用于构建"强弱指示器"指标组。"""
import json, os, time, urllib.request
import pandas as pd

BASE = "/Users/lakerhoo/Documents/LakeR/chanlun-stock-analyzer"
OUT = f"{BASE}/data/external"
os.makedirs(OUT, exist_ok=True)
HDR = {"Referer": "https://www.csindex.com.cn/", "User-Agent": "Mozilla/5.0"}

IDX = {
    "000300": "hs300",
    "000905": "zz500",
    "000852": "zz1000",
    "000928": "ind_energy",
    "000929": "ind_material",
    "000930": "ind_industrial",
    "000931": "ind_disc",
    "000932": "ind_staple",
    "000933": "ind_health",
    "000934": "ind_finance",
    "000935": "ind_tech",
    "000936": "ind_telecom",
    "000937": "ind_utility",
}


def get(url, hdr=HDR, retries=4):
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=30) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            print("retry", i, e)
            time.sleep(2)
    raise RuntimeError(url)


for code, name in IDX.items():
    d = get(f"https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode={code}"
            f"&startDate=20050101&endDate=20261020")
    df = pd.DataFrame(d.get("data") or [])
    if df.empty:
        print("EMPTY", code, name)
        continue
    df = df[["tradeDate", "close"]].rename(columns={"tradeDate": "date", "close": name})
    df["date"] = pd.to_datetime(df["date"], format="%Y%m%d")
    df = df.sort_values("date").drop_duplicates("date")
    df.to_csv(f"{OUT}/idx_{name}.csv", index=False)
    print(name, len(df), df["date"].min().date(), df["date"].max().date(), round(df[name].iloc[-1], 2))
    time.sleep(0.3)

# 利率：2Y / 10Y / 10Y-2Y 利差
rows, page = [], 1
while True:
    url = ("https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD"
           f"&columns=ALL&pageSize=500&pageNumber={page}&sortColumns=SOLAR_DATE&sortTypes=-1")
    d = get(url, {"Referer": "https://data.eastmoney.com/", "User-Agent": "Mozilla/5.0"})
    res = d.get("result") or {}
    batch = res.get("data") or []
    if not batch:
        break
    rows.extend(batch)
    if page >= (res.get("pages") or 1):
        break
    page += 1
r = pd.DataFrame(rows)[["SOLAR_DATE", "EMM00588704", "EMM00166466", "EMM01276014"]]
r.columns = ["date", "y2", "y10", "spread10_2"]
r["date"] = pd.to_datetime(r["date"]).dt.tz_localize(None).dt.normalize()
r = r.dropna(subset=["y10"]).sort_values("date").drop_duplicates("date")
r.to_csv(f"{OUT}/cn_yield.csv", index=False)
print("yield", len(r), r["date"].min().date(), r["date"].max().date(), r.iloc[-1].to_dict())
