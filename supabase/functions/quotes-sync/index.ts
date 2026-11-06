// Pulls quotes for every front and writes them with apply_quotes().
// Called once a minute by pg_cron. Requires the x-cron-secret header.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; market-wars-demo/1.0)' };
type Q = { symbol: string; price: number; change: number; change_pct: number; market_open: boolean | null; delayed: boolean; source: string };

async function binance(): Promise<Q[]> {
  const url = 'https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' + encodeURIComponent('["BTCUSDT","ETHUSDT"]');
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return j.map((t: any) => ({ symbol: t.symbol, price: +t.lastPrice, change: +t.priceChange, change_pct: +t.priceChangePercent, market_open: true, delayed: false, source: 'binance' }));
}

async function yahoo(symbol: string, ticker: string, scale = 1): Promise<Q> {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=1d`, { headers: UA, signal: AbortSignal.timeout(8000) });
  const m = (await r.json()).chart.result[0].meta;
  const p = m.regularMarketPrice * scale, prev = (m.chartPreviousClose ?? m.previousClose) * scale;
  const tp = m.currentTradingPeriod?.regular, now = Date.now() / 1000;
  return { symbol, price: p, change: p - prev, change_pct: prev ? (p / prev - 1) * 100 : 0, market_open: tp ? now >= tp.start && now < tp.end : null, delayed: true, source: 'yahoo' };
}

async function naverBond(symbol: string, code: string): Promise<Q> {
  const r = await fetch(`https://m.stock.naver.com/front-api/marketIndex/productDetail?category=bond&reutersCode=${encodeURIComponent(code)}`, { headers: UA, signal: AbortSignal.timeout(8000) });
  const x = (await r.json()).result;
  const p = +x.closePrice, ch = +x.fluctuations;
  const ageMin = (Date.now() - Date.parse(x.localTradedAt)) / 60000;
  return { symbol, price: p, change: ch, change_pct: p - ch ? (ch / (p - ch)) * 100 : 0, market_open: ageMin < 20, delayed: false, source: 'naver' };
}

const num = (x: string) => +String(x).replace(/[,+]/g, '');

// KOSPI: today's intraday net buying by investor group (억원)
async function kospiFlows(): Promise<any> {
  const r = await fetch('https://m.stock.naver.com/api/index/KOSPI/trend', { headers: UA, signal: AbortSignal.timeout(8000) });
  const x = await r.json();
  return { kind: 'investor', unit: '억원', asof: x.bizdate, live: true,
    now: { foreign: num(x.foreignValue), inst: num(x.institutionalValue), retail: num(x.personalValue) } };
}

// KR stocks: daily net buying by group for recent sessions, converted to 억원 with the close
async function stockFlows(code: string): Promise<any> {
  const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=5`, { headers: UA, signal: AbortSignal.timeout(8000) });
  const rows = await r.json();
  const days = rows.map((d: any) => { const px = num(d.closePrice) / 1e8; return { d: d.bizdate,
    foreign: Math.round(num(d.foreignerPureBuyQuant) * px), inst: Math.round(num(d.organPureBuyQuant) * px), retail: Math.round(num(d.individualPureBuyQuant) * px) }; }).reverse();
  const last = days[days.length - 1];
  return { kind: 'investor', unit: '억원', asof: last?.d, live: false, now: last && { foreign: last.foreign, inst: last.inst, retail: last.retail }, days };
}

// crypto: aggressive (taker) buy vs sell volume per hour over the last 24h, in USD
async function takerFlows(symbol: string): Promise<any> {
  const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=24`, { signal: AbortSignal.timeout(8000) });
  const k = await r.json();
  const hours = k.map((c: any) => { const quote = +c[7], buy = +c[10]; return { t: c[0], buy: Math.round(buy), sell: Math.round(quote - buy) }; });
  const buy = hours.reduce((s: number, h: any) => s + h.buy, 0), sell = hours.reduce((s: number, h: any) => s + h.sell, 0);
  return { kind: 'taker', unit: 'USD', live: true, now: { buy, sell }, hours };
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const jobs: Promise<Q | Q[]>[] = [
    binance(),
    yahoo('KOSPI', '^KS11'), yahoo('005930', '005930.KS'), yahoo('000660', '000660.KS'),
    yahoo('SPX', '^GSPC'), yahoo('NVDA', 'NVDA'), yahoo('TSLA', 'TSLA'),
    yahoo('USDKRW', 'KRW=X'), yahoo('JPYKRW', 'JPYKRW=X', 100),
    naverBond('KR3Y', 'KR3YT=RR'), naverBond('KR10Y', 'KR10YT=RR'), naverBond('US2Y', 'US2YT=RR'), naverBond('US10Y', 'US10YT=RR'),
  ];
  const flowJobs: [string, Promise<any>][] = [
    ['KOSPI', kospiFlows()], ['005930', stockFlows('005930')], ['000660', stockFlows('000660')],
    ['BTCUSDT', takerFlows('BTCUSDT')], ['ETHUSDT', takerFlows('ETHUSDT')],
  ];
  const settled = await Promise.allSettled(jobs);
  const flows: Record<string, any> = {};
  for (const [sym, p] of flowJobs) { try { flows[sym] = await p; } catch (_) { /* keep previous flows */ } }
  const quotes = settled.flatMap(s => s.status === 'fulfilled' ? [s.value].flat() : []).filter(q => Number.isFinite(q.price) && q.price > 0);
  for (const q of quotes) if (flows[q.symbol]) (q as any).flows = flows[q.symbol];
  const errors = settled.filter(s => s.status === 'rejected').map(s => String((s as PromiseRejectedResult).reason).slice(0, 120));
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await sb.rpc('apply_quotes', { q: quotes });
  return new Response(JSON.stringify({ updated: data, error: error?.message, failed: errors }), { headers: { 'content-type': 'application/json' } });
});
