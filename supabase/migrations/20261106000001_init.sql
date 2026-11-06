-- 시장대전 (Market Wars) schema.
-- Pure fun: no points. Users predict which army (UP = 상승군, DOWN = 하락군) wins a front,
-- the server scores it with real prices. All writes go through SECURITY DEFINER functions;
-- tables are read-only for clients via RLS.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------- fronts (assets)
create table public.assets (
  symbol       text primary key,
  name         text not null,
  short        text not null,
  kind         text not null check (kind in ('CRYPTO','STOCK','INDEX','BOND','FX')),
  region       text not null check (region in ('KR','US','JP','CRYPTO')),
  unit         text not null check (unit in ('USD','KRW','PCT')),
  threshold    numeric not null,          -- move that means a full rout: % for most, %p for bonds
  lon          numeric not null,          -- x on the fantasy map grid (0..100)
  lat          numeric not null,          -- y on the fantasy map grid (0..124)
  sort         int not null default 0,
  description  text not null default '',
  price        numeric,
  change       numeric,                   -- absolute change vs previous close (bonds: %p)
  change_pct   numeric,
  market_open  boolean,
  delayed      boolean not null default true,
  source       text,
  updated_at   timestamptz,
  flows        jsonb,                     -- who is buying/selling (KR investor groups, crypto taker flow)
  flows_at     timestamptz
);

create table public.quote_history (
  symbol text not null references public.assets on delete cascade,
  ts     timestamptz not null,
  price  numeric not null,
  primary key (symbol, ts)
);

insert into public.assets (symbol,name,short,kind,region,unit,threshold,lon,lat,sort,description) values
 ('KOSPI',  '코스피',        '코스피',  'INDEX', 'KR','KRW',3,   68,92, 10,'코리아 반도 본진. 여기가 뚫리면 전군이 흔들린다'),
 ('005930', '삼성전자',      '삼성',    'STOCK', 'KR','KRW',5,   50,86, 11,'반도 북서쪽 요새. 국민 병사들의 집결지'),
 ('000660', 'SK하이닉스',    '하이닉스','STOCK', 'KR','KRW',5,   54,104, 12,'반도 남서쪽 HBM 포병대 주둔지'),
 ('KR3Y',   '한국 국채 3년', '국채3년', 'BOND',  'KR','PCT',0.10,84,84, 13,'반도 동쪽 해군기지 · 금리가 오르면 상승군 우세'),
 ('KR10Y',  '한국 국채 10년','국채10년','BOND',  'KR','PCT',0.10,84,102, 14,'반도 남동쪽 심해기지 · 장기전 전문'),
 ('JPYKRW', '엔/원 환율',    '엔/원',   'FX',    'JP','KRW',1,   30,74, 20,'해협 서쪽 엔화 섬. 100엔당 원, 오르면 엔화 강세'),
 ('USDKRW', '원/달러 환율',  '원/달러', 'FX',    'KR','KRW',1,   62,62, 21,'환율 해협의 관문 섬. 오르면 달러 강세'),
 ('BTCUSDT','비트코인',      '비트',    'CRYPTO','CRYPTO','USD',5,  74,13, 30,'크립토 공중섬 사령부. 24시간 교전 중'),
 ('ETHUSDT','이더리움',      '이더',    'CRYPTO','CRYPTO','USD',6,  90,24, 31,'공중섬 제2기지'),
 ('SPX',    'S&P 500',       'S&P',     'INDEX', 'US','USD',2.5, 28,38, 40,'아메리카 대륙 본진'),
 ('NVDA',   '엔비디아',      '엔비',    'STOCK', 'US','USD',6,   14,22, 41,'대륙 서부 GPU 기갑사단'),
 ('TSLA',   '테슬라',        '테슬라',  'STOCK', 'US','USD',7,   14,52, 42,'대륙 남서부 사막 로켓 기지. 변동성 최강'),
 ('US2Y',   '미국 국채 2년', '美2년',   'BOND',  'US','PCT',0.10,40,20, 43,'대륙 동쪽 함대 · 연준 눈치 전문'),
 ('US10Y',  '미국 국채 10년','美10년',  'BOND',  'US','PCT',0.10,42,52, 44,'대륙 남동쪽 주력함대 · 전 세계 금리의 기준');

