-- 1) Frontier: users can claim new territories (any KR/US stock, ETF, index, future, coin).
-- 2) Rule-based showdowns: more automatic judging rules + system showdowns on a schedule.

-- ================================================================ assets: data source + frontier
alter table public.assets drop constraint assets_kind_check;
alter table public.assets add constraint assets_kind_check check (kind in ('CRYPTO','STOCK','INDEX','BOND','FX','ETF','FUTURE'));
alter table public.assets drop constraint assets_region_check;
alter table public.assets add constraint assets_region_check check (region in ('KR','US','JP','CRYPTO','FRONTIER'));
alter table public.assets
  add column src           text,                 -- 'binance:BTCUSDT' | 'yahoo:^KS11' | 'naver_bond:KR3YT=RR'
  add column frontier      boolean not null default false,
  add column active        boolean not null default true,
  add column added_by      uuid references public.profiles on delete set null,
  add column last_activity timestamptz not null default now(),
  add column flows_src     text,                 -- 'naver_index:KOSPI' | 'naver_stock:005930' | 'binance:BTCUSDT'
  add column added_at      timestamptz,
  add column vol_ratio     numeric;              -- trading volume vs normal pace (1 = usual)

update public.assets set src = case symbol
  when 'BTCUSDT' then 'binance:BTCUSDT' when 'ETHUSDT' then 'binance:ETHUSDT'
  when 'KOSPI' then 'yahoo:^KS11' when '005930' then 'yahoo:005930.KS' when '000660' then 'yahoo:000660.KS'
  when 'SPX' then 'yahoo:^GSPC' when 'NVDA' then 'yahoo:NVDA' when 'TSLA' then 'yahoo:TSLA'
  when 'USDKRW' then 'yahoo:KRW=X' when 'JPYKRW' then 'yahoo:JPYKRW=X*100'
  when 'KR3Y' then 'naver_bond:KR3YT=RR' when 'KR10Y' then 'naver_bond:KR10YT=RR'
  when 'US2Y' then 'naver_bond:US2YT=RR' when 'US10Y' then 'naver_bond:US10YT=RR' end;
update public.assets set flows_src = case symbol
  when 'KOSPI' then 'naver_index:KOSPI' when '005930' then 'naver_stock:005930' when '000660' then 'naver_stock:000660'
  when 'BTCUSDT' then 'binance:BTCUSDT' when 'ETHUSDT' then 'binance:ETHUSDT' end;
alter table public.assets alter column src set not null;

-- keep territories "alive" when people post or battle there
create or replace function public._touch_asset() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update assets set last_activity = now() where symbol = new.symbol and last_activity < now() - interval '1 minute';
  return new;
end $$;
create trigger posts_touch_asset after insert on public.posts for each row execute function public._touch_asset();
create trigger battles_touch_asset after insert on public.battles for each row execute function public._touch_asset();

