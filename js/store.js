// 저장소: GitHub REST API(Contents)로 데이터 저장소의 JSON 파일을 읽고 쓴다.
// 토큰이 없으면 이 기기(localStorage)에 저장한다.

const SETTINGS_KEY = 'tkd:settings';

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class Store {
  constructor(s = loadSettings()) {
    this.s = s;
  }
  get remote() {
    return !!(this.s.owner && this.s.repo && this.s.token);
  }
  get label() {
    return this.remote ? `GitHub ${this.s.owner}/${this.s.repo}` : '이 기기';
  }
  url(path) {
    return `https://api.github.com/repos/${this.s.owner}/${this.s.repo}/contents/${path}`;
  }
  headers() {
    return {
      Authorization: `Bearer ${this.s.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  // → {data, sha} | null(파일 없음)
  async read(path) {
    if (!this.remote) {
      try {
        const raw = localStorage.getItem('tkd:' + path);
        return raw ? { data: JSON.parse(raw), sha: null } : null;
      } catch { return null; }
    }
    const branch = this.s.branch ? `?ref=${encodeURIComponent(this.s.branch)}` : '';
    const r = await fetch(this.url(path) + branch, { headers: this.headers(), cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub 읽기 실패 (${r.status}) ${path}`);
    const j = await r.json();
    if (!j.content) throw new Error(`파일이 1MB를 넘어 읽을 수 없어요: ${path}`);
    return { data: JSON.parse(fromB64(j.content)), sha: j.sha };
  }

  async write(path, data, sha, message) {
    const text = JSON.stringify(data, null, 1);
    if (!this.remote) {
      localStorage.setItem('tkd:' + path, text);
      return { sha: null };
    }
    const body = { message: message || `update ${path}`, content: toB64(text) };
    if (sha) body.sha = sha;
    if (this.s.branch) body.branch = this.s.branch;
    const r = await fetch(this.url(path), { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) {
      const e = new Error('conflict'); e.conflict = true; throw e;
    }
    if (!r.ok) throw new Error(`GitHub 저장 실패 (${r.status}) ${path}`);
    const j = await r.json();
    return { sha: j.content?.sha };
  }

  // 읽고-고치고-쓰기. 다른 기기가 먼저 썼으면(sha 충돌) 다시 읽어 3번까지 재시도.
  async update(path, mutate, init, message) {
    for (let tryNo = 0; tryNo < 3; tryNo++) {
      const cur = await this.read(path);
      const data = mutate(cur ? cur.data : structuredClone(init));
      try {
        return await this.write(path, data, cur?.sha, message);
      } catch (e) {
        if (!e.conflict) throw e;
      }
    }
    throw new Error('다른 기기와 동시에 저장되어 실패했어요. 잠시 후 다시 저장해 주세요.');
  }

  async test() {
    if (!this.remote) return '토큰이 없어서 이 기기에 저장해요.';
    const r = await fetch(`https://api.github.com/repos/${this.s.owner}/${this.s.repo}`, { headers: this.headers(), cache: 'no-store' });
    if (!r.ok) throw new Error(`저장소에 접근할 수 없어요 (${r.status}). 저장소 이름과 토큰 권한을 확인해 주세요.`);
    const j = await r.json();
    if (j.permissions && !j.permissions.push) throw new Error('읽기만 가능한 토큰이에요. Contents 쓰기 권한이 필요해요.');
    return `연결됨: ${j.full_name}${j.private ? ' (비공개)' : ' (공개 — 기록이 누구에게나 보여요)'}`;
  }
}