-- ---------------------------------------------------------------- people
create table public.profiles (
  id              uuid primary key references auth.users on delete cascade,
  nickname        text not null unique check (char_length(nickname) between 2 and 12),
  flag_art        text,
  is_admin        boolean not null default false,
  banned_until    timestamptz,
  last_post_at    timestamptz,
  last_comment_at timestamptz,
  last_battle_at  timestamptz,
  last_art_at     timestamptz,
  created_at      timestamptz not null default now()
);

create table public.pixel_arts (
  id          text primary key default 'f' || substr(md5(random()::text), 1, 10),
  author_id   uuid references public.profiles on delete set null,
  author_name text not null,
  title       text not null check (char_length(title) between 1 and 12),
  px          text not null check (char_length(px) = 1024 and px ~ '^[0-9a-f.]+$'),
  uses_count  int not null default 0,
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- war reports (posts)
create table public.posts (
  id            uuid primary key default gen_random_uuid(),
  symbol        text not null references public.assets on delete cascade,
  author_id     uuid not null references public.profiles on delete cascade,
  title         text not null check (char_length(title) between 1 and 60),
  body          text not null default '' check (char_length(body) <= 2000),
  side          text check (side in ('UP','DOWN')),
  entry_price   numeric,
  window_min    int,
  settle_at     timestamptz,
  result        text check (result in ('WIN','LOSE')),
  settled_price numeric,
  poll          text[],
  poll_counts   int[],
  meme_url      text,
  rx_charge     int not null default 0,
  rx_shield     int not null default 0,
  rx_flag       int not null default 0,
  rx_medal      int not null default 0,
  comment_count int not null default 0,
  reports       int not null default 0,
  is_hidden     boolean not null default false,
  created_at    timestamptz not null default now()
);
create index posts_symbol_time on public.posts (symbol, created_at desc);
create index posts_time on public.posts (created_at desc);
create index posts_author on public.posts (author_id, created_at desc);
create index posts_unsettled on public.posts (settle_at) where side is not null and result is null;

create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts on delete cascade,
  author_id  uuid not null references public.profiles on delete cascade,
  body       text not null check (char_length(body) between 1 and 200),
  reports    int not null default 0,
  is_hidden  boolean not null default false,
  created_at timestamptz not null default now()
);
create index comments_post on public.comments (post_id, created_at);

create table public.reactions (
  post_id uuid not null references public.posts on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  kind    text not null check (kind in ('charge','shield','flag','medal')),
  primary key (post_id, user_id, kind)
);

create table public.poll_votes (
  post_id      uuid not null references public.posts on delete cascade,
  user_id      uuid not null references public.profiles on delete cascade,
  option_index int not null,
  primary key (post_id, user_id)
);

-- ---------------------------------------------------------------- showdowns (user-made A/B battles)
create table public.battles (
  id             uuid primary key default gen_random_uuid(),
  creator_id     uuid references public.profiles on delete set null,
  symbol         text not null references public.assets on delete cascade,
  question       text not null check (char_length(question) between 4 and 60),
  option_a       text not null check (char_length(option_a) between 1 and 12),
  option_b       text not null check (char_length(option_b) between 1 and 12),
  rule           jsonb not null,
  closes_at      timestamptz not null,
  resolves_at    timestamptz not null,
  status         text not null default 'OPEN' check (status in ('OPEN','CLOSED','RESOLVED','VOID')),
  winning_option text check (winning_option in ('A','B')),
  close_price    numeric,
  resolve_price  numeric,
  is_system      boolean not null default false,
  created_at     timestamptz not null default now()
);
create index battles_status on public.battles (status, closes_at);

create table public.battle_entries (
  battle_id  uuid not null references public.battles on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  option     text not null check (option in ('A','B')),
  created_at timestamptz not null default now(),
  primary key (battle_id, user_id)
);

-- ---------------------------------------------------------------- moderation
create table public.reports (
  id          bigserial primary key,
  reporter_id uuid not null references public.profiles on delete cascade,
  target_type text not null check (target_type in ('post','comment','art')),
  target_id   text not null,
  reason      text not null,
  created_at  timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)
);