-- called only by the claim-territory edge function (service role) after it verified the quote
create or replace function public.register_frontier(
  p_user uuid, p_symbol text, p_name text, p_short text, p_kind text, p_unit text, p_threshold numeric,
  p_src text, p_flows_src text, p_price numeric, p_change numeric, p_change_pct numeric
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me profiles; ex assets;
begin
  select * into me from profiles where id = p_user;
  if not found then raise exception '먼저 입대해 주세요'; end if;
  if me.banned_until is not null and me.banned_until > now() then raise exception '영창 중에는 개척할 수 없어요'; end if;
  select * into ex from assets where symbol = p_symbol;
  if found then
    if not ex.active then update assets set active = true, last_activity = now() where symbol = p_symbol; end if;
    return jsonb_build_object('symbol', p_symbol, 'existing', true);
  end if;
  if (select count(*) from assets where added_by = p_user and added_at > now() - interval '1 day') >= 3 then
    raise exception '개척은 하루 3곳까지예요';
  end if;
  if (select count(*) from assets where frontier and active) >= 40 then
    raise exception '개척지가 꽉 찼어요 (최대 40곳). 오래 조용한 곳이 정리되면 다시 시도해 주세요';
  end if;
  perform _check_text(p_name || ' ' || p_short);
  insert into assets (symbol, name, short, kind, region, unit, threshold, lon, lat, sort, description, src, flows_src,
                      frontier, active, added_by, added_at, last_activity, price, change, change_pct, delayed, market_open, updated_at)
  values (p_symbol, left(p_name, 30), left(p_short, 8), p_kind, 'FRONTIER', p_unit, p_threshold, 0, 0,
          1000 + (select count(*) from assets where frontier), me.nickname || '님이 개척한 영토', p_src, p_flows_src,
          true, true, p_user, now(), now(), p_price, p_change, p_change_pct, true, true, now());
  return jsonb_build_object('symbol', p_symbol, 'existing', false);
end $$;
revoke execute on function public.register_frontier(uuid,text,text,text,text,text,numeric,text,text,numeric,numeric,numeric) from public, anon, authenticated;

-- ================================================================ showdowns: rule-based judging
alter table public.battles
  add column other_symbol   text references public.assets on delete set null,
  add column close_price2   numeric,
  add column resolve_price2 numeric,
  add column template       text,
  add column detail         text;
create index battles_template on public.battles (template, status);

-- validate a rule object; returns the normalized rule
create or replace function public._check_rule(p_symbol text, r jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t text := r->>'type'; a assets; o assets;
begin
  select * into a from assets where symbol = p_symbol;
  case t
    when 'CHANGE_UP', 'DAY_UP', 'ARMY_UP' then return jsonb_build_object('type', t);
    when 'PRICE_ABOVE', 'TOUCH_ABOVE', 'TOUCH_BELOW' then
      if coalesce((r->>'value')::numeric, 0) <= 0 then raise exception '기준값을 넣어 주세요'; end if;
      return jsonb_build_object('type', t, 'value', (r->>'value')::numeric);
    when 'MOVE_ABOVE', 'RANGE_BREAK' then
      if coalesce((r->>'pct')::numeric, 0) <= 0 or (r->>'pct')::numeric > 50 then raise exception '변동폭은 0보다 크고 50 이하'; end if;
      return jsonb_build_object('type', t, 'pct', (r->>'pct')::numeric);
    when 'VERSUS' then
      select * into o from assets where symbol = r->>'other' and active;
      if not found or o.symbol = p_symbol then raise exception '맞붙을 다른 영토를 골라 주세요'; end if;
      if (a.kind = 'BOND') <> (o.kind = 'BOND') then raise exception '금리와 가격은 서로 비교할 수 없어요'; end if;
      return jsonb_build_object('type', t, 'other', o.symbol);
    when 'FLOW_BUY' then
      if a.flows_src is null then raise exception '이 영토는 수급 정보가 없어요'; end if;
      if a.flows_src like 'binance:%' then return jsonb_build_object('type', t, 'group', 'taker'); end if;
      if r->>'group' not in ('foreign','inst','retail') then raise exception '외국인·기관·개인 중 하나'; end if;
      return jsonb_build_object('type', t, 'group', r->>'group');
    else raise exception '지원하지 않는 판정 규칙이에요';
  end case;
end $$;

drop function if exists public.create_battle(text, text, text, text, text, numeric, int, int);
create or replace function public.create_battle(
  p_symbol text, p_question text, p_a text, p_b text, p_rule jsonb, p_close_min int, p_resolve_min int
) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles; v_id uuid; v_rule jsonb;
begin
  me := _me();
  if me.last_battle_at > now() - interval '2 minutes' then raise exception '결전은 2분에 1개만 열 수 있어요'; end if;
  if not exists (select 1 from assets where symbol = p_symbol and active) then raise exception '없는 영토예요'; end if;
  perform _check_text(p_question || ' ' || p_a || ' ' || p_b);
  if p_close_min not between 2 and 10080 then raise exception '마감은 2분~7일 뒤'; end if;
  if p_resolve_min not between 1 and 1440 then raise exception '판정은 마감 후 1분~24시간'; end if;
  v_rule := _check_rule(p_symbol, p_rule);
  insert into battles (creator_id, symbol, other_symbol, question, option_a, option_b, rule, closes_at, resolves_at)
  values (me.id, p_symbol, v_rule->>'other', btrim(p_question), btrim(p_a), btrim(p_b), v_rule,
          now() + make_interval(mins => p_close_min), now() + make_interval(mins => p_close_min + p_resolve_min))
  returning id into v_id;
  update profiles set last_battle_at = now() where id = me.id;
  return v_id;
end $$;

-- decide A/B for a closed showdown; null = cannot judge yet (missing data)
create or replace function public._judge(b battles) returns text
language plpgsql stable security definer set search_path = public as $$
declare a assets; o assets; t text := b.rule->>'type'; mv numeric; mv2 numeric; ext numeric; army jsonb; f jsonb;
begin
  select * into a from assets where symbol = b.symbol;
  if a.price is null or a.updated_at < now() - interval '15 minutes' then return null; end if;
  mv := case when a.kind = 'BOND' then (a.price - b.close_price) * 100 else (a.price / nullif(b.close_price, 0) - 1) * 100 end;
  case t
    when 'CHANGE_UP'   then return case when a.price > b.close_price then 'A' else 'B' end;
    when 'PRICE_ABOVE' then return case when a.price >= (b.rule->>'value')::numeric then 'A' else 'B' end;
    when 'MOVE_ABOVE'  then return case when mv >= (b.rule->>'pct')::numeric then 'A' else 'B' end;
    when 'RANGE_BREAK' then return case when abs(mv) >= (b.rule->>'pct')::numeric then 'A' else 'B' end;
    when 'DAY_UP'      then return case when a.change_pct > 0 or (a.kind = 'BOND' and a.change > 0) then 'A' else 'B' end;
    when 'TOUCH_ABOVE', 'TOUCH_BELOW' then
      select case when t = 'TOUCH_ABOVE' then max(price) else min(price) end into ext
        from quote_history where symbol = b.symbol and ts between b.closes_at and b.resolves_at + interval '2 minutes';
      ext := case when t = 'TOUCH_ABOVE' then greatest(coalesce(ext, a.price), a.price) else least(coalesce(ext, a.price), a.price) end;
      return case when (t = 'TOUCH_ABOVE' and ext >= (b.rule->>'value')::numeric) or (t = 'TOUCH_BELOW' and ext <= (b.rule->>'value')::numeric) then 'A' else 'B' end;
    when 'VERSUS' then
      select * into o from assets where symbol = b.other_symbol;
      if o.price is null or o.updated_at < now() - interval '15 minutes' or b.close_price2 is null then return null; end if;
      mv2 := case when o.kind = 'BOND' then (o.price - b.close_price2) * 100 else (o.price / nullif(b.close_price2, 0) - 1) * 100 end;
      return case when mv > mv2 then 'A' else 'B' end;
    when 'FLOW_BUY' then
      f := a.flows->'now'; if f is null then return null; end if;
      if b.rule->>'group' = 'taker' then return case when (f->>'buy')::numeric > (f->>'sell')::numeric then 'A' else 'B' end; end if;
      return case when (f->>(b.rule->>'group'))::numeric > 0 then 'A' else 'B' end;
    when 'ARMY_UP' then
      army := army_score();
      return case when (army->>'up_win')::int > (army->>'down_win')::int then 'A' else 'B' end;
    else return 'B';
  end case;
end $$;

-- system showdowns on a schedule (KST); each template keeps at most one live showdown
create or replace function public._ensure_system_battles() returns void
language plpgsql security definer set search_path = public as $$
declare k timestamp := now() at time zone 'Asia/Seoul'; d date := (now() at time zone 'Asia/Seoul')::date;
        dow int := extract(isodow from (now() at time zone 'Asia/Seoul')); hm int := extract(hour from k) * 60 + extract(minute from k);
        p numeric;
begin
  if not exists (select 1 from battles where template = 'btc10' and status in ('OPEN','CLOSED')) then
    insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
    values ('BTCUSDT', '비트코인, 마감 후 10분 동안 오를까?', '상승군 승', '하락군 승', '{"type":"CHANGE_UP"}', now() + interval '10 minutes', now() + interval '20 minutes', true, 'btc10');
  end if;
  if not exists (select 1 from battles where template = 'btc_eth' and status in ('OPEN','CLOSED')) then
    insert into battles (symbol, other_symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
    values ('BTCUSDT', 'ETHUSDT', '영토 대결: 1시간 동안 비트코인 vs 이더리움, 누가 더 오를까?', '비트코인', '이더리움', '{"type":"VERSUS","other":"ETHUSDT"}', now() + interval '10 minutes', now() + interval '70 minutes', true, 'btc_eth');
  end if;
  if not exists (select 1 from battles where template = 'btc_touch' and status in ('OPEN','CLOSED')) then
    select price into p from assets where symbol = 'BTCUSDT';
    if p is not null then
      insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
      values ('BTCUSDT', '1시간 안에 비트코인 ' || to_char(round(p * 1.01), 'FM$999,999,999') || ' (+1%) 터치할까?', '터치한다', '못 간다',
              jsonb_build_object('type', 'TOUCH_ABOVE', 'value', round(p * 1.01)), now() + interval '5 minutes', now() + interval '65 minutes', true, 'btc_touch');
    end if;
  end if;
  if not exists (select 1 from battles where template = 'usd_range' and status in ('OPEN','CLOSED')) then
    insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
    values ('USDKRW', '원/달러 환율, 앞으로 6시간 안에 ±0.3% 넘게 움직일까?', '크게 출렁', '잠잠', '{"type":"RANGE_BREAK","pct":0.3}', now() + interval '30 minutes', now() + interval '390 minutes', true, 'usd_range');
  end if;
  -- weekday KR morning: decided at the close
  if dow between 1 and 5 and hm between 7 * 60 and 8 * 60 + 50 then
    if not exists (select 1 from battles where template = 'kospi_day' and created_at > (d::timestamp at time zone 'Asia/Seoul')) then
      insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
      values ('KOSPI', '오늘 코스피, 플러스로 장을 마칠까?', '플러스 마감', '마이너스 마감', '{"type":"DAY_UP"}',
              (d + time '09:00') at time zone 'Asia/Seoul', (d + time '15:45') at time zone 'Asia/Seoul', true, 'kospi_day');
    end if;
    if not exists (select 1 from battles where template = 'kospi_foreign' and created_at > (d::timestamp at time zone 'Asia/Seoul')) then
      insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
      values ('KOSPI', '오늘 외국인 용병단, 코스피를 순매수로 마칠까?', '사들인다', '팔아치운다', '{"type":"FLOW_BUY","group":"foreign"}',
              (d + time '09:00') at time zone 'Asia/Seoul', (d + time '15:50') at time zone 'Asia/Seoul', true, 'kospi_foreign');
    end if;
  end if;
  -- weekday US evening: NVDA vs TSLA through the session
  if dow between 1 and 5 and hm between 18 * 60 and 23 * 60 then
    if not exists (select 1 from battles where template = 'nvda_tsla' and created_at > (d::timestamp at time zone 'Asia/Seoul')) then
      insert into battles (symbol, other_symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
      values ('NVDA', 'TSLA', '영토 대결: 오늘 밤 엔비디아 vs 테슬라, 누가 더 오를까?', '엔비디아', '테슬라', '{"type":"VERSUS","other":"TSLA"}',
              (d + time '23:20') at time zone 'Asia/Seoul', (d + 1 + time '06:10') at time zone 'Asia/Seoul', true, 'nvda_tsla');
    end if;
  end if;
  -- every day: which army wins today's scoreboard
  if hm between 10 and 11 * 60 then
    if not exists (select 1 from battles where template = 'army_day' and created_at > (d::timestamp at time zone 'Asia/Seoul')) then
      insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
      values ('KOSPI', '오늘의 진영전, 상승군이 이길까?', '상승군 승리', '하락군 승리 또는 무승부', '{"type":"ARMY_UP"}',
              (d + time '12:00') at time zone 'Asia/Seoul', (d + time '23:55') at time zone 'Asia/Seoul', true, 'army_day');
    end if;
  end if;
end $$;

create or replace function public.settle() returns void
language plpgsql security definer set search_path = public as $$
declare r record; a assets; v_win text; v_dir text;
begin
  -- war reports and bet joiners
  for r in select * from posts where side is not null and result is null and settle_at <= now() for update skip locked loop
    select * into a from assets where symbol = r.symbol;
    if a.price is null or a.updated_at < now() - interval '15 minutes' then continue; end if;
    v_dir := case when a.price > r.entry_price then 'UP' when a.price < r.entry_price then 'DOWN' end;
    update posts set settled_price = a.price,
      result = case when v_dir is not null and v_dir = r.side then 'WIN' else 'LOSE' end
    where id = r.id;
    update post_joins set result = case when v_dir is not null and v_dir = side then 'WIN' else 'LOSE' end where post_id = r.id;
  end loop;
  -- close showdowns (snapshot both sides for VERSUS)
  update battles bt set status = 'CLOSED', close_price = q.price,
         close_price2 = (select price from assets o where o.symbol = bt.other_symbol)
  from assets q where q.symbol = bt.symbol and bt.status = 'OPEN' and bt.closes_at <= now() and q.price is not null;
  -- resolve
  for r in select * from battles where status = 'CLOSED' and resolves_at <= now() for update skip locked loop
    if not exists (select 1 from battle_entries where battle_id = r.id and option = 'A')
       or not exists (select 1 from battle_entries where battle_id = r.id and option = 'B') then
      update battles set status = 'VOID', resolve_price = (select price from assets where symbol = r.symbol) where id = r.id;
      continue;
    end if;
    v_win := _judge(r);
    if v_win is null then
      if r.resolves_at < now() - interval '6 hours' then update battles set status = 'VOID', detail = '판정 자료가 없어 무효' where id = r.id; end if;
      continue;
    end if;
    update battles set status = 'RESOLVED', winning_option = v_win,
      resolve_price = (select price from assets where symbol = r.symbol),
      resolve_price2 = (select price from assets where symbol = r.other_symbol)
    where id = r.id;
  end loop;
  perform _ensure_system_battles();
  delete from quote_history where ts < now() - interval '26 hours';
end $$;
revoke execute on function public.settle(), public._judge(battles), public._ensure_system_battles() from public, anon, authenticated;

-- daily: retire frontier territories nobody touched for 14 days (keeps their posts)
create or replace function public.daily_job() returns void
language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Seoul')::date; d date := today - 2; r record; up_wins boolean;
begin
  insert into daily_snap (symbol, day, price)
  select symbol, today, price from assets where price is not null and active
  on conflict (symbol, day) do update set price = excluded.price;
  for r in
    select p.symbol, count(*) filter (where p.side = 'UP') u, count(*) filter (where p.side = 'DOWN') dn
    from posts p
    where p.side is not null and p.category in ('forecast','bet') and (p.created_at at time zone 'Asia/Seoul')::date = d
    group by p.symbol
  loop
    if r.u = r.dn then continue; end if;
    select (s1.price > s0.price) into up_wins
    from daily_snap s0 join daily_snap s1 on s1.symbol = s0.symbol and s1.day = today
    where s0.symbol = r.symbol and s0.day = today - 1;
    if up_wins is null then continue; end if;
    insert into front_daily (symbol, day, majority, defeated)
    values (r.symbol, d, case when r.u > r.dn then 'UP' else 'DOWN' end, (r.u > r.dn) <> up_wins)
    on conflict do nothing;
  end loop;
  delete from daily_snap where day < today - 40;
  update assets set active = false where frontier and active and last_activity < now() - interval '14 days';
end $$;
revoke execute on function public.daily_job() from public, anon, authenticated;

-- ================================================================ one-tap participation
-- forecasts without a body (one-tap) get a 10s limit; anything else keeps 30s.
-- at most 3 unsettled calls per soldier per territory.
create or replace function public.create_post(
  p_symbol text, p_category text, p_title text, p_body text, p_side text, p_window int, p_poll text[], p_meme_url text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles; a assets; v_id uuid; v_poll text[]; v_quick boolean; v_gap interval; v_msg text;
begin
  me := _me();
  p_title := btrim(coalesce(p_title,'')); p_body := btrim(coalesce(p_body,''));
  v_quick := p_category = 'forecast' and p_body = '' and p_poll is null and p_meme_url is null;
  v_gap := case when v_quick then interval '10 seconds' else interval '30 seconds' end;
  v_msg := case when v_quick then '잠깐! 10초 뒤에 다시 참전할 수 있어요' else '도배 방지: 글은 30초에 1개' end;
  if me.last_post_at > now() - v_gap then raise exception '%', v_msg; end if;
  select * into a from assets where symbol = p_symbol and active;
  if not found then raise exception '없는 영토예요'; end if;
  if p_category not in ('forecast','bet','wish','vent','info','chat') then raise exception '말머리를 골라 주세요'; end if;
  if p_title = '' then raise exception '제목을 써 주세요'; end if;
  perform _check_text(p_title || ' ' || p_body);
  if p_poll is not null then
    select array_agg(btrim(x)) into v_poll from unnest(p_poll) x where btrim(x) <> '';
    if coalesce(array_length(v_poll,1),0) not between 2 and 5 then raise exception '투표 선택지는 2~5개'; end if;
    if exists (select 1 from unnest(v_poll) x where char_length(x) > 20) then raise exception '선택지는 20자까지'; end if;
    perform _check_text(array_to_string(v_poll,' '));
  end if;
  if p_meme_url is not null and p_meme_url !~ ('/storage/v1/object/public/posters/' || auth.uid()::text || '/[A-Za-z0-9_.-]+$') then
    raise exception '포스터 주소가 올바르지 않아요';
  end if;
  if p_category in ('forecast','bet') and p_side is null then raise exception '오른다·내린다 중 하나를 골라 주세요'; end if;
  if p_category in ('vent','info','chat') then p_side := null; end if;
  if p_category = 'wish' and p_side is not null then p_window := 1440; end if;
  if p_side is not null then
    if p_side not in ('UP','DOWN') then raise exception '오른다·내린다 중 하나'; end if;
    if p_window not in (10, 60, 1440) then raise exception '판정 시간은 10분·1시간·24시간'; end if;
    if a.price is null or a.updated_at < now() - interval '10 minutes' then
      raise exception '지금은 시세가 안 들어와서 참전할 수 없어요';
    end if;
    if p_category in ('forecast','bet') and (select count(*) from posts where author_id = me.id and symbol = p_symbol and side is not null
          and result is null and category in ('forecast','bet')) >= 3 then
      raise exception '이 영토에 판정 기다리는 참전이 이미 3개예요';
    end if;
  end if;
  insert into posts (symbol, category, author_id, title, body, side, entry_price, window_min, settle_at, poll, poll_counts, meme_url)
  values (p_symbol, p_category, me.id, p_title, p_body, p_side,
          case when p_side is not null then a.price end,
          case when p_side is not null then p_window end,
          case when p_side is not null then now() + make_interval(mins => p_window) end,
          v_poll, case when v_poll is not null then array_fill(0, array[array_length(v_poll,1)]) end,
          p_meme_url)
  returning id into v_id;
  update profiles set last_post_at = now() where id = me.id;
  return v_id;
end $$;

-- my open calls (for the home "내 참전" card)
create or replace function public.my_open_calls() returns table (id uuid, symbol text, category text, side text, entry_price numeric, settle_at timestamptz)
language sql stable security definer set search_path = public as $$
  select id, symbol, category, side, entry_price, settle_at from posts
  where author_id = auth.uid() and side is not null and result is null order by settle_at limit 10
$$;

-- ================================================================ heat inputs: volume + recent activity
create or replace function public.apply_quotes(q jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0; ts timestamptz := now();
begin
  for r in select * from jsonb_array_elements(q) loop
    update assets set price = (r->>'price')::numeric, change = (r->>'change')::numeric,
      change_pct = (r->>'change_pct')::numeric, market_open = (r->>'market_open')::boolean,
      delayed = coalesce((r->>'delayed')::boolean, true), source = r->>'source', updated_at = ts,
      flows = coalesce(r->'flows', flows), flows_at = case when r ? 'flows' then ts else flows_at end,
      vol_ratio = coalesce((r->>'vol_ratio')::numeric, vol_ratio)
    where symbol = r->>'symbol';
    if found then
      insert into quote_history (symbol, ts, price) values (r->>'symbol', ts, (r->>'price')::numeric) on conflict do nothing;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.apply_quotes(jsonb) from public, anon, authenticated;

drop function if exists public.front_forces();
create or replace function public.front_forces() returns table (symbol text, up int, down int, recent int)
language sql stable security definer set search_path = public as $$
  select a.symbol,
         count(*) filter (where p.side = 'UP')::int,
         count(*) filter (where p.side = 'DOWN')::int,
         count(*) filter (where p.created_at > now() - interval '1 hour')::int
  from assets a left join posts p on p.symbol = a.symbol and p.created_at > now() - interval '24 hours' and not p.is_hidden
  group by a.symbol
$$;
