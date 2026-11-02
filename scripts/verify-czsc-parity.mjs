/**
 * 前端 TS 缠论实现 vs czsc 权威实现的一致性核验。
 *
 * 参考侧：scripts/czsc_parity_reference.py（pyvenv 中的 czsc 1.0.2 原生模块）
 * 被测侧：src/utils/chanlun.ts（ts.transpileModule 后动态加载）
 *
 * 一条命令重跑：
 *   node scripts/verify-czsc-parity.mjs
 *
 * 产物：
 *   1. reports/czsc-parity-reference.json   参考实现原始输出
 *   2. reports/czsc-parity-result.json      逐构件逐字段对比结果
 *   3. reports/czsc-parity-summary.md       可读摘要与判定表
 *
 * 说明：
 *   - 参考侧使用 max_bi_num=100000，显式消除 czsc 默认 50 笔截断的假差异；
 *   - czsc 没有线段原语，线段只与脚本内的“教科书特征序列（简化口径）”对照；
 *   - B2/S2 的 czsc 口径是 cxt_second_bs_V230320，与本项目自研口径不同，单独标注。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const VENV_DIR = path.join(root, '.cache/parity-venv');
const REFERENCE_FILE = path.join(root, 'reports/czsc-parity-reference.json');
const RESULT_FILE = path.join(root, 'reports/czsc-parity-result.json');
const SUMMARY_FILE = path.join(root, 'reports/czsc-parity-summary.md');
const EPS = 1e-6;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const symbols = option('symbols', '000001.SZ,600519.SH')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// 参考侧准备
// ---------------------------------------------------------------------------

function resolvePython() {
  const candidates = [
    process.env.CZSC_PYTHON,
    path.join(VENV_DIR, 'bin/python'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import czsc'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function bootstrapVenv() {
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  if (uv.status !== 0) {
    throw new Error(
      '未找到可用的 czsc Python 环境，且 uv 不可用。请手动执行：\n' +
        `  uv venv --python 3.11 ${VENV_DIR}\n` +
        `  uv pip install --python ${VENV_DIR}/bin/python -i ${PYPI_MIRROR} czsc==1.0.2`,
    );
  }
  console.log('[parity] 未找到 czsc 环境，正在创建 .cache/parity-venv ...');
  execFileSync('uv', ['venv', '--python', '3.11', VENV_DIR], { stdio: 'inherit' });
  execFileSync(
    'uv',
    ['pip', 'install', '--python', path.join(VENV_DIR, 'bin/python'), '-i', PYPI_MIRROR, 'czsc==1.0.2'],
    { stdio: 'inherit' },
  );
  return path.join(VENV_DIR, 'bin/python');
}

function generateReference() {
  if (flag('skip-reference')) {
    if (!existsSync(REFERENCE_FILE)) {
      throw new Error('--skip-reference 但缺少 reports/czsc-parity-reference.json');
    }
    console.log('[parity] 复用已有参考输出（--skip-reference）');
    return JSON.parse(readFileSync(REFERENCE_FILE, 'utf8'));
  }
  let python = resolvePython();
  if (!python) python = bootstrapVenv();
  console.log(`[parity] 参考解释器：${python}`);
  const run = spawnSync(
    python,
    [path.join(root, 'scripts/czsc_parity_reference.py'), '--symbols', ...symbols],
    { encoding: 'utf8', cwd: root },
  );
  if (run.status !== 0) {
    throw new Error(`参考脚本失败：\n${run.stdout}\n${run.stderr}`);
  }
  process.stdout.write(run.stdout);
  return JSON.parse(readFileSync(REFERENCE_FILE, 'utf8'));
}

// ---------------------------------------------------------------------------
// 被测 TS 模块
// ---------------------------------------------------------------------------

async function loadChanlun() {
  const source = readFileSync(path.join(root, 'src/utils/chanlun.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), 'chanlun-parity-'));
  const file = path.join(dir, 'chanlun-parity.mjs');
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// 对比工具
// ---------------------------------------------------------------------------

const near = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= EPS;
  }
  return a === b;
};

function fmtBar(k) {
  return `${k.date} O=${k.open} H=${k.high} L=${k.low} C=${k.close} V=${k.volume}`;
}

function context(klines, rawIndex, radius = 2) {
  if (rawIndex === undefined || rawIndex < 0) return [];
  const start = Math.max(0, rawIndex - radius);
  return klines.slice(start, start + radius * 2 + 1).map(fmtBar);
}

function signatureSetRatio(refItems, tsItems, key) {
  const tsKeys = new Set(tsItems.map(key));
  const refKeys = new Set(refItems.map(key));
  let tp = 0;
  for (const k of refKeys) if (tsKeys.has(k)) tp += 1;
  return { tp, refCount: refKeys.size, tsCount: tsKeys.size };
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// 笔
// ---------------------------------------------------------------------------

function compareBi(ref, strokes, klines) {
  const fieldFns = {
    sdt: (r, s) => r.sdt === s.start.date,
    edt: (r, s) => r.edt === s.end.date,
    direction: (r, s) => r.direction === s.direction,
    high: (r, s) => near(r.high, Math.max(s.start.price, s.end.price)),
    low: (r, s) => near(r.low, Math.min(s.start.price, s.end.price)),
    startFxIndex: (r, s) => r.fxA.rawIndex === s.start.originalIndex,
    endFxIndex: (r, s) => r.fxB.rawIndex === s.end.originalIndex,
  };

  const fieldStats = {};
  for (const name of Object.keys(fieldFns)) fieldStats[name] = { checked: 0, mismatched: 0 };

  const common = Math.min(ref.length, strokes.length);
  const samples = [];
  for (let i = 0; i < common; i++) {
    const r = ref[i];
    const s = strokes[i];
    const diffs = [];
    for (const [name, fn] of Object.entries(fieldFns)) {
      fieldStats[name].checked += 1;
      if (!fn(r, s)) {
        fieldStats[name].mismatched += 1;
        diffs.push(name);
      }
    }
    if (diffs.length > 0 && samples.length < 3) {
      samples.push({
        index: i,
        mismatchedFields: diffs,
        ref: r,
        ts: {
          sdt: s.start.date,
          edt: s.end.date,
          direction: s.direction,
          high: Math.max(s.start.price, s.end.price),
          low: Math.min(s.start.price, s.end.price),
          startFxIndex: s.start.originalIndex,
          endFxIndex: s.end.originalIndex,
        },
        startContext: context(klines, r.fxA.rawIndex),
        endContext: context(klines, r.fxB.rawIndex),
      });
    }
  }

  const firstDivergence = (() => {
    const limit = Math.max(ref.length, strokes.length);
    for (let i = 0; i < limit; i++) {
      if (!ref[i] || !strokes[i]) return i;
      const any = Object.values(fieldFns).some((fn) => !fn(ref[i], strokes[i]));
      if (any) return i;
    }
    return -1;
  })();

  const totalMismatch = Object.values(fieldStats).reduce((a, b) => a + b.mismatched, 0);
  return {
    refCount: ref.length,
    tsCount: strokes.length,
    countEqual: ref.length === strokes.length,
    fieldStats,
    totalMismatch,
    firstDivergence,
    samples,
  };
}

// ---------------------------------------------------------------------------
// 中枢
// ---------------------------------------------------------------------------

function tsHubToView(hub, strokes) {
  const startBi = strokes.findIndex((s) => s.start.originalIndex === hub.startIndex);
  return {
    startBi,
    endBi: startBi >= 0 ? startBi + hub.strokesCount - 1 : -1,
    bisCount: hub.strokesCount,
    zg: hub.zg,
    zd: hub.zd,
    gg: hub.gg,
    dd: hub.dd,
    startIndex: hub.startIndex,
    endIndex: hub.endIndex,
  };
}

function compareHub(refHubs, tsHubs, strokes) {
  const views = tsHubs.map((h) => tsHubToView(h, strokes));
  const fieldFns = {
    startBi: (r, t) => r.startBi === t.startBi,
    endBi: (r, t) => r.endBi === t.endBi,
    bisCount: (r, t) => r.bisCount === t.bisCount,
    zg: (r, t) => near(r.zg, t.zg),
    zd: (r, t) => near(r.zd, t.zd),
    gg: (r, t) => near(r.gg, t.gg),
    dd: (r, t) => near(r.dd, t.dd),
  };
  const fieldStats = {};
  for (const name of Object.keys(fieldFns)) fieldStats[name] = { checked: 0, mismatched: 0 };

  const common = Math.min(refHubs.length, views.length);
  const samples = [];
  for (let i = 0; i < common; i++) {
    const r = refHubs[i];
    const t = views[i];
    const diffs = [];
    for (const [name, fn] of Object.entries(fieldFns)) {
      fieldStats[name].checked += 1;
      if (!fn(r, t)) {
        fieldStats[name].mismatched += 1;
        diffs.push(name);
      }
    }
    if (diffs.length > 0 && samples.length < 3) {
      samples.push({ index: i, mismatchedFields: diffs, ref: r, ts: t });
    }
  }

  const firstDivergence = (() => {
    const limit = Math.max(refHubs.length, views.length);
    for (let i = 0; i < limit; i++) {
      if (!refHubs[i] || !views[i]) return i;
      if (Object.values(fieldFns).some((fn) => !fn(refHubs[i], views[i]))) return i;
    }
    return -1;
  })();

  const totalMismatch = Object.values(fieldStats).reduce((a, b) => a + b.mismatched, 0);
  const numericDeltas = {};
  let numericMismatchCount = 0;
  let roundingExplained = 0;
  for (const name of ['zg', 'zd', 'gg', 'dd']) {
    let maxAbs = 0;
    for (let i = 0; i < common; i++) {
      const d = Math.abs(refHubs[i][name] - views[i][name]);
      if (Number.isFinite(d)) maxAbs = Math.max(maxAbs, d);
      if (!near(refHubs[i][name], views[i][name])) {
        numericMismatchCount += 1;
        if (Math.abs(views[i][name] - Math.round(refHubs[i][name] * 100) / 100) < 1e-9) {
          roundingExplained += 1;
        }
      }
    }
    numericDeltas[name] = maxAbs;
  }
  return {
    refCount: refHubs.length,
    tsCount: tsHubs.length,
    countEqual: refHubs.length === tsHubs.length,
    numericMismatchCount,
    roundingExplained,
    fieldStats,
    totalMismatch,
    numericDeltas,
    firstDivergence,
    samples,
    tsViews: views,
  };
}

// ---------------------------------------------------------------------------
// 线段
// ---------------------------------------------------------------------------

function compareSegment(refSegs, tsSegs) {
  const tsViews = tsSegs.map((s) => ({
    startDate: s.start.date,
    endDate: s.end.date,
    direction: s.direction,
  }));
  const fieldFns = {
    startDate: (r, t) => r.startDate === t.startDate,
    endDate: (r, t) => r.endDate === t.endDate,
    direction: (r, t) => r.direction === t.direction,
  };
  const common = Math.min(refSegs.length, tsViews.length);
  const samples = [];
  let mismatchCount = 0;
  for (let i = 0; i < common; i++) {
    const diffs = Object.entries(fieldFns)
      .filter(([, fn]) => !fn(refSegs[i], tsViews[i]))
      .map(([name]) => name);
    if (diffs.length) {
      mismatchCount += 1;
      if (samples.length < 3) samples.push({ index: i, mismatchedFields: diffs, ref: refSegs[i], ts: tsViews[i] });
    }
  }
  const sig = signatureSetRatio(refSegs, tsViews, (x) => `${x.startDate}>${x.endDate}:${x.direction}`);
  return {
    refCount: refSegs.length,
    tsCount: tsViews.length,
    countEqual: refSegs.length === tsViews.length,
    matchedBySignature: sig.tp,
    comparedIndices: common,
    mismatchedIndices: mismatchCount,
    samples,
    refSegs,
    tsViews,
  };
}

// ---------------------------------------------------------------------------
// 买卖点
// ---------------------------------------------------------------------------

function compareBS(refEvents, bsPoints, refBis) {
  const types = ['B1', 'S1', 'B2', 'S2', 'B3', 'S3'];
  const out = {};
  for (const type of types) {
    // 参考侧记录的是“首次触发时”的笔终点；该笔可能随后被延伸。为与 TS 的最终
    // 笔表口径对齐，集合按笔下标比较，日期统一取最终笔的 edt，并保留首次触发
    // 时的 edt 作为诊断字段。
    const ref = (refEvents[type] || []).map((x) => {
      const finalBi = refBis[x.strokeIndex];
      return {
        strokeIndex: x.strokeIndex,
        strokeEdt: finalBi ? finalBi.edt : x.strokeEdt,
        firedEdt: x.strokeEdt,
        transient: finalBi ? finalBi.edt !== x.strokeEdt : false,
        signal: x.signal,
      };
    });
    const ts = bsPoints
      .filter((p) => p.type === type)
      .map((p) => ({
        strokeIndex: p.strokeIndex,
        strokeEdt: p.date,
        originalIndex: p.originalIndex,
      }));
    const refSet = new Set(ref.map((x) => x.strokeIndex));
    const tsSet = new Set(ts.map((x) => x.strokeIndex));
    const tp = [...refSet].filter((i) => tsSet.has(i)).length;
    const missing = ref.filter((x) => !tsSet.has(x.strokeIndex));
    const extra = ts.filter((x) => !refSet.has(x.strokeIndex));
    const matchedDateMismatch = ref.filter(
      (x) => tsSet.has(x.strokeIndex) && ts.find((y) => y.strokeIndex === x.strokeIndex)?.strokeEdt !== x.strokeEdt,
    );
    out[type] = {
      refCount: ref.length,
      tsCount: ts.length,
      tp,
      precision: ts.length === 0 ? (ref.length === 0 ? 1 : 0) : tp / ts.length,
      recall: ref.length === 0 ? (ts.length === 0 ? 1 : 0) : tp / ref.length,
      exactSameSet: ref.length === ts.length && missing.length === 0 && extra.length === 0,
      missing,
      extra,
      transientCount: ref.filter((x) => x.transient).length,
      matchedDateMismatchCount: matchedDateMismatch.length,
      ref,
      ts,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function judgeBi(r) {
  if (r.countEqual && r.totalMismatch === 0) return '完全一致';
  if (r.totalMismatch === 0) return '字段一致但数量不同';
  return '存在实现偏差';
}

function judgeHub(r) {
  if (r.countEqual && r.totalMismatch === 0) return '完全一致';
  if (r.totalMismatch === 0) return '字段一致但数量不同';
  return '存在实现偏差';
}

function judgeBS(set, referenceDefinition) {
  if (referenceDefinition === 'different') {
    return set.exactSameSet ? '口径不同不可比（恰好集合相同）' : '口径不同不可比';
  }
  return set.exactSameSet ? '完全一致' : '存在实现偏差';
}

/**
 * 日线合成周线，完全对齐 czsc `resample_bars(..., Freq.W, drop_unfinished=True)`：
 * - 周一~周日为一个周桶，周 K 日期取该周周五；
 * - open=首日 open、close=末日 close、high/low=区间极值、volume/amount=求和；
 * - 最后一根日 K 早于周桶周五时，丢弃该未完成周。
 */
