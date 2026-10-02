// 품새 정량 지표 계산 모듈 — 카메라/브라우저 없이도 동작하는 순수 함수만 둔다.
// 입력: MediaPipe Pose Landmarker 결과 (landmarks: 화면 정규좌표, worldLandmarks: 골반 중심 3D 미터 좌표)

export const J = { ls: 11, rs: 12, le: 13, re: 14, lw: 15, rw: 16, lh: 23, rh: 24, lk: 25, rk: 26, la: 27, ra: 28 };

// 비교에 쓰는 8개 관절각 (순서 고정 — 기준 동작 파일과 호환되므로 바꾸지 말 것)
export const ANGLES = [
  { name: '왼팔 팔꿈치', p: [J.ls, J.le, J.lw] },
  { name: '오른팔 팔꿈치', p: [J.rs, J.re, J.rw] },
  { name: '왼쪽 어깨', p: [J.lh, J.ls, J.le] },
  { name: '오른쪽 어깨', p: [J.rh, J.rs, J.re] },
  { name: '왼쪽 골반', p: [J.ls, J.lh, J.lk] },
  { name: '오른쪽 골반', p: [J.rs, J.rh, J.rk] },
  { name: '왼쪽 무릎', p: [J.lh, J.lk, J.la] },
  { name: '오른쪽 무릎', p: [J.rh, J.rk, J.ra] },
];
const IDX = { elbowL: 0, elbowR: 1, kneeL: 6, kneeR: 7 };
const BODY = [J.ls, J.rs, J.lh, J.rh, J.lk, J.rk, J.la, J.ra];

function angle3(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y, a.z - b.z];
  const v2 = [c.x - b.x, c.y - b.y, c.z - b.z];
  const n1 = Math.hypot(...v1), n2 = Math.hypot(...v2);
  if (n1 < 1e-6 || n2 < 1e-6) return NaN;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]) / (n1 * n2);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

// 프레임 1장 → 저장용 특징값 {t, ok, a[8], k, l}
export function frameFeatures(img, world, t, minVis = 0.5) {
  if (!img || !world) return { t, ok: false };
  const ok = BODY.every((i) => (img[i].visibility ?? 1) >= minVis);
  const a = ANGLES.map((d) => +angle3(world[d.p[0]], world[d.p[1]], world[d.p[2]]).toFixed(1));

  // 발차기 높이비: (지지발 발목 y − 차는발 발목 y) / (지지발 발목 y − 골반중심 y), 화면좌표(y 아래로 증가)
  // 0 = 두 발이 같은 높이, 1.0 = 차는 발목이 골반 높이
  const hipY = (img[J.lh].y + img[J.rh].y) / 2;
  const sup = Math.max(img[J.la].y, img[J.ra].y);
  const kickY = Math.min(img[J.la].y, img[J.ra].y);
  const den = sup - hipY;
  const k = den > 0.05 ? +((sup - kickY) / den).toFixed(3) : null;

  // 몸통 기울기: 골반중심→어깨중심 벡터와 수직선 사이 각 (world 좌표, y 아래로 증가)
  const sx = (world[J.ls].x + world[J.rs].x) / 2, sy = (world[J.ls].y + world[J.rs].y) / 2, sz = (world[J.ls].z + world[J.rs].z) / 2;
  const hx = (world[J.lh].x + world[J.rh].x) / 2, hy = (world[J.lh].y + world[J.rh].y) / 2, hz = (world[J.lh].z + world[J.rh].z) / 2;
  const v = [sx - hx, sy - hy, sz - hz];
  const nv = Math.hypot(...v);
  const l = nv > 1e-6 ? +((Math.acos(Math.max(-1, Math.min(1, -v[1] / nv))) * 180) / Math.PI).toFixed(1) : null;

  return { t, ok, a, k, l };
}

