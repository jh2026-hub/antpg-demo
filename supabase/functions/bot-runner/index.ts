// Operator bots. Runs every 5 minutes (pg_cron, x-cron-secret). Finds events (big moves, volume spikes,
// foreign/institution flows, market open/close, showdown results, new territories, fresh user posts,
// lost/won calls) and writes short satirical war reports and comments as clearly-labeled bot accounts.
// No AI and no cost: every text is assembled from sentence fragments plus the live numbers.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { L, REACTORS_UP, REACTORS_DOWN, COMMENTERS, IDLERS } from './lines.ts';

type Asset = { symbol: string; name: string; short: string; kind: string; region: string; threshold: number; price: number | null; change: number | null; change_pct: number | null; market_open: boolean | null; vol_ratio: number | null; frontier: boolean; added_at: string | null; flows: any };
type Task = { id: string; kind: 'post' | 'comment'; bot: string; symbol?: string; category?: string; post_id?: string; title: string; body: string; log: string[] };

const MAX_POSTS = 3, MAX_COMMENTS = 6, DAILY_POST_CAP = 70;
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const maybe = (p: number, s: string) => Math.random() < p ? s : '';
const kst = () => new Date(Date.now() + 9 * 3600e3);
const kDate = () => kst().toISOString().slice(0, 10);

// ---------------------------------------------------------------- Korean helpers
// pick the right particle for the last syllable: 이/가, 은/는, 을/를, 과/와, 으로/로
function hasBatchim(w: string) {
  const ch = w.trim().slice(-1), c = ch.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 !== 0;
  return /[0-9lmnLMN]$/.test(ch) && !/[2459]$/.test(ch);   // rough guess for digits / latin letters
}
const J = (w: string, withB: string, without: string) => w + (hasBatchim(w) ? withB : without);
// "{name|이가}" style placeholders
function fill(s: string, v: Record<string, string>) {
  return s.replace(/\{(\w+)(?:\|(\S+?))?\}/g, (_, k, p) => {
    const w = v[k] ?? ''; if (!p) return w;
    const [a, b] = ({ 이가: ['이', '가'], 은는: ['은', '는'], 을를: ['을', '를'], 과와: ['과', '와'], 으로: ['으로', '로'] } as Record<string, string[]>)[p] || ['', ''];
    return J(w, a, b);
  }).replace(/\s{2,}/g, ' ').trim();
}
const compose = (v: Record<string, string>, ...parts: (string[] | string)[]) =>
  fill(parts.map(p => Array.isArray(p) ? pick(p) : p).filter(Boolean).join(' '), v);

// ---------------------------------------------------------------- market helpers
const mv = (a: Asset) => a.kind === 'BOND' ? -(+(a.change || 0)) : +(a.change_pct || 0);
const ctl = (a: Asset) => Math.round(50 + 50 * Math.max(-1, Math.min(1, mv(a) / +a.threshold)));
const fmtC = (a: Asset) => a.kind === 'BOND' ? `금리 ${(+(a.change || 0) * 100 > 0 ? '+' : '')}${(+(a.change || 0) * 100).toFixed(1)}bp` : `${+(a.change_pct || 0) > 0 ? '+' : ''}${(+(a.change_pct || 0)).toFixed(2)}%`;
const side = (a: Asset) => mv(a) >= 0 ? '상승군' : '하락군';
const eok = (v: number) => Math.abs(v) >= 1e4 ? `${(Math.abs(v) / 1e4).toFixed(1)}조` : `${Math.round(Math.abs(v)).toLocaleString('ko-KR')}억`;
function tod() { const h = kst().getUTCHours(); return h < 5 ? '새벽' : h < 9 ? '이른 아침' : h < 12 ? '오전' : h < 14 ? '점심시간' : h < 18 ? '오후' : h < 22 ? '저녁' : '야심한 밤'; }
const DOW = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
function kindWord(a: Asset) { return a.kind === 'CRYPTO' ? '크립토 고원' : a.kind === 'BOND' ? '채권 해역' : a.kind === 'FX' ? '환율 협곡' : a.region === 'US' ? '아메리카 전선' : a.frontier ? '개척지' : '코리아 전선'; }
function vars(a: Asset, extra: Record<string, string> = {}): Record<string, string> {
  const k = kst();
  return { name: a.name, short: a.short, chg: fmtC(a), ctl: String(ctl(a)), side: side(a), enemy: side(a) === '상승군' ? '하락군' : '상승군',
    tod: tod(), dow: DOW[k.getUTCDay()], where: kindWord(a), color: ctl(a) >= 50 ? '빨강' : '파랑', ...extra };
}

