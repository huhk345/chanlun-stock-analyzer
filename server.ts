import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3010;

app.use(express.json());

// Initialize Gemini SDK with custom option headers
const apiKey = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenAI({
  apiKey: apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// TickFlow API Configuration
// 免费API无需API Key，使用 https://free-api.tickflow.org
// 完整服务需要API Key，使用 https://api.tickflow.org
const TICKFLOW_API_KEY = process.env.TICKFLOW_API_KEY || '';
const TICKFLOW_BASE_URL = TICKFLOW_API_KEY
  ? 'https://api.tickflow.org'
  : 'https://free-api.tickflow.org';

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

// Stock K-line Query endpoint using TickFlow API (Chinese stocks only)
app.get('/api/stock', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Missing stock symbol parameter' });
  }

  const { resolved, displayName, isChinaStock } = resolveSymbol(String(symbol));

  if (!isChinaStock) {
    return res.status(400).json({
      error: 'This application only supports Chinese A-share stocks. Please use a 6-digit stock code (e.g., 600000, 000001) or a symbol with .SS/.SZ suffix.',
      symbol: displayName
    });
  }

  // Always fetch 5 years of daily K-line data
  const period = '1d';
  const count = 365 * 5; // 5 years
  const isFreeAPI = !TICKFLOW_API_KEY;

  try {
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
      return res.status(response.status).json({
        error: `Unable to fetch data for symbol "${displayName}" from TickFlow API. Status: ${response.status}`,
        symbol: displayName,
        details: errorText
      });
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

    const klines: any[] = [];

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
      console.error(`Insufficient data bars for ${displayName} (only ${klines.length} bars available). Need at least 30 bars for analysis.`);
      return res.status(404).json({
        error: `Insufficient historical data for symbol "${displayName}". Only ${klines.length} bars available, need at least 30 for analysis.`,
        symbol: displayName,
        availableBars: klines.length
      });
    }

    console.log(`[TickFlow] Successfully processed ${klines.length} klines for ${displayName}`);

    return res.json({
      symbol: displayName,
      name: displayName,
      klines: klines,
      source: 'TickFlow API',
      period: '5 years daily'
    });

  } catch (error: any) {
    console.error('Failed to fetch stock data from TickFlow API:', error.message);
    return res.status(500).json({
      error: `Failed to fetch stock data for "${displayName}": ${error.message}`,
      symbol: displayName
    });
  }
});

// Gemini technical analysis review using ChanLun output parameters
app.post('/api/gemini/analyze', async (req, res) => {
  const { symbol, lastKline, stats, currentSetup } = req.body;
  if (!symbol) {
    return res.status(400).json({ error: 'Missing requirements' });
  }

  try {
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

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        temperature: 0.7
      }
    });

    return res.json({ report: response.text });
  } catch (err: any) {
    console.error('Gemini call failure:', err.message);
    return res.status(500).json({ error: 'Gemini service is currently unavailable. Please check that GEMINI_API_KEY is active.' });
  }
});

// Vite / static file router setup
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server starting robustly in full-stack container on node port ${PORT}`);
  });
}

startServer();
