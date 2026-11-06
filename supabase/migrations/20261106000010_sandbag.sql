-- Sandbag: everyone punches today's worst (or most annoying) territory; hits are pooled per day.
create table public.punches (
  symbol text not null references public.assets on delete cascade,
  day    date not null,
  kind   text not null default 'punch',
  count  bigint not null default 0,
  primary key (symbol, day, kind)
);
alter table public.punches enable row level security;
create policy read_all on public.punches for select using (true);
grant select on public.punches to anon, authenticated;

-- callable without an account; each call adds at most 40 hits (clients batch their taps)
create or replace function public.punch(p_symbol text, p_n int) returns bigint
language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Seoul')::date; v bigint;
begin
  if p_n is null or p_n < 1 then return null; end if;
  p_n := least(p_n, 40);
  if not exists (select 1 from assets where symbol = p_symbol and active) then raise exception '없는 영토예요'; end if;
  insert into punches (symbol, day, kind, count) values (p_symbol, d, 'punch', p_n)
  on conflict (symbol, day, kind) do update set count = punches.count + excluded.count
  returning count into v;
  return v;
end $$;
grant execute on function public.punch(text, int) to anon, authenticated;

alter publication supabase_realtime add table public.punches;