export function percentile(arr, p) {
  const s = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// 5점 이동 중앙값 — 관절점이 한두 프레임 튀는 것을 제거
export function median5(arr) {
  return arr.map((_, i) => {
    const w = arr.slice(Math.max(0, i - 2), i + 3).filter((x) => Number.isFinite(x));
    if (!w.length) return NaN;
    w.sort((x, y) => x - y);
    return w[Math.floor(w.length / 2)];
  });
}

export function starsFor(value, m) {
  if (!Number.isFinite(value)) return 0;
  if (m.better === 'lower') return value <= m.stars3 ? 3 : value <= m.stars2 ? 2 : 1;
  return value >= m.stars3 ? 3 : value >= m.stars2 ? 2 : 1;
}

// 기록 전체 → 지표값. 각 지표의 정의가 곧 판정 근거.
export function computeMetrics(frames) {
  const v = frames.filter((f) => f.ok);
  if (v.length < 20) return { error: '몸 전체가 화면에 잘 보이지 않았어요. 머리부터 발끝까지 들어오게 다시 서 주세요.' };

  const col = (fn) => median5(v.map(fn));
  const kick = col((f) => (f.k == null ? NaN : f.k));
  const kneeMin = col((f) => Math.min(f.a[IDX.kneeL], f.a[IDX.kneeR]));
  const elbowMax = col((f) => Math.max(f.a[IDX.elbowL], f.a[IDX.elbowR]));
  const lean = col((f) => (f.l == null ? NaN : f.l));

  // 낮게 서기: 발차기 중이 아닌 프레임(k<0.15)에서 더 굽힌 쪽 무릎각의 하위 10%
  const stanceVals = kneeMin.filter((_, i) => !(kick[i] >= 0.15));
  const kickFinite = kick.filter(Number.isFinite);

  return {
    validFrames: v.length,
    totalFrames: frames.length,
    duration: +((frames[frames.length - 1].t - frames[0].t) / 1000).toFixed(1),
    values: {
      stance: +percentile(stanceVals, 0.1).toFixed(1),   // 더 굽힌 무릎각 하위 10% (°)
      punch: +percentile(elbowMax, 0.9).toFixed(1),      // 더 편 팔꿈치각 상위 10% (°)
      kick: kickFinite.length ? +Math.max(...kickFinite).toFixed(2) : NaN, // 최대 발차기 높이비
      posture: +percentile(lean, 0.9).toFixed(1),        // 몸통 기울기 상위 10% (°)
    },
  };
}

// 시퀀스 길이를 maxLen 이하로 균등 추출
export function decimate(arr, maxLen) {
  if (arr.length <= maxLen) return arr;
  const step = arr.length / maxLen;
  return Array.from({ length: maxLen }, (_, i) => arr[Math.floor(i * step)]);
}

// DTW(동적 시간 정렬) 경로: 두 관절각 시퀀스에서 서로 대응하는 프레임 쌍 [[i,j],...]
function dtwPath(U, R) {
  const n = U.length, m = R.length, K = ANGLES.length;
  const cost = (i, j) => {
    let s = 0, c = 0;
    for (let q = 0; q < K; q++) {
      const d = Math.abs(U[i].a[q] - R[j].a[q]);
      if (Number.isFinite(d)) { s += d; c++; }
    }
    return c ? s / c : 180;
  };
  const dir = new Uint8Array(n * m); // 0 대각, 1 위(i-1), 2 왼쪽(j-1)
  let prev = new Float64Array(m).fill(Infinity), cur = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const c = cost(i, j);
      if (i === 0 && j === 0) { cur[j] = c; continue; }
      const d0 = i > 0 && j > 0 ? prev[j - 1] : Infinity;
      const d1 = i > 0 ? prev[j] : Infinity;
      const d2 = j > 0 ? cur[j - 1] : Infinity;
      let best = d0, b = 0;
      if (d1 < best) { best = d1; b = 1; }
      if (d2 < best) { best = d2; b = 2; }
      cur[j] = c + best; dir[i * m + j] = b;
    }
    [prev, cur] = [cur, prev];
  }
  const path = [];
  let i = n - 1, j = m - 1;
  while (i >= 0 && j >= 0) {
    path.push([i, j]);
    if (i === 0 && j === 0) break;
    const b = dir[i * m + j];
    if (b === 0) { i--; j--; } else if (b === 1) i--; else j--;
  }
  path.reverse();
  return { path, cost };
}