function resampleDailyToWeekly(daily, dropUnfinished = true) {
  const sorted = [...daily].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const groups = new Map();
  for (const k of sorted) {
    const d = new Date(`${k.date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) continue;
    const dow = (d.getUTCDay() + 6) % 7;
    const daysToFriday = dow <= 4 ? 4 - dow : 11 - dow;
    const friday = new Date(d);
    friday.setUTCDate(d.getUTCDate() + daysToFriday);
    const key = friday.toISOString().slice(0, 10);
    const arr = groups.get(key);
    if (arr) arr.push(k);
    else groups.set(key, [k]);
  }
  const weekly = [];
  for (const [friday, arr] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!arr.length) continue;
    weekly.push({
      date: friday,
      open: arr[0].open,
      high: Math.max(...arr.map((x) => x.high)),
      low: Math.min(...arr.map((x) => x.low)),
      close: arr[arr.length - 1].close,
      volume: arr.reduce((s, x) => s + (x.volume || 0), 0),
      amount: arr.reduce((s, x) => s + (x.amount || 0), 0),
    });
  }
  if (
    dropUnfinished &&
    weekly.length &&
    sorted[sorted.length - 1].date < weekly[weekly.length - 1].date
  ) {
    weekly.pop();
  }
  return weekly;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const reference = generateReference();
const chanlun = await loadChanlun();

const klineDir = path.join(root, '.cache/klines');
const minuteFiles = existsSync(klineDir)
  ? readdirSync(klineDir).filter(
      (f) =>
        f.endsWith('.json') &&
        !f.endsWith('_1d_forward.json') &&
        !f.startsWith('_index'),
    )
  : [];

const result = {
  meta: {
    generatedAt: new Date().toISOString(),
    referenceEngine: reference.engine,
    tsEngine:
      'src/utils/chanlun.ts (transpileModule；min_bi_len=6；不做 max_bi_num 截断)',
    tolerance: EPS,
    symbols,
    minuteData: minuteFiles.length
      ? minuteFiles
      : 'N/A：.cache/klines 下仅有日线 `*_1d_forward.json`，无分钟级数据',
    segmentReference:
      'czsc 无线段原语；对照基线为脚本内“教科书特征序列分型法（简化口径，不含缺口二次确认）”',
  },
  symbols: {},
};

const FREQS = [
  { key: '1d', label: '日线' },
  { key: '1w', label: '周线' },
];

for (const symbol of symbols) {
  const refSymbol = reference.symbols[symbol];
  if (!refSymbol || refSymbol.error) {
    result.symbols[symbol] = { error: refSymbol?.error ?? '参考输出缺失' };
    continue;
  }
  const klinePath = path.join(root, `.cache/klines/${symbol}_1d_forward.json`);
  const daily = JSON.parse(readFileSync(klinePath, 'utf8')).klines;
  const symbolResult = { dailyCount: daily.length, freqs: {} };

  for (const freq of FREQS) {
    const refFreq = refSymbol[freq.key];
    if (!refFreq) {
      symbolResult.freqs[freq.key] = { error: `参考输出缺少 ${freq.key}` };
      continue;
    }
    const klines = freq.key === '1d' ? daily : resampleDailyToWeekly(daily);
    const pipeline = chanlun.runChanlunPipeline(klines);
    const structures = pipeline;

    const bi = compareBi(refFreq.biList, structures.strokes, klines);
    const hub = compareHub(refFreq.zsHubs, structures.hubs, structures.strokes);
    const segment = compareSegment(refFreq.segmentsTextbook, structures.segments);
    const bs = compareBS(refFreq.signalEvents, structures.bsPoints, refFreq.biList);

    const verdict = {
      bi: judgeBi(bi),
      hub: judgeHub(hub),
      segment: '无 czsc 基准（czsc 无线段原语）',
      B1: judgeBS(bs.B1, 'same'),
      S1: judgeBS(bs.S1, 'same'),
      B2: judgeBS(bs.B2, 'same'),
      S2: judgeBS(bs.S2, 'same'),
      B3: judgeBS(bs.B3, 'same'),
      S3: judgeBS(bs.S3, 'same'),
    };

    symbolResult.freqs[freq.key] = {
      label: freq.label,
      refBarCount: refFreq.barCount ?? refFreq.klineCount,
      tsBarCount: klines.length,
      barCountEqual: (refFreq.barCount ?? refFreq.klineCount) === klines.length,
      refBiCount: refFreq.biCount,
      tsBiCount: structures.strokes.length,
      refBarsRawCount: refFreq.untruncatedBarsRawCount,
      defaultMaxBiNumEvidence: refFreq.defaultMaxBiNum,
      refZsAllCount: refFreq.zsAll.length,
      refZsHubCount: refFreq.zsHubs.length,
      tsHubCount: structures.hubs.length,
      tsSegmentCount: structures.segments.length,
      tsMergedKlineCount: structures.mergedKlines.length,
      weekly: freq.key === '1w'
        ? (() => {
            const truncated = daily.slice(0, -1);
            const keep = resampleDailyToWeekly(truncated, false);
            const drop = resampleDailyToWeekly(truncated, true);
            const refBoundary = refFreq.boundaryCheck;
            const tsBoundary = {
              truncatedDailyCount: truncated.length,
              truncatedLastDailyDate: truncated[truncated.length - 1]?.date ?? null,
              weeklyCountKeepUnfinished: keep.length,
              weeklyCountDropUnfinished: drop.length,
              lastWeeklyDateKeepUnfinished: keep[keep.length - 1]?.date ?? null,
              lastWeeklyDateDropUnfinished: drop[drop.length - 1]?.date ?? null,
            };
            const boundaryMatch =
              refBoundary &&
              Object.keys(tsBoundary).every((k) => refBoundary[k] === tsBoundary[k]);
            return {
              sourceDailyCount: refFreq.sourceDailyCount,
              firstBarDate: refFreq.firstBarDate,
              lastBarDate: refFreq.lastBarDate,
              lastDailyDate: refFreq.lastDailyDate,
              droppedIncompleteWeek: refFreq.droppedIncompleteWeek,
              tsFirstBarDate: klines[0]?.date ?? null,
              tsLastBarDate: klines[klines.length - 1]?.date ?? null,
              refBoundary,
              tsBoundary,
              boundaryMatch,
            };
          })()
        : null,
      bi,
      hub,
      segment,
      bs,
      verdict,
    };

    console.log(`\n=== ${symbol} [${freq.label}]（${klines.length} 根 K 线）===`);
    console.log(
      `笔  参考 ${bi.refCount} / TS ${bi.tsCount}  字段不一致 ${bi.totalMismatch}  判定 ${verdict.bi}`,
    );
    console.log(
      `中枢 参考 ${hub.refCount} / TS ${hub.tsCount}  字段不一致 ${hub.totalMismatch}  判定 ${verdict.hub}`,
    );
    console.log(
      `线段 教科书 ${segment.refCount} / TS ${segment.tsCount}  签名重合 ${segment.matchedBySignature}`,
    );
    for (const type of ['B1', 'S1', 'B2', 'S2', 'B3', 'S3']) {
      const s = bs[type];
      console.log(
        `  ${type} 参考 ${s.refCount} / TS ${s.tsCount}  TP ${s.tp}  ` +
          `精确率 ${pct(s.precision)} 召回 ${pct(s.recall)}  判定 ${verdict[type]}`,
      );
    }
  }

  result.symbols[symbol] = symbolResult;
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

mkdirSync(path.join(root, 'reports'), { recursive: true });
writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
writeFileSync(SUMMARY_FILE, renderSummary(result), 'utf8');

console.log(`\n已写入：\n  ${REFERENCE_FILE}\n  ${RESULT_FILE}\n  ${SUMMARY_FILE}`);

// ---------------------------------------------------------------------------
// Markdown 摘要
// ---------------------------------------------------------------------------

function renderSummary(data) {
  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# czsc 一致性核验摘要');
  push();
  push(`- 生成时间：${data.meta.generatedAt}`);
  push(
    `- 参考实现：czsc ${data.meta.referenceEngine.version}（原生模块 ` +
      `\`${data.meta.referenceEngine.module}\`，max_bi_num=` +
      `${data.meta.referenceEngine.maxBiNum}，min_bi_len=${data.meta.referenceEngine.minBiLen}）`,
  );
  push(`- 被测实现：${data.meta.tsEngine}`);
  push(
    `- 数据：${data.meta.symbols.map((s) => `\`${s}\``).join('、')}，日线 + 周线（周线由日线按 czsc resample 规则合成）`,
  );
  push(`- 分钟级数据：${data.meta.minuteData}`);
  push(`- 字段容差：${data.meta.tolerance}`);
  push(`- 线段口径：${data.meta.segmentReference}`);
  push(
    '- 分型索引口径：统一取“原始 K 线下标”。czsc `NewBar.id` 是合并组首根 K 线的 id，' +
      '不能直接与 TS `Fraction.originalIndex` 比较；参考侧按分型日期 `fx.dt` 回查原始 K 线后取值。',
  );
  push();
  push('复现命令：');
  push();
  push('```bash');
  push('node scripts/verify-czsc-parity.mjs');
  push('```');
  push();

  for (const symbol of data.meta.symbols) {
    const s = data.symbols[symbol];
    if (!s || s.error) {
      push(`## ${symbol}`);
      push();
      push(`跳过：${s?.error ?? '无数据'}`);
      push();
      continue;
    }
    for (const freq of ['1d', '1w']) {
      const f = s.freqs?.[freq];
      if (!f || f.error) continue;
      push(`## ${symbol} · ${f.label}（${f.refBarCount} 根，日线源 ${s.dailyCount} 根）`);
      push();
      if (f.weekly) {
        push(
          `周线合成：czsc resample_bars(Freq.W, drop_unfinished=True) → ${f.refBarCount} 根，` +
            `首 ${f.weekly.firstBarDate} / 末 ${f.weekly.lastBarDate}；TS 同规则 → ` +
            `${f.tsBarCount} 根，首 ${f.weekly.tsFirstBarDate} / 末 ${f.weekly.tsLastBarDate}；` +
            `最后一根日线 ${f.weekly.lastDailyDate}，` +
            `未完成周丢弃=${f.weekly.droppedIncompleteWeek ? '是' : '否'}。`,
        );
        push(
          `未完成周边界核验（截掉最后一根日线）：` +
            `保留未完成周=${f.weekly.tsBoundary.weeklyCountKeepUnfinished} 根` +
            `（末 ${f.weekly.tsBoundary.lastWeeklyDateKeepUnfinished}），` +
            `丢弃后=${f.weekly.tsBoundary.weeklyCountDropUnfinished} 根` +
            `（末 ${f.weekly.tsBoundary.lastWeeklyDateDropUnfinished}）；` +
            `与 czsc ${f.weekly.boundaryMatch ? '完全一致' : '不一致'}。`,
        );
        push();
      }
      const ev = f.defaultMaxBiNumEvidence;
      if (ev) {
        push(
          `参考侧 max_bi_num 处理：默认 50 时 czsc 只保留 ${ev.biCount} 笔` +
            `（首笔 ${ev.firstBiSdt}、bars_raw ${ev.barsRawCount} 根）；本次传 ` +
            `max_bi_num=${data.meta.referenceEngine.maxBiNum} → ${f.refBiCount} 笔、` +
            `bars_raw ${f.refBarsRawCount} 根，已消除 50 笔截断的假差异。`,
        );
        push();
      }
      push('| 构件 | 参考数量 | TS 数量 | 字段不一致 | 判定 |');
      push('| --- | --- | --- | --- | --- |');
      push(`| 笔 | ${f.bi.refCount} | ${f.bi.tsCount} | ${f.bi.totalMismatch} | ${f.verdict.bi} |`);
      push(
        `| 中枢 | ${f.hub.refCount} | ${f.hub.tsCount} | ${f.hub.totalMismatch} | ${f.verdict.hub} |`,
      );
      push(
        `| 线段 | ${f.segment.refCount}（教科书基线） | ${f.segment.tsCount} | ` +
          `${f.segment.mismatchedIndices}/${f.segment.comparedIndices} | ${f.verdict.segment} |`,
      );
      push();
      if (f.hub.totalMismatch > 0) {
        push(
          `中枢 zg/zd/gg/dd 与参考的最大绝对差：` +
            `zg=${f.hub.numericDeltas.zg}、zd=${f.hub.numericDeltas.zd}、` +
            `gg=${f.hub.numericDeltas.gg}、dd=${f.hub.numericDeltas.dd}；` +
            `数值不一致 ${f.hub.roundingExplained}/${f.hub.numericMismatchCount} 项可被 ` +
            `round2(参考值) 精确解释。`,
        );
        push();
      }
      push('买卖点触发集合（按笔下标对齐）：');
      push();
      push('| 类型 | 参考 | TS | 命中 | 精确率 | 召回率 | 缺失 | 多余 | 判定 |');
      push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const type of ['B1', 'S1', 'B2', 'S2', 'B3', 'S3']) {
        const b = f.bs[type];
        push(
          `| ${type} | ${b.refCount} | ${b.tsCount} | ${b.tp} | ${pct(b.precision)} | ${pct(b.recall)} | ` +
            `${b.missing.length} | ${b.extra.length} | ${f.verdict[type]} |`,
        );
      }
      push();

      if (f.bi.samples.length) {
        push('笔差异样本（前 3 个）：');
        push();
        for (const sample of f.bi.samples) {
          push(
            `- #${sample.index} 不一致字段：${sample.mismatchedFields.join(', ')}；参考 ` +
              `${sample.ref.sdt} → ${sample.ref.edt} ${sample.ref.direction} ` +
              `H=${sample.ref.high} L=${sample.ref.low} ` +
              `fx=[${sample.ref.fxA.rawIndex}, ${sample.ref.fxB.rawIndex}]；TS ` +
              `${sample.ts.sdt} → ${sample.ts.edt} ${sample.ts.direction} ` +
              `H=${sample.ts.high} L=${sample.ts.low} ` +
              `fx=[${sample.ts.startFxIndex}, ${sample.ts.endFxIndex}]`,
          );
        }
        push();
      }

      if (f.hub.samples.length) {
        push('中枢差异样本（前 3 个）：');
        push();
        for (const sample of f.hub.samples) {
          push(
            `- #${sample.index} 不一致字段：${sample.mismatchedFields.join(', ')}；参考 ` +
              `笔[${sample.ref.startBi}..${sample.ref.endBi}] zg/zd/gg/dd=` +
              `${sample.ref.zg}/${sample.ref.zd}/${sample.ref.gg}/${sample.ref.dd}；TS ` +
              `笔[${sample.ts.startBi}..${sample.ts.endBi}] zg/zd/gg/dd=` +
              `${sample.ts.zg}/${sample.ts.zd}/${sample.ts.gg}/${sample.ts.dd}`,
          );
        }
        push();
      }

      if (f.segment.samples.length) {
        push('线段差异样本（前 3 个）：');
        push();
        for (const sample of f.segment.samples) {
          push(
            `- #${sample.index} 不一致字段：${sample.mismatchedFields.join(', ')}；教科书 ` +
              `${sample.ref.startDate} → ${sample.ref.endDate} ${sample.ref.direction}；TS ` +
              `${sample.ts.startDate} → ${sample.ts.endDate} ${sample.ts.direction}`,
          );
        }
        push();
      }

      const bsDiffs = ['B1', 'S1', 'B2', 'S2', 'B3', 'S3'].filter(
        (t) => f.bs[t].missing.length || f.bs[t].extra.length,
      );
      if (bsDiffs.length) {
        push('买卖点差异明细：');
        push();
        for (const type of bsDiffs) {
          const b = f.bs[type];
          if (b.missing.length) {
            push(
              `- ${type} 参考有、TS 缺失：` +
                b.missing
                  .map(
                    (x) =>
                      `笔#${x.strokeIndex}(${x.strokeEdt}` +
                      `${x.transient ? `，首次触发 ${x.firedEdt}，该笔随后延伸` : ''})`,
                  )
                  .join('、'),
            );
          }
          if (b.extra.length) {
            const strokeDates = b.extra.map((x) => `笔#${x.strokeIndex}(${x.strokeEdt})`);
            push(`- ${type} TS 多出：` + strokeDates.join('、'));
          }
        }
        push();
      }
    }
  }

  push();
  push(renderVerdict(data));

  return lines.join('\n');
}

