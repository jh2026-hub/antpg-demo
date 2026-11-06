-- Community: post categories (전망·내기·기원·푸념·정보·잡담), empathy reactions,
-- joinable bets (동조/맞불), leaderboard and daily army-vs-army score.

alter table public.posts
  add column category text not null default 'chat' check (category in ('forecast','bet','wish','vent','info','chat')),
  add column rx_pray  int not null default 0,
  add column rx_hug   int not null default 0,
  add column rx_metoo int not null default 0,
  add column rx_lol   int not null default 0,
  add column join_up   int not null default 0,
  add column join_down int not null default 0;
update public.posts set category = case when side is not null then 'forecast' else 'chat' end;
create index posts_cat_time on public.posts (category, created_at desc);

alter table public.reactions drop constraint reactions_kind_check;
alter table public.reactions add constraint reactions_kind_check
  check (kind in ('charge','shield','flag','medal','pray','hug','metoo','lol'));

create table public.post_joins (
  post_id    uuid not null references public.posts on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  side       text not null check (side in ('UP','DOWN')),
  result     text check (result in ('WIN','LOSE')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index post_joins_user on public.post_joins (user_id);
alter table public.post_joins enable row level security;
create policy read_all on public.post_joins for select using (true);
grant select on public.post_joins to anon, authenticated;
alter publication supabase_realtime add table public.post_joins;

-- ---------------------------------------------------------------- write a post (now with a category)
drop function if exists public.create_post(text, text, text, text, int, text[], text);
create or replace function public.create_post(
  p_symbol text, p_category text, p_title text, p_body text, p_side text, p_window int, p_poll text[], p_meme_url text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles; a assets; v_id uuid; v_poll text[];
begin
  me := _me();
  if me.last_post_at > now() - interval '30 seconds' then raise exception '도배 방지: 글은 30초에 1개'; end if;
  select * into a from assets where symbol = p_symbol;
  if not found then raise exception '없는 영토예요'; end if;
  if p_category not in ('forecast','bet','wish','vent','info','chat') then raise exception '말머리를 골라 주세요'; end if;
  p_title := btrim(coalesce(p_title,'')); p_body := btrim(coalesce(p_body,''));
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
  if p_category in ('forecast','bet') and p_side is null then raise exception '전망·내기는 진영을 골라야 해요'; end if;
  if p_category in ('vent','info','chat') then p_side := null; end if;
  if p_category = 'wish' and p_side is not null then p_window := 1440; end if;
  if p_side is not null then
    if p_side not in ('UP','DOWN') then raise exception '진영은 상승군/하락군 중 하나'; end if;
    if p_window not in (10, 60, 1440) then raise exception '판정 시간은 10분·1시간·24시간'; end if;
    if a.price is null or a.updated_at < now() - interval '10 minutes' then
      raise exception '지금은 시세가 안 들어와서 진영을 고를 수 없어요';
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

create or replace function public.toggle_reaction(p_post uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me profiles; v_on boolean; v_n int;
begin
  me := _me();
  if p_kind not in ('charge','shield','flag','medal','pray','hug','metoo','lol') then raise exception '없는 반응이에요'; end if;
  delete from reactions where post_id = p_post and user_id = me.id and kind = p_kind;
  if found then v_on := false;
  else
    insert into reactions (post_id, user_id, kind) values (p_post, me.id, p_kind);
    v_on := true;
  end if;
  execute format('update posts set rx_%1$s = greatest(rx_%1$s + $1, 0) where id = $2 returning rx_%1$s', p_kind)
    into v_n using (case when v_on then 1 else -1 end), p_post;
  return jsonb_build_object('on', v_on, 'count', v_n);
end $$;

-- join someone's bet on the same or the opposite side, only in the first 30% of its window
create or replace function public.join_bet(p_post uuid, p_side text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles; p posts;
begin
  me := _me();
  select * into p from posts where id = p_post;
  if not found or p.category <> 'bet' or p.is_hidden then raise exception '내기 글이 아니에요'; end if;
  if p.author_id = me.id then raise exception '내 내기엔 끼어들 수 없어요'; end if;
  if p.result is not null or now() > p.created_at + make_interval(secs => p.window_min * 60 * 0.3) then
    raise exception '끼어들기 시간이 지났어요 (판정 시간의 처음 30%%까지만)';
  end if;
  if p_side not in ('UP','DOWN') then raise exception '진영을 골라 주세요'; end if;
  begin
    insert into post_joins (post_id, user_id, side) values (p_post, me.id, p_side);
  exception when unique_violation then raise exception '이미 끼어들었어요'; end;
  if p_side = 'UP' then update posts set join_up = join_up + 1 where id = p_post;
  else update posts set join_down = join_down + 1 where id = p_post; end if;
end $$;

-- ---------------------------------------------------------------- scoring (now also scores bet joiners)
create or replace function public.settle() returns void
language plpgsql security definer set search_path = public as $$
declare r record; a assets; v_win text; v_dir text; sys_open int;
begin
  for r in select * from posts where side is not null and result is null and settle_at <= now() for update skip locked loop
    select * into a from assets where symbol = r.symbol;
    if a.price is null or a.updated_at < now() - interval '15 minutes' then continue; end if;
    v_dir := case when a.price > r.entry_price then 'UP' when a.price < r.entry_price then 'DOWN' end;
    update posts set settled_price = a.price,
      result = case when v_dir is not null and v_dir = r.side then 'WIN' else 'LOSE' end
    where id = r.id;
    update post_joins set result = case when v_dir is not null and v_dir = side then 'WIN' else 'LOSE' end where post_id = r.id;
  end loop;
  update battles bt set status = 'CLOSED', close_price = q.price
  from assets q where q.symbol = bt.symbol and bt.status = 'OPEN' and bt.closes_at <= now();
  for r in select * from battles where status = 'CLOSED' and resolves_at <= now() for update skip locked loop
    select * into a from assets where symbol = r.symbol;
    if a.price is null or a.updated_at < now() - interval '15 minutes' then continue; end if;
    if not exists (select 1 from battle_entries where battle_id = r.id and option = 'A')
       or not exists (select 1 from battle_entries where battle_id = r.id and option = 'B') then
      update battles set status = 'VOID', resolve_price = a.price where id = r.id;
      continue;
    end if;
    v_win := case when r.rule->>'type' = 'PRICE_ABOVE'
                  then case when a.price >= (r.rule->>'value')::numeric then 'A' else 'B' end
                  else case when a.price > r.close_price then 'A' else 'B' end end;
    update battles set status = 'RESOLVED', winning_option = v_win, resolve_price = a.price where id = r.id;
  end loop;
  select count(*) into sys_open from battles where is_system and status = 'OPEN';
  if sys_open = 0 then
    insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system)
    values ('BTCUSDT', '사령부 결전: 비트코인, 마감 후 10분 동안 오를까?', '상승군 승', '하락군 승',
            '{"type":"CHANGE_UP"}', now() + interval '10 minutes', now() + interval '20 minutes', true);
  end if;
  delete from quote_history where ts < now() - interval '26 hours';
end $$;
revoke execute on function public.settle() from public, anon, authenticated;

-- ---------------------------------------------------------------- records, ranking, army score
create or replace function public.soldier_stats(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'wins',    (select count(*) from posts where author_id = p_user and category in ('forecast','bet') and result = 'WIN'),
    'total',   (select count(*) from posts where author_id = p_user and category in ('forecast','bet') and result is not null),
    'pending', (select count(*) from posts where author_id = p_user and side is not null and result is null),
    'j_wins',  (select count(*) from post_joins where user_id = p_user and result = 'WIN'),
    'j_total', (select count(*) from post_joins where user_id = p_user and result is not null),
    'b_wins',  (select count(*) from battle_entries e join battles b on b.id = e.battle_id
                 where e.user_id = p_user and b.status = 'RESOLVED' and e.option = b.winning_option),
    'b_total', (select count(*) from battle_entries e join battles b on b.id = e.battle_id
                 where e.user_id = p_user and b.status = 'RESOLVED'),
    'wishes',  (select count(*) from posts where author_id = p_user and category = 'wish' and result = 'WIN'),
    'hugs',    (select coalesce(sum(rx_hug + rx_metoo), 0) from posts where author_id = p_user))
$$;

-- every scored call (own forecasts/bets, bet joins, showdowns) in the last p_days
create or replace function public._results(p_days int)
returns table (uid uuid, at timestamptz, side text, win boolean)
language sql stable security definer set search_path = public as $$
  select author_id, settle_at, side, result = 'WIN' from posts
   where category in ('forecast','bet') and result is not null and settle_at > now() - make_interval(days => p_days)
  union all
  select j.user_id, p.settle_at, j.side, j.result = 'WIN' from post_joins j join posts p on p.id = j.post_id
   where j.result is not null and p.settle_at > now() - make_interval(days => p_days)
  union all
  select e.user_id, b.resolves_at, null, e.option = b.winning_option from battle_entries e join battles b on b.id = e.battle_id
   where b.status = 'RESOLVED' and b.resolves_at > now() - make_interval(days => p_days)
$$;
revoke execute on function public._results(int) from public, anon, authenticated;

create or replace function public.leaderboard(p_days int default 7)
returns table (nickname text, flag_art text, wins int, total int, streak int)
language sql stable security definer set search_path = public as $$
  with o as (
    select uid, win,
           sum(case when win then 0 else 1 end) over (partition by uid order by at desc rows between unbounded preceding and current row) as losses
    from _results(least(greatest(p_days, 1), 90))
  )
  select p.nickname, p.flag_art,
         count(*) filter (where o.win)::int, count(*)::int, count(*) filter (where o.losses = 0)::int
  from o join profiles p on p.id = o.uid
  group by p.id, p.nickname, p.flag_art
  having count(*) >= 3
  order by count(*) filter (where o.win)::numeric / count(*) desc, count(*) filter (where o.win) desc
  limit 20
$$;

-- today's (KST) army-vs-army scoreboard from scored forecasts, bets and bet joins
create or replace function public.army_score() returns jsonb
language sql stable security definer set search_path = public as $$
  with r as (select side, win from _results(2)
             where side is not null and (at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date)
  select jsonb_build_object(
    'up_win',    count(*) filter (where side = 'UP' and win),
    'up_lose',   count(*) filter (where side = 'UP' and not win),
    'down_win',  count(*) filter (where side = 'DOWN' and win),
    'down_lose', count(*) filter (where side = 'DOWN' and not win))
  from r
$$;
