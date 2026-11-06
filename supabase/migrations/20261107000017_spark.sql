-- Today's price line per asset (≤48 points) for the pixel billboard in each room. Written by quotes-sync every 5 minutes.
alter table public.assets add column if not exists spark jsonb;