function renderVerdict(data) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  const types = ['B1', 'S1', 'B2', 'S2', 'B3', 'S3'];
  const components = ['笔', '中枢', '线段', ...types];

  const hubMaxDelta = (s) =>
    Math.max(...['zg', 'zd', 'gg', 'dd'].map((k) => Math.abs(s.hub.numericDeltas[k] ?? 0)));

  function biReason(s) {
    if (s.bi.totalMismatch === 0 && s.bi.countEqual) {
      return { cause: '无差异：逐笔逐字段一致。', action: '无需修改。', kind: '一致' };
    }
    const bad = Object.entries(s.bi.fieldStats)
      .filter(([, v]) => v.mismatched > 0)
      .map(([name]) => name);
    return {
      cause:
        `笔表在第 ${s.bi.firstDivergence} 笔首次分歧，分歧字段：${bad.join(', ')}。` +
        '可能根因：去包含边界、min_bi_len、首笔起点、破坏笔回滚逻辑（需按样本上下文定位）。',
      action: '【必须修】按差异样本的上下文 K 线逐根比对新旧 K 线合并结果与 check_bi 回滚分支。',
      kind: '偏差',
    };
  }

  function hubReason(s) {
    if (s.hub.totalMismatch === 0 && s.hub.countEqual) {
      return { cause: '无差异：中枢段数与起止笔、zg/zd/gg/dd 全部一致。', action: '无需修改。', kind: '一致' };
    }
    if (!s.hub.countEqual) {
      return {
        cause:
          `中枢段数不同（参考 ${s.hub.refCount} / TS ${s.hub.tsCount}），` +
          '根因在 get_zs_seq 切分条件或中枢有效性过滤（>=3 笔、zg>zd、is_valid）。',
        action: '【必须修】按段序号对齐后定位首个切分分歧处的笔区间与 zg/zd 取值。',
        kind: '偏差',
      };
    }
    const bad = Object.entries(s.hub.fieldStats)
      .filter(([, v]) => v.mismatched > 0)
      .map(([name]) => name);
    return {
      cause:
        `起止笔与笔数 0 差异，仅 ${bad.join('/')} 数值不同，最大绝对差 ${hubMaxDelta(s)}；` +
        'zg/zd 由前三笔重叠区间决定，gg/dd 由中枢内全部笔的极值决定。',
      action: '【必须修】逐笔核对 ZS::new 的 zg/zd/gg/dd 取值与中枢延伸/新生判定。',
      kind: '偏差',
    };
  }

  function segmentReason(s) {
    return {
      cause:
        'czsc 没有线段原语，本项无 czsc 基准。脚本仅以“教科书特征序列分型法（简化口径）”' +
        `作参考：教科书 ${s.segment.refCount} 段 / TS ${s.segment.tsCount} 段，` +
        `签名重合 ${s.segment.matchedBySignature}/${s.segment.refCount}。` +
        'TS strokesToSegments 采用“笔端点分型 + 间隔≥3 笔”，与特征序列分型口径不同。',
      action:
        '【需用户决策】要得到教科书口径需按特征序列（含缺口二次确认）重写；' +
        '在此之前不得声称线段与 czsc 一致。',
      kind: '无基准',
    };
  }

  function bsReason(s, type) {
    const b = s.bs[type];
    if (s.verdict[type] === '完全一致') {
      return { cause: '无差异：触发笔集合与日期完全一致。', action: '无需修改。', kind: '一致' };
    }
    return {
      cause:
        `触发集合 ${b.refCount}/${b.tsCount}，精确率 ${pct(b.precision)}、召回 ${pct(b.recall)}；` +
        `缺失 ${b.missing.length}、多余 ${b.extra.length}、日期不一致 ${b.matchedDateMismatchCount}` +
        (b.transientCount ? `、参考事件中瞬时触发 ${b.transientCount}` : '') +
        '。信号入参与参考实现同一口径，残留差异需按样本定位 replay 状态变化。',
      action: '【必须修】按缺失/多余样本逐项核对触发时的笔表状态与信号入参窗口。',
      kind: '偏差',
    };
  }

  const verdictOf = (s, component) => {
    if (component === '笔') return s.verdict.bi;
    if (component === '中枢') return s.verdict.hub;
    if (component === '线段') return s.verdict.segment;
    return s.verdict[component];
  };

  // 判定表（逐标的逐频率）
  push('## 判定表');
  push();
  for (const symbol of data.meta.symbols) {
    const symbolData = data.symbols[symbol];
    if (!symbolData || symbolData.error) continue;
    for (const freq of ['1d', '1w']) {
      const s = symbolData.freqs?.[freq];
      if (!s || s.error) continue;
      push(`### ${symbol} · ${s.label}`);
      push();
      push('| 构件 | 判定 | 量化证据 | 根因 | 最小修复建议 |');
      push('| --- | --- | --- | --- | --- |');
      for (const component of components) {
        const verdict = verdictOf(s, component);
        let reason;
        let evidence;
        if (component === '笔') {
          reason = biReason(s);
          evidence = `参考 ${s.bi.refCount} / TS ${s.bi.tsCount}；` +
            `7 字段检查 ${Object.values(s.bi.fieldStats).reduce((a, v) => a + v.checked, 0)} 次，` +
            `不一致 ${s.bi.totalMismatch} 次`;
        } else if (component === '中枢') {
          reason = hubReason(s);
          evidence =
            `参考 ${s.hub.refCount} / TS ${s.hub.tsCount}；字段不一致 ${s.hub.totalMismatch}；` +
            `zg/zd/gg/dd 最大绝对差 ${hubMaxDelta(s)}`;
        } else if (component === '线段') {
          reason = segmentReason(s);
          evidence =
            `教科书基线 ${s.segment.refCount} / TS ${s.segment.tsCount}；` +
            `签名重合 ${s.segment.matchedBySignature}/${s.segment.refCount}`;
        } else {
          const b = s.bs[component];
          reason = bsReason(s, component);
          evidence =
            `参考 ${b.refCount} / TS ${b.tsCount}；精确率 ${pct(b.precision)}、召回 ${pct(b.recall)}；` +
            `缺失 ${b.missing.length}、多余 ${b.extra.length}、日期不一致 ${b.matchedDateMismatchCount}`;
        }
        push(`| ${component} | ${verdict} | ${evidence} | ${reason.cause} | ${reason.action} |`);
      }
      push();
    }
  }

  // 判定表（跨标的、跨频率汇总）
  push('### 最终验收汇总（2 标的 × 日线/周线）');
  push();
  push('| 构件 | 判定 | 量化证据 | 根因分类 | 最小修复建议 |');
  push('| --- | --- | --- | --- | --- |');
  for (const component of components) {
    const parts = [];
    const verdicts = [];
    const kinds = [];
    const actions = [];
    for (const symbol of data.meta.symbols) {
      const symbolData = data.symbols[symbol];
      if (!symbolData || symbolData.error) continue;
      for (const freq of ['1d', '1w']) {
        const s = symbolData.freqs?.[freq];
        if (!s || s.error) continue;
        const tag = `${symbol} ${s.label}`;
        verdicts.push(`${tag}: ${verdictOf(s, component)}`);
        let reason;
        let evidence;
        if (component === '笔') {
          reason = biReason(s);
          evidence = `${tag} ${s.bi.refCount}/${s.bi.tsCount}（不一致 ${s.bi.totalMismatch}）`;
        } else if (component === '中枢') {
          reason = hubReason(s);
          evidence = `${tag} ${s.hub.refCount}/${s.hub.tsCount}（不一致 ${s.hub.totalMismatch}）`;
        } else if (component === '线段') {
          reason = segmentReason(s);
          evidence = `${tag} 教科书基线 ${s.segment.refCount}/TS ${s.segment.tsCount}`;
        } else {
          const b = s.bs[component];
          reason = bsReason(s, component);
          evidence =
            `${tag} ${b.refCount}/${b.tsCount}（P ${pct(b.precision)} / R ${pct(b.recall)}）`;
        }
        parts.push(evidence);
        kinds.push(reason.kind);
        if (!actions.includes(reason.action)) actions.push(reason.action);
      }
    }
    const unified = verdicts.every((v) => v.split(': ')[1] === verdicts[0].split(': ')[1]);
    const verdict = unified ? verdicts[0].split(': ')[1] : verdicts.join('；');
    const kindSet = [...new Set(kinds)];
    const rootTag = kindSet.length === 1 ? kindSet[0] : kindSet.join(' / ');
    push(`| ${component} | ${verdict} | ${parts.join('；')} | ${rootTag} | ${actions.join(' ')} |`);
  }
  push();
  push('判定口径说明：');
  push();
  push('- 「完全一致」：数量相同且所有比对字段 0 差异；');
  push('- 「字段一致但数量不同」：共有部分字段 0 差异但条数不同；');
  push('- 「无 czsc 基准」：参考实现没有对应原语，不参与一致性判定；');
  push('- 「存在实现偏差」：存在可定位的字段/集合差异。');
  push();

  return lines.join('\n');
}
