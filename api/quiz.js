/**
 * 퀴즈 (Vercel 서버 함수 + Upstash Redis)
 *
 * 학생: GET  /api/quiz            퀴즈 상태·문제 (버셀 CDN이 2초 캐시 → 350명이 불러도 함수는 2초에 한 번)
 *       GET  /api/quiz?img=키      문제 그림 (내용 해시 주소라 1년 캐시)
 *       POST /api/quiz {action:'submit'}  답안 제출 (학번당 첫 제출만 인정)
 * 선생님: POST /api/quiz {action:'qget'|'qsave'|'qimg'|'qstatus'|'qnew'|'qcount'|'qresults', password}
 *
 * 버셀 > Storage > Upstash for Redis 를 프로젝트에 연결하면 아래 환경 변수가 자동으로 생겨요.
 *   KV_REST_API_URL, KV_REST_API_TOKEN  (또는 UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN)
 *   ADMIN_PASSWORD  (api/save.js와 같은 비밀번호)
 */
const crypto = require('crypto');

const SID_RE = /^\d{5}$/;          // 학번 형식 (5자리 숫자). 학교 학번 규칙이 다르면 여기만 고치세요
const GRACE_MS = 120 * 1000;       // 마감 뒤에도 재시도 중이던 제출을 받아 주는 시간
const MAX_SUBS = 1000;             // 한 회차에 받을 최대 제출 수
const COUNTDOWN_MS = 10 * 1000;    // ▶ 시작 후 문제 공개까지 카운트다운. 모든 휴대폰이 이 시각을 미리 알고 같은 순간에 문제를 받음
const MAX_Q = 30;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Upstash REST ---------- */
function redisEnv() {
  const e = process.env;
  return { url: e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL, token: e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN };
}
async function pipe(cmds) {
  const { url, token } = redisEnv();
  const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis_' + r.status);
  const out = await r.json();
  return out.map((o) => { if (o.error) throw new Error('redis_cmd'); return o.result; });
}
const jparse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };

const K = { def: 'hq:def', state: 'hq:state', pub: 'hq:pub', img: (k) => 'hq:img:' + k, sub: (id) => 'hq:sub:' + id, dup: (id) => 'hq:dup:' + id };
const EMPTY_STATE = { id: '', status: 'off', reveal: false, openedAt: 0, closedAt: 0 };

/* 함수 인스턴스 안의 1초 기억: CDN 캐시가 어떤 이유로 안 먹어도 Redis에는 인스턴스당 1초에 한 번만 물어봄 */
const MEMO_MS = 1000;
let memoPub = { at: 0, v: null }, memoSD = { at: 0, v: null };
function forget() { memoPub = { at: 0, v: null }; memoSD = { at: 0, v: null }; }
async function getSD() { // [state, def]
  if (memoSD.v && Date.now() - memoSD.at < MEMO_MS) return memoSD.v;
  const [st, df] = await pipe([['GET', K.state], ['GET', K.def]]);
  const v = [Object.assign({}, EMPTY_STATE, jparse(st, {})), jparse(df, null)];
  memoSD = { at: Date.now(), v };
  return v;
}
/* 학생 화면용 응답은 선생님이 바꿀 때 미리 만들어 hq:pub 하나에 저장 → 학생 요청 1번 = Redis 명령 1개 */
async function getPub() {
  if (memoPub.v && Date.now() - memoPub.at < MEMO_MS) return memoPub.v;
  const [p] = await pipe([['GET', K.pub]]);
  let v = jparse(p, null);
  if (!v) { const [state, def] = await getSD(); v = publicQuiz(state, def); await pipe([['SET', K.pub, JSON.stringify(v)]]); }
  memoPub = { at: Date.now(), v };
  return v;
}
async function writeState(state, def, saveDef) { // 상태·문제를 바꿀 때마다 학생용 응답도 같이 갱신
  const cmds = [['SET', K.state, JSON.stringify(state)], ['SET', K.pub, JSON.stringify(publicQuiz(state, def))]];
  if (saveDef) cmds.push(['SET', K.def, JSON.stringify(def)]);
  await pipe(cmds);
  forget();
}

