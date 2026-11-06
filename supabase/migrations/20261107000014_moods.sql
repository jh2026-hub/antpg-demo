-- Zero-base rebuild: "오늘 장 어땠어요?" — share a mood + one line, get hugs, give opinions.
-- Old prediction/battle tables stay in place but the new page no longer uses them.

create table public.moods (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references public.profiles on delete cascade,
  mood          text not null check (mood in ('rekt','empty','unfair','meh','held','won')),
  symbol        text references public.assets on delete set null,
  body          text not null default '' check (char_length(body) <= 200),
  hug           int not null default 0,
  metoo         int not null default 0,
  cheer         int not null default 0,
  lol           int not null default 0,
  comment_count int not null default 0,
  reports       int not null default 0,
  is_hidden     boolean not null default false,
  created_at    timestamptz not null default now()
);
create index moods_time on public.moods (created_at desc);
create index moods_mood_time on public.moods (mood, created_at desc);
create index moods_author on public.moods (author_id, created_at desc);

create table public.mood_comments (
  id         uuid primary key default gen_random_uuid(),
  mood_id    uuid not null references public.moods on delete cascade,
  author_id  uuid not null references public.profiles on delete cascade,
  body       text not null check (char_length(body) between 1 and 200),
  is_hidden  boolean not null default false,
  created_at timestamptz not null default now()
);
create index mood_comments_mood on public.mood_comments (mood_id, created_at);

create table public.mood_reactions (
  mood_id uuid not null references public.moods on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  kind    text not null check (kind in ('hug','metoo','cheer','lol')),
  primary key (mood_id, user_id, kind)
);

create table public.opinions (
  symbol     text not null references public.assets on delete cascade,
  day        date not null,
  user_id    uuid not null references public.profiles on delete cascade,
  pick       text not null check (pick in ('up','down','dunno')),
  created_at timestamptz not null default now(),
  primary key (symbol, day, user_id)
);

alter table public.moods          enable row level security;
alter table public.mood_comments  enable row level security;
alter table public.mood_reactions enable row level security;
alter table public.opinions       enable row level security;
create policy read_vis on public.moods         for select using (not is_hidden or author_id = auth.uid() or public.is_admin());
create policy read_vis on public.mood_comments for select using (not is_hidden or author_id = auth.uid() or public.is_admin());
create policy read_own on public.mood_reactions for select using (user_id = auth.uid());
create policy read_own on public.opinions       for select using (user_id = auth.uid());
grant select on public.moods, public.mood_comments, public.mood_reactions, public.opinions to anon, authenticated;

alter table public.reports drop constraint reports_target_type_check;
alter table public.reports add constraint reports_target_type_check check (target_type in ('post','comment','art','mood','mood_comment'));

