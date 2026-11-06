// Shared helpers for searching and resolving claimable territories.
export const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; market-war-demo/1.0)' };
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'content-type': 'application/json' } });

// Korean nicknames for well-known Yahoo instruments (searchable in Korean)
export const YAHOO_KO: Record<string, [string, string, string]> = {
  'GC=F': ['금', '금', 'FUTURE'], 'SI=F': ['은', '은', 'FUTURE'], 'CL=F': ['WTI 유가', '유가', 'FUTURE'], 'BZ=F': ['브렌트유', '브렌트', 'FUTURE'],
  'NG=F': ['천연가스', '가스', 'FUTURE'], 'HG=F': ['구리', '구리', 'FUTURE'], '^IXIC': ['나스닥', '나스닥', 'INDEX'], '^DJI': ['다우존스', '다우', 'INDEX'],
  '^N225': ['니케이225', '니케이', 'INDEX'], '^KQ11': ['코스닥', '코스닥', 'INDEX'], '^SOX': ['필라델피아 반도체', '반도체지수', 'INDEX'],
  '^VIX': ['VIX 공포지수', 'VIX', 'INDEX'], '^HSI': ['항셍', '항셍', 'INDEX'], '000001.SS': ['상해종합', '상해', 'INDEX'], };
export const KO_ALIAS: Record<string, string[]> = {
  '금': ['GC=F'], '골드': ['GC=F'], '은': ['SI=F'], '유가': ['CL=F', 'BZ=F'], '원유': ['CL=F', 'BZ=F'], '기름': ['CL=F'], '가스': ['NG=F'], '천연가스': ['NG=F'],
  '구리': ['HG=F'], '나스닥': ['^IXIC'], '다우': ['^DJI'], '니케이': ['^N225'], '일본': ['^N225'], '코스닥': ['^KQ11'], '반도체': ['^SOX'],
  '공포': ['^VIX'], 'vix': ['^VIX'], '항셍': ['^HSI'], '홍콩': ['^HSI'], '상해': ['000001.SS'], '중국': ['000001.SS'],
};
export const COIN_KO: Record<string, string> = {
  '솔라나': 'SOL', '리플': 'XRP', '도지': 'DOGE', '도지코인': 'DOGE', '에이다': 'ADA', '트론': 'TRX', '아발란체': 'AVAX', '체인링크': 'LINK',
  '수이': 'SUI', '페페': 'PEPE', '시바': 'SHIB', '시바이누': 'SHIB', '폴카닷': 'DOT', '라이트코인': 'LTC', '비트코인캐시': 'BCH', '톤': 'TON',
  '앱토스': 'APT', '아비트럼': 'ARB', '니어': 'NEAR', '스텔라': 'XLM', '이더리움클래식': 'ETC', '바이낸스코인': 'BNB', '비앤비': 'BNB', '월드코인': 'WLD',
};
export const COIN_NAME: Record<string, string> = Object.fromEntries(Object.entries(COIN_KO).map(([k, v]) => [v, k]));

const ETF_BRANDS = /^(KODEX|TIGER|ACE|RISE|SOL|PLUS|KBSTAR|HANARO|ARIRANG|KOSEF|TIMEFOLIO|1Q|WON|BNK|파워|히어로즈|마이티|에셋플러스|TREX|UNICORN)\b/i;

let coinCache: { at: number; list: string[] } = { at: 0, list: [] };
export async function coinList(): Promise<string[]> {
  if (Date.now() - coinCache.at < 3600_000 && coinCache.list.length) return coinCache.list;
  const j = await (await fetch('https://data-api.binance.vision/api/v3/ticker/price', { signal: AbortSignal.timeout(8000) })).json();
  coinCache = { at: Date.now(), list: j.map((x: any) => x.symbol).filter((s: string) => s.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(s)) };
  return coinCache.list;
}

export type Pick = { key: string; symbol: string; name: string; short: string; kind: string; unit: string; threshold: number; src: string; flows_src: string | null; label: string };

