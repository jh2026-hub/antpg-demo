// Operator bots. Runs every 5 minutes (pg_cron, x-cron-secret). Finds events (big moves, volume spikes,
// market open/close, showdown results, new territories, fresh user posts, lost calls), then writes short
// satirical war reports and comments as clearly-labeled bot accounts.
// Text comes from Claude when ANTHROPIC_API_KEY is set; otherwise (or on any failure) from templates.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { z } from 'npm:zod@3';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk/helpers/zod';

type Asset = { symbol: string; name: string; short: string; kind: string; threshold: number; price: number | null; change: number | null; change_pct: number | null; market_open: boolean | null; vol_ratio: number | null; frontier: boolean; added_at: string | null; active: boolean; flows: any };
type Task = { id: string; kind: 'post' | 'comment'; bot: string; symbol?: string; category?: string; post_id?: string; facts: string; reply_to?: string; fb: { title: string; body: string }; log: string[] };

const MAX_POSTS = 3, MAX_COMMENTS = 5;
const BANNED = ['리딩방', '수익보장', '원금보장', '시발', 'ㅅㅂ', '씨발', '병신', '매수하세요', '매도하세요', '사세요', '파세요'];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const kst = () => new Date(Date.now() + 9 * 3600e3);
const kDate = () => kst().toISOString().slice(0, 10);
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');

// ---------------------------------------------------------------- market helpers
const mv = (a: Asset) => a.kind === 'BOND' ? -(+(a.change || 0)) : +(a.change_pct || 0);
const ctl = (a: Asset) => Math.round(50 + 50 * Math.max(-1, Math.min(1, mv(a) / +a.threshold)));
const fmtC = (a: Asset) => a.kind === 'BOND' ? `금리 ${(+(a.change || 0) * 100 > 0 ? '+' : '')}${(+(a.change || 0) * 100).toFixed(1)}bp` : `${+(a.change_pct || 0) > 0 ? '+' : ''}${(+(a.change_pct || 0)).toFixed(2)}%`;
const side = (a: Asset) => mv(a) >= 0 ? '상승군' : '하락군';

