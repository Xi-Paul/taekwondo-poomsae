// 리플레이 영상 저장소
// - native: Android APK 안에서 실행 중 → Movies/품새연습장 (갤러리에 보임), 관절은 Documents/품새연습장
// - folder: 사용자가 고른 폴더에 파일로 저장 (File System Access API — 지원 브라우저에서만)
// - app   : 브라우저 앱 저장공간(IndexedDB)에 저장 — 모든 브라우저
// 파일 구성: {아이id}/{품새id}/{날짜_시각}_{기록id}.{mp4|webm} + 같은 이름 .pose.json (관절 데이터·점수)

const DB = 'tkd-video';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('files'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    const req = fn(s);
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('저장공간이 부족하거나 저장이 취소되었어요.'));
  });
}
const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
const kvDel = (k) => tx('kv', 'readwrite', (s) => s.delete(k));

export const canPickFolder = typeof window.showDirectoryPicker === 'function';

// 녹화 형식: 휴대폰 갤러리·다른 앱 호환을 위해 mp4 우선, 안 되면 webm
export function pickRecorderType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const c = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = c.find((t) => MediaRecorder.isTypeSupported(t));
  return mime ? { mime, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' } : null;
}

// APK 브리지(동기 호출)와 주고받는 조각 크기
const CHUNK = 768 * 1024;
const MIME = { mp4: 'video/mp4', webm: 'video/webm' };
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
function b64ToBytes(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const splitBase = (base) => { const p = base.split('/'), name = p.pop(); return { sub: p.join('/'), name }; };
// 브리지 예외 메시지는 기기마다 달라 사람이 읽을 문장으로 감싼다
function bridge(fn, what) {
  try { return fn(); } catch (e) { throw new Error(`${what} 실패 (${e.message || e})`); }
}

export function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class VideoStore {
  async init() {
    this.folder = null; this.needsPermission = false; this.jsonUri = {};
    this.native = typeof window.TkdNative === 'object' && window.TkdNative ? window.TkdNative : null;
    if (this.native) return;
    try { this.folder = (await kvGet('folder')) || null; } catch {}
    if (this.folder) {
      try {
        const p = await this.folder.queryPermission({ mode: 'readwrite' });
        this.needsPermission = p !== 'granted';
      } catch { this.folder = null; }
    }
    try { this.persisted = await navigator.storage?.persisted?.(); } catch {}
  }
  get kind() { return this.native ? 'native' : this.folder ? 'folder' : 'app'; }
  get label() {
    if (this.native) return `휴대폰 ${bridge(() => this.native.folderLabel(), '폴더 확인')} 폴더`;
    return this.folder ? `선택한 폴더 "${this.folder.name}"` : '앱 저장공간';
  }

  async pickFolder() {
    const h = await window.showDirectoryPicker({ id: 'tkd-videos', mode: 'readwrite', startIn: 'videos' });
    await kvSet('folder', h);
    this.folder = h; this.needsPermission = false;
  }
  async useApp() { await kvDel('folder'); this.folder = null; this.needsPermission = false; }

  // 사용자 조작(버튼) 안에서 불러야 폴더 권한 요청 창이 뜬다
  async ensure() {
    if (this.native) return true;
    if (this.folder && this.needsPermission) {
      const p = await this.folder.requestPermission({ mode: 'readwrite' });
      this.needsPermission = p !== 'granted';
    }
    if (!this.persisted) { try { this.persisted = await navigator.storage?.persist?.(); } catch {} }
    return !this.needsPermission;
  }

  async #dir(parts, create) {
    let d = this.folder;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }

  // base: "{child}/{pid}/{stamp}_{id}"
  async save(base, ext, blob, meta) {
    const json = JSON.stringify(meta);
    if (this.native) {
      const N = this.native, { sub, name } = splitBase(base);
      const mime = MIME[ext] || (blob.type || '').split(';')[0] || 'video/mp4';
      const id = bridge(() => N.beginVideo(sub, `${name}.${ext}`, mime), '영상 파일 만들기');
      try {
        for (let o = 0; o < blob.size; o += CHUNK) {
          const b64 = await blobToB64(blob.slice(o, o + CHUNK));
          bridge(() => N.writeChunk(id, b64), '영상 쓰기');
        }
        bridge(() => N.endVideo(id), '영상 마무리');
      } catch (e) { try { N.abortVideo(id); } catch {} throw e; }
      this.jsonUri[base] = bridge(() => N.writeText(sub, `${name}.pose.json`, json), '관절 데이터 저장');
      return;
    }
    if (this.folder) {
      if (this.needsPermission) throw new Error('영상 폴더 접근 권한이 필요해요. 설정에서 폴더를 다시 연결해 주세요.');
      const parts = base.split('/'), name = parts.pop(), d = await this.#dir(parts, true);
      for (const [fname, data] of [[`${name}.${ext}`, blob], [`${name}.pose.json`, json]]) {
        const w = await (await d.getFileHandle(fname, { create: true })).createWritable();
        await w.write(data); await w.close();
      }
    } else {
      await tx('files', 'readwrite', (s) => { s.put(blob, `v:${base}`); return s.put(json, `m:${base}`); });
    }
  }

  // → [{base, meta}] 오래된 순
  async list(child, pid) {
    const out = [];
    if (this.native) {
      const N = this.native, files = JSON.parse(bridge(() => N.listJson(`${child}/${pid}`), '영상 목록 읽기'));
      for (const f of files) {
        try {
          const base = `${child}/${pid}/${f.name.slice(0, -10)}`;
          this.jsonUri[base] = f.uri;
          out.push({ base, meta: JSON.parse(N.readText(f.uri)) });
        } catch {}
      }
      return out.sort((a, b) => (a.meta.at < b.meta.at ? -1 : 1));
    }
    if (this.folder) {
      if (this.needsPermission) return null;
      let d;
      try { d = await this.#dir([child, pid], false); } catch { return out; }
      for await (const [name, h] of d.entries()) {
        if (h.kind !== 'file' || !name.endsWith('.pose.json')) continue;
        try { out.push({ base: `${child}/${pid}/${name.slice(0, -10)}`, meta: JSON.parse(await (await h.getFile()).text()) }); } catch {}
      }
    } else {
      const prefix = `m:${child}/${pid}/`;
      const keys = await tx('files', 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff')));
      for (const k of keys || []) {
        const raw = await tx('files', 'readonly', (s) => s.get(k));
        try { out.push({ base: k.slice(2), meta: JSON.parse(raw) }); } catch {}
      }
    }
    return out.sort((a, b) => (a.meta.at < b.meta.at ? -1 : 1));
  }

  #nativeVideoUri(base, ext) {
    const { sub, name } = splitBase(base);
    const uri = bridge(() => this.native.findVideo(sub, `${name}.${ext}`), '영상 찾기');
    if (!uri) throw new Error('영상 파일이 없어요. 갤러리에서 지워졌을 수 있어요.');
    return uri;
  }

  async video(base, ext) {
    if (this.native) {
      const N = this.native, uri = this.#nativeVideoUri(base, ext);
      const id = bridge(() => N.openRead(uri), '영상 열기'), parts = [];
      try {
        for (;;) {
          const b64 = bridge(() => N.readChunk(id, CHUNK), '영상 읽기');
          if (!b64) break;
          parts.push(b64ToBytes(b64));
          await new Promise((r) => setTimeout(r, 0)); // 화면이 멈추지 않게 조금씩
        }
      } finally { try { N.closeRead(id); } catch {} }
      return new Blob(parts, { type: MIME[ext] || 'video/mp4' });
    }
    if (this.folder) {
      const parts = base.split('/'), name = parts.pop(), d = await this.#dir(parts, false);
      return (await d.getFileHandle(`${name}.${ext}`)).getFile();
    }
    const b = await tx('files', 'readonly', (s) => s.get(`v:${base}`));
    if (!b) throw new Error('영상 파일을 찾지 못했어요.');
    return b;
  }

  async remove(base, ext) {
    if (this.native) {
      const N = this.native;
      try { N.remove(this.#nativeVideoUri(base, ext)); } catch {}
      if (this.jsonUri[base]) { try { N.remove(this.jsonUri[base]); } catch {} delete this.jsonUri[base]; }
      return;
    }
    if (this.folder) {
      const parts = base.split('/'), name = parts.pop(), d = await this.#dir(parts, false);
      for (const f of [`${name}.${ext}`, `${name}.pose.json`]) { try { await d.removeEntry(f); } catch {} }
    } else {
      await tx('files', 'readwrite', (s) => { s.delete(`v:${base}`); return s.delete(`m:${base}`); });
    }
  }

  // APK: 안드로이드 공유 창 (갤러리 영상이므로 카톡·드라이브 등으로 바로 보냄)
  shareNative(base, ext, title) {
    const uri = this.#nativeVideoUri(base, ext);
    bridge(() => this.native.share(uri, MIME[ext] || 'video/mp4', title), '공유');
  }

  async usage() {
    if (this.native) return null;
    try {
      const e = await navigator.storage.estimate();
      return { used: e.usage ?? 0, quota: e.quota ?? 0 };
    } catch { return null; }
  }
}
