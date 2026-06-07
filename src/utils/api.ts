import { Kline } from '../types/stock';

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
function resolveSymbol(symbol: string): { resolved: string; displayName: string; isChinaStock: boolean } {
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
      'This application only supports Chinese A-share stocks. Please use a 6-digit stock code (e.g., 600000, 000001) or a symbol with .SS/.SZ suffix.'
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

  const response = await fetch(tickflowUrl, { headers });

  console.log(`[TickFlow] Response status: ${response.status}`);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`TickFlow API error: ${response.status} - ${errorText}`);
    throw new Error(`Unable to fetch data for symbol "${displayName}" from TickFlow API. Status: ${response.status}`);
  }

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

    // Convert timestamp to date string (YYYY-MM-DD)
    const date = new Date(timestamp);
    const dateStr = date.toISOString().split('T')[0];

    klines.push({
      date: dateStr,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: volume
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

// Call Gemini API or OpenRouter API for technical analysis
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
  const OPENROUTER_API_KEY = getOpenRouterApiKey();
  const GEMINI_API_KEY = getGeminiApiKey();

  if (!OPENROUTER_API_KEY && !GEMINI_API_KEY) {
    throw new Error('未配置 AI API 密钥。请在配置中设置 Gemini API Key 或 OpenRouter API Key。');
  }

  const { symbol, lastKline, stats, currentSetup } = params;

  const prompt = `You are an elite financial quant analyst specializing in "ChanLun" (缠论 / theory of Chuan-Lun or Zen in Stock Market).
    Provide a professional, localized technical analyst commentary report in beautiful Markdown format for stock/symbol "${symbol}".
    Here is the active state and parsed parameters of this asset:
    - Current Candle Data: Date: ${lastKline?.date}, Open: ${lastKline?.open}, Close: ${lastKline?.close}, High: ${lastKline?.high}, Low: ${lastKline?.low}
    - ChanLun Components Identified:
      - Stroke (线笔) Count: ${stats?.strokesCount}
      - Segments (线段) Count: ${stats?.segmentsCount}
      - Identified Hubs (中枢) Count: ${stats?.hubsCount}
      - Buy/Sell Triggers (买卖点) active: ${JSON.stringify(currentSetup || [])}

    Write a detailed review with the following sections:
    1. **ChanLun Market Stage Breakdown (分型与中枢结构分析)** - Assess what the existence of ${stats?.hubsCount} hubs and current strokes means. Has there been a breakout (三买 or 三卖) or are we currently oscillating in a consolidation zone?
    2. **Buy/Sell Signal Valuation (买卖点估值与应对战略)** - Review the recent active buy/sell signals. Explain whether they are strong or diverging setups (Divergence/背驰).
    3. **Actionable Trading Playbook & Risk Controls (仓位管理与风控建议)** - Recommend concrete stop-loss prices and position entry sizes based on these structural zones.

    Use strong technical prose. Respond in a highly legible and encouraging tone, strictly in the user's apparent context (Chinese language prefered since ChanLun is a traditional Chinese methodology). Make it look highly quantitative and authoritative.`;

  // Use OpenRouter if available, otherwise use Gemini
  if (OPENROUTER_API_KEY) {
    console.log('[AI] Using OpenRouter API');
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': window.location.origin,
        },
        body: JSON.stringify({
          model: 'google/gemini-2.0-flash-exp:free',
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ]
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenRouter API error:', errorText);
      throw new Error('OpenRouter 服务当前不可用。请检查 API 密钥是否有效。');
    }

    const data = await response.json();
    const report = data.choices?.[0]?.message?.content || '';
    return report;
  } else {
    // Use Gemini API
    console.log('[AI] Using Gemini API');
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.7
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', errorText);
      throw new Error('Gemini 服务当前不可用。请检查 VITE_GEMINI_API_KEY 是否有效。');
    }

    const data = await response.json();
    const report = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return report;
  }
}
