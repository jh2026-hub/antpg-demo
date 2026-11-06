// Bots for "오늘 장 어땠어?". Runs every 5 minutes (pg_cron, x-cron-secret).
// - comment on fresh user moods (토닥 / 같이 웃기 / 축하), one persona per mood, sometimes a second
// - share a mood themselves when the market makes a big move, or when the room has been quiet
// - chat under each other's moods so the feed feels alive
// No AI and no cost: every line is picked from sentence banks and filled with live numbers.
// Bot posts are labeled in the UI and excluded from today's mood stats.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { L } from './lines.ts';

type Asset = { symbol: string; name: string; short: string; kind: string; region: string; price: number | null; change_pct: number | null; market_open: boolean | null };
type Task = { id: string; kind: 'mood' | 'comment'; bot: string; mood?: string; symbol?: string | null; mood_id?: string; body: string; log: string[] };

const MAX_MOODS = 2, MAX_COMMENTS = 8, DAILY_MOOD_CAP = 40;
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const shuffle = <T>(a: T[]) => a.slice().sort(() => Math.random() - .5);
const kst = () => new Date(Date.now() + 9 * 3600e3);
const kDate = () => kst().toISOString().slice(0, 10);
const CRISIS = /죽고\s*싶|자살|극단적\s*선택|사라지고\s*싶|살기\s*싫|다\s*끝내고\s*싶/;
const OLD_WAR = /병영|동지|전사|패전|승전|진영|전투|척살|포로|기원 접수|촛불|참여|판정/;   // lines written for the retired board

// ---------------------------------------------------------------- Korean helpers ({name|이가} → 코스피가)
function hasBatchim(w: string) {
  const ch = w.trim().slice(-1), c = ch.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 !== 0;
  return /[0-9lmnLMN]$/.test(ch) && !/[2459]$/.test(ch);
}
function fill(s: string, v: Record<string, string>) {
  return s.replace(/\{(\w+)(?:\|(\S+?))?\}/g, (_, k, p) => {
    const w = v[k] ?? ''; if (!p) return w;
    const [a, b] = ({ 이가: ['이', '가'], 은는: ['은', '는'], 을를: ['을', '를'], 과와: ['과', '와'], 으로: ['으로', '로'] } as Record<string, string[]>)[p] || ['', ''];
    return w + (hasBatchim(w) ? a : b);
  }).replace(/\s{2,}/g, ' ').trim();
}
const fmtC = (a: Asset) => `${+(a.change_pct || 0) > 0 ? '+' : ''}${(+(a.change_pct || 0)).toFixed(2)}%`;
const vars = (a?: Asset): Record<string, string> => a ? { name: a.name, short: a.short, chg: fmtC(a) } : {};

// ---------------------------------------------------------------- sentence banks
// comments under a user's mood, by mood. {name}/{chg} only used when the mood names a ticker.
const CM: Record<string, string[]> = {
  rekt: ['털린 사람 여기 한 명 추가요. 같이 줄 서요 🫠', '계좌가 파란 건 하늘을 닮아서예요. 넓은 마음으로…', '오늘 털린 거 내일의 나한테 맡깁시다.', '손실은 일시적, 이 글은 영원. 기록 남겨 줘서 고마워요.', '괜찮아요, 시장도 가끔 실수해요. 거의 매일이지만.', '저도 오늘 앱 열었다가 바로 닫았어요 🤝', '{name} {chg}… 그 와중에 글 남긴 멘탈 인정합니다.', '{name|이가} 오늘 좀 너무했네요. 대신 사과드립니다.'],
  empty: ['허탈할 땐 치킨이 국룰입니다 🍗', '멍때리기 대회 나가면 오늘 우승각이에요.', '차트 보지 말고 하늘 한번 봐요. 하늘은 안 빠져요.', '그 기분 알아요. 화면만 쳐다보다 하루 끝나는 느낌.', '허탈함은 반으로 나누면 반이 된대요. 저 반 가져갈게요.', '{name} {chg}… 할 말을 잃게 만드는 숫자네요.'],
  unfair: ['억울한 건 당연해요. 시장이 나만 피해 간 거 맞아요.', '판 날 오르고 산 날 내리는 거, 과학적으로 증명된 현상이에요.', '시장한테 정식으로 항의서 넣어 드릴게요. 답장은 안 와요.', '억울하면 샌드백 한 대 치고 오세요 🥊', '{name}, 왜 하필 오늘이야. 같이 따져 줄게요.', '내가 사면 고점, 팔면 저점. 오늘도 법칙 성립.'],
  meh: ['그냥저냥이 제일 좋은 날이에요. 진짜로.', '무난한 하루, 계좌도 무난하길.', '평화로운 날엔 커피나 한 잔 ☕', '아무 일 없는 게 제일 큰 일이죠.', '오늘은 시장도 나도 졸린 날.'],
  held: ['버틴 게 제일 어려운 거예요. 오늘의 MVP 👏', '멘탈 근육 +1 획득!', '흔들려도 안 판 손가락, 칭찬합니다.', '버티는 사람이 결국 웃더라고요. 대체로요.', '{name} {chg}에도 버티셨다니, 존경합니다.'],
  won: ['축하해요! 근데 너무 크게 웃으면 옆 사람이 울어요 😂', '벌었으면 오늘 밥은 그쪽이 사는 걸로.', '부럽다… 진심 반, 질투 반.', '이 기세 그대로 겸손 유지! 🙏', '{name} {chg}! 오늘은 당신이 주인공.', '자랑은 적당히, 치킨은 넉넉히 🍗'],
};
// persona pools per mood, and which of their own slots fit
const POOL: Record<string, string[]> = {
  rekt: ['grandma', 'cynic', 'optimist', 'ramen', 'salaryman', 'doomer'], empty: ['grandma', 'ramen', 'salaryman', 'cynic', 'optimist'],
  unfair: ['cynic', 'contra', 'salaryman', 'ramen', 'grandma'], meh: ['salaryman', 'ramen', 'grandma', 'cynic', 'seer'],
  held: ['grandma', 'optimist', 'salaryman', 'chartist', 'meter'], won: ['optimist', 'grandma', 'cynic', 'degen', 'salaryman', 'contra'],
};
const SLOT: Record<string, string[]> = { rekt: ['vent', 'lose'], empty: ['vent'], unfair: ['vent', 'lose'], meh: ['chat'], held: ['win', 'chat'], won: ['win'] };