// ---------------------------------------------------------------- templates (fallback voice)
const T: Record<string, string[]> = {
  move_up: ['[속보] {name} 전선 붕괴… 상승군이 {chg} 진격', '{name}, 상승군 탱크 {chg} 돌파. 하락군 참호는 텅 비었다', '{name} {chg}. 어제의 패잔병이 오늘의 영웅이 되는 그곳'],
  move_down: ['[속보] {name} {chg}… 하락군 포격에 요새가 흔들린다', '{name} {chg}. 상승군 지휘부 "전략적 후퇴일 뿐"', '{name} {chg}. 평단가라는 이름의 지뢰밭이 밟혔다'],
  move_body: ['{name} 전선이 {chg} 움직였다. 지금 상승군 점령률 {ctl}%. 존버 부대는 위치를 사수 중이라는데, 그 위치가 어딘지는 아무도 모른다.', '현재 {name} {chg}, 점령률 {ctl}%. 전문가들은 "오를 수도, 내릴 수도 있다"는 놀라운 분석을 내놨다.'],
  vol: ['{name} 거래량 평소의 {vr}배… 병력이 몰려든다', '{name}에 대규모 병력 집결. 거래량 {vr}배'],
  vol_body: ['{name}에 평소의 {vr}배 병력이 몰렸다. 누가 사고 누가 파는지는 모르지만, 확실한 건 다들 바쁘다는 것.', '거래량 {vr}배. 조용하던 {name} 마을에 갑자기 축제가 열렸다. 축제인지 피난인지는 내일 알게 된다.'],
  open: ['📯 {name} 전장 개방. 오늘도 개미 병력 투입 완료', '📯 {name} 장 시작. 커피 들고 참호로'],
  open_body: ['{name} 전장이 열렸다. 출발선 {chg}. 오늘의 작전명: "본전만 찾자".', '{name} 개장. 시작부터 {chg}. 각자 자리에서 기도를 시작해 주시기 바랍니다.'],
  close: ['🌙 {name} 휴전. 오늘의 성적표 {chg}', '🌙 {name} 장 마감 {chg}. 내일 다시 만나요'],
  close_body: ['{name} 오늘 {chg}로 휴전 돌입. {side}이 오늘의 승자. 패자는 저녁 메뉴로 위로받길.', '마감 {chg}. 오늘 하루도 수고 많았다, 병사들. 계좌는 수고하지 않았지만.'],
  brief: ['🗺 정시 전황 브리핑', '🗺 지금 전황 한눈에', '🗺 사령부 정기 보고'],
  brief_body: ['현재 세력도 상승군 {pw}%. 가장 뜨거운 곳은 {hot}. 사령부는 "상황을 예의주시 중"이라고 밝혔다. 늘 그렇듯.', '세력도 상승군 {pw}% 대 하락군 {pwd}%. 격전지: {hot}. 참전은 무료, 멘탈은 유료.'],
  contra: ['🎖 역지표 장군의 작전 명령', '🎖 장군 왈: 모두가 한쪽이면 반대가 정답'],
  contra_body: ['지금 병사들 다수가 {major} 쪽이다. 역사적으로 다수가 맞은 적이… 가끔 있긴 했다. 본 장군은 늘 그렇듯 반대편에서 홀로 서 있겠다.', '{major}이 우세하다는 소문이 돈다. 소문이 돌 때가 가장 위험한 법. 장군은 오늘도 거꾸로 걷는다.'],
  seer: ['🔮 오늘의 영토 운세', '🔮 도사가 본 오늘의 전장'],
  seer_body: ['{a}: 동쪽에서 귀인이 온다(아마 기관). {b}: 물을 조심하라(물타기). {c}: 오늘은 쉬는 것도 전략이다. 재미로만 보시오.', '{a}: 대길… 이라고 하면 떨어지겠지. {b}: 흉 속에 길. {c}: 운세보다 손절선. 재미로만 보시오.'],
  battle: ['📯 결전 결과: {q}', '📯 종전 발표: {q}'],
  battle_body: ['판정 결과 "{win}" 승리. 승자는 훈장을, 패자는 교훈을 챙기시오. 참전 {n}명.', '"{win}" 쪽이 이겼다. 참전 {n}명 중 절반은 오늘 밤 잠을 설치게 됐다.'],
  frontier: ['🚩 새 영토 개척: {name}', '🚩 {name} 땅에 깃발이 꽂혔다'],
  frontier_body: ['용감한 병사가 {name}에 깃발을 꽂았다. 첫 참전자에게는 아무것도 주어지지 않지만 명예는 있다.', '{name} 개척 완료. 지도에 새 땅이 생겼다. 이제 이 땅을 두고 싸울 차례.'],
  c_vent: ['토닥토닥. 계좌는 파랗지만 마음까지 파랄 필요는 없소.', '나도 거기 있었소. 같이 버팁시다, 전우여.', '물린 게 아니라 장기 투자로 전환된 거요. 그렇다고 해 둡시다.'],
  c_wish: ['🔮 기원 접수. 하늘이 바쁘시니 순번대로 처리될 예정.', '🔮 촛불 하나 보탠다. 효과는 장담 못 함.'],
  c_call: ['확신에 찬 참전, 보기 좋소. 시장이 이 확신을 알아줄지는 별개요.', '다수가 그쪽이면 장군은 반대로 가겠소. 행운을.', '그 근거, 차트에서 왔소 꿈에서 왔소?'],
  c_chat: ['전장에서도 밥은 먹어야지.', '이 글 보고 매매 결정하면 안 되오. 그래도 재밌군.'],
  c_info: ['정보 감사하오. 다만 정보와 수익은 사이가 안 좋소.', '좋은 정리군. 시장이 읽어 줄지는 모르겠지만.'],
  c_lose: ['💀 패전 확인. 괜찮소, 시장도 가끔 틀린 사람을 맞다고 하니까.', '💀 이번엔 졌소. 다음엔… 또 모르지.', '💀 전사 처리됐소. 부활은 다음 참전에서.'],
  c_win: ['🎖 승전 축하하오! 이 기세 그대로… 겸손을 유지하시오.', '🎖 적중! 오늘은 당신이 장군이오.'],
};

