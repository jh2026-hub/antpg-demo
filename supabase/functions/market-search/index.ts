// Search claimable territories: KR/US stocks and ETFs (Naver), indices/futures/FX (Yahoo), coins (Binance).
import { cors, json, naverSearch, yahooSearch, coinSearch, KO_ALIAS, COIN_KO, type Pick } from '../_shared/catalog.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let q = '';
  try { q = String((await req.json()).q || '').trim().slice(0, 30); } catch (_) { /* empty */ }
  if (q.length < 1) return json({ items: [] });
  // an exact Korean nickname (금, 유가, 솔라나...) puts those results first
  const exact = KO_ALIAS[q.toLowerCase()] ? 'yahoo' : COIN_KO[q] ? 'coin' : null;
  const jobs = exact === 'yahoo' ? [yahooSearch(q), naverSearch(q), coinSearch(q)] : exact === 'coin' ? [coinSearch(q), naverSearch(q), yahooSearch(q)] : [naverSearch(q), yahooSearch(q), coinSearch(q)];
  const res = await Promise.allSettled(jobs);
  const seen = new Set<string>(), items: Pick[] = [];
  for (const r of res) if (r.status === 'fulfilled') for (const p of r.value) if (!seen.has(p.symbol)) { seen.add(p.symbol); items.push(p); }
  return json({ items: items.slice(0, 15).map(p => ({ key: p.key, symbol: p.symbol, name: p.name, label: p.label, kind: p.kind })) });
});
