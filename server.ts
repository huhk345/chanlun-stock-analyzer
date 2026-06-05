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

// Helper: Resolve Chinese stock symbols & general formats
function resolveSymbol(symbol: string): { resolved: string; displayName: string; isChinaStock: boolean } {
  const clean = symbol.trim().toUpperCase();
  if (/^\d{6}$/.test(clean)) {
    // 6-digit pure numbers represent Chinese stocks
    const isSS = /^(60|68|90|11|13|51|58|60)/.test(clean);
    const suffix = isSS ? 'SS' : 'SZ';
    return {
      resolved: `${clean}.${suffix}`,
      displayName: `${clean}.${suffix}`,
      isChinaStock: true
    };
  }
  return {
    resolved: clean,
    displayName: clean,
    isChinaStock: clean.endsWith('.SS') || clean.endsWith('.SZ')
  };
}

// Generate Realistic Mock Candlesticks (Fallback)
function generateMockKlines(symbol: string, days: number = 200, interval: string = '1d'): any[] {
  const data: any[] = [];
  let currentPrice = symbol.startsWith('AAPL') ? 180 : symbol.startsWith('TSLA') ? 220 : symbol.startsWith('600519') ? 1600 : 100;
  
  const today = new Date();
  
  // Decide spacing based on interval
  let stepMs = 24 * 60 * 60 * 1000; // default 1d
  let count = days;
  
  if (interval === '5m') {
    stepMs = 5 * 60 * 1000;
    count = 150; // 150 bars of 5m is clean
  } else if (interval === '60m') {
    stepMs = 60 * 60 * 1000;
    count = 120; // 120 bars of 60m is clean
  } else if (interval === '4h') {
    stepMs = 4 * 60 * 60 * 1000;
    count = 100; // 100 bars of 4h is clean
  }
  
  for (let i = count; i >= 0; i--) {
    const date = new Date(today.getTime() - i * stepMs);
    
    // For 1d, exclude weekends
    if (interval === '1d' && (date.getDay() === 0 || date.getDay() === 6)) continue;
    
    const changePercent = (Math.random() - 0.49) * 0.05; 
    const open = currentPrice;
    const close = currentPrice * (1 + changePercent);
    const high = Math.max(open, close) * (1 + Math.random() * 0.015);
    const low = Math.min(open, close) * (1 - Math.random() * 0.015);
    const volume = Math.floor(100000 + Math.random() * 1000000);
    
    let dateStr = '';
    if (interval === '1d') {
      dateStr = date.toISOString().split('T')[0];
    } else {
      const yyyy = date.getFullYear();
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const hh = String(date.getHours()).padStart(2, '0');
      const minVal = String(date.getMinutes()).padStart(2, '0');
      dateStr = `${yyyy}-${mm}-${dd} ${hh}:${minVal}`;
    }
    
    data.push({
      date: dateStr,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: volume
    });
    
    currentPrice = close;
  }
  
  return data;
}

// Stock K-line Query endpoint using Yahoo Finance or fallback
app.get('/api/stock', async (req, res) => {
  const { symbol, range, interval } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'Missing stock symbol parameter' });
  }

  const queryRange = range ? String(range) : '1y'; 
  const queryInterval = interval ? String(interval) : '1d';
  const { resolved, displayName } = resolveSymbol(String(symbol));

  let yahooInterval = queryInterval;
  let yahooRange = queryRange;

  if (queryInterval === '5m') {
    yahooInterval = '5m';
    yahooRange = '5d';
  } else if (queryInterval === '60m') {
    yahooInterval = '60m';
    yahooRange = '1mo';
  } else if (queryInterval === '4h') {
    yahooInterval = '60m'; // Fetch 60m and aggregate every 4 to make 4h
    yahooRange = '3mo';
  } else {
    yahooInterval = '1d';
  }
  
  try {
    // Attempt real fetch from Yahoo Finance chart endpoint
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${resolved}?range=${yahooRange}&interval=${yahooInterval}`;
    const response = await fetch(yahooUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      console.warn(`Yahoo Finance rejected symbol: ${resolved}. Emitting fallbacks.`);
      const fallbackData = generateMockKlines(resolved, yahooRange === '2y' ? 450 : yahooRange === '6m' ? 120 : 220, queryInterval);
      return res.json({
        symbol: resolved,
        name: displayName,
        klines: fallbackData,
        source: 'Simulated Engine',
        range: yahooRange,
        interval: queryInterval
      });
    }

    const json: any = await response.json();
    const result = json?.chart?.result?.[0];
    
    if (!result) {
      throw new Error('Malformed structure from stock source');
    }

    const timestamps: number[] = result.timestamp || [];
    const indicators = result.indicators?.quote?.[0] || {};
    const opens: number[] = indicators.open || [];
    const highs: number[] = indicators.high || [];
    const lows: number[] = indicators.low || [];
    const closes: number[] = indicators.close || [];
    const volumes: number[] = indicators.volume || [];

    const klines: any[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (opens[i] === null || highs[i] === null || lows[i] === null || closes[i] === null) continue;
      
      const d = new Date(timestamps[i] * 1000);
      let dateStr = '';
      if (queryInterval === '1d') {
        dateStr = d.toISOString().split('T')[0];
      } else {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const minVal = String(d.getMinutes()).padStart(2, '0');
        dateStr = `${yyyy}-${mm}-${dd} ${hh}:${minVal}`;
      }

      klines.push({
        date: dateStr,
        open: parseFloat(opens[i].toFixed(2)),
        high: parseFloat(highs[i].toFixed(2)),
        low: parseFloat(lows[i].toFixed(2)),
        close: parseFloat(closes[i].toFixed(2)),
        volume: volumes[i] ? Math.floor(volumes[i]) : 0
      });
    }

    // Aggregate to 4h if requested
    let processedKlines = klines;
    if (queryInterval === '4h') {
      processedKlines = [];
      for (let i = 0; i < klines.length; i += 4) {
        const chunk = klines.slice(i, i + 4);
        if (chunk.length === 0) continue;
        
        const open = chunk[0].open;
        const close = chunk[chunk.length - 1].close;
        const high = Math.max(...chunk.map(c => c.high));
        const low = Math.min(...chunk.map(c => c.low));
        const volume = chunk.reduce((sum, c) => sum + c.volume, 0);
        const date = chunk[0].date;
        
        processedKlines.push({ date, open, high, low, close, volume });
      }
    }

    if (processedKlines.length < 30) {
      console.warn(`Insufficient online data bars for ${resolved} (${processedKlines.length} bars recovered). Engaging high-fidelity simulation fallbacks.`);
      const fallbackData = generateMockKlines(resolved, 220, queryInterval);
      return res.json({
        symbol: resolved,
        name: displayName,
        klines: fallbackData,
        source: processedKlines.length === 0 ? 'Simulated Engine' : `Simulated Engine (Failsafe for ${processedKlines.length} bars)`,
        range: yahooRange,
        interval: queryInterval
      });
    }

    return res.json({
      symbol: resolved,
      name: displayName,
      klines: processedKlines,
      source: 'Yahoo Finance',
      range: yahooRange,
      interval: queryInterval
    });

  } catch (error: any) {
    console.error('Failed to resolve online stock metadata:', error.message);
    const fallbackData = generateMockKlines(resolved, 220, queryInterval);
    return res.json({
      symbol: resolved,
      name: displayName,
      klines: fallbackData,
      source: 'Simulated Engine (Failure Failover)',
      range: yahooRange,
      interval: queryInterval
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