// ---------------------------------------------------------------- fragment banks
const F = {
  // headlines
  moveTitleUp: ['[속보] {name} {chg}', '{name} {chg}, 상승군 대진격', '{tod} {name} 전선 {chg} 돌파', '{name} {chg}… 하락군 참호 함락', '빨간 깃발 휘날리는 {name} {chg}', '{name} 탱크 부대 {chg} 전진'],
  moveTitleDown: ['[속보] {name} {chg}', '{name} {chg}, 하락군 대공세', '{tod} {name} 요새 {chg} 함락 위기', '{name} {chg}… 상승군 전선 붕괴', '파란 포탄 쏟아지는 {name} {chg}', '{name} 방어선 {chg} 후퇴'],
  bondTitle: ['[해역 속보] {name} {chg}', '{name} {chg}, 채권 함대 {side} 우세', '{tod}의 채권 해역, {name} {chg}'],
  fxTitle: ['[협곡 속보] {name} {chg}', '{name} {chg}, 환율 협곡이 흔들린다', '{tod} {name} {chg}… 수입업자들 표정 관리 중'],
  // body: opener / fact / quip / closer
  opener: ['{where}에서 긴급 전보.', '사령부에 타전이 들어왔다.', '{dow} {tod}, 전장이 요동친다.', '방금 들어온 소식이다.', '종군기자가 참호에서 전한다.', '연합 통신 속보.'],
  fact: ['{name|이가} 오늘 {chg} 움직였고 상승군 점령률은 {ctl}%.', '{name} {chg}. 지도는 {color}으로 물들었다.', '현재 {name} {chg}, 상승군 점령률 {ctl}%.'],
  quipUp: ['어제 판 병사들은 오늘 조용하다.', '갑자기 다들 원래 알고 있었다고 한다.', 'FOMO 징집 영장이 대량 발송됐다.', '존버 부대가 드디어 참호 밖으로 고개를 내밀었다.', '하락군 지휘관은 "전략적 재배치"라고 해명했다.', '빨간불을 본 개미들이 일제히 계좌를 열어 봤다.', '이럴 때 꼭 "이제 시작"이라는 사람이 나타난다.', '익절한 사람은 배 아프고, 안 판 사람은 불안하다.'],
  quipDown: ['상승군 보급로가 끊겼다는 첩보다.', '상승군 참호마다 구조 요청 신호탄이 오른다.', '존버 부대는 위치를 사수 중이라는데, 그 위치가 어딘지 아무도 모른다.', '상승군 지휘부는 "건강한 조정"이라고 발표했다.', '파란 화면 앞에서 개미들이 단체로 명상에 들어갔다.', '"장기 투자자입니다"라는 말이 다시 유행이다.', '앱을 지웠다 깔았다 하는 병사가 늘고 있다.', '바닥이라고 외친 사람이 벌써 세 번째다.'],
  quipBondUp: ['금리가 내려 채권 함대가 웃는다. 대출 있는 병사도 살짝 웃는다.', '채권 강세. 연준 한마디에 함대가 출렁였다는 소문이다.'],
  quipBondDown: ['금리가 올라 채권 함대가 가라앉는 중. 예금 이자 생각하는 병사만 웃는다.', '채권 약세. 금리 상승의 파도가 해역을 덮쳤다.'],
  quipFx: ['해외 직구 장바구니가 조용히 비워지고 있다.', '여행 계획 짜던 병사가 환율 계산기를 다시 두드린다.', '수출 부대는 미소를, 수입 부대는 한숨을.'],
  quipCrypto: ['고원은 쉬는 날이 없다. 잠도 없다.', '새벽 세 시에도 전쟁 중인 유일한 땅.', '"이번엔 다르다"는 말이 고원에 또 울려 퍼진다.'],
  closer: ['이유는 아무도 모른다. 원래 그렇다.', '전문가들은 사후에 이유를 찾아낼 예정이다.', '재미로만 보시오.', '다음 전보를 기다려라.', '참전은 자유, 멘탈은 각자.', ''],
  // volume
  volTitle: ['{name} 거래량 평소의 {vr}배', '{name}에 병력 {vr}배 집결', '{name} 마을이 북적인다 (거래량 {vr}배)'],
  volQuip: ['누가 사고 누가 파는지는 모르지만 다들 바쁘다.', '축제인지 피난인지는 내일 알게 된다.', '조용하던 동네에 갑자기 장이 섰다.', '이럴 땐 보통 누군가는 알고 있다. 그게 우리는 아니다.'],
  // flows
  flowTitleBuy: ['외국인 용병단, {name}에 {amt} 투입', '[수급] 외국인 {name} {amt} 순매수', '용병단 상륙: {name} {amt}'],
  flowTitleSell: ['외국인 용병단, {name}에서 {amt} 철수', '[수급] 외국인 {name} {amt} 순매도', '용병단 퇴각: {name} {amt}'],
  flowQuip: ['개인 의병대는 {retail}, 기관 정규군은 {inst}로 응수했다.', '그 사이 개인 의병대는 {retail}. 늘 그렇듯 반대편에 섰다.', '기관 정규군 {inst}, 개인 의병대 {retail}. 이 땅의 주인은 누구인가.'],
  // sessions
  openTitle: ['📯 {name} 전장 개방', '📯 {name} 장 시작, 출발선 {chg}', '📯 {dow} {name} 개장'],
  openBody: ['커피 들고 참호로. 출발선은 {chg}.', '오늘의 작전명: "본전만 찾자". 시작은 {chg}.', '각자 자리에서 기도를 시작해 주시기 바랍니다. 출발 {chg}.'],
  closeTitle: ['🌙 {name} 휴전, 오늘 {chg}', '🌙 {name} 장 마감 {chg}', '🌙 {dow} {name} 전투 종료'],
  closeBody: ['오늘의 승자는 {side}. 패자는 저녁 메뉴로 위로받길.', '{side|이가} 웃으며 퇴근했다. 반대편은 야근 중.', '오늘 하루도 수고했다, 병사들. 계좌는 수고하지 않았지만.'],
  // briefing
  briefTitle: ['🗺 {tod} 전황 브리핑', '🗺 사령부 정기 보고', '🗺 지금 세력도 상승군 {pw}%'],
  briefBody: ['세력도 상승군 {pw}% 대 하락군 {pwd}%. 가장 뜨거운 곳은 {hot}.', '현재 지도의 {pw}%가 빨강. 격전지는 {hot}.', '상승군 {pw}%, 하락군 {pwd}%. 최전선: {hot}.'],
  briefQuip: ['사령부는 "상황을 예의주시 중"이라고 밝혔다. 늘 그렇듯.', '참전은 무료, 멘탈은 유료.', '지도를 보고 결정하지 말고, 지도를 보고 웃자.', '병사들은 오늘도 각자의 이유로 확신에 차 있다.'],
  // contrarian general
  contraTitle: ['🎖 역지표 장군의 작전 명령', '🎖 장군 왈: 다수가 가면 나는 반대로', '🎖 긴급 하명 (믿지 마시오)'],
  contraBody: ['최근 3시간 병사들은 {major} {majn}명, {minor} {minn}명.', '병사 다수({majn}명)가 {major} 쪽에 줄을 섰다.'],
  contraQuip: ['역사적으로 다수가 맞은 적이… 가끔 있긴 했다.', '본 장군은 늘 그렇듯 반대편에서 홀로 서 있겠다. 외롭다.', '소문이 돌 때가 가장 위험한 법. 물론 장군도 자주 틀린다.', '장군의 승률은 기밀이다. 묻지 마라.'],
  // fortune teller
  seerTitle: ['🔮 {dow}의 영토 운세', '🔮 도사가 본 오늘의 전장', '🔮 오늘의 점괘'],
  fortune: ['대길(大吉)이라 하면 떨어지겠지', '흉 속에 길이 숨어 있다', '동쪽에서 귀인이 온다 (아마 기관)', '강을 건너지 마라 (추격 금지)', '오늘은 쉬는 것도 전략', '서두르면 체한다', '귀가 얇아지는 날', '구관이 명관', '바람이 바뀐다, 방향은 모름'],
  seerClose: ['재미로만 보시오. 운세보다 손절선.', '맞으면 도사 덕, 틀리면 시장 탓.', '복채는 받지 않는다. 손실도 책임지지 않는다.'],
  // showdowns / frontier
  battleTitle: ['📯 결전 결과: {q}', '📯 종전 발표: {q}'],
  battleBody: ['판정 결과 "{win}" 승리. 참전 {n}명.', '"{win}" 쪽이 이겼다. 참전 병사 {n}명.'],
  battleQuip: ['승자는 훈장을, 패자는 교훈을 챙기시오.', '패배한 쪽은 다음 결전에서 설욕하라.', '이긴 쪽은 겸손하게, 진 쪽은 조용히.'],
  frontierTitle: ['🚩 새 영토 개척: {name}', '🚩 {name} 땅에 깃발이 꽂혔다', '🚩 개척지에 {name} 등장'],
  frontierBody: ['용감한 병사가 {name}에 깃발을 꽂았다. 지금 {chg}.', '{name} 개척 완료. 지도에 새 땅이 생겼다. 현재 {chg}.'],
  frontierQuip: ['첫 참전자에게는 아무것도 주어지지 않지만 명예는 있다.', '이제 이 땅을 두고 싸울 차례.', '안개가 걷히고 새 전선이 열렸다.'],
};
// comments
const C = {
  vent: ['토닥토닥. 계좌는 파랗지만 마음까지 파랄 필요는 없소.', '나도 거기 있었소. 같이 버팁시다, 전우여.', '물린 게 아니라 장기 투자로 전환된 거요. 그렇다고 해 둡시다.', '{name} {chg}인 날엔 다들 그 자리에 있소. 혼자가 아니오.', '참호에서 컵라면 하나 끓여 드리리다.', '오늘은 앱 끄고 산책 어떻소. 시장은 내일도 열리오.'],
  wish: ['🔮 기원 접수. 하늘이 바쁘시니 순번대로 처리될 예정.', '🔮 촛불 하나 보탠다. 효과는 장담 못 함.', '🔮 {name}의 기운이… 흐릿하다. 계속 빌어 보시오.', '🔮 간절함은 전해졌소. 시장에게 전해질지는 모르겠지만.'],
  call: ['확신에 찬 참전, 보기 좋소. 시장이 알아줄지는 별개요.', '다수가 그쪽이면 장군은 반대로 가겠소. 행운을.', '그 근거, 차트에서 왔소 꿈에서 왔소?', '{name} {chg} 상황에서 그 선택이라… 용기는 인정하오.', '판정 시간까지 화장실은 미리 다녀오시오.'],
  chat: ['전장에서도 밥은 먹어야지.', '이 글 보고 매매 결정하면 안 되오. 그래도 재밌군.', '병영에 활기가 도는군.', '좋은 수다는 전쟁의 윤활유요.'],
  info: ['정보 감사하오. 다만 정보와 수익은 사이가 안 좋소.', '좋은 정리군. 시장이 읽어 줄지는 모르겠지만.', '기록해 두겠소. 나중에 맞았는지 같이 봅시다.'],
  lose: ['💀 패전 확인. 괜찮소, 시장도 가끔 틀린 사람을 맞다고 하니까.', '💀 이번엔 졌소. 다음엔… 또 모르지.', '💀 전사 처리됐소. 부활은 다음 참전에서.', '💀 {name}이 배신했군. 늘 그렇듯.'],
  win: ['🎖 승전 축하하오! 이 기세 그대로… 겸손을 유지하시오.', '🎖 적중! 오늘은 당신이 장군이오.', '🎖 훈장 수여. 액자에 걸어 두시오.'],
};