// moods bots post on a big move
const MOVE: Record<string, string[]> = {
  down: ['{name} {chg}. 오늘 다들 괜찮아요? 저는 아니에요.', '{name|이가} {chg}… 앱 지울까 고민 중', '{chg} 실화인가요 {name}', '{name} {chg}. 오늘 저녁은 라면입니다.', '{name|이가} 오늘 {chg}. 할 말은 많지만 하지 않겠습니다.'],
  up: ['{name} {chg}! 오늘만큼은 내가 천재', '{name|이가} {chg}… 이게 무슨 일이죠', '{name} {chg}. 근데 왜 내 계좌는 그대로죠?', '{chg} 찍은 {name}, 오늘 치킨 각', '{name|이가} {chg}. 겸손하게 기뻐하는 중'],
};
// bot-to-bot chatter under bot moods
const BANTER = ['ㅋㅋㅋ 공감 100%', '저도요… 🫠', '이분 매일 이래요', '오늘도 한 명 추가', '그래도 버텨 봐요', '내일은 다를 거예요. 아마도.'];

function personaLine(who: string, mood: string, v: Record<string, string>, hasSym: boolean) {
  const own = (SLOT[mood] || []).flatMap(s => L[who]?.[s] || []);
  const bank = [...CM[mood], ...own].filter(s => !OLD_WAR.test(s) && (hasSym || !s.includes('{')));
  return bank.length ? fill(pick(bank), v) : null;
}

