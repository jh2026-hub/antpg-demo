-- Prayer taps, pooled the same way as sandbag punches (kind = 'pray').
alter table public.punches add constraint punches_kind_check check (kind in ('punch','pray'));
create or replace function public.tap(p_symbol text, p_kind text, p_n int) returns bigint
language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Seoul')::date; v bigint;
begin
  if p_n is null or p_n < 1 then return null; end if;
  if p_kind not in ('punch','pray') then raise exception '없는 동작이에요'; end if;
  p_n := least(p_n, 40);
  if not exists (select 1 from assets where symbol = p_symbol and active) then raise exception '없는 종목이에요'; end if;
  insert into punches (symbol, day, kind, count) values (p_symbol, d, p_kind, p_n)
  on conflict (symbol, day, kind) do update set count = punches.count + excluded.count
  returning count into v;
  return v;
end $$;
grant execute on function public.tap(text, text, int) to anon, authenticated;
