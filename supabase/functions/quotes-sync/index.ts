// Pulls quotes, investor flows and volume pace for every active territory and writes them
// with apply_quotes(). Called once a minute by pg_cron with the x-cron-secret header.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; market-war-demo/1.0)' };
const T = (ms = 8000) => AbortSignal.timeout(ms);
const num = (x: unknown) => +String(x ?? '').replace(/[,+]/g, '');
type Q = { symbol: string; price: number; change: number; change_pct: number; market_open: boolean | null; delayed: boolean; source: string; flows?: unknown; vol_ratio?: number };
type Asset = { symbol: string; src: string; flows_src: string | null; kind: string; frontier: boolean };

async function binanceQuotes(list: Asset[]): Promise<Q[]> {
  if (!list.length) return [];
  const ids = list.map(a => a.src.split(':')[1]);
  const r = await fetch('https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' + encodeURIComponent(JSON.stringify(ids)), { signal: T() });
  const j = await r.json();
  const bySym: Record<string, string> = Object.fromEntries(list.map(a => [a.src.split(':')[1], a.symbol]));
  return j.map((t: any) => ({ symbol: bySym[t.symbol], price: +t.lastPrice, change: +t.priceChange, change_pct: +t.priceChangePercent, market_open: true, delayed: false, source: 'binance' }));
}

