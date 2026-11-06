-- Plain, playful descriptions now that the war theme is gone.
update public.assets set description = case symbol
  when 'BTCUSDT' then '코인판 대장. 주말도 새벽도 쉬지 않는다'
  when 'ETHUSDT' then '코인판 2인자. 대장 따라 웃고 운다'
  when 'SPX'     then '미국장 대표 선수. 전 세계가 이 숫자를 본다'
  when 'NVDA'    then 'AI 시대의 주인공. 하루에도 몇 번씩 롤러코스터'
  when 'TSLA'    then '변동성 끝판왕. 오늘도 누군가는 울고 누군가는 웃는다'
  when 'KOSPI'   then '국장 대표 선수. 여기가 흔들리면 다 흔들린다'
  when '005930'  then '국민 주식. 단톡방 단골 손님'
  when '000660'  then 'HBM 스타. 요즘 제일 말 많은 종목'
  else description end
where not frontier;
