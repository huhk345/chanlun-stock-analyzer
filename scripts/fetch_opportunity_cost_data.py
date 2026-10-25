import json, time, urllib.request, os
import pandas as pd

OUT = "/Users/lakerhoo/Documents/LakeR/chanlun-stock-analyzer/data/external"
os.makedirs(OUT, exist_ok=True)

HDR = {"Referer": "https://www.csindex.com.cn/", "User-Agent": "Mozilla/5.0"}


def get(url, hdr=HDR, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=hdr)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            print("retry", i, e)
            time.sleep(2)
    raise RuntimeError("failed " + url)


def csindex(code, name):
    url = (f"https://www.csindex.com.cn/csindex-home/perf/index-perf"
           f"?indexCode={code}&startDate=20041231&endDate=20261019")
    d = get(url)
    rows = d.get("data") or []
    df = pd.DataFrame(rows)
    df = df[["tradeDate", "close", "changePct", "peg"]].copy()
    df.columns = ["date", "close", "pct", "pe"]
    df["date"] = pd.to_datetime(df["date"], format="%Y%m%d")
    df = df.sort_values("date").drop_duplicates("date")
    df.to_csv(f"{OUT}/{name}.csv", index=False)
    print(name, len(df), df["date"].min().date(), df["date"].max().date(), df["close"].iloc[-1])
    return df


hs = csindex("H00300", "hs300_tr")
bond = csindex("H11001", "csi_allbond")

# 10Y CGB yield from eastmoney
rows = []
page = 1
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
print("pages fetched", page, "rows", len(rows))
df = pd.DataFrame(rows)
df = df[["SOLAR_DATE", "EMM00166466"]]
df.columns = ["date", "y10"]
df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
df = df.dropna().sort_values("date").drop_duplicates("date")
df.to_csv(f"{OUT}/cn10y.csv", index=False)
print("cn10y", len(df), df["date"].min().date(), df["date"].max().date(), df["y10"].iloc[-1])
