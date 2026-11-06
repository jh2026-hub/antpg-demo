// Claim a new territory. The caller must be a signed-in soldier; the server resolves the search key
// itself, checks the quote is real, then registers it through register_frontier().
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, json, resolveKey, quoteOf } from '../_shared/catalog.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') || '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: '먼저 입대해 주세요' }, 401);
  let key = '';
  try { key = String((await req.json()).key || ''); } catch (_) { /* empty */ }
  const pick = key ? await resolveKey(key).catch(() => null) : null;
  if (!pick) return json({ error: '찾을 수 없는 종목이에요' }, 400);
  const q = await quoteOf(pick).catch(() => null);
  if (!q) return json({ error: '시세를 확인할 수 없는 종목이에요' }, 400);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await admin.rpc('register_frontier', {
    p_user: user.id, p_symbol: pick.symbol, p_name: pick.name, p_short: pick.short, p_kind: pick.kind, p_unit: pick.unit,
    p_threshold: pick.threshold, p_src: pick.src, p_flows_src: pick.flows_src, p_price: q.price, p_change: q.change, p_change_pct: q.change_pct,
  });
  if (error) return json({ error: error.message }, 400);
  return json(data);
});