function fb(kind: string, v: Record<string, string>): { title: string; body: string } {
  return { title: T[kind] ? fill(pick(T[kind]), v) : '', body: T[kind + '_body'] ? fill(pick(T[kind + '_body']), v) : '' };
}

// ---------------------------------------------------------------- Claude voice
const PERSONAS: Record<string, string> = {
  reporter: '종군기자김속보: 숫자를 정확히 전하는 전쟁 특파원. 건조하고 냉소적인 유머.',
  cynic: '냉소병장: 다 겪어 본 고참. 시니컬하지만 결국 전우를 챙긴다.',
  contra: '역지표장군: 늘 다수와 반대로 가는 허세 가득한 장군. 자기 자신도 풍자 대상.',
  pr: '사령부공보관: 과장된 군대식 공식 발표 말투로 결과를 알린다.',
  seer: '점쟁이도사: 그럴듯한 운세를 말하지만 마지막엔 꼭 재미로만 보라고 한다.',
};
const SYSTEM = `너는 주식·코인·채권·환율 시세를 전쟁에 비유하는 재미용 커뮤니티의 운영 봇들이다.
오르면 상승군(빨강), 내리면 하락군(파랑)이 이긴다. 채권은 금리가 내리면 채권 강세라 상승군이다.
규칙:
- 한국어, 짧게. 제목은 30자 이내, 본문은 2~3문장 150자 이내, 댓글은 80자 이내.
- 냉소·풍자·자조는 좋지만 사용자 개인을 모욕하지 말 것. 실존 인물(CEO, 정치인 등)을 비방하지 말 것.
- 투자 권유·매수/매도 추천·수익 보장 표현 금지. 가격 예측을 단정하지 말 것.
- 주어진 사실(숫자)만 사용하고 뉴스나 이유를 지어내지 말 것.
- 욕설·혐오 표현 금지. 각 항목의 페르소나 말투를 지킬 것.`;
const Out = z.object({ items: z.array(z.object({ id: z.string(), title: z.string(), body: z.string() })) });

async function writeWithClaude(tasks: Task[]): Promise<Record<string, { title: string; body: string }>> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key || !tasks.length) return {};
  const client = new Anthropic({ apiKey: key });
  const input = tasks.map(t => ({ id: t.id, type: t.kind === 'post' ? '새 글 (제목+본문)' : '댓글 (title은 빈 문자열)', persona: PERSONAS[t.bot], facts: t.facts, reply_to: t.reply_to }));
  const res = await client.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(Out) },
    system: SYSTEM,
    messages: [{ role: 'user', content: `아래 각 항목에 대해 글이나 댓글을 써 줘. 같은 id로 돌려줘.\n${JSON.stringify(input, null, 1)}` }],
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) return {};
  return Object.fromEntries(res.parsed_output.items.map(i => [i.id, { title: i.title, body: i.body }]));
}

function clean(t: Task, txt?: { title: string; body: string }) {
  const ok = txt && txt.body && !BANNED.some(w => (txt.title + txt.body).includes(w)) && !/(t\.me\/|open\.kakao|https?:\/\/)/i.test(txt.title + txt.body);
  const use = ok ? txt! : t.fb;
  return { title: (use.title || t.fb.title).slice(0, 40), body: use.body.slice(0, t.kind === 'comment' ? 180 : 400) };
}

