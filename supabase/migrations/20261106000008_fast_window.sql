-- allow a 3-minute window so calls resolve fast
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
    if p_window not in (3, 10, 60, 1440) then raise exception '판정 시간은 3분·10분·1시간·24시간'; end if;
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
