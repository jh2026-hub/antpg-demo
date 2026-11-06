# 시세 전쟁 놀이 (demo)

A fun-only war game on top of real market data. Price moves are armies: when a market rises the
**상승군 (red)** pushes the front, when it falls the **하락군 (blue)** does. No points, no money.

- Fantasy world map: 아메리카 대륙, 코리아 반도, 환율 해협, 크립토 공중섬 — every asset is a territory
  colored by who controls it today
- 14 fronts: KOSPI, Samsung, SK hynix, S&P 500, NVIDIA, Tesla, BTC, ETH, KR 3Y/10Y, US 2Y/10Y, USD/KRW, JPY/KRW
- Battle scene per territory, investor flows (foreign / institution / retail for KR, taker buy/sell for crypto)
- Soldiers pick a side with a 10m / 1h / 24h window; the server scores it with real prices; ranks from record
- User-declared A/B showdowns, war reports, comments (realtime), polls, reactions, pixel flags, propaganda posters
- Reports auto-hide at 3, link and banned-word filters, admin view

Stack: static page on GitHub Pages + Supabase (Postgres with RLS, anonymous auth, realtime, storage,
pg_cron, one Edge Function `quotes-sync` that pulls Binance / Yahoo / Naver every minute).

Not investment advice.