/* 단답형 비교: 전각/반각·대소문자·공백·문장부호 차이를 무시 (index.html의 qNorm과 똑같이 유지) */
function norm(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s​.,!?'"`~\-_:;()\[\]{}<>\/\\·…]/g, '');
}
function grade(def, ans) {
  const ok = def.questions.map((q, i) => {
    const a = ans[i];
    if (a === '' || a == null) return false;
    if (q.type === 'choice') return Number(a) === q.answer;
    const n = norm(a);
    return n !== '' && q.answer.some((x) => norm(x) === n);
  });
  return { ok, score: ok.filter(Boolean).length };
}

function publicQuiz(state, def) {
  const out = { id: state.id, status: state.status, reveal: !!state.reveal, openedAt: state.openedAt || 0, title: '', n: 0 };
  if (!def || !Array.isArray(def.questions)) return out;
  out.title = def.title || '';
  out.n = def.questions.length;
  if (state.status === 'open' || state.status === 'closed') {
    const showAns = state.status === 'closed' && state.reveal;
    out.questions = def.questions.map((q) => {
      const o = { type: q.type, text: q.text, img: q.img || '', choices: q.choices || [] };
      if (showAns) o.answer = q.answer;
      return o;
    });
  }
  return out;
}

function cleanDef(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.questions)) return null;
  if (d.questions.length < 1 || d.questions.length > MAX_Q) return null;
  const questions = [];
  for (const q of d.questions) {
    if (!q || (q.type !== 'choice' && q.type !== 'short')) return null;
    const o = { type: q.type, text: String(q.text || '').slice(0, 1000), img: '', choices: [] };
    if (q.img) { if (!/^[0-9a-f]{16}$/.test(q.img)) return null; o.img = q.img; }
    if (q.type === 'choice') {
      const ch = Array.isArray(q.choices) ? q.choices.map((c) => String(c || '').slice(0, 200)) : [];
      if (ch.length < 2 || ch.length > 5) return null;
      const a = Number(q.answer);
      if (!Number.isInteger(a) || a < 0 || a >= ch.length) return null;
      o.choices = ch; o.answer = a;
    } else {
      const al = (Array.isArray(q.answer) ? q.answer : []).map((x) => String(x || '').trim().slice(0, 100)).filter((x) => norm(x));
      if (!al.length) return null;
      o.answer = al;
    }
    questions.push(o);
  }
  return { title: String(d.title || '').slice(0, 60), questions };
}

function rank(rows) {
  return rows.sort((a, b) => (b.score - a.score) || (a.el - b.el) || (a.t - b.t));
}

