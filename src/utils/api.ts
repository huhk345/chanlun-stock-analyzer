import { Kline, Stroke, Segment, Hub, Fraction, StockBasicInfo } from '../types/stock';
import { acquireTickFlowSlot } from './rateLimiter';

// Helper function to get API keys from localStorage or environment variables
function getApiKey(key: string): string {
  try {
    const savedKeys = localStorage.getItem('api_keys');
    if (savedKeys) {
      const keys = JSON.parse(savedKeys);
      if (keys[key]) {
        return keys[key];
      }
    }
  } catch (e) {
    console.error('Failed to read API keys from localStorage');
  }
  return '';
}

// TickFlow API Configuration
// 免费API无需API Key，使用 https://free-api.tickflow.org
// 完整服务需要API Key，使用 https://api.tickflow.org
const getTickFlowApiKey = () => getApiKey('tickflow') || import.meta.env.VITE_TICKFLOW_API_KEY || '';
const getTickFlowBaseUrl = () => getTickFlowApiKey() ? 'https://api.tickflow.org' : 'https://free-api.tickflow.org';

// Helper: Resolve stock symbols for TickFlow API (Chinese stocks only)
export function resolveSymbol(symbol: string): { resolved: string; displayName: string; isChinaStock: boolean } {
  const clean = symbol.trim().toUpperCase();
  if (/^\d{6}$/.test(clean)) {
    // 6-digit pure numbers represent Chinese stocks
    const isSS = /^(60|68|90|11|13|51|58|60)/.test(clean);
    const suffix = isSS ? 'SH' : 'SZ';
    return {
      resolved: `${clean}.${suffix}`,
      displayName: `${clean}.${suffix}`,
      isChinaStock: true
    };
  }
  // Handle symbols with .SS or .SZ suffix
  if (clean.endsWith('.SS')) {
    return {
      resolved: clean.replace('.SS', '.SH'),
      displayName: clean,
      isChinaStock: true
    };
  }
  if (clean.endsWith('.SZ')) {
    return {
      resolved: clean,
      displayName: clean,
      isChinaStock: true
    };
  }
  return {
    resolved: clean,
    displayName: clean,
    isChinaStock: false
  };
}

// Fetch stock K-line data directly from TickFlow API
export async function fetchStockData(symbol: string): Promise<{
  symbol: string;
  name: string;
  klines: Kline[];
  source: string;
  period: string;
}> {
  const { resolved, displayName, isChinaStock } = resolveSymbol(symbol);

  if (!isChinaStock) {
    throw new Error(
      'This application only supports Chinese A-share stocks. Please use a 6-digit stock code (e.g., 000001.ss, 600000) or a symbol with .SS/.SZ suffix.'
    );
  }

  // Always fetch 5 years of daily K-line data
  const period = '1d';
  const count = 365 * 5; // 5 years
  const TICKFLOW_API_KEY = getTickFlowApiKey();
  const TICKFLOW_BASE_URL = getTickFlowBaseUrl();
  const isFreeAPI = !TICKFLOW_API_KEY;

  // TickFlow API URL with query parameters
  const tickflowUrl = `${TICKFLOW_BASE_URL}/v1/klines?symbol=${resolved}&period=${period}&count=${count}&adjust=forward`;

  console.log(`[TickFlow] ${isFreeAPI ? '免费API' : '完整服务'} - Fetching 5 years data for ${displayName} (前复权)`);
  console.log(`[TickFlow] URL: ${tickflowUrl}`);

  const headers: Record<string, string> = {};
  if (TICKFLOW_API_KEY) {
    headers['x-api-key'] = TICKFLOW_API_KEY;
  }

  // TickFlow may signal rate limiting either via HTTP 429 or via a 200 body
  // containing the "请求频率超限" message with a "请 Nms 后重试" hint.
  // Parse that hint to wait exactly the suggested duration before retrying.
  const extractRateLimitDelay = (text: string): number | null => {
    const msMatch = text.match(/请\s*(\d+)\s*ms\s*后重试/);
    if (msMatch) return parseInt(msMatch[1], 10);
    const secMatch = text.match(/请\s*(\d+(?:\.\d+)?)\s*秒?\s*后重试/);
    if (secMatch) return Math.ceil(parseFloat(secMatch[1]) * 1000);
    return null;
  };

  const MAX_RETRIES = 4;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Proactively throttle to 55/min so we stay under the free tier's 60/min
    // hard cap before even issuing the request.
    await acquireTickFlowSlot();

    const response = await fetch(tickflowUrl, { headers });

    console.log(`[TickFlow] Response status: ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);

    if (response.ok) {
      return await handleTickflowResponse(response, displayName);
    }

    const errorText = await response.text();
    console.error(`TickFlow API error: ${response.status} - ${errorText}`);

    const delayMs = extractRateLimitDelay(errorText);
    if (delayMs != null && attempt < MAX_RETRIES) {
      console.warn(`[TickFlow] Rate limited. Waiting ${delayMs}ms before retry...`);
      await new Promise((r) => setTimeout(r, delayMs));
      lastError = new Error(
        `TickFlow 免费接口请求频率超限 (60/min)。已等待 ${Math.round(delayMs / 1000)} 秒后自动重试。若频繁触发, 建议在配置中填入完整服务 API Key (https://api.tickflow.org)。`
      );
      continue;
    }

    throw new Error(
      `Unable to fetch data for symbol "${displayName}" from TickFlow API. Status: ${response.status}` +
        (errorText ? ` - ${errorText}` : '')
    );
  }

  throw lastError ?? new Error(`Unable to fetch data for symbol "${displayName}" from TickFlow API after retries.`);
}