-- ---------------------------------------------------------------- contrarian index
create table public.daily_snap (
  symbol text not null references public.assets on delete cascade,
  day    date not null,
  price  numeric not null,
  primary key (symbol, day)
);
create table public.front_daily (
  symbol   text not null references public.assets on delete cascade,
  day      date not null,
  majority text not null check (majority in ('UP','DOWN')),
  defeated boolean not null,
  primary key (symbol, day)
);

-- ================================================================ RLS: read-only for clients
alter table public.assets         enable row level security;
alter table public.quote_history  enable row level security;
alter table public.profiles       enable row level security;
alter table public.pixel_arts     enable row level security;
alter table public.posts          enable row level security;
alter table public.comments       enable row level security;
alter table public.reactions      enable row level security;
alter table public.poll_votes     enable row level security;
alter table public.battles        enable row level security;
alter table public.battle_entries enable row level security;
alter table public.reports        enable row level security;
alter table public.daily_snap     enable row level security;
alter table public.front_daily    enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false)
$$;

create policy read_all on public.assets         for select using (true);
create policy read_all on public.quote_history  for select using (true);
create policy read_all on public.profiles       for select using (true);
create policy read_all on public.battles        for select using (true);
create policy read_all on public.battle_entries for select using (true);
create policy read_all on public.front_daily    for select using (true);
create policy read_all on public.reactions      for select using (true);
create policy read_vis on public.pixel_arts for select using (not is_hidden or author_id = auth.uid() or public.is_admin());
create policy read_vis on public.posts      for select using (not is_hidden or author_id = auth.uid() or public.is_admin());
create policy read_vis on public.comments   for select using (not is_hidden or author_id = auth.uid() or public.is_admin());
create policy read_own on public.poll_votes for select using (user_id = auth.uid());
create policy read_adm on public.reports    for select using (public.is_admin());

-- ================================================================ helpers
create or replace function public._check_text(t text) returns void
language plpgsql immutable as $$
declare w text;
begin
  foreach w in array array['리딩방','수익보장','원금보장','급등주추천','시발','ㅅㅂ','씨발','병신'] loop
    if position(w in coalesce(t,'')) > 0 then
      raise exception '금칙어가 있어요: "%"', w;
    end if;
  end loop;
  if coalesce(t,'') ~* '(open\.kakao\.com|t\.me/|telegram\.me|telegram\.org|discord\.gg)' then
    raise exception '오픈채팅·텔레그램 링크는 올릴 수 없어요 (리딩방 차단)';
  end if;
end $$;

create or replace function public._me() returns public.profiles
language plpgsql security definer set search_path = public as $$
declare p profiles;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  select * into p from profiles where id = auth.uid() for update;
  if not found then raise exception '먼저 병사 이름을 정해 주세요'; end if;
  if p.banned_until is not null and p.banned_until > now() then
    raise exception '영창 중이에요 (% 까지)', to_char(p.banned_until at time zone 'Asia/Seoul', 'MM/DD HH24:MI');
  end if;
  return p;
end $$;

-- ================================================================ client RPCs
create or replace function public.set_nickname(nick text) returns public.profiles
language plpgsql security definer set search_path = public as $$
declare p profiles;
begin
  if auth.uid() is null then raise exception '로그인이 필요해요'; end if;
  nick := btrim(nick);
  if char_length(nick) not between 2 and 12 then raise exception '이름은 2~12자'; end if;
  if nick !~ '^[0-9A-Za-z가-힣_]+$' then raise exception '이름은 한글·영문·숫자·_ 만 쓸 수 있어요'; end if;
  perform _check_text(nick);
  begin
    insert into profiles (id, nickname) values (auth.uid(), nick)
      on conflict (id) do update set nickname = excluded.nickname
      returning * into p;
  exception when unique_violation then
    raise exception '이미 있는 이름이에요';
  end;
  return p;
end $$;

