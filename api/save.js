/**
 * 선생님 수정 저장 · 공지 보내기 (Vercel 서버 함수)
 *
 * 학생 화면은 이 함수를 전혀 부르지 않고, 정적 파일 data.json, announce.json만 읽습니다.
 * 저장할 때만 비밀번호를 확인하고 깃허브의 파일을 고칩니다.
 * 깃허브가 바뀌면 버셀이 자동으로 새 버전을 배포합니다(약 1분).
 *
 * 버셀 프로젝트 > Settings > Environment Variables
 *   ADMIN_PASSWORD  수정용 비밀번호
 *   GITHUB_TOKEN    이 저장소의 Contents 읽기/쓰기 권한만 가진 토큰
 *   GITHUB_REPO     "아이디/저장소이름"  (예: geumjeong/hanumul)
 *   GITHUB_BRANCH   (선택) 기본값 main
 */
const crypto = require('crypto');

function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function validData(d) {
  return d && typeof d === 'object' && Array.isArray(d.program) &&
    typeof d.start === 'string' && typeof d.meetTime === 'string';
}

/* 깃허브 저장소의 파일 하나를 통째로 씀. 동시에 두 사람이 저장하면 한 번 다시 시도 */
async function writeRepoFile(path, text, message) {
  const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
  const BRANCH = process.env.GITHUB_BRANCH || 'main';
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hanumul-festival-app',
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    // 현재 파일의 sha가 있어야 덮어쓸 수 있어요
    let sha;
    const cur = await fetch(`${url}?ref=${encodeURIComponent(BRANCH)}`, { headers });
    if (cur.ok) sha = (await cur.json()).sha;
    else if (cur.status !== 404) return { status: 502, error: 'github_read_' + cur.status };

    const put = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: Buffer.from(text, 'utf8').toString('base64'), branch: BRANCH, sha }),
    });
    if (put.ok) return { status: 200 };
    if (put.status !== 409 && put.status !== 422) return { status: 502, error: 'github_write_' + put.status };
  }
  return { status: 409, error: 'conflict' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const { ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_REPO } = process.env;
  if (!ADMIN_PASSWORD || !GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ ok: false, error: 'not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'bad_request' });

  if (!same(body.password || '', ADMIN_PASSWORD)) {
    await sleep(1200); // 비밀번호 무작위 대입을 느리게
    return res.status(401).json({ ok: false, error: 'wrong_password' });
  }
  if (body.action === 'check') return res.status(200).json({ ok: true });

  const now = new Date();
  const updated = now.toISOString();
  let path, text, message, extra = {};

  if (body.action === 'save') {
    if (!validData(body.data)) return res.status(400).json({ ok: false, error: 'bad_data' });
    path = 'data.json';
    text = JSON.stringify({ updated, data: body.data }, null, 1) + '\n';
    message = `한우물제 안내 수정 (${updated})`;
    if (text.length > 300000) return res.status(413).json({ ok: false, error: 'too_large' });
  } else if (body.action === 'announce') {
    // 학생 화면 공지: 1~200자, 5·10·30분 동안 표시
    const msg = String(body.text || '').trim();
    const minutes = [5, 10, 30].includes(+body.minutes) ? +body.minutes : 10;
    if (!msg || msg.length > 200) return res.status(400).json({ ok: false, error: 'bad_text' });
    const until = new Date(now.getTime() + minutes * 60000).toISOString();
    extra = { id: updated, text: msg, at: updated, until };
    path = 'announce.json';
    text = JSON.stringify(extra, null, 1) + '\n';
    message = `한우물제 공지 (${updated})`;
  } else if (body.action === 'unannounce') {
    path = 'announce.json';
    text = JSON.stringify({ id: '', text: '', at: '', until: '' }, null, 1) + '\n';
    message = `한우물제 공지 내림 (${updated})`;
  } else {
    return res.status(400).json({ ok: false, error: 'unknown_action' });
  }

  try {
    const r = await writeRepoFile(path, text, message);
    if (r.status === 200) return res.status(200).json({ ok: true, updated, announce: extra });
    return res.status(r.status).json({ ok: false, error: r.error });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'github_unreachable' });
  }
};