export async function naverSearch(q: string): Promise<Pick[]> {
  const r = await fetch(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock,index,etf`, { headers: UA, signal: AbortSignal.timeout(6000) });
  const items = (await r.json()).items || [];
  const out: Pick[] = [];
  for (const i of items) {
    if (i.category !== 'stock' && i.category !== 'etf') continue;
    if (i.nationCode === 'KOR' && /^[0-9A-Z]{6}$/.test(i.code) && (i.typeCode === 'KOSPI' || i.typeCode === 'KOSDAQ')) {
      const etf = i.category === 'etf' || ETF_BRANDS.test(i.name);
      out.push({ key: `naver:${i.code}`, symbol: i.code, name: i.name, short: i.name.replace(/\s+/g, '').slice(0, 6), kind: etf ? 'ETF' : 'STOCK', unit: 'KRW',
        threshold: etf ? 3 : 6, src: `yahoo:${i.code}.${i.typeCode === 'KOSPI' ? 'KS' : 'KQ'}`, flows_src: etf ? null : `naver_stock:${i.code}`, label: `${i.typeName || i.typeCode} · ${i.code}` });
    } else if (i.nationCode === 'USA' && /^[A-Z.]{1,6}$/.test(i.code)) {
      const etf = i.category === 'etf';
      const tk = i.code.replace('.', '-');
      out.push({ key: `naver:${i.code}`, symbol: tk, name: i.name, short: tk, kind: etf ? 'ETF' : 'STOCK', unit: 'USD',
        threshold: etf ? 3 : 7, src: `yahoo:${tk}`, flows_src: null, label: `미국 ${i.typeCode} · ${tk}` });
    }
  }
  return out;
}

export function yahooPick(tk: string, name?: string, type?: string): Pick | null {
  const ko = YAHOO_KO[tk]; const qt = ko?.[2] || type;
  if (!qt || !['FUTURE', 'INDEX', 'ETF', 'EQUITY'].includes(qt)) return null;   // no FX or bonds
  const kind = qt === 'FUTURE' ? 'FUTURE' : qt === 'INDEX' ? 'INDEX' : qt === 'CURRENCY' ? 'FX' : qt === 'ETF' ? 'ETF' : 'STOCK';
  const thr = { FUTURE: 3, INDEX: 2.5, FX: 1, ETF: 3, STOCK: 7 }[kind]!;
  const nm = ko?.[0] || name || tk;
  return { key: `yahoo:${tk}`, symbol: tk, name: nm, short: (ko?.[1] || tk).slice(0, 8), kind, unit: kind === 'FX' ? 'KRW' : 'USD', threshold: thr,
    src: `yahoo:${tk}`, flows_src: null, label: kind === 'FUTURE' ? '선물' : kind === 'INDEX' ? '지수' : kind === 'FX' ? '환율' : kind === 'ETF' ? 'ETF' : '주식' };
}

export async function yahooSearch(q: string): Promise<Pick[]> {
  const out: Pick[] = [];
  for (const [k, tks] of Object.entries(KO_ALIAS)) if (q.toLowerCase().includes(k)) for (const tk of tks) { const p = yahooPick(tk); if (p) out.push(p); }
  if (/^[\x20-\x7e]+$/.test(q)) {
    const r = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, { headers: UA, signal: AbortSignal.timeout(6000) });
    for (const x of (await r.json()).quotes || []) {
      if (x.quoteType === 'EQUITY' && /\./.test(x.symbol)) continue;          // non-US equities come from Naver
      if (x.quoteType === 'FUTURE' && !/^[A-Z]{1,3}=F$/.test(x.symbol)) continue; // continuous contracts only
      const p = yahooPick(x.symbol, x.shortname || x.longname, x.quoteType); if (p) out.push(p);
    }
  }
  return out;
}

export async function coinSearch(q: string): Promise<Pick[]> {
  const base = (COIN_KO[q.trim()] || q.trim()).toUpperCase().replace(/USDT$/, '');
  if (!/^[A-Z0-9]{2,12}$/.test(base)) return [];
  const list = await coinList();
  return list.filter(s => s.startsWith(base)).slice(0, 4).map(s => { const b = s.replace(/USDT$/, '');
    return { key: `binance:${s}`, symbol: s, name: COIN_NAME[b] ? `${COIN_NAME[b]} (${b})` : b, short: (COIN_NAME[b] || b).slice(0, 6), kind: 'CRYPTO', unit: 'USD', threshold: 8,
      src: `binance:${s}`, flows_src: `binance:${s}`, label: '코인 · 바이낸스' }; });
}

// Resolve a search key back into a pick on the server, so clients can't invent tickers.
export async function resolveKey(key: string): Promise<Pick | null> {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'naver') return (await naverSearch(id)).find(p => p.key === key) || null;
  if (kind === 'yahoo') { if (YAHOO_KO[id]) return yahooPick(id); return (await yahooSearch(id)).find(p => p.key === key) || null; }
  if (kind === 'binance') return (await coinSearch(id)).find(p => p.key === key) || null;
  return null;
}

export async function quoteOf(p: Pick): Promise<{ price: number; change: number; change_pct: number } | null> {
  if (p.src.startsWith('binance:')) {
    const t = await (await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${p.src.slice(8)}`, { signal: AbortSignal.timeout(6000) })).json();
    return +t.lastPrice > 0 ? { price: +t.lastPrice, change: +t.priceChange, change_pct: +t.priceChangePercent } : null;
  }
  const tk = p.src.slice(6);
  const v = (await (await fetch(`https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(tk)}&range=1d&interval=5m`, { headers: UA, signal: AbortSignal.timeout(6000) })).json())[tk];
  const closes = (v?.close || []).filter((x: number | null) => x != null), last = closes[closes.length - 1], prev = v?.chartPreviousClose;
  return last > 0 ? { price: last, change: last - prev, change_pct: prev ? (last / prev - 1) * 100 : 0 } : null;
}
