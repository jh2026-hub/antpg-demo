-- bots may share a mood too (clearly labeled; excluded from today's mood stats)
create or replace function public.bot_share_mood(p_bot uuid, p_mood text, p_symbol text, p_body text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from profiles where id = p_bot and is_bot) then raise exception 'not a bot'; end if;
  if p_mood not in ('rekt','empty','unfair','meh','held','won') then raise exception 'bad mood'; end if;
  if p_symbol is not null and not exists (select 1 from assets where symbol = p_symbol and active) then p_symbol := null; end if;
  insert into moods (author_id, mood, symbol, body) values (p_bot, p_mood, p_symbol, left(coalesce(p_body, ''), 200)) returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.bot_share_mood(uuid, text, text, text) from public, anon, authenticated;
