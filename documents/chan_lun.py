#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
缠论量化数据生成器
使用真实数据生成缠论结构数据作为训练集
"""

import pandas as pd
import numpy as np
from datetime import datetime
from dataclasses import dataclass
from typing import List, Dict, Tuple
import warnings
warnings.filterwarnings('ignore')


@dataclass
class Fenxing:
    date: str
    type: str
    high: float
    low: float
    kline_idx: int
    confirmed_idx: int


@dataclass
class Bi:
    start_idx: int
    end_idx: int
    start_date: str
    end_date: str
    direction: str
    start_price: float
    end_price: float
    confirmed_idx: int
    macd_area: float = 0.0


@dataclass
class Zhongshu:
    start_idx: int
    end_idx: int
    start_date: str
    end_date: str
    gg: float
    dd: float
    zg: float
    zd: float
    level: int


@dataclass
class Segment:
    start_idx: int
    end_idx: int
    start_date: str
    end_date: str
    direction: str
    start_price: float
    end_price: float
    macd_area: float = 0.0


@dataclass
class BuySellPoint:
    date: str
    idx: int
    type: str
    price: float
    confidence: float


@dataclass
class MergedKline:
    start_idx: int
    end_idx: int
    high: float
    low: float
    date: str
    # 记录 high 和 low 分别对应哪根原始K线的哪个端点日期
    # top_date: high 值对应的原始日期（顶分型用）
    # bottom_date: low 值对应的原始日期（底分型用）
    top_date: str = ''
    bottom_date: str = ''
    # top_idx: high 值对应的笔索引
    # bottom_idx: low 值对应的笔索引
    top_idx: int = 0
    bottom_idx: int = 0


def read_real_data_from_csv(csv_path: str) -> pd.DataFrame:
    try:
        df = pd.read_csv(csv_path, encoding='utf-8')
        df['日期'] = pd.to_datetime(df['日期'])
        df = df.set_index('日期')
        result_df = pd.DataFrame(index=df.index)
        result_df['open'] = df['开盘']
        result_df['high'] = df['最高']
        result_df['low'] = df['最低']
        result_df['close'] = df['收盘']
        result_df['volume'] = df['成交量']
        result_df = result_df.sort_index()
        return result_df
    except Exception as e:
        print(f"读取CSV文件失败 {csv_path}: {e}")
        return pd.DataFrame()


def get_stock_name_from_code(code: str) -> str:
    stock_names = {
        '000001': '平安银行', '000002': '万科A', '000063': '中兴通讯',
        '000333': '美的集团', '000538': '云南白药', '000568': '泸州老窖',
        '000651': '格力电器', '000725': '京东方A', '000768': '中航西飞',
        '000858': '五粮液', '002001': '新和成', '002007': '华兰生物',
        '002024': '苏宁易购', '002027': '分众传媒', '002049': '紫光国微',
        '002120': '韵达股份', '002142': '宁波银行', '002230': '科大讯飞',
        '002236': '大华股份', '002271': '东方雨虹', '002304': '洋河股份',
        '002352': '顺丰控股', '002415': '海康威视', '002460': '赣锋锂业',
        '002475': '立讯精密', '002594': '比亚迪', '002714': '牧原股份',
        '002812': '恩捷股份', '300003': '乐普医疗', '300014': '亿纬锂能',
        '300015': '爱尔眼科', '300033': '同花顺', '300059': '东方财富',
        '600000': '浦发银行', '600009': '上海机场', '600016': '民生银行',
        '600019': '宝钢股份', '600028': '中国石化', '600030': '中信证券',
        '600036': '招商银行', '600048': '保利地产', '600050': '中国联通',
        '600104': '上汽集团', '600276': '恒瑞医药', '600309': '万华化学',
        '600519': '贵州茅台', '600585': '海螺水泥', '600690': '海尔智家',
        '600887': '伊利股份', '601012': '隆基绿能', '601166': '兴业银行',
        '601288': '农业银行', '601318': '中国平安', '601398': '工商银行',
        '601601': '中国太保', '601668': '中国建筑', '601688': '华泰证券',
        '601728': '中国人寿', '601857': '中国石油', '601888': '中国中免',
        '601899': '紫金矿业', '601988': '中国银行', '603259': '药明康德',
        '603288': '海天味业', '603501': '韦尔股份', '603986': '兆易创新',
    }
    return stock_names.get(code, f'股票{code}')


class ChanLunAnalyzer:

    def __init__(self, df: pd.DataFrame):
        self.df = df.copy()
        self.merged_klines: List[MergedKline] = []
        self.fenxings: List[Fenxing] = []
        self.bis: List[Bi] = []
        self.zhongshus: List[Zhongshu] = []
        self.segment_zhongshus: List[Zhongshu] = []
        self.segments: List[Segment] = []
        self.buy_sell_points: List[BuySellPoint] = []
        self._macd_calculated = False

    def process_inclusion(self) -> List[MergedKline]:
        n = len(self.df)
        if n < 3:
            self.merged_klines = [
                MergedKline(start_idx=i, end_idx=i,
                            high=self.df['high'].iloc[i],
                            low=self.df['low'].iloc[i],
                            date=self.df.index[i].strftime('%Y-%m-%d'))
                for i in range(n)
            ]
            return self.merged_klines

        merged: List[MergedKline] = []
        merged.append(MergedKline(
            start_idx=0, end_idx=0,
            high=self.df['high'].iloc[0],
            low=self.df['low'].iloc[0],
            date=self.df.index[0].strftime('%Y-%m-%d')
        ))

        for i in range(1, n):
            curr_high = self.df['high'].iloc[i]
            curr_low = self.df['low'].iloc[i]
            last = merged[-1]

            curr_contains_last = (curr_high >= last.high and curr_low <= last.low)
            last_contains_curr = (last.high >= curr_high and last.low <= curr_low)

            if curr_contains_last or last_contains_curr:
                if len(merged) >= 2:
                    prev = merged[-2]
                    # 确定趋势方向
                    if last.high > prev.high:
                        trend_up = True
                    elif last.high < prev.high:
                        trend_up = False
                    else:
                        if last.low > prev.low:
                            trend_up = True
                        else:
                            trend_up = False
                else:
                    trend_up = curr_high >= last.high

                if trend_up:
                    new_high = max(last.high, curr_high)
                    new_low = max(last.low, curr_low)
                else:
                    new_high = min(last.high, curr_high)
                    new_low = min(last.low, curr_low)

                merged[-1] = MergedKline(
                    start_idx=last.start_idx,
                    end_idx=i,
                    high=new_high,
                    low=new_low,
                    date=last.date
                )
            else:
                merged.append(MergedKline(
                    start_idx=i, end_idx=i,
                    high=curr_high,
                    low=curr_low,
                    date=self.df.index[i].strftime('%Y-%m-%d')
                ))

        self.merged_klines = merged
        return merged

    def identify_fenxing(self) -> List[Fenxing]:
        if not self.merged_klines:
            self.process_inclusion()

        merged = self.merged_klines
        n = len(merged)
        if n < 3:
            self.fenxings = []
            return []

        fenxings = []
        for i in range(1, n - 1):
            prev = merged[i - 1]
            curr = merged[i]
            nxt = merged[i + 1]

            if curr.high > prev.high and curr.high > nxt.high and curr.low > prev.low and curr.low > nxt.low:
                # Find the actual index of the highest high in original data
                original_range = self.df.iloc[curr.start_idx:curr.end_idx+1]
                actual_idx = original_range['high'].idxmax()
                actual_idx_int = self.df.index.get_loc(actual_idx)
                
                fenxings.append(Fenxing(
                    date=actual_idx.strftime('%Y-%m-%d') if isinstance(actual_idx, (datetime, pd.Timestamp)) else str(actual_idx),
                    type='top',
                    high=curr.high,
                    low=original_range.loc[actual_idx, 'low'],
                    kline_idx=actual_idx_int,
                    confirmed_idx=min(curr.end_idx + 1, len(self.df) - 1)
                ))
            elif curr.low < prev.low and curr.low < nxt.low and curr.high < prev.high and curr.high < nxt.high:
                # Find the actual index of the lowest low in original data
                original_range = self.df.iloc[curr.start_idx:curr.end_idx+1]
                actual_idx = original_range['low'].idxmin()
                actual_idx_int = self.df.index.get_loc(actual_idx)

                fenxings.append(Fenxing(
                    date=actual_idx.strftime('%Y-%m-%d') if isinstance(actual_idx, (datetime, pd.Timestamp)) else str(actual_idx),
                    type='bottom',
                    high=original_range.loc[actual_idx, 'high'],
                    low=curr.low,
                    kline_idx=actual_idx_int,
                    confirmed_idx=min(curr.end_idx + 1, len(self.df) - 1)
                ))

        self.fenxings = fenxings
        return fenxings

    def identify_bi(self) -> List[Bi]:
        if not self.fenxings:
            self.identify_fenxing()

        fenxings = self.fenxings
        if len(fenxings) < 2:
            self.bis = []
            return []

        # Use a more robust state-machine approach to find the best alternating extremes
        bi_points: List[Fenxing] = []
        
        for fx in fenxings:
            if not bi_points:
                bi_points.append(fx)
                continue
            
            last = bi_points[-1]
            if fx.type == last.type:
                # Same type: only take the more extreme one. 
                if last.type == 'top' and fx.high > last.high:
                    bi_points[-1] = fx
                elif last.type == 'bottom' and fx.low < last.low:
                    bi_points[-1] = fx
            else:
                # Different type: check distance (5 bars including extremes -> index diff >= 4)
                if abs(fx.kline_idx - last.kline_idx) >= 4:
                    bi_points.append(fx)

        # Final pass to ensure we didn't end up with same-type adjacents after distance filtering
        final_points: List[Fenxing] = []
        for fx in bi_points:
            if not final_points:
                final_points.append(fx)
                continue
            last = final_points[-1]
            if fx.type == last.type:
                if (fx.type == 'top' and fx.high > last.high) or (fx.type == 'bottom' and fx.low < last.low):
                    final_points[-1] = fx
            else:
                if abs(fx.kline_idx - last.kline_idx) >= 4:
                    final_points.append(fx)

        if not self._macd_calculated:
            self.calculate_macd()

        bis: List[Bi] = []
        for i in range(len(final_points) - 1):
            curr = final_points[i]
            nxt = final_points[i + 1]

            if curr.type == 'top' and nxt.type == 'bottom':
                direction = 'down'
                start_price = curr.high
                end_price = nxt.low
            elif curr.type == 'bottom' and nxt.type == 'top':
                direction = 'up'
                start_price = curr.low
                end_price = nxt.high
            else:
                continue

            macd_area = self._calc_bi_macd_area(curr.kline_idx, nxt.kline_idx, direction)
            bis.append(Bi(
                start_idx=curr.kline_idx,
                end_idx=nxt.kline_idx,
                start_date=curr.date,
                end_date=nxt.date,
                direction=direction,
                start_price=start_price,
                end_price=end_price,
                confirmed_idx=min(nxt.kline_idx + 1, len(self.df) - 1),
                macd_area=macd_area
            ))

        self.bis = bis
        return bis

    def _calc_bi_macd_area(self, start_idx: int, end_idx: int, direction: str) -> float:
        if 'macd_hist' not in self.df.columns:
            return 0.0
        if end_idx >= len(self.df) or start_idx >= len(self.df):
            return 0.0

        s = max(0, start_idx)
        e = min(len(self.df) - 1, end_idx)
        hist = self.df['macd_hist'].iloc[s:e + 1]

        if direction == 'down':
            area = hist[hist < 0].sum()
        else:
            area = hist[hist > 0].sum()

        return abs(area)

    def _identify_zhongshu_generic(self, lines: List, level: int = 1) -> List[Zhongshu]:
        if len(lines) < 3:
            return []

        zhongshus: List[Zhongshu] = []
        i = 0
        while i <= len(lines) - 3:
            l1, l2, l3 = lines[i], lines[i + 1], lines[i + 2]

            l1_high = max(l1.start_price, l1.end_price)
            l1_low = min(l1.start_price, l1.end_price)
            l2_high = max(l2.start_price, l2.end_price)
            l2_low = min(l2.start_price, l2.end_price)
            l3_high = max(l3.start_price, l3.end_price)
            l3_low = min(l3.start_price, l3.end_price)

            zg = min(l1_high, l2_high, l3_high)
            zd = max(l1_low, l2_low, l3_low)

            if zg > zd:
                gg = max(l1_high, l2_high, l3_high)
                dd = min(l1_low, l2_low, l3_low)

                end_idx = l3.end_idx
                end_date = l3.end_date

                j = i + 3
                while j < len(lines):
                    next_l = lines[j]
                    next_high = max(next_l.start_price, next_l.end_price)
                    next_low = min(next_l.start_price, next_l.end_price)

                    if next_high > zd and next_low < zg:
                        end_idx = next_l.end_idx
                        end_date = next_l.end_date
                        gg = max(gg, next_high)
                        dd = min(dd, next_low)
                        j += 1
                    else:
                        break

                zhongshus.append(Zhongshu(
                    start_idx=l1.start_idx,
                    end_idx=end_idx,
                    start_date=l1.start_date,
                    end_date=end_date,
                    gg=gg,
                    dd=dd,
                    zg=zg,
                    zd=zd,
                    level=level
                ))
                i = j
            else:
                i += 1
        return zhongshus

    def identify_zhongshu(self) -> List[Zhongshu]:
        if not self.bis:
            self.identify_bi()
        self.zhongshus = self._identify_zhongshu_generic(self.bis, level=1)
        return self.zhongshus

    def identify_segment_zhongshu(self) -> List[Zhongshu]:
        if not self.segments:
            self.identify_segment()
        self.segment_zhongshus = self._identify_zhongshu_generic(self.segments, level=2)
        return self.segment_zhongshus

    def _standardize_elements(self, elements: List[Dict], trend_up: bool, fixed_direction: bool = False) -> List[Dict]:
        """对特征序列进行包含处理"""
        if not elements:
            return []
        standardized = [elements[0]]
        for i in range(1, len(elements)):
            curr = elements[i]
            last = standardized[-1]
            # 包含关系判断
            curr_contains_last = (curr['high'] >= last['high'] and curr['low'] <= last['low'])
            last_contains_curr = (last['high'] >= curr['high'] and last['low'] <= curr['low'])

            if curr_contains_last or last_contains_curr:
                # 合并
                if trend_up:
                    new_high = max(last['high'], curr['high'])
                    new_low = max(last['low'], curr['low'])
                else:
                    new_high = min(last['high'], curr['high'])
                    new_low = min(last['low'], curr['low'])
                standardized[-1] = {'high': new_high, 'low': new_low, 'bi_idx': last['bi_idx']}
            else:
                # 不包含
                if not fixed_direction:
                    # 更新趋势方向
                    if curr['high'] > last['high']:
                        trend_up = True
                    elif curr['high'] < last['high']:
                        trend_up = False
                standardized.append(curr)
        return standardized

    def identify_segment(self) -> List[Segment]:
        """
        缠论线段识别（将笔视为K线，用笔的end_price判断分型）
        """
        if not self.bis:
            self.identify_bi()

        bis = self.bis
        if len(bis) < 3:
            self.segments = []
            return []

        # 用笔的end_price作为close来判断分型
        fenxings: List[Fenxing] = []
        for i in range(1, len(bis) - 1):
            prev_close = bis[i-1].end_price
            curr_close = bis[i].end_price
            next_close = bis[i+1].end_price
            
            if curr_close > prev_close and curr_close > next_close:
                # 顶分型
                fenxings.append(Fenxing(
                    date=bis[i].end_date,
                    type='top',
                    high=max(bis[i].start_price, bis[i].end_price),
                    low=min(bis[i].start_price, bis[i].end_price),
                    kline_idx=i,
                    confirmed_idx=i + 1
                ))
            elif curr_close < prev_close and curr_close < next_close:
                # 底分型
                fenxings.append(Fenxing(
                    date=bis[i].end_date,
                    type='bottom',
                    high=max(bis[i].start_price, bis[i].end_price),
                    low=min(bis[i].start_price, bis[i].end_price),
                    kline_idx=i,
                    confirmed_idx=i + 1
                ))

        if len(fenxings) < 2:
            self.segments = []
            return []

        seg_points = self._connect_fenxing_to_bi_like(fenxings, min_distance=3)

        segments: List[Segment] = []
        for i in range(len(seg_points) - 1):
            curr = seg_points[i]
            nxt = seg_points[i + 1]

            start_bi = bis[curr.kline_idx]
            end_bi = bis[nxt.kline_idx]

            if curr.type == 'top' and nxt.type == 'bottom':
                direction = 'down'
                start_price = curr.high
                end_price = nxt.low
                # 顶分型作为起点：取笔的高点端点
                # 如果笔向下，high 在起点；如果笔向上，high 在终点
                start_idx = start_bi.start_idx if start_bi.direction == 'down' else start_bi.end_idx
                start_date = start_bi.start_date if start_bi.direction == 'down' else start_bi.end_date
                # 底分型作为终点：取笔的低点端点
                # 如果笔向上，low 在起点；如果笔向下，low 在终点
                end_idx = end_bi.start_idx if end_bi.direction == 'up' else end_bi.end_idx
                end_date = end_bi.start_date if end_bi.direction == 'up' else end_bi.end_date
            elif curr.type == 'bottom' and nxt.type == 'top':
                direction = 'up'
                start_price = curr.low
                end_price = nxt.high
                # 底分型作为起点：取笔的低点端点
                start_idx = start_bi.start_idx if start_bi.direction == 'up' else start_bi.end_idx
                start_date = start_bi.start_date if start_bi.direction == 'up' else start_bi.end_date
                # 顶分型作为终点：取笔的高点端点
                end_idx = end_bi.start_idx if end_bi.direction == 'down' else end_bi.end_idx
                end_date = end_bi.start_date if end_bi.direction == 'down' else end_bi.end_date
            else:
                continue

            macd_area = self._calc_bi_macd_area(start_idx, end_idx, direction)

            segments.append(Segment(
                start_idx=start_idx,
                end_idx=end_idx,
                start_date=start_date,
                end_date=end_date,
                direction=direction,
                start_price=start_price,
                end_price=end_price,
                macd_area=macd_area
            ))

        self.segments = segments
        return segments

    def _process_inclusion_on(self, klines: List[MergedKline]) -> List[MergedKline]:
        n = len(klines)
        if n < 3:
            return klines[:]

        merged: List[MergedKline] = [MergedKline(
            start_idx=klines[0].start_idx,
            end_idx=klines[0].end_idx,
            high=klines[0].high,
            low=klines[0].low,
            date=klines[0].date,
            top_date=klines[0].top_date,
            bottom_date=klines[0].bottom_date,
            top_idx=klines[0].top_idx,
            bottom_idx=klines[0].bottom_idx
        )]

        for i in range(1, n):
            curr_high = klines[i].high
            curr_low = klines[i].low
            last = merged[-1]

            curr_contains_last = (curr_high >= last.high and curr_low <= last.low)
            last_contains_curr = (last.high >= curr_high and last.low <= curr_low)

            if curr_contains_last or last_contains_curr:
                if len(merged) >= 2:
                    prev = merged[-2]
                    if last.high > prev.high:
                        trend_up = True
                    elif last.high < prev.high:
                        trend_up = False
                    else:
                        trend_up = last.low > prev.low
                else:
                    trend_up = curr_high >= last.high

                if trend_up:
                    new_high = max(last.high, curr_high)
                    new_low = max(last.low, curr_low)
                    # 上升趋势：high 取更大者的 top_date/top_idx，low 取更大者的 bottom_date/bottom_idx
                    new_top_date = last.top_date if last.high >= curr_high else klines[i].top_date
                    new_bottom_date = last.bottom_date if last.low >= curr_low else klines[i].bottom_date
                    new_top_idx = last.top_idx if last.high >= curr_high else klines[i].top_idx
                    new_bottom_idx = last.bottom_idx if last.low >= curr_low else klines[i].bottom_idx
                else:
                    new_high = min(last.high, curr_high)
                    new_low = min(last.low, curr_low)
                    # 下降趋势：high 取更小者的 top_date/top_idx，low 取更小者的 bottom_date/bottom_idx
                    new_top_date = last.top_date if last.high <= curr_high else klines[i].top_date
                    new_bottom_date = last.bottom_date if last.low <= curr_low else klines[i].bottom_date
                    new_top_idx = last.top_idx if last.high <= curr_high else klines[i].top_idx
                    new_bottom_idx = last.bottom_idx if last.low <= curr_low else klines[i].bottom_idx

                merged[-1] = MergedKline(
                    start_idx=last.start_idx,
                    end_idx=i,
                    high=new_high,
                    low=new_low,
                    date=last.date,
                    top_date=new_top_date,
                    bottom_date=new_bottom_date,
                    top_idx=new_top_idx,
                    bottom_idx=new_bottom_idx
                )
            else:
                merged.append(MergedKline(
                    start_idx=i,
                    end_idx=i,
                    high=curr_high,
                    low=curr_low,
                    date=klines[i].date,
                    top_date=klines[i].top_date,
                    bottom_date=klines[i].bottom_date,
                    top_idx=klines[i].top_idx,
                    bottom_idx=klines[i].bottom_idx
                ))

        return merged

    def _identify_fenxing_on(self, merged: List[MergedKline]) -> List[Fenxing]:
        n = len(merged)
        if n < 3:
            return []

        fenxings = []
        for i in range(1, n - 1):
            prev = merged[i - 1]
            curr = merged[i]
            nxt = merged[i + 1]

            # 放宽分型条件：只检查high或low，不要求两者都满足
            # 顶分型：high是局部最大值
            if curr.high > prev.high and curr.high > nxt.high:
                fenxings.append(Fenxing(
                    date=curr.top_date,
                    type='top',
                    high=curr.high,
                    low=curr.low,
                    kline_idx=curr.top_idx,
                    confirmed_idx=min(curr.top_idx + 1, n - 1)
                ))
            # 底分型：low是局部最小值
            elif curr.low < prev.low and curr.low < nxt.low:
                fenxings.append(Fenxing(
                    date=curr.bottom_date,
                    type='bottom',
                    high=curr.high,
                    low=curr.low,
                    kline_idx=curr.bottom_idx,
                    confirmed_idx=min(curr.bottom_idx + 1, n - 1)
                ))

        return fenxings

    def _connect_fenxing_to_bi_like(self, fenxings: List[Fenxing], min_distance: int = 4) -> List[Fenxing]:
        if len(fenxings) < 2:
            return []

        bi_points: List[Fenxing] = []

        for fx in fenxings:
            if not bi_points:
                bi_points.append(fx)
                continue

            last = bi_points[-1]
            if fx.type == last.type:
                if last.type == 'top' and fx.high > last.high:
                    bi_points[-1] = fx
                elif last.type == 'bottom' and fx.low < last.low:
                    bi_points[-1] = fx
            else:
                if abs(fx.kline_idx - last.kline_idx) >= min_distance:
                    bi_points.append(fx)

        final_points: List[Fenxing] = []
        for fx in bi_points:
            if not final_points:
                final_points.append(fx)
                continue
            last = final_points[-1]
            if fx.type == last.type:
                if (fx.type == 'top' and fx.high > last.high) or (fx.type == 'bottom' and fx.low < last.low):
                    final_points[-1] = fx
            else:
                if abs(fx.kline_idx - last.kline_idx) >= min_distance:
                    final_points.append(fx)

        return final_points

    def identify_buy_sell_points(self) -> List[BuySellPoint]:
        if not self.bis:
            self.identify_bi()
        if not self.zhongshus:
            self.identify_zhongshu()
        if not self.segment_zhongshus:
            self.identify_segment_zhongshu()

        points: List[BuySellPoint] = []
        
        # 1. Identify points based on Bi-level Zhongshus (笔级别买卖点)
        bi_points = self._identify_points_generic(self.bis, self.zhongshus, suffix="")
        for p in bi_points:
            p.type = f"bi_{p.type}"  # 添加 bi_ 前缀区分笔级别
        points.extend(bi_points)
        
        # 2. Identify points based on Segment-level Zhongshus (线段级别买卖点)
        seg_points = self._identify_points_generic(self.segments, self.segment_zhongshus, suffix="")
        for p in seg_points:
            p.type = f"seg_{p.type}"  # 添加 seg_ 前缀区分线段级别
        points.extend(seg_points)

        # Remove duplicates (same type on same index)
        points.sort(key=lambda p: p.idx)
        seen = set()
        unique_points = []
        for p in points:
            key = (p.idx, p.type)
            if key not in seen:
                seen.add(key)
                unique_points.append(p)

        self.buy_sell_points = unique_points
        return unique_points

    def _find_entry_line_idx(self, lines: List, zs: Zhongshu) -> int:
        """Find the index of the line that enters this zhongshu (the line just before the first line of the zhongshu)."""
        for k, l in enumerate(lines):
            if l.start_idx == zs.start_idx:
                return k - 1 if k > 0 else -1
        return -1

    def _find_trend_groups(self, zhongshus: List[Zhongshu]) -> Tuple[List[List[Zhongshu]], List[List[Zhongshu]]]:
        """
        Find trend groups (sequences of non-overlapping zhongshus in the same direction).
        
        A downtrend: consecutive zhongshus where each subsequent zhongshu's ZG is below the previous ZD
        (i.e., no overlap, each zhongshu is lower than the previous).
        
        An uptrend: consecutive zhongshus where each subsequent zhongshu's ZD is above the previous ZG
        (i.e., no overlap, each zhongshu is higher than the previous).
        
        Returns: (downtrend_groups, uptrend_groups)
        """
        sorted_zs = sorted(zhongshus, key=lambda z: z.start_idx)
        
        downtrend_groups = []
        uptrend_groups = []
        
        current_downtrend = []
        current_uptrend = []
        
        for i, zs in enumerate(sorted_zs):
            # Check downtrend: new zhongshu is below the previous (no overlap)
            if not current_downtrend:
                current_downtrend = [zs]
            else:
                prev = current_downtrend[-1]
                if zs.zg < prev.zd:  # No overlap, new zhongshu is below
                    current_downtrend.append(zs)
                else:
                    if len(current_downtrend) >= 2:
                        downtrend_groups.append(current_downtrend)
                    current_downtrend = [zs]
            
            # Check uptrend: new zhongshu is above the previous (no overlap)
            if not current_uptrend:
                current_uptrend = [zs]
            else:
                prev = current_uptrend[-1]
                if zs.zd > prev.zg:  # No overlap, new zhongshu is above
                    current_uptrend.append(zs)
                else:
                    if len(current_uptrend) >= 2:
                        uptrend_groups.append(current_uptrend)
                    current_uptrend = [zs]
        
        if len(current_downtrend) >= 2:
            downtrend_groups.append(current_downtrend)
        if len(current_uptrend) >= 2:
            uptrend_groups.append(current_uptrend)
        
        return downtrend_groups, uptrend_groups

    def _check_beichi(self, line_a, line_b) -> bool:
        """Check if line_a has weaker momentum (beichi) compared to line_b."""
        if hasattr(line_a, 'macd_area') and hasattr(line_b, 'macd_area'):
            if line_a.macd_area > 0 and line_b.macd_area > 0:
                return line_a.macd_area < line_b.macd_area
        # Fallback: compare price length
        len_a = abs(line_a.end_price - line_a.start_price)
        len_b = abs(line_b.end_price - line_b.start_price)
        return len_a < len_b

    def _identify_points_generic(self, lines: List, zhongshus: List[Zhongshu], suffix: str = "") -> List[BuySellPoint]:
        """
        Identify all 3 types of buy/sell points based on Chan Theory:
        
        1Buy (第一类买点): Trend divergence at the bottom of a downtrend with >= 2 zhongshus.
            The last segment exiting the last zhongshu (c) shows weaker momentum
            than the segment connecting the two zhongshus (b).
            Formula: P_c_low < P_b_low AND Force(c) < Force(b)
        
        1Sell (第一类卖点): Symmetric to 1Buy at the top of an uptrend.
        
        2Buy (第二类买点): After 1Buy, a sub-level callback that does NOT break below 1Buy low.
            Formula: P_pullback_low > P_1Buy
        
        2Sell (第二类卖点): Symmetric to 2Buy.
        
        3Buy (第三类买点): After a zhongshu, an upward breakout followed by a callback
            that stays above ZG. Formula: L_pullback_min > ZG
        
        3Sell (第三类卖点): Symmetric to 3Buy. Formula: H_rebound_max < ZD
        """
        points: List[BuySellPoint] = []
        if not lines or not zhongshus:
            return []

        # Track which (zs, line) pairs already generated a 3Buy/3Sell signal
        # to prevent overlapping with 1Buy/1Sell
        used_for_third = set()

        sorted_zs = sorted(zhongshus, key=lambda z: z.start_idx)

        # ============================================================
        # Pass 1: Identify 3Buy and 3Sell (中枢脱离与趋势加速点)
        # ============================================================
        for zs in sorted_zs:
            for i in range(len(lines)):
                line = lines[i]
                if line.start_idx <= zs.end_idx:
                    continue

                # --- 3Buy: Upward exit above ZG, then downward callback stays above ZG ---
                if line.direction == 'up' and line.end_price > zs.zg:
                    if i + 1 < len(lines):
                        callback = lines[i + 1]
                        if callback.direction == 'down' and callback.end_price > zs.zg:
                            entry_line_idx = self._find_entry_line_idx(lines, zs)
                            is_beichi = False
                            if entry_line_idx >= 0:
                                entry_line = lines[entry_line_idx]
                                if entry_line.direction == 'down':
                                    is_beichi = self._check_beichi(callback, entry_line)

                            used_for_third.add((zs.start_idx, zs.end_idx, line.start_idx, line.end_idx))
                            points.append(BuySellPoint(
                                date=self.df.index[callback.end_idx].strftime('%Y-%m-%d'),
                                idx=callback.end_idx,
                                type='3buy' + suffix,
                                price=callback.end_price,
                                confidence=0.9 if is_beichi else 0.7
                            ))

                # --- 3Sell: Downward exit below ZD, then upward rebound stays below ZD ---
                elif line.direction == 'down' and line.end_price < zs.zd:
                    if i + 1 < len(lines):
                        rebound = lines[i + 1]
                        if rebound.direction == 'up' and rebound.end_price < zs.zd:
                            entry_line_idx = self._find_entry_line_idx(lines, zs)
                            is_beichi = False
                            if entry_line_idx >= 0:
                                entry_line = lines[entry_line_idx]
                                if entry_line.direction == 'up':
                                    is_beichi = self._check_beichi(rebound, entry_line)

                            used_for_third.add((zs.start_idx, zs.end_idx, line.start_idx, line.end_idx))
                            points.append(BuySellPoint(
                                date=self.df.index[rebound.end_idx].strftime('%Y-%m-%d'),
                                idx=rebound.end_idx,
                                type='3sell' + suffix,
                                price=rebound.end_price,
                                confidence=0.9 if is_beichi else 0.7
                            ))

        # ============================================================
        # Pass 2: Identify 1Buy and 1Sell (趋势转折点)
        # MUST have at least 2 zhongshus in a trend (趋势),
        # compare the c-segment (exit from last zhongshu) with
        # the b-segment (entry to last zhongshu = connecting segment)
        # ============================================================
        downtrend_groups, uptrend_groups = self._find_trend_groups(sorted_zs)

        # 1Buy: Last zhongshu in each downtrend group
        for group in downtrend_groups:
            last_zs = group[-1]  # The last zhongshu in the downtrend

            for i in range(len(lines)):
                line = lines[i]
                if line.start_idx <= last_zs.end_idx:
                    continue
                pair_key = (last_zs.start_idx, last_zs.end_idx, line.start_idx, line.end_idx)
                if pair_key in used_for_third:
                    continue

                if line.direction == 'down' and line.end_price < last_zs.zd:
                    # Find the b-segment: the entry line to the last zhongshu
                    # This is the segment connecting the previous zhongshu to the last zhongshu
                    entry_line_idx = self._find_entry_line_idx(lines, last_zs)
                    if entry_line_idx >= 0:
                        b_segment = lines[entry_line_idx]  # b segment (connecting segment)
                        if b_segment.direction == 'down':
                            # Check trend divergence: c-segment (line) vs b-segment
                            # P_c_low < P_b_low AND Force(c) < Force(b)
                            price_condition = line.end_price < b_segment.end_price
                            is_beichi = self._check_beichi(line, b_segment)

                            if price_condition and is_beichi:
                                points.append(BuySellPoint(
                                    date=self.df.index[line.end_idx].strftime('%Y-%m-%d'),
                                    idx=line.end_idx,
                                    type='1buy' + suffix,
                                    price=line.end_price,
                                    confidence=0.9
                                ))

        # 1Sell: Last zhongshu in each uptrend group
        for group in uptrend_groups:
            last_zs = group[-1]  # The last zhongshu in the uptrend

            for i in range(len(lines)):
                line = lines[i]
                if line.start_idx <= last_zs.end_idx:
                    continue
                pair_key = (last_zs.start_idx, last_zs.end_idx, line.start_idx, line.end_idx)
                if pair_key in used_for_third:
                    continue

                if line.direction == 'up' and line.end_price > last_zs.zg:
                    entry_line_idx = self._find_entry_line_idx(lines, last_zs)
                    if entry_line_idx >= 0:
                        b_segment = lines[entry_line_idx]  # b segment (connecting segment)
                        if b_segment.direction == 'up':
                            # Check trend divergence: c-segment (line) vs b-segment
                            price_condition = line.end_price > b_segment.end_price
                            is_beichi = self._check_beichi(line, b_segment)

                            if price_condition and is_beichi:
                                points.append(BuySellPoint(
                                    date=self.df.index[line.end_idx].strftime('%Y-%m-%d'),
                                    idx=line.end_idx,
                                    type='1sell' + suffix,
                                    price=line.end_price,
                                    confidence=0.9
                                ))

        # ============================================================
        # Pass 3: Identify 2Buy and 2Sell (次级别确认点)
        # ============================================================
        # --- 2Buy: Callback after 1Buy that doesn't break the 1Buy low ---
        for b1 in [p for p in points if p.type == '1buy' + suffix]:
            start_search = -1
            for k, line in enumerate(lines):
                if line.end_idx == b1.idx:
                    start_search = k
                    break

            if start_search != -1:
                if start_search + 2 < len(lines):
                    up_move = lines[start_search + 1]
                    callback = lines[start_search + 2]
                    if up_move.direction == 'up' and callback.direction == 'down':
                        if callback.end_price > b1.price:
                            points.append(BuySellPoint(
                                date=self.df.index[callback.end_idx].strftime('%Y-%m-%d'),
                                idx=callback.end_idx,
                                type='2buy' + suffix,
                                price=callback.end_price,
                                confidence=0.85
                            ))

        # --- 2Sell: Rebound after 1Sell that doesn't break the 1Sell high ---
        for s1 in [p for p in points if p.type == '1sell' + suffix]:
            start_search = -1
            for k, line in enumerate(lines):
                if line.end_idx == s1.idx:
                    start_search = k
                    break

            if start_search != -1:
                if start_search + 2 < len(lines):
                    down_move = lines[start_search + 1]
                    rebound = lines[start_search + 2]
                    if down_move.direction == 'down' and rebound.direction == 'up':
                        if rebound.end_price < s1.price:
                            points.append(BuySellPoint(
                                date=self.df.index[rebound.end_idx].strftime('%Y-%m-%d'),
                                idx=rebound.end_idx,
                                type='2sell' + suffix,
                                price=rebound.end_price,
                                confidence=0.85
                            ))

        return points

    def calculate_beichi(self, idx: int) -> Tuple[bool, float]:
        if idx < 20 or 'macd_hist' not in self.df.columns:
            return False, 0.0

        for bi in self.bis:
            if bi.end_idx == idx or bi.end_idx == idx - 1:
                if bi.direction == 'down':
                    down_bis_before = [b for b in self.bis
                                       if b.direction == 'down' and b.end_idx < bi.end_idx]
                    if down_bis_before:
                        prev = down_bis_before[-1]
                        if (bi.end_price < prev.end_price and
                                bi.macd_area > 0 and prev.macd_area > 0 and
                                bi.macd_area < prev.macd_area):
                            strength = prev.macd_area / bi.macd_area
                            return True, round(strength, 2)
                elif bi.direction == 'up':
                    up_bis_before = [b for b in self.bis
                                     if b.direction == 'up' and b.end_idx < bi.end_idx]
                    if up_bis_before:
                        prev = up_bis_before[-1]
                        if (bi.end_price > prev.end_price and
                                bi.macd_area > 0 and prev.macd_area > 0 and
                                bi.macd_area < prev.macd_area):
                            strength = prev.macd_area / bi.macd_area
                            return True, round(strength, 2)

        return False, 0.0

    def calculate_macd(self):
        exp1 = self.df['close'].ewm(span=12, adjust=False).mean()
        exp2 = self.df['close'].ewm(span=26, adjust=False).mean()
        self.df['macd'] = exp1 - exp2
        self.df['macd_signal'] = self.df['macd'].ewm(span=9, adjust=False).mean()
        self.df['macd_hist'] = self.df['macd'] - self.df['macd_signal']
        self._macd_calculated = True

    def analyze_all(self):
        self.calculate_macd()
        self.process_inclusion()
        self.identify_fenxing()
        self.identify_bi()
        self.identify_zhongshu()
        self.identify_segment()
        self.identify_segment_zhongshu()
        self.identify_buy_sell_points()
        return self


def calculate_future_returns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df['return_5d'] = df['close'].shift(-5) / df['close'] - 1
    df['return_10d'] = df['close'].shift(-10) / df['close'] - 1
    df['return_20d'] = df['close'].shift(-20) / df['close'] - 1

    max_returns = []
    max_drawdowns = []

    for i in range(len(df)):
        if i + 20 < len(df):
            future_prices = df['close'].iloc[i:i + 20].values
            max_ret = future_prices.max() / df['close'].iloc[i] - 1
            max_dd = future_prices.min() / df['close'].iloc[i] - 1
            max_returns.append(max_ret)
            max_drawdowns.append(max_dd)
        else:
            max_returns.append(np.nan)
            max_drawdowns.append(np.nan)

    df['max_return_20d'] = max_returns
    df['max_drawdown_20d'] = max_drawdowns

    return df


def process_symbol(symbol: str, name: str, df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or len(df) < 60:
        return pd.DataFrame()

    df = calculate_future_returns(df)

    analyzer = ChanLunAnalyzer(df)
    analyzer.analyze_all()

    result_data = []
    for i in range(len(df)):
        date = df.index[i]

        row = {
            'symbol': symbol,
            'name': name,
            'date': date.strftime('%Y-%m-%d'),
            'open': round(df['open'].iloc[i], 2),
            'high': round(df['high'].iloc[i], 2),
            'low': round(df['low'].iloc[i], 2),
            'close': round(df['close'].iloc[i], 2),
            'volume': int(df['volume'].iloc[i]) if not pd.isna(df['volume'].iloc[i]) else 0,
            'fenxing_type': None,
            'bi_direction': None,
            'bi_start': False,
            'bi_end': False,
            'in_zhongshu': False,
            'zhongshu_zg': None,
            'zhongshu_zd': None,
            'in_segment_zhongshu': False,
            'segment_zhongshu_zg': None,
            'segment_zhongshu_zd': None,
            'buy_sell_signal': None,
            'is_beichi': False,
            'segment_start': False,
            'segment_end': False,
            'segment_direction': None,
            'return_5d': round(df['return_5d'].iloc[i], 4) if not pd.isna(df['return_5d'].iloc[i]) else None,
            'return_10d': round(df['return_10d'].iloc[i], 4) if not pd.isna(df['return_10d'].iloc[i]) else None,
            'return_20d': round(df['return_20d'].iloc[i], 4) if not pd.isna(df['return_20d'].iloc[i]) else None,
            'max_return_20d': round(df['max_return_20d'].iloc[i], 4) if not pd.isna(df['max_return_20d'].iloc[i]) else None,
            'max_drawdown_20d': round(df['max_drawdown_20d'].iloc[i], 4) if not pd.isna(df['max_drawdown_20d'].iloc[i]) else None
        }

        for fx in analyzer.fenxings:
            if fx.kline_idx == i:
                row['fenxing_type'] = fx.type
                break

        for bi in analyzer.bis:
            if bi.start_idx == i:
                row['bi_start'] = True
                row['bi_direction'] = bi.direction
            elif bi.end_idx == i:
                row['bi_end'] = True
                row['bi_direction'] = bi.direction

        for point in analyzer.buy_sell_points:
            if point.idx == i:
                row['buy_sell_signal'] = point.type
                break

        for zs in analyzer.zhongshus:
            if zs.start_idx <= i <= zs.end_idx:
                row['in_zhongshu'] = True
                row['zhongshu_zg'] = round(zs.zg, 2)
                row['zhongshu_zd'] = round(zs.zd, 2)
                break

        for zs in analyzer.segment_zhongshus:
            if zs.start_idx <= i <= zs.end_idx:
                row['in_segment_zhongshu'] = True
                row['segment_zhongshu_zg'] = round(zs.zg, 2)
                row['segment_zhongshu_zd'] = round(zs.zd, 2)
                break

        is_beichi, strength = analyzer.calculate_beichi(i)
        row['is_beichi'] = is_beichi

        for seg in analyzer.segments:
            if seg.start_idx == i:
                row['segment_start'] = True
                row['segment_direction'] = seg.direction
            elif seg.end_idx == i:
                row['segment_end'] = True
                row['segment_direction'] = seg.direction
            if seg.start_idx == i:
                row['segment_start_price'] = round(seg.start_price, 2)
            if seg.end_idx == i:
                row['segment_end_price'] = round(seg.end_price, 2)

        result_data.append(row)

    return pd.DataFrame(result_data)


def download_stock_data_baostock(stock_code: str, start_date: str, end_date: str) -> pd.DataFrame:
    import baostock as bs

    if stock_code.startswith('6') or stock_code.startswith('9'):
        full_code = f"sh.{stock_code}"
    else:
        full_code = f"sz.{stock_code}"

    lg = bs.login()
    if lg.error_code != '0':
        print(f"  BaoStock登录失败: {lg.error_msg}")
        return pd.DataFrame()

    try:
        rs = bs.query_history_k_data_plus(
            full_code,
            "date,open,high,low,close,volume",
            start_date=start_date,
            end_date=end_date,
            frequency="d",
            adjustflag="2"
        )

        if rs.error_code != '0':
            print(f"  下载 {stock_code} 失败: {rs.error_msg}")
            return pd.DataFrame()

        data_list = []
        while (rs.error_code == '0') and rs.next():
            data_list.append(rs.get_row_data())

        if not data_list:
            return pd.DataFrame()

        df = pd.DataFrame(data_list, columns=rs.fields)

        for col in ['open', 'high', 'low', 'close', 'volume']:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors='coerce')

        df['date'] = pd.to_datetime(df['date'])
        df = df.set_index('date')
        df = df.sort_index()
        df = df.dropna(subset=['open', 'high', 'low', 'close'])

        return df
    except Exception as e:
        print(f"  下载 {stock_code} 异常: {e}")
        return pd.DataFrame()
    finally:
        bs.logout()


def main():
    import os
    import glob
    import sys

    debug_mode = '--debug' in sys.argv

    limit = None
    for i, arg in enumerate(sys.argv):
        if arg == '--limit' and i + 1 < len(sys.argv):
            limit = int(sys.argv[i + 1])
            break

    print("=" * 60)
    print("缠论量化数据生成器 v3.0 (修正笔逻辑 + 消除未来信息)")
    print("=" * 60)
    if debug_mode:
        print("[DEBUG 模式] 仅处理前10个股票")
    if limit is not None:
        print(f"[LIMIT 模式] 仅处理前 {limit} 个股票")

    data_dir = '/Users/lakerhoo/Documents/LakeR/alphas-main/data_qfq'
    use_csv = os.path.exists(data_dir)

    stock_list = [
        ('000001', '平安银行'), ('000858', '五粮液'), ('600519', '贵州茅台'),
        ('000333', '美的集团'), ('600036', '招商银行'), ('002594', '比亚迪'),
        ('601318', '中国平安'), ('000651', '格力电器'), ('600276', '恒瑞医药'),
        ('002415', '海康威视'), ('600030', '中信证券'), ('000002', '万科A'),
        ('002230', '科大讯飞'), ('300059', '东方财富'), ('601012', '隆基绿能'),
    ]

    all_data = []

    if use_csv:
        csv_files = glob.glob(os.path.join(data_dir, '*.csv'))
        csv_files.sort()
        first_stock = os.path.join(data_dir, '000001.csv')
        if first_stock in csv_files:
            csv_files.remove(first_stock)
            csv_files.insert(0, first_stock)
        print(f"\n找到 {len(csv_files)} 个CSV文件")

        if debug_mode:
            csv_files = csv_files[:10]
            print(f"[DEBUG] 限制为前 {len(csv_files)} 个文件")
        elif limit is not None:
            csv_files = csv_files[:limit]
            print(f"[LIMIT] 限制为前 {len(csv_files)} 个文件")

        print("\n" + "=" * 50)
        print("处理股票数据 (CSV)...")
        print("=" * 50)

        for csv_file in csv_files:
            try:
                code = os.path.basename(csv_file).replace('.csv', '')
                name = get_stock_name_from_code(code)
                df = read_real_data_from_csv(csv_file)

                if df.empty:
                    print(f"  ✗ {name}({code}): 数据为空，跳过")
                    continue

                result = process_symbol(code, name, df)

                if not result.empty:
                    all_data.append(result)
                    fenxing_count = result['fenxing_type'].notna().sum()
                    signal_count = result['buy_sell_signal'].notna().sum()
                    bi_count = result['bi_start'].sum()
                    print(f"  ✓ {name}({code}): {len(result)} 条, 分型{fenxing_count}个, 笔{bi_count}个, 买卖点{signal_count}个")
                else:
                    print(f"  ✗ {name}({code}): 处理失败")

            except Exception as e:
                print(f"  ✗ 处理文件 {csv_file} 时出错: {e}")
                import traceback
                traceback.print_exc()
                continue
    else:
        print(f"\n数据目录不存在，使用BaoStock在线下载 {len(stock_list)} 只股票数据")

        if debug_mode:
            stock_list = stock_list[:10]
            print(f"[DEBUG] 限制为前 {len(stock_list)} 只股票")
        elif limit is not None:
            stock_list = stock_list[:limit]
            print(f"[LIMIT] 限制为前 {len(stock_list)} 只股票")

        from datetime import datetime, timedelta
        end_date = datetime.now().strftime('%Y-%m-%d')
        start_date = (datetime.now() - timedelta(days=5*365)).strftime('%Y-%m-%d')

        print(f"  日期范围: {start_date} ~ {end_date}")

        print("\n" + "=" * 50)
        print("处理股票数据 (BaoStock)...")
        print("=" * 50)

        for code, name in stock_list:
            try:
                df = download_stock_data_baostock(code, start_date, end_date)

                if df.empty:
                    print(f"  ✗ {name}({code}): 数据为空，跳过")
                    continue

                result = process_symbol(code, name, df)

                if not result.empty:
                    all_data.append(result)
                    fenxing_count = result['fenxing_type'].notna().sum()
                    signal_count = result['buy_sell_signal'].notna().sum()
                    bi_count = result['bi_start'].sum()
                    print(f"  ✓ {name}({code}): {len(result)} 条, 分型{fenxing_count}个, 笔{bi_count}个, 买卖点{signal_count}个")
                else:
                    print(f"  ✗ {name}({code}): 处理失败")

            except Exception as e:
                print(f"  ✗ {name}({code}) 处理出错: {e}")
                import traceback
                traceback.print_exc()
                continue

    if all_data:
        final_df = pd.concat(all_data, ignore_index=True)

        output_dir = '/Users/lakerhoo/Documents/LakeR/alphas-main'
        output_file = os.path.join(output_dir, 'chanlun_training_data.csv')

        chanlun_cols = ['fenxing_type', 'bi_direction', 'bi_start', 'bi_end',
                        'in_zhongshu', 'in_segment_zhongshu', 'buy_sell_signal', 'is_beichi',
                        'segment_start', 'segment_end', 'segment_direction']
        mask = pd.Series(False, index=final_df.index)
        for col in chanlun_cols:
            if col in final_df.columns:
                if final_df[col].dtype == bool:
                    mask = mask | final_df[col]
                else:
                    mask = mask | final_df[col].notna() & (final_df[col] != '') & (final_df[col] is not False)

        filtered_df = final_df[mask].copy()
        filtered_df.to_csv(output_file, index=False, encoding='utf-8-sig')

        print("\n" + "=" * 60)
        print("数据统计")
        print("=" * 60)
        print(f"总样本数: {len(final_df)} (过滤后: {len(filtered_df)})")
        print(f"品种数量: {filtered_df['symbol'].nunique()}")
        print(f"日期范围: {filtered_df['date'].min()} ~ {filtered_df['date'].max()}")
        print("\n分型统计:")
        print(filtered_df['fenxing_type'].value_counts())
        print("\n买卖点统计:")
        print(filtered_df['buy_sell_signal'].value_counts())
        print(f"\n中枢内K线占比: {filtered_df['in_zhongshu'].mean() * 100:.2f}%")
        print(f"背驰标记占比: {filtered_df['is_beichi'].mean() * 100:.2f}%")

        print("\n买卖点收益率分析:")
        for signal in ['1buy', '2buy', '3buy', '1sell', '2sell', '3sell']:
            signal_data = filtered_df[filtered_df['buy_sell_signal'] == signal]
            if not signal_data.empty:
                avg_return = signal_data['return_20d'].mean()
                print(f"  {signal}: 平均20日收益率 {avg_return * 100:.2f}% (样本数: {len(signal_data)})")

        print(f"\n✓ CSV数据已保存至: {output_file}")

        return filtered_df
    else:
        print("数据生成失败")
        return pd.DataFrame()


if __name__ == '__main__':
    main()