// 기준 동작 비교: 빠르기 차이를 DTW로 흡수한 뒤 각도 차이를 평균
// user/ref: [{t, a:[8]}...]
export function compareToReference(user, ref, maxLen = 600, windowSec = 2) {
  const U = decimate(user, maxLen), R = decimate(ref, maxLen);
  const n = U.length;
  if (n < 10 || R.length < 10) return null;
  const K = ANGLES.length;
  const { path, cost } = dtwPath(U, R);

  const jointErr = new Array(K).fill(0), jointCnt = new Array(K).fill(0);
  const perUser = new Array(n).fill(0), perUserCnt = new Array(n).fill(0);
  let total = 0;
  for (const [pi, pj] of path) {
    const c = cost(pi, pj);
    total += c; perUser[pi] += c; perUserCnt[pi]++;
    for (let q = 0; q < K; q++) {
      const d = Math.abs(U[pi].a[q] - R[pj].a[q]);
      if (Number.isFinite(d)) { jointErr[q] += d; jointCnt[q]++; }
    }
  }
  const meanErr = total / path.length;
  const jErr = jointErr.map((s, q) => (jointCnt[q] ? s / jointCnt[q] : NaN));
  const worstJoint = jErr.reduce((w, e, q) => (e > jErr[w] ? q : w), 0);

  // 가장 차이가 큰 구간 (사용자 기록 기준 windowSec 이동평균 최대 지점)
  const pu = perUser.map((s, q) => (perUserCnt[q] ? s / perUserCnt[q] : 0));
  const t0 = U[0].t;
  const dtAvg = (U[n - 1].t - t0) / Math.max(1, n - 1) || 66;
  const w = Math.max(1, Math.round((windowSec * 1000) / dtAvg));
  let worstIdx = 0, worstVal = -1;
  for (let q = 0; q + w <= n; q++) {
    let s = 0;
    for (let r = q; r < q + w; r++) s += pu[r];
    if (s / w > worstVal) { worstVal = s / w; worstIdx = q + Math.floor(w / 2); }
  }

  const uDur = (user[user.length - 1].t - user[0].t) / 1000;
  const rDur = (ref[ref.length - 1].t - ref[0].t) / 1000;
  return {
    meanErr: +meanErr.toFixed(1),
    jointErr: jErr.map((e) => +e.toFixed(1)),
    worstJoint,
    worstJointName: ANGLES[worstJoint].name,
    worstAtSec: +((U[worstIdx].t - t0) / 1000).toFixed(1),
    tempo: rDur > 0 ? +(uDur / rDur).toFixed(2) : NaN,
  };
}

// 리플레이 비교용: A 영상 시각(ms) → 같은 동작인 B 영상 시각(ms) 함수
export function alignTimes(framesA, framesB, maxLen = 600) {
  const A = decimate(framesA.filter((f) => f.ok && f.a), maxLen);
  const B = decimate(framesB.filter((f) => f.ok && f.a), maxLen);
  if (A.length < 10 || B.length < 10) return null;
  const { path } = dtwPath(A, B);
  const sum = new Array(A.length).fill(0), cnt = new Array(A.length).fill(0);
  for (const [i, j] of path) { sum[i] += B[j].t; cnt[i]++; }
  const ta = A.map((f) => f.t), tb = sum.map((s, i) => s / cnt[i]);
  return (t) => {
    if (t <= ta[0]) return tb[0] + (t - ta[0]);
    if (t >= ta[ta.length - 1]) return tb[tb.length - 1] + (t - ta[ta.length - 1]);
    let lo = 0, hi = ta.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ta[mid] <= t) lo = mid; else hi = mid; }
    const r = (t - ta[lo]) / (ta[hi] - ta[lo] || 1);
    return tb[lo] + (tb[hi] - tb[lo]) * r;
  };
}

// 재생 위치(ms)에 가장 가까운 프레임 번호 (frames는 t 오름차순)
export function frameAt(frames, t) {
  let lo = 0, hi = frames.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (frames[mid].t <= t) lo = mid; else hi = mid; }
  return Math.abs(frames[hi].t - t) < Math.abs(frames[lo].t - t) ? hi : lo;
}