create or replace function public.create_post(
  p_symbol text, p_title text, p_body text, p_side text, p_window int, p_poll text[], p_meme_url text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles; a assets; v_id uuid; v_poll text[];
begin
  me := _me();
  if me.last_post_at > now() - interval '30 seconds' then raise exception '도배 방지: 전황 보고는 30초에 1개'; end if;
  select * into a from assets where symbol = p_symbol;
  if not found then raise exception '없는 전선이에요'; end if;
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
  if p_side is not null then
    if p_side not in ('UP','DOWN') then raise exception '진영은 상승군/하락군 중 하나'; end if;
    if p_window not in (10, 60, 1440) then raise exception '판정 시간은 10분·1시간·24시간'; end if;
    if a.price is null or a.updated_at < now() - interval '10 minutes' then
      raise exception '지금은 시세가 안 들어와서 참전할 수 없어요';
    end if;
  end if;
  insert into posts (symbol, author_id, title, body, side, entry_price, window_min, settle_at, poll, poll_counts, meme_url)
  values (p_symbol, me.id, p_title, p_body, p_side,
          case when p_side is not null then a.price end,
          case when p_side is not null then p_window end,
          case when p_side is not null then now() + make_interval(mins => p_window) end,
          v_poll, case when v_poll is not null then array_fill(0, array[array_length(v_poll,1)]) end,
          p_meme_url)
  returning id into v_id;
  update profiles set last_post_at = now() where id = me.id;
  return v_id;
end $$;

create or replace function public.add_comment(p_post uuid, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles; v_id uuid;
begin
  me := _me();
  if me.last_comment_at > now() - interval '10 seconds' then raise exception '도배 방지: 댓글은 10초에 1개'; end if;
  p_body := btrim(coalesce(p_body,''));
  if p_body = '' or char_length(p_body) > 200 then raise exception '댓글은 1~200자'; end if;
  perform _check_text(p_body);
  if not exists (select 1 from posts where id = p_post and not is_hidden) then raise exception '없는 글이에요'; end if;
  insert into comments (post_id, author_id, body) values (p_post, me.id, p_body) returning id into v_id;
  update posts set comment_count = comment_count + 1 where id = p_post;
  update profiles set last_comment_at = now() where id = me.id;
  return v_id;
end $$;

create or replace function public.toggle_reaction(p_post uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me profiles; v_on boolean; v_n int;
begin
  me := _me();
  if p_kind not in ('charge','shield','flag','medal') then raise exception '없는 반응이에요'; end if;
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

create or replace function public.vote(p_post uuid, p_index int) returns int[]
language plpgsql security definer set search_path = public as $$
declare me profiles; v_n int; v_counts int[];
begin
  me := _me();
  select array_length(poll, 1) into v_n from posts where id = p_post;
  if v_n is null then raise exception '투표가 없는 글이에요'; end if;
  if p_index < 0 or p_index >= v_n then raise exception '없는 선택지예요'; end if;
  begin
    insert into poll_votes (post_id, user_id, option_index) values (p_post, me.id, p_index);
  exception when unique_violation then raise exception '이미 투표했어요'; end;
  update posts set poll_counts[p_index + 1] = poll_counts[p_index + 1] + 1 where id = p_post returning poll_counts into v_counts;
  return v_counts;
end $$;

create or replace function public.create_battle(
  p_symbol text, p_question text, p_a text, p_b text, p_type text, p_value numeric, p_close_min int, p_resolve_min int
) returns uuid
language plpgsql security definer set search_path = public as $$
declare me profiles; a assets; v_id uuid; v_rule jsonb;
begin
  me := _me();
  if me.last_battle_at > now() - interval '2 minutes' then raise exception '결전은 2분에 1개만 열 수 있어요'; end if;
  select * into a from assets where symbol = p_symbol;
  if not found then raise exception '없는 전선이에요'; end if;
  perform _check_text(p_question || ' ' || p_a || ' ' || p_b);
  if p_close_min not between 2 and 10080 then raise exception '마감은 2분~7일 뒤'; end if;
  if p_resolve_min not between 1 and 1440 then raise exception '판정은 마감 후 1분~24시간'; end if;
  if p_type = 'PRICE_ABOVE' then
    if p_value is null or p_value <= 0 then raise exception '기준값을 넣어 주세요'; end if;
    v_rule := jsonb_build_object('type', 'PRICE_ABOVE', 'value', p_value);
  elsif p_type = 'CHANGE_UP' then
    v_rule := jsonb_build_object('type', 'CHANGE_UP');
  else raise exception '판정 규칙은 두 가지 중 하나'; end if;
  insert into battles (creator_id, symbol, question, option_a, option_b, rule, closes_at, resolves_at)
  values (me.id, p_symbol, btrim(p_question), btrim(p_a), btrim(p_b), v_rule,
          now() + make_interval(mins => p_close_min), now() + make_interval(mins => p_close_min + p_resolve_min))
  returning id into v_id;
  update profiles set last_battle_at = now() where id = me.id;
  return v_id;
end $$;

create or replace function public.join_battle(p_battle uuid, p_option text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles; b battles;
begin
  me := _me();
  select * into b from battles where id = p_battle;
  if not found then raise exception '없는 결전이에요'; end if;
  if b.status <> 'OPEN' or b.closes_at <= now() then raise exception '이미 마감됐어요'; end if;
  if b.creator_id = me.id then raise exception '내가 연 결전엔 참전할 수 없어요 (조작 방지)'; end if;
  if p_option not in ('A','B') then raise exception 'A 또는 B'; end if;
  begin
    insert into battle_entries (battle_id, user_id, option) values (p_battle, me.id, p_option);
  exception when unique_violation then raise exception '이미 참전했어요'; end;
end $$;

create or replace function public.save_flag(p_title text, p_px text) returns text
language plpgsql security definer set search_path = public as $$
declare me profiles; v_id text;
begin
  me := _me();
  if me.last_art_at > now() - interval '20 seconds' then raise exception '깃발은 20초에 1개'; end if;
  p_title := btrim(coalesce(p_title,''));
  if p_title = '' then p_title := '이름 없는 깃발'; end if;
  perform _check_text(p_title);
  if char_length(coalesce(p_px,'')) <> 1024 or p_px !~ '^[0-9a-f.]+$' or p_px ~ '^\.+$' then raise exception '그림이 비어 있어요'; end if;
  insert into pixel_arts (author_id, author_name, title, px) values (me.id, me.nickname, left(p_title, 12), p_px) returning id into v_id;
  update profiles set last_art_at = now() where id = me.id;
  return v_id;
end $$;

create or replace function public.use_flag(p_art text) returns void
language plpgsql security definer set search_path = public as $$
declare me profiles;
begin
  me := _me();
  if not exists (select 1 from pixel_arts where id = p_art and not is_hidden) then raise exception '없는 깃발이에요'; end if;
  update profiles set flag_art = p_art where id = me.id;
  update pixel_arts set uses_count = uses_count + 1 where id = p_art and author_id is distinct from me.id;
end $$;

create or replace function public.report(p_type text, p_id text, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare me profiles; v_n int;
begin
  me := _me();
  if p_type not in ('post','comment','art') then raise exception '신고 대상이 올바르지 않아요'; end if;
  begin
    insert into reports (reporter_id, target_type, target_id, reason) values (me.id, p_type, p_id, left(p_reason, 40));
  exception when unique_violation then raise exception '이미 신고했어요'; end;
  select count(*) into v_n from reports where target_type = p_type and target_id = p_id;
  if p_type = 'post' then update posts set reports = v_n, is_hidden = is_hidden or v_n >= 3 where id = p_id::uuid;
  elsif p_type = 'comment' then update comments set reports = v_n, is_hidden = is_hidden or v_n >= 3 where id = p_id::uuid;
  else update pixel_arts set is_hidden = is_hidden or v_n >= 3 where id = p_id; end if;
  return v_n;
end $$;

create or replace function public.admin_moderate(p_type text, p_id text, p_action text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception '관리자만 할 수 있어요'; end if;
  if p_action = 'clear' then delete from reports where target_type = p_type and target_id = p_id; end if;
  if p_type = 'post' then
    update posts set is_hidden = (p_action = 'hide'), reports = case when p_action = 'clear' then 0 else reports end where id = p_id::uuid;
  elsif p_type = 'comment' then
    update comments set is_hidden = (p_action = 'hide'), reports = case when p_action = 'clear' then 0 else reports end where id = p_id::uuid;
  else
    update pixel_arts set is_hidden = (p_action = 'hide') where id = p_id;
  end if;
end $$;

create or replace function public.admin_ban(p_user uuid, p_hours int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception '관리자만 할 수 있어요'; end if;
  update profiles set banned_until = case when p_hours > 0 then now() + make_interval(hours => p_hours) end where id = p_user;
end $$;

create or replace function public.soldier_stats(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'wins',     (select count(*) from posts where author_id = p_user and result = 'WIN'),
    'total',    (select count(*) from posts where author_id = p_user and result is not null),
    'pending',  (select count(*) from posts where author_id = p_user and side is not null and result is null),
    'b_wins',   (select count(*) from battle_entries e join battles b on b.id = e.battle_id
                  where e.user_id = p_user and b.status = 'RESOLVED' and e.option = b.winning_option),
    'b_total',  (select count(*) from battle_entries e join battles b on b.id = e.battle_id
                  where e.user_id = p_user and b.status = 'RESOLVED'))
$$;

-- army sizes on each front over the last 24h, for the map and gauges
create or replace function public.front_forces() returns table (symbol text, up int, down int)
language sql stable security definer set search_path = public as $$
  select a.symbol,
         count(*) filter (where p.side = 'UP')::int,
         count(*) filter (where p.side = 'DOWN')::int
  from assets a left join posts p on p.symbol = a.symbol and p.created_at > now() - interval '24 hours' and not p.is_hidden
  group by a.symbol
$$;

-- ================================================================ server-only jobs
create or replace function public.apply_quotes(q jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0; ts timestamptz := now();
begin
  for r in select * from jsonb_array_elements(q) loop
    update assets set price = (r->>'price')::numeric, change = (r->>'change')::numeric,
      change_pct = (r->>'change_pct')::numeric, market_open = (r->>'market_open')::boolean,
      delayed = coalesce((r->>'delayed')::boolean, true), source = r->>'source', updated_at = ts,
      flows = coalesce(r->'flows', flows), flows_at = case when r ? 'flows' then ts else flows_at end
    where symbol = r->>'symbol';
    if found then
      insert into quote_history (symbol, ts, price) values (r->>'symbol', ts, (r->>'price')::numeric) on conflict do nothing;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.settle() returns void
language plpgsql security definer set search_path = public as $$
declare r record; a assets; v_win text; sys_open int;
begin
  -- 1) score war reports
  for r in select * from posts where side is not null and result is null and settle_at <= now() for update skip locked loop
    select * into a from assets where symbol = r.symbol;
    if a.price is null or a.updated_at < now() - interval '15 minutes' then continue; end if;
    update posts set settled_price = a.price,
      result = case when a.price = r.entry_price then 'LOSE'
                    when (r.side = 'UP') = (a.price > r.entry_price) then 'WIN' else 'LOSE' end
    where id = r.id;
  end loop;
  -- 2) close showdowns
  update battles bt set status = 'CLOSED', close_price = q.price
  from assets q where q.symbol = bt.symbol and bt.status = 'OPEN' and bt.closes_at <= now();
  -- 3) resolve showdowns
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
  -- 4) keep one HQ showdown always open on the crypto island
  select count(*) into sys_open from battles where is_system and status = 'OPEN';
  if sys_open = 0 then
    insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system)
    values ('BTCUSDT', '사령부 결전: 비트코인, 마감 후 10분 동안 오를까?', '상승군 승', '하락군 승',
            '{"type":"CHANGE_UP"}', now() + interval '10 minutes', now() + interval '20 minutes', true);
  end if;
  -- 5) trim history
  delete from quote_history where ts < now() - interval '26 hours';
end $$;

-- runs once a day just after midnight KST: snapshot prices, then judge the day before yesterday
create or replace function public.daily_job() returns void
language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Seoul')::date; d date := today - 2; r record; up_wins boolean;
begin
  insert into daily_snap (symbol, day, price)
  select symbol, today, price from assets where price is not null
  on conflict (symbol, day) do update set price = excluded.price;
  for r in
    select p.symbol,
           count(*) filter (where p.side = 'UP') u, count(*) filter (where p.side = 'DOWN') dn
    from posts p
    where p.side is not null and (p.created_at at time zone 'Asia/Seoul')::date = d
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
end $$;

-- lock down: helpers and jobs are not callable by clients
revoke execute on function public._me(), public.apply_quotes(jsonb), public.settle(), public.daily_job() from public, anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to anon, authenticated;

-- ================================================================ storage: propaganda posters
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('posters', 'posters', true, 2097152, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

create policy posters_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'posters' and (storage.foldername(name))[1] = auth.uid()::text);

-- ================================================================ realtime
alter publication supabase_realtime add table public.assets, public.comments, public.posts, public.battle_entries, public.battles;
