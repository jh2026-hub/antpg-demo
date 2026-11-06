-- War theme retired: plain wording for system showdowns and server messages.
update public.battles set option_a = '오른다', option_b = '안 오른다' where option_a = '상승군 승';
update public.battles set question = replace(replace(replace(question, '사령부 결전: ', ''), '영토 대결: ', '맞대결: '), '진영전, 상승군이', '판 대결, 상승파가') where status in ('OPEN','CLOSED');
create or replace function public._ensure_system_battles() returns void
language plpgsql security definer set search_path = public as $$
declare k timestamp := now() at time zone 'Asia/Seoul'; d date := (now() at time zone 'Asia/Seoul')::date;
        dow int := extract(isodow from (now() at time zone 'Asia/Seoul')); hm int := extract(hour from k) * 60 + extract(minute from k);
        p numeric;
begin
  if not exists (select 1 from battles where template = 'btc10' and status in ('OPEN','CLOSED')) then
    insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
    values ('BTCUSDT', '비트코인, 마감 후 10분 동안 오를까?', '오른다', '안 오른다', '{"type":"CHANGE_UP"}', now() + interval '10 minutes', now() + interval '20 minutes', true, 'btc10');
  end if;
  if not exists (select 1 from battles where template = 'btc_eth' and status in ('OPEN','CLOSED')) then
    insert into battles (symbol, other_symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
    values ('BTCUSDT', 'ETHUSDT', '맞대결: 1시간 동안 비트코인 vs 이더리움, 누가 더 오를까?', '비트코인', '이더리움', '{"type":"VERSUS","other":"ETHUSDT"}', now() + interval '10 minutes', now() + interval '70 minutes', true, 'btc_eth');
  end if;
  if not exists (select 1 from battles where template = 'btc_touch' and status in ('OPEN','CLOSED')) then
    select price into p from assets where symbol = 'BTCUSDT';
    if p is not null then
      insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
      values ('BTCUSDT', '1시간 안에 비트코인 ' || to_char(round(p * 1.01), 'FM$999,999,999') || ' (+1%) 터치할까?', '터치한다', '못 간다',
              jsonb_build_object('type', 'TOUCH_ABOVE', 'value', round(p * 1.01)), now() + interval '5 minutes', now() + interval '65 minutes', true, 'btc_touch');
    end if;
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
      values ('KOSPI', '오늘 외국인, 코스피를 순매수로 마칠까?', '사들인다', '팔아치운다', '{"type":"FLOW_BUY","group":"foreign"}',
              (d + time '09:00') at time zone 'Asia/Seoul', (d + time '15:50') at time zone 'Asia/Seoul', true, 'kospi_foreign');
    end if;
  end if;
  -- weekday US evening: NVDA vs TSLA through the session
  if dow between 1 and 5 and hm between 18 * 60 and 23 * 60 then
    if not exists (select 1 from battles where template = 'nvda_tsla' and created_at > (d::timestamp at time zone 'Asia/Seoul')) then
      insert into battles (symbol, other_symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
      values ('NVDA', 'TSLA', '맞대결: 오늘 밤 엔비디아 vs 테슬라, 누가 더 오를까?', '엔비디아', '테슬라', '{"type":"VERSUS","other":"TSLA"}',
              (d + time '23:20') at time zone 'Asia/Seoul', (d + 1 + time '06:10') at time zone 'Asia/Seoul', true, 'nvda_tsla');
    end if;
  end if;
  -- every day: which army wins today's scoreboard
  if hm between 10 and 11 * 60 then
    if not exists (select 1 from battles where template = 'army_day' and created_at > (d::timestamp at time zone 'Asia/Seoul')) then
      insert into battles (symbol, question, option_a, option_b, rule, closes_at, resolves_at, is_system, template)
      values ('KOSPI', '오늘 판 대결, 상승파가 이길까?', '상승파 승', '하락파 승 또는 무승부', '{"type":"ARMY_UP"}',
              (d + time '12:00') at time zone 'Asia/Seoul', (d + time '23:55') at time zone 'Asia/Seoul', true, 'army_day');
    end if;
  end if;
end $$;
revoke execute on function public._ensure_system_battles() from public, anon, authenticated;