async function handleTickflowResponse(response: Response, displayName: string): Promise<{
  symbol: string;
  name: string;
  klines: Kline[];
  source: string;
  period: string;
}> {
  const responseData = await response.json();
  console.log(`[TickFlow] Response data keys: ${Object.keys(responseData || {}).join(', ')}`);

  if (!responseData || !responseData.data) {
    console.error(`[TickFlow] No data in response`);
    throw new Error('No data returned from TickFlow API');
  }

  const { data } = responseData;
  const dataLength = data.timestamp?.length || 0;
  console.log(`[TickFlow] Received ${dataLength} data points`);

  if (dataLength === 0) {
    throw new Error('No K-line data points returned from TickFlow API');
  }

  const klines: Kline[] = [];

  // TickFlow returns columnar data: arrays for each field
  for (let i = 0; i < dataLength; i++) {
    const timestamp = data.timestamp[i];
    const open = data.open[i];
    const high = data.high[i];
    const low = data.low[i];
    const close = data.close[i];
    const volume = data.volume[i] || 0;
    const amount = data.amount[i] || 0;

    // Convert timestamp to date string (YYYY-MM-DD) in China timezone (UTC+8)
    const CHINA_OFFSET = 8 * 60 * 60 * 1000;
    const date = new Date(timestamp + CHINA_OFFSET);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    klines.push({
      date: dateStr,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: volume,
      amount: amount,
    });
  }

  console.log(`[TickFlow] Processed ${klines.length} klines`);
  if (klines.length > 0) {
    console.log(`[TickFlow] First kline: ${JSON.stringify(klines[0])}`);
    console.log(`[TickFlow] Last kline: ${JSON.stringify(klines[klines.length - 1])}`);
  }

  if (klines.length < 30) {
    throw new Error(
      `Insufficient historical data for symbol "${displayName}". Only ${klines.length} bars available, need at least 30 for analysis.`
    );
  }

  console.log(`[TickFlow] Successfully processed ${klines.length} klines for ${displayName}`);

  return {
    symbol: displayName,
    name: displayName,
    klines: klines,
    source: 'TickFlow API',
    period: '5 years daily'
  };
}

// Gemini API configuration
const getGeminiApiKey = () => getApiKey('gemini') || import.meta.env.VITE_GEMINI_API_KEY || '';
const getOpenRouterApiKey = () => getApiKey('openrouter') || import.meta.env.VITE_OPENROUTER_API_KEY || '';

// ---------------------------------------------------------------------------
// ChanLun context serialization
// ---------------------------------------------------------------------------

