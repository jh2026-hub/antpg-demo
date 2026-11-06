-- The map is now one continent: rename the place names in territory descriptions.
update public.assets set description = case symbol
  when 'KOSPI'   then '코리아 지방 본진. 여기가 뚫리면 전군이 흔들린다'
  when '005930'  then '코리아 서쪽 요새. 국민 병사들의 집결지'
  when '000660'  then '코리아 남서쪽 HBM 포병대 주둔지'
  when 'KR3Y'    then '코리아 동쪽 해군기지 · 금리가 내리면(채권 강세) 상승군 우세'
  when 'KR10Y'   then '코리아 남동쪽 심해기지 · 장기전 전문 · 금리↓ = 채권 강세 = 상승군'
  when 'USDKRW'  then '환율 협곡의 관문. 오르면 달러 강세'
  when 'JPYKRW'  then '환율 협곡 남쪽 엔화 마을. 100엔당 원, 오르면 엔화 강세'
  when 'BTCUSDT' then '크립토 고원 사령부. 24시간 교전 중'
  when 'ETHUSDT' then '크립토 고원 제2기지'
  when 'SPX'     then '아메리카 지방 본진'
  when 'NVDA'    then '아메리카 서부 GPU 기갑사단'
  when 'TSLA'    then '아메리카 남서부 사막 로켓 기지. 변동성 최강'
  when 'US2Y'    then '아메리카 북동쪽 함대 · 연준 눈치 전문 · 금리↓ = 채권 강세 = 상승군'
  when 'US10Y'   then '아메리카 동남쪽 주력함대 · 전 세계 금리의 기준 · 금리↓ = 채권 강세 = 상승군'
  else description end
where not frontier;