module.exports = async function handler(req, res) {
  const { url, token } = redisEnv();
  if (!url || !token) { res.setHeader('Cache-Control', 'no-store'); return res.status(500).json({ ok: false, error: 'not_configured' }); }

  try {
    /* ---------- 학생: 읽기 ---------- */
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.img) {
        if (!/^[0-9a-f]{16}$/.test(String(q.img))) return res.status(400).end();
        const [b64] = await pipe([['GET', K.img(q.img)]]);
        if (!b64) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).end(); }
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.status(200).send(Buffer.from(b64, 'base64'));
      }
      const pub = await getPub();
      const now = Date.now();
      const waiting = pub.status === 'open' && now < pub.openedAt; // 카운트다운 중에는 문제를 절대 내주지 않음
      const out = Object.assign({}, pub, { now });
      if (waiting) delete out.questions;
      res.setHeader('Cache-Control', 'public, max-age=1'); // 브라우저는 1초만 기억
      // 버셀 CDN은 평소 2초, 카운트다운 중에는 1초(공개 순간을 놓치지 않게). 서버 오류 때는 10분까지 마지막 정상 응답
      // 공개 1.5초 전부터는 "아직 문제 없음" 응답을 CDN에 남기지 않음 → 0초에 받은 요청이 바로 문제를 받음
      // 숨김(off) 상태는 15초: 하루 종일 사이트를 열어 둔 휴대폰이 많아도 서버·Redis 호출이 거의 없음
      res.setHeader('Vercel-CDN-Cache-Control', waiting && pub.openedAt - now < 1500 ? 'no-store' : `max-age=${waiting ? 1 : pub.status === 'off' || !pub.id ? 15 : 2}, stale-if-error=600`);
      return res.status(200).json(out);
    }

    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'bad_request' });

    /* ---------- 학생: 제출 ---------- */
    if (body.action === 'submit') {
      const sid = String(body.sid || '').trim();
      const name = String(body.name || '').trim();
      if (!SID_RE.test(sid)) return res.status(400).json({ ok: false, error: 'bad_sid' });
      if (!name || name.length > 20) return res.status(400).json({ ok: false, error: 'bad_name' });
      const nonce = String(body.nonce || '').slice(0, 40);

      const id = String(body.quizId || '');
      const [state, def] = await getSD();
      if (!def || !state.id || id !== state.id) return res.status(409).json({ ok: false, error: 'stale' });
      const now = Date.now();
      if (state.status === 'open' && now < state.openedAt) return res.status(409).json({ ok: false, error: 'closed' });
      const live = state.status === 'open' ||(state.status === 'closed' && state.closedAt && now - state.closedAt <= GRACE_MS);
      if (!live) return res.status(409).json({ ok: false, error: 'closed' });

      const ans = Array.isArray(body.ans) ? body.ans.map((a) => String(a == null ? '' : a).slice(0, 50)) : null;
      if (!ans || ans.length !== def.questions.length) return res.status(400).json({ ok: false, error: 'bad_answers' });

      const g = grade(def, ans);
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      const rec = {
        sid, name, ans, score: g.score, ok: g.ok, t: now, el: Math.max(0, now - (state.openedAt || now)),
        ce: Math.max(0, Math.round(Number(body.ce) || 0)), tries: Math.max(1, Math.min(99, Math.round(Number(body.tries) || 1))), code, nonce,
      };
      const [added, size] = await pipe([['HSETNX', K.sub(id), sid, JSON.stringify(rec)], ['HLEN', K.sub(id)]]);
      if (added === 1) {
        if (size > MAX_SUBS) { await pipe([['HDEL', K.sub(id), sid]]); return res.status(429).json({ ok: false, error: 'full' }); }
        return res.status(200).json({ ok: true, code, at: now });
      }
      const [old] = await pipe([['HGET', K.sub(id), sid]]);
      const prev = jparse(old, null);
      if (prev && nonce && prev.nonce === nonce) return res.status(200).json({ ok: true, code: prev.code, at: prev.t }); // 같은 휴대폰의 재시도
      await pipe([['LPUSH', K.dup(id), JSON.stringify({ sid, name, t: now })], ['LTRIM', K.dup(id), 0, 499]]);
      return res.status(409).json({ ok: false, error: 'duplicate' });
    }

    /* ---------- 선생님 ---------- */
    const { ADMIN_PASSWORD } = process.env;
    if (!ADMIN_PASSWORD) return res.status(500).json({ ok: false, error: 'not_configured' });
    if (!same(body.password || '', ADMIN_PASSWORD)) { await sleep(1200); return res.status(401).json({ ok: false, error: 'wrong_password' }); }

    forget(); // 선생님은 항상 최신 상태로
    const [state, def] = await getSD();

    if (body.action === 'qget') { // 수정 화면을 열 때마다 학생용 응답도 다시 만들어 둠 (혹시 어긋나 있어도 스스로 복구)
      await pipe([['SET', K.pub, JSON.stringify(publicQuiz(state, def))]]);
      forget();
      return res.status(200).json({ ok: true, state, def });
    }

    if (body.action === 'qhealth') { // 행사 전 점검: 저장소 응답 시간과 현재 제출 수
      const t0 = Date.now();
      const [pong, n] = await pipe([['PING'], ['HLEN', K.sub(state.id || '-')]]);
      return res.status(200).json({ ok: pong === 'PONG', ms: Date.now() - t0, n, state });
    }

    if (body.action === 'qsave') {
      if (state.status === 'open' || state.status === 'closed') return res.status(409).json({ ok: false, error: 'quiz_open' }); // 채점이 끝난 회차의 문제를 바꾸지 못하게 (새 회차를 만든 뒤 수정)
      const d = cleanDef(body.def);
      if (!d) return res.status(400).json({ ok: false, error: 'bad_quiz' });
      await writeState(state, d, true);
      return res.status(200).json({ ok: true, def: d });
    }

    if (body.action === 'qimg') {
      const b64 = String(body.data || '').replace(/^data:image\/\w+;base64,/, '');
      if (!b64 || b64.length > 800000 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return res.status(400).json({ ok: false, error: 'bad_image' });
      const key = crypto.createHash('sha1').update(b64).digest('hex').slice(0, 16);
      await pipe([['SET', K.img(key), b64]]);
      return res.status(200).json({ ok: true, key });
    }

    if (body.action === 'qstatus') {
      const next = Object.assign({}, state);
      if (body.status !== undefined) {
        if (!['off', 'ready', 'open', 'closed'].includes(body.status)) return res.status(400).json({ ok: false, error: 'bad_status' });
        if (body.status !== 'off' && (!def || !next.id)) return res.status(409).json({ ok: false, error: 'no_quiz' });
        if (body.status === 'open' && !next.openedAt) next.openedAt = Date.now() + COUNTDOWN_MS; // 공개 예정 시각 = 순위 시간 기준. 처음 한 번만 기록 (다시 열어도 유지)
        if (body.status === 'closed' && next.status !== 'closed') next.closedAt = Date.now();
        next.status = body.status;
      }
      if (body.reveal !== undefined) next.reveal = !!body.reveal;
      await writeState(next, def);
      return res.status(200).json({ ok: true, state: next });
    }

    if (body.action === 'qnew') {
      if (!def) return res.status(409).json({ ok: false, error: 'no_quiz' });
      const next = { id: Date.now().toString(36), status: 'ready', reveal: false, openedAt: 0, closedAt: 0 };
      await writeState(next, def);
      return res.status(200).json({ ok: true, state: next });
    }

    if (body.action === 'qreset') { // 연습용: 지금 회차의 제출 기록을 지우고 새 회차를 대기 상태로 (학생 휴대폰의 제출 잠금도 새 id를 받으면 풀림)
      if (!def) return res.status(409).json({ ok: false, error: 'no_quiz' });
      if (state.id) await pipe([['DEL', K.sub(state.id)], ['DEL', K.dup(state.id)]]);
      const next = { id: Date.now().toString(36), status: 'ready', reveal: false, openedAt: 0, closedAt: 0 };
      await writeState(next, def);
      return res.status(200).json({ ok: true, state: next });
    }

    if (body.action === 'qcount') {
      if (!state.id) return res.status(200).json({ ok: true, n: 0 });
      const [n] = await pipe([['HLEN', K.sub(state.id)]]);
      return res.status(200).json({ ok: true, n });
    }

    if (body.action === 'qresults') {
      if (!state.id) return res.status(200).json({ ok: true, rows: [], dups: [], right: [], total: 0, n: 0, state, title: def ? def.title : '' });
      const [flat, dl] = await pipe([['HGETALL', K.sub(state.id)], ['LRANGE', K.dup(state.id), 0, 499]]);
      const rows = [], nq = def ? def.questions.length : 0, right = new Array(nq).fill(0);
      for (let i = 1; i < flat.length; i += 2) {
        const r = jparse(flat[i], null);
        if (!r) continue;
        rows.push({ sid: r.sid, name: r.name, score: r.score, el: r.el, ce: r.ce, tries: r.tries, code: r.code, t: r.t });
        (r.ok || []).forEach((v, k) => { if (v && k < nq) right[k]++; });
      }
      rank(rows);
      return res.status(200).json({ ok: true, total: rows.length, n: nq, rows, right, dups: dl.map((x) => jparse(x, {})), state, title: def ? def.title : '' });
    }

    return res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ ok: false, error: 'redis' });
  }
};
