/**
 * 선생님 수정 저장 (Vercel 서버 함수)
 *
 * 학생 화면은 이 함수를 전혀 부르지 않고, 정적 파일 data.json만 읽습니다.
 * 저장할 때만 비밀번호를 확인하고 깃허브의 data.json을 고칩니다.
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const { ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_REPO } = process.env;
  const BRANCH = process.env.GITHUB_BRANCH || 'main';
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
  if (body.action !== 'save') return res.status(400).json({ ok: false, error: 'unknown_action' });
  if (!validData(body.data)) return res.status(400).json({ ok: false, error: 'bad_data' });

  const updated = new Date().toISOString();
  const text = JSON.stringify({ updated, data: body.data }, null, 1) + '\n';
  if (text.length > 300000) return res.status(413).json({ ok: false, error: 'too_large' });

  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/data.json`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hanumul-festival-app',
  };

  try {
    // 현재 파일의 sha가 있어야 덮어쓸 수 있어요. 동시에 두 사람이 저장하면 한 번 다시 시도합니다.
    for (let attempt = 0; attempt < 2; attempt++) {
      let sha;
      const cur = await fetch(`${url}?ref=${encodeURIComponent(BRANCH)}`, { headers });
      if (cur.ok) sha = (await cur.json()).sha;
      else if (cur.status !== 404) return res.status(502).json({ ok: false, error: 'github_read_' + cur.status });

      const put = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `한우물제 안내 수정 (${updated})`,
          content: Buffer.from(text, 'utf8').toString('base64'),
          branch: BRANCH,
          sha,
        }),
      });
      if (put.ok) return res.status(200).json({ ok: true, updated });
      if (put.status !== 409 && put.status !== 422) {
        return res.status(502).json({ ok: false, error: 'github_write_' + put.status });
      }
    }
    return res.status(409).json({ ok: false, error: 'conflict' });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'github_unreachable' });
  }
};
