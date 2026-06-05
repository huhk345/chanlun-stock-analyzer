import React, { useState } from 'react';
import { Sparkles, BrainCircuit, RefreshCw, Layers, CheckCircle2, AlertTriangle, Key } from 'lucide-react';
import { Kline, Stroke, Segment, Hub, BuySellPoint } from '../types/stock';

interface GeminiAdvisorProps {
  symbol: string;
  klines: Kline[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  buySellPoints: BuySellPoint[];
}

export default function GeminiAdvisor({ symbol, klines, strokes, segments, hubs, buySellPoints }: GeminiAdvisorProps) {
  const [report, setReport] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleFetchReport = async () => {
    if (klines.length === 0) return;
    setLoading(true);
    setErrorMsg('');
    setReport('');

    const lastKline = klines[klines.length - 1];
    const stats = {
      strokesCount: strokes.length,
      segmentsCount: segments.length,
      hubsCount: hubs.length,
    };
    
    // Get recent 5 buy/sell points for commentary context
    const currentSetup = buySellPoints.slice(-5).map(p => ({
      type: p.type,
      price: p.price,
      date: p.date,
      reason: p.reason
    }));

    try {
      const response = await fetch('/api/gemini/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          lastKline,
          stats,
          currentSetup
        })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to generate technical report');
      }

      const data = await response.json();
      setReport(data.report || 'No report returned');
    } catch (err: any) {
      setErrorMsg(err.message || 'The AI analyst service is currently offline.');
    } finally {
      setLoading(false);
    }
  };

  // Simple, completely robust React 19-safe plain markdown-to-html custom converter
  const renderFormattedReport = (rawText: string) => {
    if (!rawText) return null;
    
    const lines = rawText.split('\n');
    return lines.map((line, idx) => {
      // 1. Headers e.g. ### Header
      if (line.startsWith('### ')) {
        return <h5 key={`h5-${idx}`} className="text-sm font-bold text-zinc-200 font-sans mt-5 mb-2 flex items-center gap-2">{line.replace('### ', '')}</h5>;
      }
      if (line.startsWith('## ')) {
        return <h4 key={`h4-${idx}`} className="text-base font-extrabold text-zinc-100 font-sans mt-6 border-b border-zinc-800 pb-1.5 flex items-center gap-2">{line.replace('## ', '')}</h4>;
      }
      if (line.startsWith('# ')) {
        return <h3 key={`h3-${idx}`} className="text-lg font-black text-emerald-400 font-sans mt-7 mb-3 flex items-center gap-2">{line.replace('# ', '')}</h3>;
      }

      // 2. Strong texts
      let processedComponent: React.ReactNode = line;
      if (line.includes('**')) {
        const parts = line.split('**');
        processedComponent = parts.map((part, pIdx) => {
          if (pIdx % 2 === 1) {
            return <strong key={`str-${pIdx}`} className="text-emerald-400 font-semibold font-sans">{part}</strong>;
          }
          return part;
        });
      }

      // 3. Bullet points e.g. - list item
      if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
        const trimmed = line.trim().substring(2);
        return (
          <li key={`li-${idx}`} className="list-disc list-inside text-xs font-sans text-zinc-400 pl-4 py-1.5 leading-relaxed">
            {processedComponent}
          </li>
        );
      }

      // 4. Highlighted blocks
      if (line.trim().startsWith('> ')) {
        return (
          <div key={`blk-${idx}`} className="p-3 bg-zinc-900 border-l-4 border-emerald-500 rounded text-xs text-zinc-300 my-2 font-serif italic">
            {line.trim().substring(2)}
          </div>
        );
      }

      // 5. Normal paragraphs
      if (line.trim() === '') return <div key={`sp-${idx}`} className="h-2" />;
      
      return (
        <p key={`p-${idx}`} className="text-xs font-sans text-zinc-300 leading-relaxed py-1.5 pl-1.5">
          {processedComponent}
        </p>
      );
    });
  };

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-sm overflow-hidden relative text-zinc-100">
      <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none" />
      
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2 font-sans uppercase tracking-wider">
            <BrainCircuit className="h-5 w-5 text-emerald-400" />
            <span>Automated AI Multi-Factor Advisor</span>
          </h3>
          <p className="text-xs text-zinc-500 mt-1">Get quantitative trading briefings processed by Gemini Core</p>
        </div>

        <button
          onClick={handleFetchReport}
          disabled={loading || klines.length === 0}
          className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-bold text-xs rounded-xl shadow-lg shadow-emerald-500/10 cursor-pointer transition-all disabled:opacity-50"
          id="btn-gemini-advisor"
        >
          {loading ? (
            <RefreshCw className="h-4 w-4 animate-spin text-zinc-950" />
          ) : (
            <Sparkles className="h-4 w-4 fill-zinc-950 text-zinc-950 animate-pulse" />
          )}
          <span>{loading ? 'Compiling AI Analysis...' : 'Consult AI ChanLun Intelligence'}</span>
        </button>
      </div>

      {loading && (
        <div className="p-8 border border-dashed border-zinc-800 rounded-xl bg-zinc-950/50 flex flex-col items-center justify-center text-center">
          <BrainCircuit className="h-10 w-10 text-emerald-400 animate-pulse mb-3" />
          <p className="text-xs font-semibold text-zinc-300 font-sans">Gemini is running structural validations...</p>
          <p className="text-[11px] text-zinc-500 mt-1 font-sans font-sans">Mapping active hubs and structural trend divergence</p>
        </div>
      )}

      {errorMsg && (
        <div className="p-4 bg-red-950/20 border border-red-900/30 rounded-xl text-red-400 text-xs flex gap-3">
          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">{errorMsg}</p>
            <p className="text-zinc-500 font-sans leading-relaxed">
              Ensure that your <strong>GEMINI_API_KEY</strong> has been provided in the <strong>Settings &gt; Secrets</strong> panel of the workspace, then restart the application to register keys.
            </p>
          </div>
        </div>
      )}

      {report && (
        <div className="bg-zinc-950 border border-zinc-850 rounded-2xl p-6 transition-all duration-300 shadow-inner">
          <div className="flex items-center gap-2 pb-3 mb-4 border-b border-zinc-800">
            <CheckCircle2 className="h-4.5 w-4.5 text-emerald-400" />
            <span className="text-xs font-bold text-emerald-400 font-sans uppercase tracking-wider">Quant analyst report issued</span>
          </div>
          <div className="space-y-1 overflow-y-auto max-h-[420px] pr-2 text-zinc-100">
            {renderFormattedReport(report)}
          </div>
        </div>
      )}

    </div>
  );
}