// Yahoo spark: many tickers per call. 'yahoo:JPYKRW=X*100' scales the quote.
async function yahooQuotes(list: Asset[]): Promise<Q[]> {
  const out: Q[] = [];
  const parsed = list.map(a => { const [tk, mul] = a.src.slice(6).split('*'); return { a, tk, mul: mul ? +mul : 1 }; });
  for (let i = 0; i < parsed.length; i += 20) {
    const chunk = parsed.slice(i, i + 20);
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/spark?symbols=${chunk.map(c => encodeURIComponent(c.tk)).join(',')}&range=1d&interval=5m`, { headers: UA, signal: T(10000) });
    const j = await r.json();
    for (const c of chunk) {
      const v = j[c.tk]; if (!v) continue;
      const closes = (v.close || []).filter((x: number | null) => x != null), ts = v.timestamp || [];
      const last = closes[closes.length - 1], prev = v.chartPreviousClose ?? v.previousClose;
      if (!last) continue;
      const p = last * c.mul, pv = prev * c.mul;
      const ageMin = ts.length ? (Date.now() / 1000 - ts[ts.length - 1]) / 60 : 999;
      out.push({ symbol: c.a.symbol, price: p, change: p - pv, change_pct: pv ? (p / pv - 1) * 100 : 0, market_open: ageMin < 40, delayed: true, source: 'yahoo' });
    }
  }
  return out;
}

async function naverBond(a: Asset): Promise<Q> {
  const code = a.src.split(':')[1];
  const r = await fetch(`https://m.stock.naver.com/front-api/marketIndex/productDetail?category=bond&reutersCode=${encodeURIComponent(code)}`, { headers: UA, signal: T() });
  const x = (await r.json()).result;
  const p = +x.closePrice, ch = +x.fluctuations;
  const ageMin = (Date.now() - Date.parse(x.localTradedAt)) / 60000;
  return { symbol: a.symbol, price: p, change: ch, change_pct: p - ch ? (ch / (p - ch)) * 100 : 0, market_open: ageMin < 20, delayed: false, source: 'naver' };
}

// ---- who is buying / selling
async function naverIndexFlows(code: string) {
  const x = await (await fetch(`https://m.stock.naver.com/api/index/${code}/trend`, { headers: UA, signal: T() })).json();
  return { kind: 'investor', unit: '억원', asof: x.bizdate, live: true, now: { foreign: num(x.foreignValue), inst: num(x.institutionalValue), retail: num(x.personalValue) } };
}
async function naverStockFlows(code: string) {
  const rows = await (await fetch(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=5`, { headers: UA, signal: T() })).json();
  const days = rows.map((d: any) => { const px = num(d.closePrice) / 1e8; return { d: d.bizdate,
    foreign: Math.round(num(d.foreignerPureBuyQuant) * px), inst: Math.round(num(d.organPureBuyQuant) * px), retail: Math.round(num(d.individualPureBuyQuant) * px) }; }).reverse();
  const last = days[days.length - 1];
  return { kind: 'investor', unit: '억원', asof: last?.d, live: false, now: last && { foreign: last.foreign, inst: last.inst, retail: last.retail }, days };
}
// crypto: taker buy/sell per hour + volume pace (last hour vs the 24h hourly mean)
async function takerFlows(sym: string) {
  const k = await (await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1h&limit=24`, { signal: T() })).json();
  const hours = k.map((c: any) => { const quote = +c[7], buy = +c[10]; return { t: c[0], buy: Math.round(buy), sell: Math.round(quote - buy) }; });
  const buy = hours.reduce((s: number, h: any) => s + h.buy, 0), sell = hours.reduce((s: number, h: any) => s + h.sell, 0);
  const vols = hours.map((h: any) => h.buy + h.sell), mean = vols.slice(0, -1).reduce((s: number, v: number) => s + v, 0) / Math.max(1, vols.length - 1);
  const lastHourFrac = Math.max(.15, ((Date.now() - hours[hours.length - 1].t) / 3600000));
  return { flows: { kind: 'taker', unit: 'USD', live: true, now: { buy, sell }, hours }, vol_ratio: mean ? vols[vols.length - 1] / (mean * Math.min(1, lastHourFrac)) : null };
}
// stocks/indices/futures: today's volume vs the 20-day average, scaled by how much of the session has passed
async function volumePace(tk: string) {
  const r = (await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tk)}?range=1mo&interval=1d`, { headers: UA, signal: T() })).json()).chart.result[0];
  const v: number[] = (r.indicators.quote[0].volume || []).map((x: number | null) => x || 0);
  if (v.length < 6) return null;
  const today = v[v.length - 1], base = v.slice(-21, -1).filter(x => x > 0);
  if (!today || !base.length) return null;
  const avg = base.reduce((s, x) => s + x, 0) / base.length;
  const tp = r.meta.currentTradingPeriod?.regular, now = Date.now() / 1000;
  const frac = tp && now > tp.start && now < tp.end ? Math.max(.12, (now - tp.start) / (tp.end - tp.start)) : 1;
  return today / (avg * frac);
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: assets, error: e0 } = await sb.from('assets').select('symbol,src,flows_src,kind,frontier').eq('active', true);
  if (e0 || !assets) return new Response(JSON.stringify({ error: e0?.message }), { status: 500 });
  const minute = new Date().getUTCMinutes(), every5 = minute % 5 === 0;
  const by = (p: string) => (assets as Asset[]).filter(a => a.src.startsWith(p));

  const settled = await Promise.allSettled([binanceQuotes(by('binance:')), yahooQuotes(by('yahoo:')), ...by('naver_bond:').map(naverBond)]);
  const quotes: Q[] = settled.flatMap(s => s.status === 'fulfilled' ? [s.value].flat() : []).filter(q => q && q.symbol && Number.isFinite(q.price) && q.price > 0);
  const errors = settled.filter(s => s.status === 'rejected').map(s => String((s as PromiseRejectedResult).reason).slice(0, 120));
  const qs: Record<string, Q> = Object.fromEntries(quotes.map(q => [q.symbol, q]));

  // flows: index + curated every minute, frontier every 5 minutes
  const flowJobs = (assets as Asset[]).filter(a => a.flows_src && qs[a.symbol] && (!a.frontier || every5)).map(async a => {
    const [kind, id] = a.flows_src!.split(':');
    if (kind === 'naver_index') qs[a.symbol].flows = await naverIndexFlows(id);
    else if (kind === 'naver_stock') qs[a.symbol].flows = await naverStockFlows(id);
    else if (kind === 'binance') { const t = await takerFlows(id); qs[a.symbol].flows = t.flows; if (t.vol_ratio != null) qs[a.symbol].vol_ratio = +t.vol_ratio.toFixed(2); }
  });
  // volume pace for exchange-traded things every 5 minutes
  const volJobs = every5 ? (assets as Asset[]).filter(a => a.src.startsWith('yahoo:') && ['STOCK','ETF','INDEX','FUTURE'].includes(a.kind) && qs[a.symbol]).map(async a => {
    const v = await volumePace(a.src.slice(6).split('*')[0]); if (v != null && Number.isFinite(v)) qs[a.symbol].vol_ratio = +v.toFixed(2);
  }) : [];
  const side = await Promise.allSettled([...flowJobs, ...volJobs]);
  const sideErr = side.filter(s => s.status === 'rejected').length;

  const { data, error } = await sb.rpc('apply_quotes', { q: Object.values(qs) });
  return new Response(JSON.stringify({ updated: data, error: error?.message, failed: errors, side_failed: sideErr }), { headers: { 'content-type': 'application/json' } });
});