// ---------------------------------------------------------------- main
Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now(), date = kDate(), k = kst(), hour = k.getUTCHours(), dow = k.getUTCDay();
  const ago = (min: number) => new Date(now - min * 60e3).toISOString();

  const [{ data: assets }, { data: bots }, { data: recent }, { data: states }] = await Promise.all([
    sb.from('assets').select('symbol,name,short,kind,threshold,price,change,change_pct,market_open,vol_ratio,frontier,added_at,active,flows').eq('active', true),
    sb.from('profiles').select('id,bot_role').eq('is_bot', true),
    sb.from('bot_log').select('key,at,val').gte('at', ago(60 * 48)),
    sb.from('bot_log').select('key,at,val').like('key', 'state:%'),   // market state survives weekends
  ]);
  const logs = [...(recent || []), ...(states || [])];
  if (!assets || !bots) return new Response('no data', { status: 500 });
  const BOT: Record<string, string> = Object.fromEntries(bots.map(b => [b.bot_role, b.id]));
  const seen = new Map(logs.map(l => [l.key, l]));
  const A: Record<string, Asset> = Object.fromEntries((assets as Asset[]).map(a => [a.symbol, a]));
  const tasks: Task[] = [];
  // daily cap on bot posts
  const { count: botPostsToday } = await sb.from('posts').select('id, author:profiles!posts_author_id_fkey!inner(is_bot)', { count: 'exact', head: true }).eq('author.is_bot', true).gte('created_at', ago(60 * 24));
  const capReached = (botPostsToday || 0) >= 60;
  const posts = () => tasks.filter(t => t.kind === 'post').length, comments = () => tasks.filter(t => t.kind === 'comment').length;
  const addPost = (t: Omit<Task, 'kind'>) => { if (!capReached && posts() < MAX_POSTS && !t.log.some(x => seen.has(x))) tasks.push({ ...t, kind: 'post' }); };
  const addComment = (t: Omit<Task, 'kind'>) => { if (comments() < MAX_COMMENTS && !t.log.some(x => seen.has(x))) tasks.push({ ...t, kind: 'comment' }); };
  const stateWrites: { key: string; val: string }[] = [];

  // 1) market open / close (KOSPI, S&P 500)
  for (const sym of ['KOSPI', 'SPX']) {
    const a = A[sym]; if (!a || a.market_open == null) continue;
    const prev = seen.get('state:' + sym)?.val, cur = String(a.market_open);
    if (prev !== undefined && prev !== cur) {
      const v = { name: a.name, chg: fmtC(a), side: side(a) };
      addPost({ id: `sess-${sym}`, bot: 'reporter', symbol: sym, category: 'info', facts: `${a.name} 장이 방금 ${a.market_open ? '열렸다' : '닫혔다'}. 전일 대비 ${fmtC(a)}. 오늘 우세: ${side(a)}.`, fb: fb(a.market_open ? 'open' : 'close', v), log: [`sess:${sym}:${date}:${cur}`] });
    }
    if (prev !== cur) stateWrites.push({ key: 'state:' + sym, val: cur });
  }

  // 2) big moves: first step and the extreme step only, at most one per run
  let movePosts = 0;
  for (const a of Object.values(A).sort((x, y) => Math.abs(mv(y) / y.threshold) - Math.abs(mv(x) / x.threshold))) {
    if (movePosts >= 1) break;
    if (!a.market_open || a.price == null) continue;
    const m = a.kind === 'BOND' ? Math.abs(+(a.change || 0) * 100) : Math.abs(+(a.change_pct || 0));
    const steps = a.kind === 'BOND' ? [8, 15, 25] : a.kind === 'FX' ? [0.8, 1.5, 2.5] : a.kind === 'INDEX' ? [2, 3.5, 5] : [3, 5, 8];
    const lvl = steps.filter(s => m >= s).length; if (!lvl || lvl === 2) continue;
    if (seen.has(`move:${a.symbol}:${date}:${lvl}`)) continue; movePosts++;
    const v = { name: a.name, chg: fmtC(a), ctl: String(ctl(a)) };
    addPost({ id: `move-${a.symbol}`, bot: 'reporter', symbol: a.symbol, category: 'info',
      facts: `${a.name} 오늘 ${fmtC(a)} (${lvl}단계 급변). 상승군 점령률 ${ctl(a)}%.${a.kind === 'BOND' ? ' 채권은 금리가 내리면 강세.' : ''}`,
      fb: { title: fb(mv(a) >= 0 ? 'move_up' : 'move_down', v).title, body: fb('move', v).body }, log: [`move:${a.symbol}:${date}:${lvl}`] });
  }

  // 3) volume spikes
  for (const a of Object.values(A)) {
    if (!a.market_open || !a.vol_ratio || a.vol_ratio < 2.5) continue;
    const v = { name: a.name, vr: (+a.vol_ratio).toFixed(1) };
    addPost({ id: `vol-${a.symbol}`, bot: 'reporter', symbol: a.symbol, category: 'info', facts: `${a.name} 거래량이 평소의 ${v.vr}배. 등락 ${fmtC(a)}.`, fb: fb('vol', v), log: [`vol:${a.symbol}:${date}`] });
  }

  // 4) new territories
  for (const a of Object.values(A)) {
    if (!a.frontier || !a.added_at || Date.parse(a.added_at) < now - 30 * 60e3) continue;
    addPost({ id: `fr-${a.symbol}`, bot: 'pr', symbol: a.symbol, category: 'chat', facts: `새 영토 "${a.name}"가 개척됐다. 현재 ${fmtC(a)}.`, fb: fb('frontier', { name: a.name }), log: [`frontier:${a.symbol}`] });
  }

  // 5) showdown results worth announcing (user-made, or system ones with 2+ soldiers)
  const { data: done } = await sb.from('battles').select('id,symbol,question,option_a,option_b,winning_option,creator_id,entries:battle_entries(option)').eq('status', 'RESOLVED').gte('resolves_at', ago(30));
  for (const b of done || []) {
    const n = (b.entries || []).length; if (!b.creator_id && n < 2) continue;
    const win = b.winning_option === 'A' ? b.option_a : b.option_b;
    addPost({ id: `bt-${b.id}`, bot: 'pr', symbol: b.symbol, category: 'chat', facts: `결전 "${b.question}" 종료. 승리: ${win}. 참전 ${n}명.`, fb: fb('battle', { q: b.question.slice(0, 22), win, n: String(n) }), log: [`battle:${b.id}`] });
  }

  // 6) daily fortune 08:00-09:59 KST
  if (hour >= 8 && hour < 10) {
    const xs = Object.values(A).sort(() => Math.random() - .5).slice(0, 3);
    if (xs.length === 3) addPost({ id: 'seer', bot: 'seer', symbol: xs[0].symbol, category: 'chat', facts: `오늘의 운세 대상 영토: ${xs.map(x => `${x.name}(${fmtC(x)})`).join(', ')}.`, fb: fb('seer', { a: xs[0].name, b: xs[1].name, c: xs[2].name }), log: [`seer:${date}`] });
  }

  // 7) contrarian general, every 3 hours: mock today's majority
  {
    const slot = `contra:${date}:${Math.floor(hour / 3)}`;
    const { data: calls } = await sb.from('posts').select('side').gte('created_at', ago(180)).not('side', 'is', null);
    const up = (calls || []).filter(c => c.side === 'UP').length, down = (calls || []).length - up;
    if (up + down >= 2) addPost({ id: 'contra', bot: 'contra', symbol: 'KOSPI', category: 'chat', facts: `최근 3시간 병사 참전: 상승군 ${up}명, 하락군 ${down}명.`, fb: fb('contra', { major: up >= down ? '상승군' : '하락군' }), log: [slot] });
  }

  // 8) periodic briefing if bots have been quiet for 50 minutes
  {
    const last = [...seen.values()].filter(l => l.key.startsWith('posted:')).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if ((!last || Date.parse(last.at) < now - 50 * 60e3) && posts() === 0) {
      const xs = Object.values(A); const pw = Math.round(xs.reduce((s, a) => s + ctl(a), 0) / xs.length);
      const hot = xs.slice().sort((a, b) => Math.abs(mv(b) / b.threshold) - Math.abs(mv(a) / a.threshold)).slice(0, 3);
      addPost({ id: 'brief', bot: 'reporter', symbol: hot[0].symbol, category: 'info',
        facts: `세력도 상승군 ${pw}%, 하락군 ${100 - pw}%. 격전지: ${hot.map(h => `${h.name} ${fmtC(h)}`).join(', ')}. 현재 시각 KST ${hour}시.`,
        fb: fb('brief', { pw: String(pw), pwd: String(100 - pw), hot: hot.map(h => h.name).join(', ') }), log: [`brief:${date}:${hour}:${Math.floor(k.getUTCMinutes() / 50)}`] });
    }
  }

  // 9) comments on fresh user posts, and on calls that just lost or won
  const { data: fresh } = await sb.from('posts').select('id,category,title,body,symbol,author:profiles!posts_author_id_fkey(is_bot)').gte('created_at', ago(60)).eq('is_hidden', false).order('created_at', { ascending: false }).limit(20);
  for (const p of fresh || []) {
    if ((p.author as any)?.is_bot || Math.random() > .75) continue;
    const bot = p.category === 'vent' ? 'cynic' : p.category === 'wish' ? 'seer' : p.category === 'info' ? 'reporter' : p.category === 'chat' ? 'cynic' : pick(['contra', 'cynic']);
    const fbk = p.category === 'vent' ? 'c_vent' : p.category === 'wish' ? 'c_wish' : p.category === 'info' ? 'c_info' : p.category === 'chat' ? 'c_chat' : 'c_call';
    const a = A[p.symbol];
    addComment({ id: `c-${p.id}`, bot, post_id: p.id, facts: `글의 말머리: ${p.category}. 영토: ${a?.name || p.symbol} (${a ? fmtC(a) : ''}).`, reply_to: `${p.title}\n${(p.body || '').slice(0, 300)}`, fb: { title: '', body: pick(T[fbk]) }, log: [`cmt:${p.id}`] });
  }
  const { data: scored } = await sb.from('posts').select('id,result,title,symbol,author:profiles!posts_author_id_fkey(is_bot)').in('category', ['forecast', 'bet']).not('result', 'is', null).gte('settle_at', ago(15)).limit(10);
  for (const p of scored || []) {
    if ((p.author as any)?.is_bot) continue;
    const lost = p.result === 'LOSE'; if (!lost && Math.random() > .5) continue;
    const a = A[p.symbol];
    addComment({ id: `r-${p.id}`, bot: lost ? 'cynic' : 'pr', post_id: p.id, facts: `이 참전은 방금 ${lost ? '패전' : '승전'}으로 판정됐다. 영토: ${a?.name || p.symbol} ${a ? fmtC(a) : ''}.`, reply_to: p.title, fb: { title: '', body: pick(T[lost ? 'c_lose' : 'c_win']) }, log: [`res:${p.id}`] });
  }

  // ---------------------------------------------------------------- write
  let ai: Record<string, { title: string; body: string }> = {}, aiErr = '';
  try { ai = await writeWithClaude(tasks); } catch (e) { aiErr = String(e).slice(0, 160); }
  const wrote: string[] = [], logRows: { key: string; val?: string }[] = [...stateWrites];
  for (const t of tasks) {
    const txt = clean(t, ai[t.id]); const bot = BOT[t.bot]; if (!bot) continue;
    try {
      if (t.kind === 'post') { const { error } = await sb.rpc('bot_post', { p_bot: bot, p_symbol: t.symbol, p_category: t.category, p_title: txt.title, p_body: txt.body }); if (error) throw error; logRows.push({ key: `posted:${t.id}:${now}` }); }
      else { const { error } = await sb.rpc('bot_comment', { p_bot: bot, p_post: t.post_id, p_body: txt.body }); if (error) throw error; }
      t.log.forEach(key => logRows.push({ key })); wrote.push(t.id + (ai[t.id] ? '*' : ''));
    } catch (e) { aiErr += ` | ${t.id}: ${String((e as any)?.message || e).slice(0, 80)}`; }
  }
  if (logRows.length) await sb.from('bot_log').upsert(logRows.map(r => ({ key: r.key, val: r.val ?? null, at: new Date().toISOString() })));
  await sb.from('bot_log').delete().lt('at', ago(60 * 24 * 3)).not('key', 'like', 'state:%');
  return new Response(JSON.stringify({ wrote, ai: Object.keys(ai).length, err: aiErr || undefined }), { headers: { 'content-type': 'application/json' } });
});