export interface ChanLunContext {
  symbol: string;
  klines: Kline[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  fractions: Fraction[];
  /** Optional pre-computed buy/sell triggers. */
  currentSetup?: any[];
  /** Number of recent K-line bars to embed in full OHLCV form. Default 90. */
  recentWindow?: number;
}

const DEFAULT_RECENT_WINDOW = 90;

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function summarizeKlines(klines: Kline[]) {
  if (klines.length === 0) {
    return { count: 0, first: null, last: null, highest: 0, lowest: 0, avgVolume: 0, avgAmount: 0, range: 0, totalReturn: 0, maxDrawdown: 0 };
  }
  const first = klines[0];
  const last = klines[klines.length - 1];
  const highest = Math.max(...klines.map((k) => k.high));
  const lowest = Math.min(...klines.map((k) => k.low));
  const avgVolume = klines.reduce((acc, k) => acc + k.volume, 0) / klines.length;
  const avgAmount = klines.reduce((acc, k) => acc + k.amount, 0) / klines.length;
  const totalReturn = first.close === 0 ? 0 : (last.close - first.close) / first.close;

  // Crude max drawdown based on running close-to-close highs.
  let peak = first.close;
  let maxDD = 0;
  for (const k of klines) {
    if (k.close > peak) peak = k.close;
    if (peak > 0) {
      const dd = (peak - k.close) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }

  return {
    count: klines.length,
    first: { date: first.date, close: first.close },
    last: { date: last.date, close: last.close },
    highest,
    lowest,
    avgVolume,
    avgAmount,
    range: highest - lowest,
    totalReturn,
    maxDrawdown: maxDD,
  };
}

function formatKlineRows(klines: Kline[]): string {
  if (klines.length === 0) return '(无 K 线数据)';
  return klines
    .map(
      (k) =>
        `${k.date} | O:${k.open.toFixed(2)} H:${k.high.toFixed(2)} L:${k.low.toFixed(2)} C:${k.close.toFixed(2)} V:${Math.round(k.volume)} A:${Math.round(k.amount)}`,
    )
    .join('\n');
}

function formatStrokes(strokes: Stroke[]): string {
  if (strokes.length === 0) return '(无笔)';
  return strokes
    .map(
      (s, i) =>
        `#${i + 1} ${s.direction === 'up' ? '↑' : '↓'} ${s.start.date} ${s.start.price.toFixed(2)} → ${s.end.date} ${s.end.price.toFixed(2)}`,
    )
    .join('\n');
}

function formatSegments(segments: Segment[]): string {
  if (segments.length === 0) return '(无线段)';
  return segments
    .map(
      (s, i) =>
        `#${i + 1} ${s.direction === 'up' ? '↑' : '↓'} ${s.start.date} ${s.start.price.toFixed(2)} → ${s.end.date} ${s.end.price.toFixed(2)}`,
    )
    .join('\n');
}

function formatHubs(hubs: Hub[]): string {
  if (hubs.length === 0) return '(无中枢)';
  return hubs
    .map(
      (h, i) =>
        `#${i + 1} level:${h.level} ZG:${h.zg.toFixed(2)} ZD:${h.zd.toFixed(2)} GG:${h.gg.toFixed(2)} DD:${h.dd.toFixed(2)} | bars[${h.startIndex}..${h.endIndex}] strokes:${h.strokesCount}`,
    )
    .join('\n');
}

function formatFractions(fractions: Fraction[]): string {
  if (fractions.length === 0) return '(无分型)';
  return fractions
    .map((f) => `${f.date} ${f.type === 'TOP' ? '顶' : '底'} ${f.price.toFixed(2)} (idx=${f.originalIndex})`)
    .join('\n');
}

/**
 * Build the full markdown context block that gets injected into the AI prompt.
 * Includes summary statistics, recent K-line OHLCV rows, and complete
 * strokes / segments / hubs / fractions arrays.
 */
export function buildChanLunContext(ctx: ChanLunContext): string {
  const recentWindow = ctx.recentWindow ?? DEFAULT_RECENT_WINDOW;
  const recent = ctx.klines.slice(-recentWindow);
  const summary = summarizeKlines(ctx.klines);

  const lastKline = ctx.klines[ctx.klines.length - 1];
  const firstRecent = recent[0];
  const recentReturn =
    firstRecent && lastKline && firstRecent.close > 0
      ? (lastKline.close - firstRecent.close) / firstRecent.close
      : 0;

  return [
    `# ${ctx.symbol} 缠论多因子分析上下文`,
    '',
    '## 1. K线全期统计 (5 年日线 / 总计 ' + summary.count + ' 根)',
    `- 数据起点: ${summary.first ? `${summary.first.date} 收 ${summary.first.close.toFixed(2)}` : 'N/A'}`,
    `- 数据终点: ${summary.last ? `${summary.last.date} 收 ${summary.last.close.toFixed(2)}` : 'N/A'}`,
    `- 区间最高: ${summary.highest.toFixed(2)} | 区间最低: ${summary.lowest.toFixed(2)} | 区间振幅: ${summary.range.toFixed(2)}`,
    `- 累计收益率: ${pct(summary.totalReturn)} | 最大回撤: ${pct(summary.maxDrawdown)} | 均成交量: ${Math.round(summary.avgVolume)} | 均成交额: ${Math.round(summary.avgAmount)}`,
    '',
    `## 2. 最近 ${recent.length} 根日 K 线 (近 ${recentWindow} 个交易日) 累计涨跌 ${pct(recentReturn)}`,
    '| 日期 | 开 | 高 | 低 | 收 | 量 | 额 |',
    '|---|---|---|---|---|---|---|',
    recent
      .map(
        (k) =>
          `| ${k.date} | ${k.open.toFixed(2)} | ${k.high.toFixed(2)} | ${k.low.toFixed(2)} | ${k.close.toFixed(2)} | ${Math.round(k.volume)} | ${Math.round(k.amount)} |`,
      )
      .join('\n'),
    '',
    `## 3. 分型列表 (${ctx.fractions.length} 个, 取最近 60 个)`,
    formatFractions(ctx.fractions.slice(-60)),
    '',
    `## 4. 笔列表 (${ctx.strokes.length} 条, 取最近 80 条)`,
    formatStrokes(ctx.strokes.slice(-80)),
    '',
    `## 5. 线段列表 (${ctx.segments.length} 条, 全部)`,
    formatSegments(ctx.segments.slice(-60)),
    '',
    `## 6. 中枢列表 (${ctx.hubs.length} 个, 全部)`,
    formatHubs(ctx.hubs),
    '',
    `## 7. 当前活跃买卖点 (Buy/Sell Triggers)`,
    ctx.currentSetup && ctx.currentSetup.length > 0
      ? '```json\n' + JSON.stringify(ctx.currentSetup, null, 2) + '\n```'
      : '(无已识别的活跃买卖点)',
  ].join('\n');
}

function buildSystemPrompt(): string {
  return [
    '你是一位资深 A 股缠论 (ChanLun) 量化分析师, 精通分型、笔、线段、中枢、买卖点、走势背驰 (背离) 等核心概念。',
    '你将收到一份结构化上下文, 包含 5 年日 K 线汇总 + 最近约 90 个交易日的完整 OHLCV, 以及识别出的分型、笔、线段、中枢。',
    '请基于这些数据给出专业、可执行的中文投资分析报告, 严格使用 Markdown 格式, 包含以下章节:',
    '1. # 总览 (Overall Bias): 多空判断、当前趋势方向、关键价位',
    '2. ## 缠论结构解读: 笔 / 线段 / 中枢的状态、最近中枢的 zg/zd/gg/dd 含义',
    '3. ## 买卖点与背驰分析: 是否存在一买 / 二买 / 三买 / 一卖 / 二卖 / 三卖, 是否存在顶 / 底背驰',
    '4. ## 关键支撑压力位: 结合中枢边界、分型高低点给出具体价格',
    '5. ## 交易策略与风控: 入场区间、止损位、仓位建议、目标位',
    '6. ## 风险提示: 数据局限、模型风险、宏观 / 消息面提醒',
    '语气专业、量化、有数据支撑; 必要时引用具体日期和价格。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Provider callers
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

async function callOpenRouterChat(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  temperature = 0.7,
): Promise<string> {
  console.log(`[AI] OpenRouter -> ${model} (${messages.length} msg)`);
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'ChanLun Stock Analyzer',
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AI] OpenRouter error:', response.status, errorText);
    let detail = errorText;
    try {
      const parsed = JSON.parse(errorText);
      detail = parsed?.error?.message || parsed?.message || errorText;
    } catch {
      // keep raw text
    }
    throw new Error(`OpenRouter 调用失败 (${response.status}): ${detail || '请检查模型 id 或 API Key'}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGeminiChat(
  apiKey: string,
  messages: ChatMessage[],
  temperature = 0.7,
): Promise<string> {
  console.log(`[AI] Gemini direct (${messages.length} msg)`);
  // Split out the system message and remap roles to Gemini format.
  const systemMsg = messages.find((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');
  const contents = conversation.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body: any = {
    contents,
    generationConfig: { temperature },
  };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AI] Gemini error:', responseTextSafe(errorText));
    throw new Error(`Gemini 调用失败 (${response.status}): 请检查 VITE_GEMINI_API_KEY 是否有效`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function responseTextSafe(text: string): string {
  return text.length > 300 ? text.slice(0, 300) + '...' : text;
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

export type StreamCallback = (chunk: string) => void;
export type ReasoningCallback = (reasoning: string) => void;

async function callOpenRouterChatStream(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: StreamCallback,
  temperature = 0.7,
  onReasoning?: ReasoningCallback,
): Promise<string> {
  console.log(`[AI] OpenRouter stream -> ${model} (${messages.length} msg)`);
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'ChanLun Stock Analyzer',
    },
    body: JSON.stringify({
      model,
      temperature,
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AI] OpenRouter stream error:', response.status, errorText);
    let detail = errorText;
    try {
      const parsed = JSON.parse(errorText);
      detail = parsed?.error?.message || parsed?.message || errorText;
    } catch {
      // keep raw text
    }
    throw new Error(`OpenRouter 调用失败 (${response.status}): ${detail || '请检查模型 id 或 API Key'}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('ReadableStream not supported');

  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta;
          const content = delta?.content || '';
          const reasoning = delta?.reasoning || delta?.reasoning_content || '';
          if (reasoning && onReasoning) {
            onReasoning(reasoning);
          }
          if (content) {
            full += content;
            onToken(content);
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return full;
}

async function callGeminiChatStream(
  apiKey: string,
  messages: ChatMessage[],
  onToken: StreamCallback,
  temperature = 0.7,
): Promise<string> {
  console.log(`[AI] Gemini stream (${messages.length} msg)`);
  const systemMsg = messages.find((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');
  const contents = conversation.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`;
  const body: any = {
    contents,
    generationConfig: { temperature },
  };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AI] Gemini stream error:', errorText);
    throw new Error(`Gemini 调用失败 (${response.status}): 请检查 VITE_GEMINI_API_KEY 是否有效`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('ReadableStream not supported');

  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (text) {
            full += text;
            onToken(text);
          }
        } catch {
          // skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return full;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export interface AnalyzeWithAIParams extends ChanLunContext {
  /** OpenRouter model id (e.g. "google/gemini-2.0-flash-exp:free"). */
  model?: string;
  /** Optional temperature override. */
  temperature?: number;
}

/**
 * Run a multi-factor ChanLun analysis using either OpenRouter (preferred) or
 * the direct Gemini API. The model id is forwarded to OpenRouter; for the
 * Gemini path the model is fixed to gemini-2.0-flash.
 */
export async function analyzeWithAI(params: AnalyzeWithAIParams): Promise<string> {
  const { model, klines, strokes, segments, hubs, fractions, currentSetup, symbol, recentWindow } = params;

  if (!klines || klines.length === 0) {
    throw new Error('没有可用的 K 线数据, 请先加载股票数据。');
  }

  const OPENROUTER_API_KEY = getOpenRouterApiKey();
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    throw new Error('未配置 AI API 密钥。请在配置中设置 Gemini API Key 或 OpenRouter API Key。');
  }

  const systemPrompt = buildSystemPrompt();
  const contextBlock = buildChanLunContext({ symbol, klines, strokes, segments, hubs, fractions, currentSetup, recentWindow });
  const lastKline = klines[klines.length - 1];

  const userPrompt = [
    `请基于以下"${symbol}"的结构化缠论上下文给出专业量化分析报告:`,
    '',
    '--- CONTEXT START ---',
    contextBlock,
    '--- CONTEXT END ---',
    '',
    `当前最新一根 K 线: 日期=${lastKline.date}, 收=${lastKline.close}, 区间 [${lastKline.low.toFixed(2)}, ${lastKline.high.toFixed(2)}]。`,
    '请严格按系统提示中的 6 个章节给出中文 Markdown 报告。',
  ].join('\n');

  if (OPENROUTER_API_KEY) {
    const selectedModel = model && model.trim().length > 0 ? model : 'google/gemini-2.0-flash-exp:free';
    return callOpenRouterChat(OPENROUTER_API_KEY, selectedModel, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);
  }

  return callGeminiChat(GEMINI_API_KEY, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);
}

// ---------------------------------------------------------------------------
// Chat with the AI (multi-turn, context is included in the system prompt)
// ---------------------------------------------------------------------------

export interface ChatWithAIParams extends ChanLunContext {
  /** Conversation history (most recent last). System messages are accepted but
   *  the actual system prompt is rebuilt from the fresh context. */
  messages: ChatMessage[];
  /** OpenRouter model id. */
  model?: string;
  temperature?: number;
}

/**
 * Send the current conversation to the AI, using a freshly built system prompt
 * that embeds the latest ChanLun context. The returned string is the
 * assistant's reply.
 */
export async function chatWithAI(params: ChatWithAIParams): Promise<string> {
  const {
    messages,
    model,
    klines,
    strokes,
    segments,
    hubs,
    fractions,
    currentSetup,
    symbol,
    recentWindow,
    temperature,
  } = params;

  if (!klines || klines.length === 0) {
    throw new Error('没有可用的 K 线数据, 请先加载股票数据。');
  }
  if (!messages || messages.length === 0) {
    throw new Error('请输入要发送给 AI 的消息。');
  }

  const OPENROUTER_API_KEY = getOpenRouterApiKey();
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    throw new Error('未配置 AI API 密钥。请在配置中设置 Gemini API Key 或 OpenRouter API Key。');
  }

  const systemPrompt = buildSystemPrompt();
  const contextBlock = buildChanLunContext({ symbol, klines, strokes, segments, hubs, fractions, currentSetup, recentWindow });

  // Inject the ChanLun context as the very first user turn so the model
  // has the full data available, regardless of which model is used.
  const contextPrimer: ChatMessage = {
    role: 'user',
    content: [
      `以下是"${symbol}"的结构化缠论上下文 (system-managed, 请勿要求重新提供):`,
      '',
      '--- CONTEXT START ---',
      contextBlock,
      '--- CONTEXT END ---',
      '',
      '请记住这些数据, 后续我将基于此上下文进行提问。请用中文 Markdown 简洁回答。',
    ].join('\n'),
  };

  // Sanitize: keep only user / assistant turns, ignore any client-supplied
  // system messages (we always provide our own).
  const conversation = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .filter((m) => m.content.length > 0);

  const finalMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    contextPrimer,
    ...conversation,
  ];

  if (OPENROUTER_API_KEY) {
    const selectedModel = model && model.trim().length > 0 ? model : 'google/gemini-2.0-flash-exp:free';
    return callOpenRouterChat(OPENROUTER_API_KEY, selectedModel, finalMessages, temperature);
  }

  return callGeminiChat(GEMINI_API_KEY, finalMessages, temperature);
}

/**
 * Streaming version of chatWithAI. Calls onToken for each content chunk as it
 * arrives, and returns the full assembled reply.
 */
export async function chatWithAIStream(
  params: ChatWithAIParams,
  onToken: StreamCallback,
): Promise<string> {
  const {
    messages,
    model,
    klines,
    strokes,
    segments,
    hubs,
    fractions,
    currentSetup,
    symbol,
    recentWindow,
    temperature,
  } = params;

  if (!klines || klines.length === 0) {
    throw new Error('没有可用的 K 线数据, 请先加载股票数据。');
  }
  if (!messages || messages.length === 0) {
    throw new Error('请输入要发送给 AI 的消息。');
  }

  const OPENROUTER_API_KEY = getOpenRouterApiKey();
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    throw new Error('未配置 AI API 密钥。请在配置中设置 Gemini API Key 或 OpenRouter API Key。');
  }

  const systemPrompt = buildSystemPrompt();
  const contextBlock = buildChanLunContext({ symbol, klines, strokes, segments, hubs, fractions, currentSetup, recentWindow });

  const contextPrimer: ChatMessage = {
    role: 'user',
    content: [
      `以下是"${symbol}"的结构化缠论上下文 (system-managed, 请勿要求重新提供):`,
      '',
      '--- CONTEXT START ---',
      contextBlock,
      '--- CONTEXT END ---',
      '',
      '请记住这些数据, 后续我将基于此上下文进行提问。请用中文 Markdown 简洁回答。',
    ].join('\n'),
  };

  const conversation = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .filter((m) => m.content.length > 0);

  const finalMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    contextPrimer,
    ...conversation,
  ];

  if (OPENROUTER_API_KEY) {
    const selectedModel = model && model.trim().length > 0 ? model : 'google/gemini-2.0-flash-exp:free';
    return callOpenRouterChatStream(OPENROUTER_API_KEY, selectedModel, finalMessages, onToken, temperature);
  }

  return callGeminiChatStream(GEMINI_API_KEY, finalMessages, onToken, temperature);
}

/**
 * Backwards-compatible wrapper used by older callers. It still works but
 * delegates to the new unified pipeline with the legacy truncated context.
 */
export async function analyzeWithGemini(params: {
  symbol: string;
  lastKline?: Kline;
  stats?: {
    strokesCount: number;
    segmentsCount: number;
    hubsCount: number;
  };
  currentSetup?: any[];
}): Promise<string> {
  // The legacy call only receives counts. We degrade gracefully by
  // telling the user to use the new AI advisor and run a minimal prompt.
  const OPENROUTER_API_KEY = getOpenRouterApiKey();
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    throw new Error('未配置 AI API 密钥。请在配置中设置 Gemini API Key 或 OpenRouter API Key。');
  }

  const lastKline = params.lastKline;
  const stats = params.stats;

  const prompt = `You are an elite financial quant analyst specializing in "ChanLun" (缠论).
    Provide a professional, localized technical analyst commentary report in beautiful Markdown format for stock/symbol "${params.symbol}".
    Here is the active state and parsed parameters of this asset:
    - Current Candle Data: Date: ${lastKline?.date}, Open: ${lastKline?.open}, Close: ${lastKline?.close}, High: ${lastKline?.high}, Low: ${lastKline?.low}
    - ChanLun Components Identified:
      - Stroke (线笔) Count: ${stats?.strokesCount}
      - Segments (线段) Count: ${stats?.segmentsCount}
      - Identified Hubs (中枢) Count: ${stats?.hubsCount}
      - Buy/Sell Triggers (买卖点) active: ${JSON.stringify(params.currentSetup || [])}

    Write a detailed review with the following sections:
    1. **ChanLun Market Stage Breakdown (分型与中枢结构分析)** - Assess what the existence of ${stats?.hubsCount} hubs and current strokes means. Has there been a breakout (三买 or 三卖) or are we currently oscillating in a consolidation zone?
    2. **Buy/Sell Signal Valuation (买卖点估值与应对战略)** - Review the recent active buy/sell signals. Explain whether they are strong or diverging setups (Divergence/背驰).
    3. **Actionable Trading Playbook & Risk Controls (仓位管理与风控建议)** - Recommend concrete stop-loss prices and position entry sizes based on these structural zones.

    Use strong technical prose. Respond in a highly legible and encouraging tone, strictly in the user's apparent context (Chinese language prefered since ChanLun is a traditional Chinese methodology). Make it look highly quantitative and authoritative.`;

  if (OPENROUTER_API_KEY) {
    return callOpenRouterChat(OPENROUTER_API_KEY, 'google/gemini-2.0-flash-exp:free', [
      { role: 'system', content: 'You are a professional ChanLun (缠论) financial analyst. Reply in Chinese using Markdown.' },
      { role: 'user', content: prompt },
    ]);
  }
  return callGeminiChat(GEMINI_API_KEY, [
    { role: 'system', content: 'You are a professional ChanLun (缠论) financial analyst. Reply in Chinese using Markdown.' },
    { role: 'user', content: prompt },
  ]);
}

// ---------------------------------------------------------------------------
// AI Indicator Code Generation
// ---------------------------------------------------------------------------

const INDICATOR_GENERATION_SYSTEM_PROMPT = `You are a TypeScript expert creating stock indicators for a trading analysis platform.

Generate ONLY valid JavaScript code for the indicator described by the user. No explanations, no markdown formatting.

The code MUST be a self-contained object following this exact structure:

const indicator = {
  id: 'my-indicator',
  name: 'My Indicator',
  description: 'Description',
  defaultVisible: false,
  params: [
    // { key: 'period', label: 'Period', type: 'number', defaultValue: 20, min: 1, max: 200, step: 1 }
  ],
  calculate({ klines, symbol, timeframe, params }) {
    // klines: Array<{ date: string, open: number, high: number, low: number, close: number, volume: number, amount: number }>
    return {
      series: [
        {
          id: 'main',
          name: 'Series Name',
          type: 'line',      // 'line' | 'histogram'
          pane: 'price',      // 'price' | 'indicator'
          color: '#38bdf8',
          lineWidth: 2,
          data: klines.map(k => ({ time: k.date, value: number | null })),
        },
      ],
      signals: [
        // { time: '2024-01-01', position: 'aboveBar', shape: 'arrowUp', color: '#22c55e', text: 'Buy' }
      ],
      fields: [
        // { key: 'value', label: 'Value', sourceSeriesId: 'main', precision: 2 }
      ],
    };
  },
};

if (typeof exports !== 'undefined') { exports.default = indicator; }
else if (typeof module !== 'undefined') { module.exports = indicator; }

RULES:
1. Return ONLY the raw JavaScript code. NO markdown, NO code fences, NO explanations.
2. NO imports, NO require, NO async/await, NO fetch, NO eval, NO DOM APIs.
3. id must be lowercase kebab-case.
4. Handle edge cases: division by zero, empty data, null checks.
5. klines are sorted oldest to newest. data array must match klines length and order.
6. Use appropriate colors for buy/sell signals (green for buy, red for sell).
7. For multi-line indicators, add multiple series objects.
8. For histogram indicators, use positiveColor and negativeColor.`;

/**
 * Extracts JavaScript code from AI response, handling markdown code fences
 */
export function extractCodeFromResponse(text: string): string {
  const codeBlockMatch = text.match(/```(?:typescript|javascript|js|ts)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  return text.trim();
}

/**
 * Generate indicator code using AI based on user description
 */
export async function generateIndicatorCode(
  userDescription: string,
  onToken?: StreamCallback,
  model?: string,
): Promise<string> {
  const OPENROUTER_API_KEY = getOpenRouterApiKey();
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    throw new Error('未配置 AI API 密钥。请在设置中配置 OpenRouter API Key 或 Gemini API Key。');
  }

  const userMessage = `请根据以下需求生成一个股票技术分析指标代码：\n\n${userDescription}\n\n请严格按照格式要求，返回纯 JavaScript 代码。`;

  if (OPENROUTER_API_KEY) {
    const selectedModel = model?.trim() || 'google/gemini-2.0-flash-exp:free';

    if (onToken) {
      return callOpenRouterChatStream(
        OPENROUTER_API_KEY,
        selectedModel,
        [
          { role: 'system', content: INDICATOR_GENERATION_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        onToken,
        0.3,
      );
    }

    return callOpenRouterChat(
      OPENROUTER_API_KEY,
      selectedModel,
      [
        { role: 'system', content: INDICATOR_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      0.3,
    );
  }

  if (onToken) {
    return callGeminiChatStream(
      GEMINI_API_KEY,
      [
        { role: 'system', content: INDICATOR_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      onToken,
      0.3,
    );
  }

  return callGeminiChat(
    GEMINI_API_KEY,
    [
      { role: 'system', content: INDICATOR_GENERATION_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    0.3,
  );
}

// ---------------------------------------------------------------------------
// AI Strategy Code Generation
// ---------------------------------------------------------------------------

/**
 * Build a dynamic description of available indicator structures for the AI prompt.
 * Describes built-in indicators (MA, BOLL, MACD) and any user-defined indicators
 * that are available in the system at generation time.
 */
function buildIndicatorStructureContext(availableIndicatorIds: string[]): string {
  const lines: string[] = [];
  lines.push('// [params]: strategy params + computed indicator values (flat key-value pairs).');
  lines.push('//   Strategy params are defined in the \'params\' array above.');
  lines.push('//   Indicator values are AUTO-INJECTED at each step as flat key-value pairs:');

  // Built-in indicators
  lines.push('//');
  lines.push('//   Built-in indicators always available:');
  lines.push('//     Moving Averages (SMA):');
  lines.push('//       params.MA5   -- 5-period SMA of close prices');
  lines.push('//       params.MA10  -- 10-period SMA of close prices');
  lines.push('//       params.MA20  -- 20-period SMA of close prices');
  lines.push('//       params.MA60  -- 60-period SMA of close prices');
  lines.push('//     Bollinger Bands (period 20, 2-sigma):');
  lines.push('//       params.BOLL_UP  -- Upper band');
  lines.push('//       params.BOLL_MID -- Middle band (SMA 20)');
  lines.push('//       params.BOLL_LOW -- Lower band');
  lines.push('//     MACD (12, 26, 9):');
  lines.push('//       params.MACD_DIF -- DIF line (fast EMA - slow EMA)');
  lines.push('//       params.MACD_DEA -- DEA signal line (EMA of DIF)');
  lines.push('//       params.MACD     -- MACD histogram bar = (DIF - DEA) * 2');

  // User-defined indicators from availableIndicatorIds
  if (availableIndicatorIds.length > 0) {
    lines.push('//');
    lines.push('//   User-defined indicators available:');
    for (const id of availableIndicatorIds) {
      lines.push(`//       params.{seriesName} -- values from indicator "${id}" (series names are defined by the indicator's calculate output)`);
    }
  }

  lines.push('//   Example: params.MA5, params.MACD_DIF, params.BOLL_UP');
  lines.push('//   DO NOT define params inside decide() -- define them in the \'params\' array above.');
  lines.push('//');
  lines.push('// [indicators]: (unused -- use params for indicator values instead)');

  return lines.join('\n');
}

function buildChanLunContextForPrompt(): string {
  return `// [chanlun]: ChanLun analysis result. Detailed structure:
    //   {
    //     mergedKlines: MergedKline[],  // Inclusion-merged K-lines (high, low, direction, originalIndices)
    //     fractions: Fraction[],        // TOP/BOTTOM fractions (type, price, index/mergedIdx, originalIndex/klinesIdx, date)
    //     strokes: Stroke[],            // 笔 - Basic trend unit (id, start/end Fraction, direction: up/down)
    //     segments: Segment[],          // 线段 - Higher-level trend (id, start/end Fraction, direction: up/down)
    //     hubs: Hub[]                   // 中枢 - Price consolidation zones (zg, zd, gg, dd, startIndex, endIndex, strokesCount, level)
    //   }
    //
    // [ChanLun structure reference]:
    //   Stroke = { id, start: Fraction, end: Fraction, direction: 'up'|'down' }
    //     - Use for basic trend direction, momentum estimation, buy/sell point detection
    //     - Stroke range = Math.abs(end.price - start.price) (proxy for momentum/force)
    //
    //   Segment = { id, start: Fraction, end: Fraction, direction: 'up'|'down' }
    //     - Higher-level trend (contains 3+ strokes). Use for primary trend identification.
    //
    //   Hub = { zg, zd, gg, dd, startIndex, endIndex, strokesCount, level }
    //     - zg = 中枢上沿 (min of 3 highs), zd = 中枢下沿 (max of 3 lows)
    //     - gg = 最高点 (max all highs), dd = 最低点 (min all lows)
    //     - A valid hub exists when zg > zd (price overlap)
    //     - level: 1 = stroke-level, 2 = segment-level
    //     - Use for support/resistance zones, breakout detection, buy/sell point logic
    //
    // [1st Buy/Sell - Trend reversal]:
    //   1Buy: downtrend with >=2 hubs, exit stroke shows weaker momentum (divergence) than entry stroke
    //   1Sell: uptrend with >=2 hubs, exit stroke shows weaker momentum (divergence) than entry stroke
    //
    // [2nd Buy/Sell - Pullback confirmation]:
    //   2Buy: after 1Buy, pullback does NOT break below 1Buy low
    //   2Sell: after 1Sell, rebound does NOT break above 1Sell high
    //
    // [3rd Buy/Sell - Hub breakout]:
    //   3Buy: breakout above hub ZG, pullback stays above ZG (hub becomes support)
    //   3Sell: breakout below hub ZD, rebound stays below ZD (hub becomes resistance)
    //
    // [Divergence - momentum weakening]:
    //   Bullish divergence: lower low + weaker momentum (shorter stroke range) = potential reversal up
    //   Bearish divergence: higher high + weaker momentum (shorter stroke range) = potential reversal down
    //   Momentum proxy: Math.abs(stroke.end.price - stroke.start.price)
    //
    // IMPORTANT: Always check arrays length > 0 before accessing elements.
    //            index/originalIndex fields refer to positions in klines[] array.`;
}

function buildStrategyPrompt(indicatorContext: string): string {
  return `Implement a user-defined backtest strategy for this TypeScript project.

Use exactly the UserStrategyDefinition interface from src/types/strategy.ts.
Do not edit the backtest runner, chart, React components, or storage code.
Create one strategy module that exports a UserStrategyDefinition.
Full ChanLun structure reference: spec/spec-chanlun-structure-for-ai-strategy-generation.md

The code MUST be a self-contained object following this exact structure:

const strategy = {
  id: 'my-strategy',
  name: 'My Strategy',
  description: 'Description of the strategy',
  defaultSelected: false,
  params: [
    // { key: 'period', label: 'Period', type: 'number', defaultValue: 20, min: 1, max: 200, step: 1 }
  ],
  availableIndicators: [
    // { id: 'indicator-id', name: 'Indicator Name', defaultSelected: false }
  ],
  requiredIndicators: [
    // { id: 'indicator-id' }
  ],
  decide({ klines, currentIndex, currentKline, account, position, trades, params, indicators, chanlun, currency, initialCash }) {
    // klines: Array<{ date: string, open: number, high: number, low: number, close: number, volume: number, amount: number }>
    // klines contains only data up to and including currentKline
    // currentIndex: zero-based index of currentKline in klines array (use for array lookups)
    // account: { initialCash, cash, equity, currency }
    // position: { shares, averageCost, marketValue, unrealizedPnl, unrealizedPnlPercent }
    // trades: previously executed trades
    //
${indicatorContext}
    //
${buildChanLunContextForPrompt()}
    //
    // IMPORTANT: params, indicators, and chanlun are READ-ONLY inputs.
    // Do NOT assign values to them inside decide().

    return {
      action: 'BUY',  // 'BUY' | 'SELL' | 'HOLD'
      amount: { unit: 'percent', value: 100 },  // required for BUY/SELL
      // unit: 'cash' (currency amount, BUY only) | 'shares' | 'percent' (0-100)
      reason: 'Optional explanation',
      confidence: 0.8,  // optional 0-1
    };
  },
};

if (typeof exports !== 'undefined') { exports.default = strategy; }
else if (typeof module !== 'undefined') { module.exports = strategy; }

RULES:
1. Return ONLY the raw JavaScript code. NO markdown, NO code fences, NO explanations.
2. NO imports, NO require, NO async/await, NO fetch, NO eval, NO DOM APIs.
3. id must be lowercase kebab-case (e.g., 'ma-cross', 'rsi-strategy').
4. Handle edge cases: division by zero, empty data, null checks, insufficient data.
5. klines are sorted oldest to newest. Only data up to currentIndex is available.
6. Use percent amounts unless the strategy specifically needs cash or shares.
7. Keep the decide function pure and deterministic.
8. For BUY: action 'BUY' with amount { unit: 'percent'/'cash'/'shares', value: number }.
9. For SELL: action 'SELL' with amount { unit: 'shares'/'percent', value: number }. Cash unit is invalid for SELL.
10. For HOLD: action 'HOLD'. Amount is optional and ignored.`;
}

/**
 * Generate strategy code using AI based on user description
 */
export async function generateStrategyCode(
  userDescription: string,
  availableIndicatorIds: string[] = [],
  onToken?: StreamCallback,
  model?: string,
  onReasoning?: ReasoningCallback,
): Promise<string> {
  const OPENROUTER_API_KEY = getOpenRouterApiKey();
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    throw new Error('未配置 AI API 密钥。请在设置中配置 OpenRouter API Key 或 Gemini API Key。');
  }

  const indicatorContext = buildIndicatorStructureContext(availableIndicatorIds);
  const systemPrompt = buildStrategyPrompt(indicatorContext);

  const userMessage = `请根据以下需求生成一个股票回测策略代码：\n\n${userDescription}\n\n请严格按照格式要求，返回纯 JavaScript 代码。`;

  if (OPENROUTER_API_KEY) {
    const selectedModel = model?.trim() || 'google/gemini-2.0-flash-exp:free';

    if (onToken) {
      return callOpenRouterChatStream(
        OPENROUTER_API_KEY,
        selectedModel,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        onToken,
        0.3,
        onReasoning,
      );
    }

    return callOpenRouterChat(
      OPENROUTER_API_KEY,
      selectedModel,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      0.3,
    );
  }

  if (onToken) {
    return callGeminiChatStream(
      GEMINI_API_KEY,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      onToken,
      0.3,
    );
  }

  return callGeminiChat(
    GEMINI_API_KEY,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    0.3,
  );
}

// Fetch stock basic information from free API (Tencent Stock)
export async function fetchStockBasicInfo(symbol: string): Promise<StockBasicInfo> {
  const clean = symbol.trim().toUpperCase();

  // Determine if it's a Shanghai or Shenzhen stock
  let tencentSymbol = '';
  let pureCode = '';
  
  if (/^\d{6}$/.test(clean)) {
    const isSS = /^(60|68|90|11|13|51|58|60)/.test(clean);
    tencentSymbol = `${isSS ? 'sh' : 'sz'}${clean}`;
    pureCode = clean;
  } else if (clean.endsWith('.SH') || clean.endsWith('.SS')) {
    pureCode = clean.replace(/\.(SH|SS)$/, '');
    tencentSymbol = `sh${pureCode}`;
  } else if (clean.endsWith('.SZ')) {
    pureCode = clean.replace('.SZ', '');
    tencentSymbol = `sz${pureCode}`;
  } else {
    throw new Error('Invalid symbol format. Please use 6-digit code or symbol with .SH/.SZ suffix.');
  }

  // Tencent Stock API - supports CORS
  const url = `https://web.sqt.gtimg.cn/q=${tencentSymbol}`;

  console.log(`[Tencent] Fetching stock info for ${tencentSymbol}`);

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch stock info: ${response.status}`);
    }

    // Use arrayBuffer and decode with GBK encoding
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('gbk');
    const text = decoder.decode(buffer);
    
    console.log(`[Tencent] Response: ${text}`);

    // Parse Tencent's response format: v_sh600000="1~浦发银行~600000~10.50~..."
    const match = text.match(/="(.+)"/);
    if (!match || !match[1]) {
      throw new Error('No data found in response');
    }

    const data = match[1].split('~');

    if (data.length < 45) {
      throw new Error('Insufficient data fields');
    }

    // Tencent data fields (Common indices):
    // 1: name, 2: code, 3: current price, 4: prev close
    // 5: open, 6: volume (手), 7: amount (万), 32: high, 33: low
    // 38: turnover rate, 39: PE ratio, 44: total market value (亿), 45: circulating market value (亿)

    const name = data[1];
    const price = parseFloat(data[3]);
    const prevClose = parseFloat(data[4]);
    const volume = parseFloat(data[6]); // 单位：手
    const amount = parseFloat(data[37]) * 10000; // 单位：元 (data[37] is more reliable for amount)
    const open = parseFloat(data[5]);
    const high = parseFloat(data[33]);
    const low = parseFloat(data[34]);
    const peRatio = parseFloat(data[39]);
    const turnoverRate = parseFloat(data[38]);
    const totalMarketValue = parseFloat(data[44]) * 100000000; // 单位：元（API返回亿）
    const circulatingMarketValue = parseFloat(data[45]) * 100000000; // 单位：元（API返回亿）

    const change = price - prevClose;
    const changePercent = (change / prevClose) * 100;

    const stockInfo: StockBasicInfo = {
      symbol: pureCode,
      name: name,
      price: price,
      change: change,
      changePercent: changePercent,
      open: open,
      high: high,
      low: low,
      volume: volume * 100, // 转换为股
      amount: amount,
      peRatio: peRatio,
      turnoverRate: turnoverRate,
      totalMarketValue: totalMarketValue,
      circulatingMarketValue: circulatingMarketValue
    };

    console.log(`[Tencent] Successfully fetched info for ${name} (${pureCode})`);
    return stockInfo;

  } catch (error) {
    console.error('[Tencent] Error fetching stock info:', error);
    throw new Error(`Failed to fetch stock basic information for ${symbol}`);
  }
}