// ---------------------------------------------------------------- main
Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now(), date = kDate(), hour = kst().getUTCHours();
  const ago = (min: number) => new Date(now - min * 60e3).toISOString();

  const [{ data: assets }, { data: bots }, { data: recent }, { data: moods }] = await Promise.all([
    sb.from('assets').select('symbol,name,short,kind,region,price,change_pct,market_open').eq('active', true),
    sb.from('profiles').select('id,bot_role').eq('is_bot', true),
    sb.from('bot_log').select('key,at').gte('at', ago(60 * 48)),
    sb.from('moods').select('id,mood,symbol,body,created_at,author:profiles!moods_author_id_fkey(is_bot,bot_role),comments:mood_comments(author:profiles!mood_comments_author_id_fkey(is_bot,bot_role))')
      .eq('is_hidden', false).gte('created_at', ago(24 * 60)).order('created_at', { ascending: false }).limit(200),
  ]);
  if (!assets || !bots) return new Response('no data', { status: 500 });
  const BOT: Record<string, string> = Object.fromEntries(bots.map(b => [b.bot_role, b.id]));
  const seen = new Set((recent || []).map(l => l.key));
  const A: Record<string, Asset> = Object.fromEntries((assets as Asset[]).map(a => [a.symbol, a]));
  const all = Object.values(A), ms = (moods || []) as any[];
  const botMoodsToday = ms.filter(m => m.author?.is_bot).length;

  const tasks: Task[] = [];
  const n = (k: string) => tasks.filter(t => t.kind === k).length;
  const addMood = (t: Omit<Task, 'kind'>) => { if (botMoodsToday + n('mood') < DAILY_MOOD_CAP && n('mood') < MAX_MOODS && !t.log.some(x => seen.has(x))) tasks.push({ ...t, kind: 'mood' }); };
  const addCmt = (t: Omit<Task, 'kind'>) => { if (n('comment') < MAX_COMMENTS && !t.log.some(x => seen.has(x))) tasks.push({ ...t, kind: 'comment' }); };

  // 1) comment on fresh user moods: first reply soon, a second one sometimes
  for (const m of ms) {
    if (m.author?.is_bot || Date.parse(m.created_at) < now - 90 * 60e3 || Date.parse(m.created_at) > now - 60e3) continue;
    if (CRISIS.test(m.body || '')) continue;          // no jokes there; the page shows help lines instead
    const botsIn = new Set(((m.comments || []) as any[]).filter(c => c.author?.is_bot).map(c => c.author.bot_role));
    if (botsIn.size >= 2 || (botsIn.size === 1 && Math.random() > .25) || (botsIn.size === 0 && Math.random() > .9)) continue;
    const a = m.symbol ? A[m.symbol] : undefined;
    for (const who of shuffle(POOL[m.mood] || POOL.meh)) {
      if (botsIn.has(who)) continue;
      const txt = personaLine(who, m.mood, vars(a), !!a); if (!txt) continue;
      addCmt({ id: `c-${m.id}-${who}`, bot: who, mood_id: m.id, body: txt, log: [`mc:${m.id}:${botsIn.size}`] }); break;
    }
  }

  // 2) big move → a persona shares a mood (first level and the extreme level, once a day each)
  for (const a of all.slice().sort((x, y) => Math.abs(+(y.change_pct || 0)) - Math.abs(+(x.change_pct || 0)))) {
    if (!a.market_open || a.price == null) continue;
    const c = +(a.change_pct || 0), steps = a.kind === 'INDEX' ? [2, 3.5, 5] : [3, 5, 8];
    const lvl = steps.filter(s => Math.abs(c) >= s).length;
    if (!lvl || lvl === 2) continue;
    const up = c > 0, who = up ? pick(a.kind === 'CRYPTO' ? ['degen', 'optimist'] : ['optimist', 'salaryman', 'chartist']) : pick(['doomer', 'ramen', 'salaryman', 'cynic']);
    addMood({ id: `mv-${a.symbol}`, bot: who, mood: up ? pick(['won', 'won', 'held']) : pick(['rekt', 'rekt', 'empty', 'unfair']), symbol: a.symbol,
      body: fill(pick(MOVE[up ? 'up' : 'down']), vars(a)), log: [`mmove:${a.symbol}:${date}:${lvl}`] });
    if (n('mood')) break;
  }

  // 3) quiet room (no mood in 40 min, 07–24시) → one persona says something
  {
    const last = ms[0] ? Date.parse(ms[0].created_at) : 0;
    if (hour >= 7 && last < now - 40 * 60e3 && !n('mood') && Math.random() < .6) {
      const avg = all.length ? all.reduce((s, a) => s + +(a.change_pct || 0), 0) / all.length : 0;
      const mood = avg <= -1.5 ? pick(['rekt', 'empty', 'unfair']) : avg >= 1.5 ? pick(['won', 'held']) : pick(['meh', 'meh', 'held', 'empty']);
      const who = pick(['grandma', 'cynic', 'ramen', 'salaryman', 'optimist', 'doomer', 'chartist', 'seer']);
      const bank = (L[who]?.idle || []).filter(s => !OLD_WAR.test(s) && !s.includes('{'));
      if (bank.length) addMood({ id: `idle-${who}`, bot: who, mood, symbol: null, body: pick(bank), log: [`midle:${date}:${hour}`] });
    }
  }

  // 4) bot-to-bot: someone chimes in under a recent bot mood
  for (const m of ms.filter(m => m.author?.is_bot && Date.parse(m.created_at) > now - 40 * 60e3).slice(0, 3)) {
    const done = new Set([m.author.bot_role, ...((m.comments || []) as any[]).map(c => c.author?.bot_role).filter(Boolean)]);
    if (done.size >= 3 || Math.random() > .5) continue;
    const who = shuffle(POOL[m.mood] || POOL.meh).find(b => !done.has(b)); if (!who) continue;
    const a = m.symbol ? A[m.symbol] : undefined;
    const txt = Math.random() < .3 ? pick(BANTER) : personaLine(who, m.mood, vars(a), !!a); if (!txt) continue;
    addCmt({ id: `b-${m.id}-${who}`, bot: who, mood_id: m.id, body: txt, log: [`mb:${m.id}:${who}`] });
  }

  // ---------------------------------------------------------------- write
  const wrote: string[] = [], errs: string[] = [], logRows: string[] = [];
  for (const t of tasks) {
    const bot = BOT[t.bot]; if (!bot) continue;
    try {
      const { error } = t.kind === 'mood'
        ? await sb.rpc('bot_share_mood', { p_bot: bot, p_mood: t.mood, p_symbol: t.symbol ?? null, p_body: t.body })
        : await sb.rpc('bot_mood_comment', { p_bot: bot, p_mood: t.mood_id, p_body: t.body });
      if (error) throw error;
      logRows.push(...t.log); wrote.push(t.id);
    } catch (e) { errs.push(`${t.id}: ${String((e as any)?.message || e).slice(0, 80)}`); }
  }
  if (logRows.length) await sb.from('bot_log').upsert(logRows.map(key => ({ key, val: null, at: new Date().toISOString() })));
  await sb.from('bot_log').delete().lt('at', ago(60 * 24 * 3)).not('key', 'like', 'state:%');
  return new Response(JSON.stringify({ wrote, errs: errs.length ? errs : undefined, samples: tasks.slice(0, 3).map(t => t.body) }), { headers: { 'content-type': 'application/json' } });
});
