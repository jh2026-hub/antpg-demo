-- 52-week range per asset, refreshed by quotes-sync every ~6 hours.
-- The room turns into an ice age when the price sits near its 52-week low.
alter table public.assets add column if not exists low_52w numeric, add column if not exists high_52w numeric, add column if not exists range_at timestamptz;