-- ---------------------------------------------------------------- writes
create or replace function public.share_mood(p_mood text, p_symbol text, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles; v_id uuid;
begin
  me := _me();
  if me.last_post_at > now() - interval '20 seconds' then raise exception '잠깐만요, 20초 뒤에 다시 남길 수 있어요'; end if;
  if p_mood not in ('rekt','empty','unfair','meh','held','won') then raise exception '기분을 골라 주세요'; end if;
  p_body := btrim(coalesce(p_body, ''));
  if char_length(p_body) > 200 then raise exception '200자까지 쓸 수 있어요'; end if;
  perform _check_text(p_body);
  if p_symbol is not null and not exists (select 1 from assets where symbol = p_symbol and active) then p_symbol := null; end if;
  insert into moods (author_id, mood, symbol, body) values (me.id, p_mood, p_symbol, p_body) returning id into v_id;
  update profiles set last_post_at = now() where id = me.id;
  return v_id;
end $$;

create or replace function public.add_mood_comment(p_mood uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles; v_id uuid;
begin
  me := _me();
  if me.last_comment_at > now() - interval '8 seconds' then raise exception '잠깐만요, 8초 뒤에 다시 쓸 수 있어요'; end if;
  p_body := btrim(coalesce(p_body, ''));
  if p_body = '' or char_length(p_body) > 200 then raise exception '댓글은 1~200자'; end if;
  perform _check_text(p_body);
  if not exists (select 1 from moods where id = p_mood and not is_hidden) then raise exception '없는 글이에요'; end if;
  insert into mood_comments (mood_id, author_id, body) values (p_mood, me.id, p_body) returning id into v_id;
  update moods set comment_count = comment_count + 1 where id = p_mood;
  update profiles set last_comment_at = now() where id = me.id;
  return v_id;
end $$;

create or replace function public.toggle_mood_reaction(p_mood uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me profiles; v_on boolean; v_n int;
begin
  me := _me();
  if p_kind not in ('hug','metoo','cheer','lol') then raise exception '없는 반응이에요'; end if;
  delete from mood_reactions where mood_id = p_mood and user_id = me.id and kind = p_kind;
  if found then v_on := false; else insert into mood_reactions (mood_id, user_id, kind) values (p_mood, me.id, p_kind); v_on := true; end if;
  execute format('update moods set %1$I = greatest(%1$I + $1, 0) where id = $2 returning %1$I', p_kind) into v_n using (case when v_on then 1 else -1 end), p_mood;
  return jsonb_build_object('on', v_on, 'count', v_n);
end $$;

create or replace function public.give_opinion(p_symbol text, p_pick text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me profiles; d date := (now() at time zone 'Asia/Seoul')::date;
begin
  me := _me();
  if p_pick not in ('up','down','dunno') then raise exception '골라 주세요'; end if;
  if not exists (select 1 from assets where symbol = p_symbol and active) then raise exception '없는 종목이에요'; end if;
  insert into opinions (symbol, day, user_id, pick) values (p_symbol, d, me.id, p_pick)
  on conflict (symbol, day, user_id) do update set pick = excluded.pick, created_at = now();
  return opinion_today(p_symbol);
end $$;

create or replace function public.report_mood(p_type text, p_id uuid, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare me profiles; v_n int;
begin
  me := _me();
  if p_type not in ('mood','mood_comment') then raise exception '신고 대상이 올바르지 않아요'; end if;
  begin insert into reports (reporter_id, target_type, target_id, reason) values (me.id, p_type, p_id::text, left(p_reason, 40));
  exception when unique_violation then raise exception '이미 신고했어요'; end;
  select count(*) into v_n from reports where target_type = p_type and target_id = p_id::text;
  if p_type = 'mood' then update moods set reports = v_n, is_hidden = is_hidden or v_n >= 3 where id = p_id;
  else update mood_comments set is_hidden = is_hidden or v_n >= 3 where id = p_id; end if;
  return v_n;
end $$;

-- ---------------------------------------------------------------- reads
create or replace function public.mood_today() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(mood, n), '{}'::jsonb) from (
    select mood, count(*) n from moods m join profiles p on p.id = m.author_id
    where not m.is_hidden and not p.is_bot and (m.created_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date
    group by mood) t
$$;

create or replace function public.opinion_today(p_symbol text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'up',    count(*) filter (where pick = 'up'),
    'down',  count(*) filter (where pick = 'down'),
    'dunno', count(*) filter (where pick = 'dunno'),
    'mine',  (select pick from opinions where symbol = p_symbol and day = (now() at time zone 'Asia/Seoul')::date and user_id = auth.uid()))
  from opinions where symbol = p_symbol and day = (now() at time zone 'Asia/Seoul')::date
$$;

-- bots may comment on moods (service role only)
create or replace function public.bot_mood_comment(p_bot uuid, p_mood uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from profiles where id = p_bot and is_bot) then raise exception 'not a bot'; end if;
  insert into mood_comments (mood_id, author_id, body) values (p_mood, p_bot, left(p_body, 200)) returning id into v_id;
  update moods set comment_count = comment_count + 1 where id = p_mood;
  return v_id;
end $$;
revoke execute on function public.bot_mood_comment(uuid, uuid, text) from public, anon, authenticated;

alter publication supabase_realtime add table public.moods, public.mood_comments;
