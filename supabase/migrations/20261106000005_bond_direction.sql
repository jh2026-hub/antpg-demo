-- Bonds trade on yield. A higher yield means a weaker bond, so for bond territories
-- 상승군 = bond strength = falling yield. Scoring, the contrarian index and DAY_UP follow that.

update public.assets set description = case symbol
  when 'KR3Y'  then '반도 동쪽 해군기지 · 금리가 내리면(채권 강세) 상승군 우세'
  when 'KR10Y' then '반도 남동쪽 심해기지 · 장기전 전문 · 금리↓ = 채권 강세 = 상승군'
  when 'US2Y'  then '대륙 동쪽 함대 · 연준 눈치 전문 · 금리↓ = 채권 강세 = 상승군'
  when 'US10Y' then '대륙 남동쪽 주력함대 · 전 세계 금리의 기준 · 금리↓ = 채권 강세 = 상승군'
  else description end
where kind = 'BOND';

create or replace function public.settle() returns void
language plpgsql security definer set search_path = public as $$
declare r record; a assets; v_win text; v_dir text;
begin
  -- war reports and bet joiners
  for r in select * from posts where side is not null and result is null and settle_at <= now() for update skip locked loop
    select * into a from assets where symbol = r.symbol;
    if a.price is null or a.updated_at < now() - interval '15 minutes' then continue; end if;
    -- bonds trade on yield: a lower yield is a stronger bond, so 상승군 (UP) wins when the yield falls
    v_dir := case when a.kind = 'BOND' then case when a.price < r.entry_price then 'UP' when a.price > r.entry_price then 'DOWN' end
                  else case when a.price > r.entry_price then 'UP' when a.price < r.entry_price then 'DOWN' end end;
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
    select case when x.kind = 'BOND' then s1.price < s0.price else s1.price > s0.price end into up_wins
    from daily_snap s0 join daily_snap s1 on s1.symbol = s0.symbol and s1.day = today join assets x on x.symbol = s0.symbol
    where s0.symbol = r.symbol and s0.day = today - 1;
    if up_wins is null then continue; end if;
    insert into front_daily (symbol, day, majority, defeated)
    values (r.symbol, d, case when r.u > r.dn then 'UP' else 'DOWN' end, (r.u > r.dn) <> up_wins)
    on conflict do nothing;
  end loop;
  delete from daily_snap where day < today - 40;
  update assets set active = false where frontier and active and last_activity < now() - interval '14 days';
end $$;

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
    when 'DAY_UP'      then return case when (a.kind = 'BOND' and a.change < 0) or (a.kind <> 'BOND' and a.change_pct > 0) then 'A' else 'B' end;
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

revoke execute on function public.settle(), public.daily_job(), public._judge(battles) from public, anon, authenticated;
