/**
 * 퀴즈 부하 테스트 (Node 18 이상, 설치할 것 없음)
 *
 *   node tools/quiz-loadtest.js https://내사이트.vercel.app 관리자비밀번호 [인원=350]
 *
 * 하는 일
 *  1) 퀴즈 상태 GET 을 인원 수만큼 동시에 요청 → 성공률, 응답 시간, CDN 캐시 적중(HIT) 비율
 *  2) 가짜 학번(9로 시작하는 5자리)으로 제출 POST 를 인원 수만큼 동시에 요청 → 성공·실패, 응답 시간
 *  3) 관리자 기능(qcount)으로 실제 저장된 제출 수와 대조
 *
 * 꼭 지켜 주세요
 *  - 선생님 수정 화면에서 문제를 저장하고 "새 회차 만들고 대기 열기" → "▶ 시작" 까지 눌러 둔 상태에서 실행
 *  - 끝나면 "■ 마감" 후 "새 회차"로 가짜 제출을 비우기 (이전 회차 기록은 서버에 남지만 화면·순위에는 안 나와요)
 *  - 실제 행사 사이트에서 돌리면 가짜 제출이 그 회차에 섞이니, 반드시 새 회차에서 다시 시작하세요
 */
const [, , SITE, PASSWORD, N_ARG] = process.argv;
if (!SITE || !PASSWORD) {
  console.log('사용법: node tools/quiz-loadtest.js https://내사이트.vercel.app 관리자비밀번호 [인원=350]');
  process.exit(1);
}
const N = Math.max(1, Math.min(1000, parseInt(N_ARG, 10) || 350));
const API = SITE.replace(/\/$/, '') + '/api/quiz';

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
const fmt = (ms) => (ms / 1000).toFixed(2) + '초';

async function timed(fn) {
  const t0 = Date.now();
  try { const r = await fn(); return { ms: Date.now() - t0, ...r }; }
  catch (e) { return { ms: Date.now() - t0, ok: false, status: 0, err: String(e.message || e) }; }
}
function summary(title, rs) {
  const ok = rs.filter((r) => r.ok).length;
  const ts = rs.map((r) => r.ms);
  console.log(`\n[${title}] 요청 ${rs.length}건 · 성공 ${ok}건 (${((ok / rs.length) * 100).toFixed(1)}%) · 실패 ${rs.length - ok}건`);
  console.log(`  응답 시간  중간 ${fmt(pct(ts, 0.5))} · 95% ${fmt(pct(ts, 0.95))} · 최대 ${fmt(Math.max(...ts))}`);
  const bad = {};
  rs.filter((r) => !r.ok).forEach((r) => { const k = `${r.status} ${r.err || ''}`; bad[k] = (bad[k] || 0) + 1; });
  Object.keys(bad).forEach((k) => console.log(`  실패 이유 ${k} × ${bad[k]}`));
}
async function post(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: !!j.ok, status: r.status, err: j.error, json: j };
}

(async () => {
  console.log(`대상 ${API} · 인원 ${N}명`);

  // 0) 현재 퀴즈 상태 확인
  const first = await fetch(API, { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!first || first.status !== 'open' || !first.questions) {
    console.log(`\n퀴즈가 "진행 중"이 아니에요 (현재: ${first ? first.status : '응답 없음'}). 선생님 화면에서 ▶ 시작을 누른 뒤 다시 실행해 주세요.`);
    process.exit(1);
  }
  const quizId = first.id;

  // 1) 상태 조회 동시 요청
  const gets = await Promise.all(Array.from({ length: N }, () => timed(async () => {
    const r = await fetch(API);
    await r.text();
    return { ok: r.ok, status: r.status, hit: r.headers.get('x-vercel-cache') };
  })));
  summary('상태 조회 GET', gets);
  const hits = gets.filter((r) => r.hit === 'HIT' || r.hit === 'STALE').length;
  console.log(`  CDN 캐시 적중 ${hits}건 (${((hits / N) * 100).toFixed(1)}%) — 높을수록 서버 부담이 적어요`);

  // 2) 제출 동시 요청 (학번 95000부터 차례로)
  const answersFor = (i) => first.questions.map((q) => (q.type === 'choice' ? String(i % q.choices.length) : '테스트'));
  const subs = await Promise.all(Array.from({ length: N }, (_, i) => timed(() => post({
    action: 'submit', quizId, sid: String(95000 + i), name: '부하' + i, ans: answersFor(i), ce: 1000, tries: 1, nonce: 'lt' + i,
  }))));
  summary('답안 제출 POST', subs);

  // 3) 실제 저장 수 대조
  const cnt = await post({ action: 'qcount', password: PASSWORD });
  if (cnt.ok) {
    const saved = cnt.json.n;
    const okN = subs.filter((r) => r.ok).length;
    console.log(`\n서버에 저장된 제출 ${saved}건 / 성공 응답 ${okN}건 ${saved >= okN ? '→ 빠짐없이 저장됨' : '→ 응답과 저장 수가 달라요! 확인이 필요해요'}`);
  } else {
    console.log(`\n저장 수 확인 실패 (${cnt.status} ${cnt.err || ''}) — 비밀번호를 확인해 주세요`);
  }

  const okRate = subs.filter((r) => r.ok).length / N;
  const p95 = pct(subs.map((r) => r.ms), 0.95);
  console.log(`\n판정: ${okRate === 1 && p95 <= 2000 ? '통과 ✅ (제출 100% 성공, 95% 응답 2초 이하)' : '점검 필요 ⚠️ (성공률 100%, 95% 응답 2초 이하가 목표)'}`);
  console.log('끝나면 선생님 화면에서 ■ 마감 → 새 회차로 가짜 제출을 비워 주세요.');
})();