// a line from a persona's bank, or null if that persona has nothing for the slot
const line = (bot: string, slot: string, v: Record<string, string>) => { const bank = L[bot]?.[slot]; return bank && bank.length ? fill(pick(bank), v) : null; };
const shuffle = <T>(a: T[]) => a.slice().sort(() => Math.random() - .5);

// ---------------------------------------------------------------- main
Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('CRON_SECRET')) return new Response('forbidden', { status: 403 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = Date.now(), date = kDate(), k = kst(), hour = k.getUTCHours();
  const ago = (min: number) => new Date(now - min * 60e3).toISOString();

  const [{ data: assets }, { data: bots }, { data: recent }, { data: states }] = await Promise.all([
    sb.from('assets').select('symbol,name,short,kind,region,threshold,price,change,change_pct,market_open,vol_ratio,frontier,added_at,flows').eq('active', true),
    sb.from('profiles').select('id,bot_role').eq('is_bot', true),
    sb.from('bot_log').select('key,at,val').gte('at', ago(60 * 48)),
    sb.from('bot_log').select('key,at,val').like('key', 'state:%'),
  ]);
  if (!assets || !bots) return new Response('no data', { status: 500 });
  const BOT: Record<string, string> = Object.fromEntries(bots.map(b => [b.bot_role, b.id]));
  const seen = new Map([...(recent || []), ...(states || [])].map(l => [l.key, l]));
  const A: Record<string, Asset> = Object.fromEntries((assets as Asset[]).map(a => [a.symbol, a]));
  const all = Object.values(A);

  const { count: botPostsToday } = await sb.from('posts').select('id, author:profiles!posts_author_id_fkey!inner(is_bot)', { count: 'exact', head: true }).eq('author.is_bot', true).gte('created_at', ago(60 * 24));
  const capReached = (botPostsToday || 0) >= DAILY_POST_CAP;
  const tasks: Task[] = [], stateWrites: { key: string; val: string }[] = [];
  const nPosts = () => tasks.filter(t => t.kind === 'post').length, nComments = () => tasks.filter(t => t.kind === 'comment').length;
  const post = (t: Omit<Task, 'kind'>) => { if (!capReached && nPosts() < MAX_POSTS && !t.log.some(x => seen.has(x))) tasks.push({ ...t, kind: 'post' }); };
  const comment = (t: Omit<Task, 'kind' | 'title'>) => { if (nComments() < MAX_COMMENTS && !t.log.some(x => seen.has(x))) tasks.push({ ...t, title: '', kind: 'comment' }); };

  // 1) market open / close
  for (const sym of ['KOSPI', 'SPX']) {
    const a = A[sym]; if (!a || a.market_open == null) continue;
    const prev = seen.get('state:' + sym)?.val, cur = String(a.market_open);
    if (prev !== undefined && prev !== cur) {
      const v = vars(a);
      post({ id: `sess-${sym}`, bot: 'reporter', symbol: sym, category: 'info', log: [`sess:${sym}:${date}:${cur}`],
        title: compose(v, a.market_open ? F.openTitle : F.closeTitle), body: compose(v, a.market_open ? F.openBody : F.closeBody, maybe(.5, pick(F.closer))) });
    }
    if (prev !== cur) stateWrites.push({ key: 'state:' + sym, val: cur });
  }

  // 2) big moves: first step and the extreme step only, at most one per run (biggest first)
  for (const a of all.slice().sort((x, y) => Math.abs(mv(y) / y.threshold) - Math.abs(mv(x) / x.threshold))) {
    if (!a.market_open || a.price == null) continue;
    const m = a.kind === 'BOND' ? Math.abs(+(a.change || 0) * 100) : Math.abs(+(a.change_pct || 0));
    const steps = a.kind === 'BOND' ? [8, 15, 25] : a.kind === 'FX' ? [0.8, 1.5, 2.5] : a.kind === 'INDEX' ? [2, 3.5, 5] : [3, 5, 8];
    const lvl = steps.filter(s => m >= s).length;
    if (!lvl || lvl === 2 || seen.has(`move:${a.symbol}:${date}:${lvl}`)) continue;
    const v = vars(a), up = mv(a) >= 0;
    const title = compose(v, a.kind === 'BOND' ? F.bondTitle : a.kind === 'FX' ? F.fxTitle : up ? F.moveTitleUp : F.moveTitleDown);
    const quip = a.kind === 'BOND' ? (up ? F.quipBondUp : F.quipBondDown) : a.kind === 'FX' ? F.quipFx : a.kind === 'CRYPTO' && Math.random() < .4 ? F.quipCrypto : up ? F.quipUp : F.quipDown;
    post({ id: `move-${a.symbol}`, bot: 'reporter', symbol: a.symbol, category: 'info', log: [`move:${a.symbol}:${date}:${lvl}`],
      title, body: compose(v, maybe(.7, pick(F.opener)), F.fact, quip, maybe(.6, pick(F.closer))) });
    break;
  }

  // 3) volume spikes
  for (const a of all) {
    if (!a.market_open || !a.vol_ratio || a.vol_ratio < 2.5) continue;
    const v = vars(a, { vr: (+a.vol_ratio).toFixed(1) });
    post({ id: `vol-${a.symbol}`, bot: 'reporter', symbol: a.symbol, category: 'info', log: [`vol:${a.symbol}:${date}`],
      title: compose(v, F.volTitle), body: compose(v, F.fact, F.volQuip, maybe(.5, pick(F.closer))) });
  }

  // 4) foreign money: KOSPI intraday net flow beyond ±5,000억
  {
    const a = A.KOSPI, f = a?.flows?.now;
    if (a && f && a.flows.live && Math.abs(f.foreign) >= 5000) {
      const buy = f.foreign > 0, v = vars(a, { amt: eok(f.foreign), retail: (f.retail >= 0 ? '+' : '−') + eok(f.retail), inst: (f.inst >= 0 ? '+' : '−') + eok(f.inst) });
      post({ id: 'flow-KOSPI', bot: 'reporter', symbol: 'KOSPI', category: 'info', log: [`flow:KOSPI:${date}:${buy ? 'b' : 's'}`],
        title: compose(v, buy ? F.flowTitleBuy : F.flowTitleSell), body: compose(v, F.flowQuip, `코스피는 ${v.chg}.`, maybe(.5, pick(F.closer))) });
    }
  }

  // 5) new territories
  for (const a of all) {
    if (!a.frontier || !a.added_at || Date.parse(a.added_at) < now - 30 * 60e3) continue;
    const v = vars(a);
    post({ id: `fr-${a.symbol}`, bot: 'pr', symbol: a.symbol, category: 'chat', log: [`frontier:${a.symbol}`], title: compose(v, F.frontierTitle), body: compose(v, F.frontierBody, F.frontierQuip) });
  }

  // 6) showdown results worth announcing (user-made, or system ones with 2+ soldiers)
  const { data: done } = await sb.from('battles').select('id,symbol,question,option_a,option_b,winning_option,creator_id,entries:battle_entries(option)').eq('status', 'RESOLVED').gte('resolves_at', ago(30));
  for (const b of done || []) {
    const n = (b.entries || []).length; if (!b.creator_id && n < 2) continue;
    const v = { q: b.question.slice(0, 24), win: b.winning_option === 'A' ? b.option_a : b.option_b, n: String(n) };
    post({ id: `bt-${b.id}`, bot: 'pr', symbol: b.symbol, category: 'chat', log: [`battle:${b.id}`], title: compose(v, F.battleTitle), body: compose(v, F.battleBody, F.battleQuip) });
  }

  // 7) daily fortune 08:00–09:59 KST
  if (hour >= 8 && hour < 10) {
    const xs = all.slice().sort(() => Math.random() - .5).slice(0, 3);
    const fs = F.fortune.slice().sort(() => Math.random() - .5);
    if (xs.length === 3) post({ id: 'seer', bot: 'seer', symbol: xs[0].symbol, category: 'chat', log: [`seer:${date}`],
      title: compose(vars(xs[0]), F.seerTitle), body: xs.map((x, i) => `${x.name}: ${fs[i]}.`).join(' ') + ' ' + pick(F.seerClose) });
  }

  // 8) contrarian general every 3 hours: mock the recent majority
  {
    const { data: calls } = await sb.from('posts').select('side').gte('created_at', ago(180)).not('side', 'is', null);
    const up = (calls || []).filter(c => c.side === 'UP').length, down = (calls || []).length - up;
    if (up + down >= 2 && up !== down) {
      const v = { major: up > down ? '상승군' : '하락군', minor: up > down ? '하락군' : '상승군', majn: String(Math.max(up, down)), minn: String(Math.min(up, down)) };
      post({ id: 'contra', bot: 'contra', symbol: 'KOSPI', category: 'chat', log: [`contra:${date}:${Math.floor(hour / 3)}`], title: compose(v, F.contraTitle), body: compose(v, F.contraBody, F.contraQuip) });
    }
  }

  // 9) briefing when bots have been quiet for 50 minutes
  {
    const last = [...seen.values()].filter(l => l.key.startsWith('posted:')).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if ((!last || Date.parse(last.at) < now - 50 * 60e3) && nPosts() === 0 && all.length) {
      const pw = Math.round(all.reduce((s, a) => s + ctl(a), 0) / all.length);
      const hot = all.slice().sort((a, b) => Math.abs(mv(b) / b.threshold) - Math.abs(mv(a) / a.threshold)).slice(0, 3);
      const v = { ...vars(hot[0]), pw: String(pw), pwd: String(100 - pw), hot: hot.map(h => `${h.name}(${fmtC(h)})`).join(', ') };
      post({ id: 'brief', bot: 'reporter', symbol: hot[0].symbol, category: 'info', log: [`brief:${date}:${hour}:${k.getUTCMinutes() >= 30 ? 1 : 0}`],
        title: compose(v, F.briefTitle), body: compose(v, F.briefBody, F.briefQuip) });
    }
  }

  // 10) bot banter: other personas react under recent bot reports (a little thread per post)
  const { data: botPosts } = await sb.from('posts').select('id,symbol,category,author:profiles!posts_author_id_fkey(is_bot,bot_role),comments(author:profiles!comments_author_id_fkey(bot_role))').gte('created_at', ago(45)).eq('is_hidden', false).order('created_at', { ascending: false }).limit(8);
  for (const p of botPosts || []) {
    const au = p.author as any; if (!au?.is_bot) continue;
    const done = new Set([au.bot_role, ...((p.comments as any[]) || []).map(c => c.author?.bot_role).filter(Boolean)]);
    if (done.size >= 5 || Math.random() > .6) continue;
    const a = A[p.symbol]; const v = a ? vars(a) : { name: p.symbol, chg: '' };
    const up = a ? mv(a) >= 0 : true;
    let pool = up ? REACTORS_UP : REACTORS_DOWN;
    if (a?.kind === 'CRYPTO') pool = [...pool, 'degen', 'degen']; if (a?.kind === 'BOND') pool = [...pool, 'admiral', 'admiral'];
    if (p.category === 'chat') pool = COMMENTERS.chat;
    const who = shuffle(pool).find(b => !done.has(b)); if (!who) continue;
    const txt = line(who, p.category === 'chat' ? 'chat' : up ? 'react_up' : 'react_down', v); if (!txt) continue;
    comment({ id: `b-${p.id}-${who}`, bot: who, post_id: p.id, body: txt, log: [`banter:${p.id}:${who}`] });
  }

  // 11) persona comments on fresh user posts
  const { data: fresh } = await sb.from('posts').select('id,category,side,symbol,author:profiles!posts_author_id_fkey(is_bot)').gte('created_at', ago(60)).eq('is_hidden', false).order('created_at', { ascending: false }).limit(20);
  for (const p of fresh || []) {
    if ((p.author as any)?.is_bot || Math.random() > .8) continue;
    const a = A[p.symbol]; const v = a ? vars(a) : { name: p.symbol, chg: '' };
    const isCall = p.category === 'forecast' || p.category === 'bet';
    const pool = COMMENTERS[isCall ? 'call' : p.category] || COMMENTERS.chat;
    const slot = isCall ? (p.side === 'DOWN' ? 'call_down' : 'call_up') : p.category;
    for (const who of shuffle(pool)) { const txt = line(who, slot, v); if (txt){ comment({ id: `c-${p.id}`, bot: who, post_id: p.id, body: txt, log: [`cmt:${p.id}`] }); break; } }
  }

  // 12) calls that just won or lost
  const { data: scored } = await sb.from('posts').select('id,result,symbol,category,author:profiles!posts_author_id_fkey(is_bot)').in('category', ['forecast', 'bet', 'wish']).not('result', 'is', null).gte('settle_at', ago(15)).limit(10);
  for (const p of scored || []) {
    if ((p.author as any)?.is_bot) continue;
    const lost = p.result === 'LOSE'; if (!lost && Math.random() > .6) continue;
    const a = A[p.symbol]; const v = a ? vars(a) : { name: p.symbol, chg: '' };
    const pool = p.category === 'wish' ? ['seer', 'grandma', 'optimist'] : lost ? ['cynic', 'doomer', 'grandma', 'ramen', 'optimist', 'salaryman', 'contra'] : ['pr', 'optimist', 'grandma', 'salaryman', 'ramen', 'degen'];
    for (const who of shuffle(pool)) { const txt = line(who, lost ? 'lose' : 'win', v); if (txt){ comment({ id: `r-${p.id}`, bot: who, post_id: p.id, body: txt, log: [`res:${p.id}`] }); break; } }
  }

  // 13) idle musings when the square is quiet (35 min), one persona at a time
  {
    const last = [...seen.values()].filter(l => l.key.startsWith('posted:')).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if ((!last || Date.parse(last.at) < now - 35 * 60e3) && nPosts() === 0 && Math.random() < .7) {
      const who = pick(IDLERS), a = who === 'degen' ? A.BTCUSDT : who === 'admiral' ? (A.US10Y || A.KR10Y) : pick(all);
      const v = a ? vars(a) : {}; const title = line(who, 'idle_t', v), body = line(who, 'idle', v);
      if (title && body && a) post({ id: `idle-${who}`, bot: who, symbol: a.symbol, category: 'chat', title, body, log: [`idle:${date}:${hour}:${who}`] });
    }
  }

  // ---------------------------------------------------------------- write
  const wrote: string[] = [], errs: string[] = [], logRows: { key: string; val?: string }[] = [...stateWrites];
  for (const t of tasks) {
    const bot = BOT[t.bot]; if (!bot) continue;
    try {
      if (t.kind === 'post'){ const { error } = await sb.rpc('bot_post', { p_bot: bot, p_symbol: t.symbol, p_category: t.category, p_title: t.title.slice(0, 40), p_body: t.body.slice(0, 400) }); if (error) throw error; logRows.push({ key: `posted:${t.id}:${now}` }); }
      else { const { error } = await sb.rpc('bot_comment', { p_bot: bot, p_post: t.post_id, p_body: t.body.slice(0, 180) }); if (error) throw error; }
      t.log.forEach(key => logRows.push({ key })); wrote.push(t.id);
    } catch (e) { errs.push(`${t.id}: ${String((e as any)?.message || e).slice(0, 80)}`); }
  }
  if (logRows.length) await sb.from('bot_log').upsert(logRows.map(r => ({ key: r.key, val: r.val ?? null, at: new Date().toISOString() })));
  await sb.from('bot_log').delete().lt('at', ago(60 * 24 * 3)).not('key', 'like', 'state:%');
  return new Response(JSON.stringify({ wrote, errs: errs.length ? errs : undefined, samples: tasks.slice(0, 2).map(t => t.title || t.body) }), { headers: { 'content-type': 'application/json' } });
});
