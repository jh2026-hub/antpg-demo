-- Operator bots: labeled accounts that post satirical war reports and comment on events.
-- They never take a side, so they never enter scoring, rankings or the army score.

alter table public.profiles add column is_bot boolean not null default false;
alter table public.profiles add column bot_role text;

-- events the bots already reacted to (dedupe) and small state values (e.g. last market_open)
create table public.bot_log (
  key text primary key,
  at  timestamptz not null default now(),
  val text
);
alter table public.bot_log enable row level security;   -- no client policies: server only

-- bots are excluded from rankings even if a side ever slipped through
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
  where not p.is_bot
  group by p.id, p.nickname, p.flag_art
  having count(*) >= 3
  order by count(*) filter (where o.win)::numeric / count(*) desc, count(*) filter (where o.win) desc
  limit 20
$$;

-- bot writes go through here (service role only): keeps counters right and skips user rate limits
create or replace function public.bot_post(p_bot uuid, p_symbol text, p_category text, p_title text, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from profiles where id = p_bot and is_bot) then raise exception 'not a bot'; end if;
  insert into posts (symbol, category, author_id, title, body)
  values (p_symbol, p_category, p_bot, left(p_title, 60), left(p_body, 2000)) returning id into v_id;
  return v_id;
end $$;

create or replace function public.bot_comment(p_bot uuid, p_post uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from profiles where id = p_bot and is_bot) then raise exception 'not a bot'; end if;
  insert into comments (post_id, author_id, body) values (p_post, p_bot, left(p_body, 200)) returning id into v_id;
  update posts set comment_count = comment_count + 1 where id = p_post;
  return v_id;
end $$;
revoke execute on function public.bot_post(uuid,text,text,text,text), public.bot_comment(uuid,uuid,text) from public, anon, authenticated;
