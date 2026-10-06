// 월간 운동 정리 — 순수 계산 (브라우저·Node 모두에서 동작)
// 입력은 앱이 이미 저장하는 데이터 그대로:
//   days  : daily/{아이}.json 의 days   { 'YYYY-MM-DD': { v:{항목id:값}, g:{항목id: true|목표}, note } }
//   recs  : records/{아이}.json 의 records [{ at, poomsaeId, total, max, values:{...} }]
//   items : 현재 운동 목록 [{ id, name, type, goal, unit, optional }]

const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export function shiftMonth(mk, n) {
  const [y, m] = mk.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + n, 1));
}
const localDay = (iso) => new Date(iso).toLocaleDateString('sv-SE');

// 그날 기준 목표: 기록 당시 스냅숏(g)이 있으면 그것, 없으면 현재 목록 (오늘은 항상 현재 목록)
function goalsFor(key, entry, items, todayKey) {
  if (key !== todayKey && entry?.g) return entry.g;
  return Object.fromEntries(items.filter((i) => !i.optional).map((i) => [i.id, i.type === 'check' ? true : (i.goal ?? 1)]));
}
const met = (g, v) => (g === true ? v === true : Number(v) >= g);

export function dayInfo(key, days, recs, items, todayKey) {
  const e = days[key], v = e?.v ?? {}, g = goalsFor(key, e, items, todayKey);
  const ids = Object.keys(g), done = ids.filter((id) => met(g[id], v[id])).length;
  const poomsae = recs.filter((r) => localDay(r.at) === key).length;
  const any = Object.values(v).some((x) => x === true || Number(x) > 0) || poomsae > 0;
  return { key, required: ids.length, done, full: ids.length > 0 && done === ids.length, active: any, poomsae };
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const pct = (r) => (r.max ? (r.total / r.max) * 100 : NaN);

/**
 * mk: 'YYYY-MM', ctx: { days, recs, items, poomsaeName(id)→이름, metrics(설정), todayKey }
 */
export function computeMonth(mk, ctx) {
  const { days, recs, items, todayKey } = ctx;
  const [y, m] = mk.split('-').map(Number);
  const nDays = new Date(y, m, 0).getDate();
  const curMk = todayKey.slice(0, 7);
  const future = mk > curMk;
  const elapsed = future ? 0 : mk === curMk ? Number(todayKey.slice(8, 10)) : nDays;

  // 날짜별
  const daily = [];
  for (let d = 1; d <= nDays; d++) {
    const key = `${mk}-${pad(d)}`;
    daily.push(d <= elapsed ? dayInfo(key, days, recs, items, todayKey) : { key, future: true });
  }
  const past = daily.filter((x) => !x.future);
  const activeDays = past.filter((x) => x.active).length;
  const fullDays = past.filter((x) => x.full).length;
  let best = 0, run = 0;
  for (const x of past) { run = x.active ? run + 1 : 0; best = Math.max(best, run); }

  // 운동 항목별 — 이달에 값이 있는 항목은 목록에서 지워졌어도 포함
  const monthKeys = past.map((x) => x.key);
  const ids = new Set(items.map((i) => i.id));
  for (const k of monthKeys) for (const id of Object.keys(days[k]?.v ?? {})) ids.add(id);
  const itemStats = [...ids].map((id) => {
    const it = items.find((i) => i.id === id);
    const vals = monthKeys.map((k) => ({ k, v: days[k]?.v?.[id], g: goalsFor(k, days[k], items, todayKey)[id] }));
    const isCheck = it ? it.type === 'check' : vals.some((x) => x.v === true);
    const doneDays = vals.filter((x) => (isCheck ? x.v === true : Number(x.v) > 0)).length;
    const goalDays = vals.filter((x) => x.g !== undefined && met(x.g, x.v)).length;
    const total = isCheck ? doneDays : vals.reduce((s, x) => s + (Number(x.v) || 0), 0);
    return {
      id, name: it?.name ?? '(목록에서 뺀 항목)', type: isCheck ? 'check' : 'count', unit: it?.unit ?? '',
      removed: !it, optional: !!it?.optional, doneDays, goalDays, total,
      perDay: !isCheck && doneDays ? Math.round(total / doneDays) : null,
    };
  }).filter((s) => !s.removed || s.doneDays > 0);

  // 품새
  const mRecs = recs.filter((r) => localDay(r.at).startsWith(mk)).sort((a, b) => (a.at < b.at ? -1 : 1));
  const byP = {};
  for (const r of mRecs) (byP[r.poomsaeId] ??= []).push(r);
  const metrics = ctx.metrics || {};
  const poomsae = Object.entries(byP).map(([pid, rs]) => {
    // 변화: 기록이 4개 이상이면 처음 3개 평균 → 마지막 3개 평균, 아니면 첫 기록 → 마지막 기록
    const k = rs.length >= 4 ? 3 : 1;
    const head = rs.slice(0, k), tail = rs.slice(-k);
    const change = Object.keys(metrics).filter((mid) => mid !== 'reference').map((mid) => {
      const a = avg(head.map((r) => r.values?.[mid]).filter(Number.isFinite));
      const b = avg(tail.map((r) => r.values?.[mid]).filter(Number.isFinite));
      if (!Number.isFinite(a) || !Number.isFinite(b) || rs.length < 2) return null;
      const better = metrics[mid].better === 'lower' ? b < a : b > a;
      return { id: mid, label: metrics[mid].label, unit: metrics[mid].unit ?? '', from: +a.toFixed(2), to: +b.toFixed(2), improved: better, same: Math.abs(b - a) < 1e-9 };
    }).filter(Boolean);
    return {
      id: pid, name: ctx.poomsaeName?.(pid) ?? pid, count: rs.length,
      avgScore: Math.round(avg(rs.map(pct))),
      firstScore: Math.round(avg(head.map(pct))), lastScore: Math.round(avg(tail.map(pct))),
      basis: k === 3 ? '처음 3회 → 마지막 3회 평균' : '첫 기록 → 마지막 기록',
      change,
    };
  }).sort((a, b) => b.count - a.count);

  const notes = monthKeys.filter((k) => days[k]?.note?.trim()).map((k) => ({ key: k, note: days[k].note.trim() }));

  return {
    month: mk, nDays, elapsed, inProgress: mk === curMk, future,
    activeDays, fullDays, bestStreak: best,
    activeRate: elapsed ? Math.round((activeDays / elapsed) * 100) : 0,
    daily, items: itemStats,
    poomsaeCount: mRecs.length,
    poomsaeAvg: mRecs.length ? Math.round(avg(mRecs.map(pct))) : null,
    poomsae, notes,
  };
}

// 지난달과 비교: 진행 중인 달은 지난달의 같은 기간(1일~오늘 날짜)과 비교해야 공정하다
export function comparePrev(rep, prev) {
  if (!prev || prev.future || !prev.elapsed || !rep.elapsed) return null;
  const n = rep.inProgress ? Math.min(rep.elapsed, prev.nDays) : prev.nDays;
  const prevActive = prev.daily.slice(0, n).filter((x) => x.active).length;
  const curActive = rep.daily.slice(0, rep.inProgress ? n : rep.nDays).filter((x) => x.active).length;
  return { delta: curActive - prevActive, prevActive, basis: rep.inProgress ? `지난달 같은 기간(1~${n}일)` : '지난달' };
}

// 카톡 등에 붙여 넣을 요약 문장
export function summaryText(rep, prev, childName) {
  const [y, m] = rep.month.split('-');
  const L = [`[${childName} ${y}년 ${Number(m)}월 운동 정리${rep.inProgress ? ` (${rep.elapsed}일째)` : ''}]`];
  L.push(`운동한 날 ${rep.activeDays}일 / ${rep.elapsed}일 (목표 달성 ${rep.fullDays}일, 최장 ${rep.bestStreak}일 연속)`);
  const cp = comparePrev(rep, prev);
  if (cp) L.push(`${cp.basis}보다 운동한 날 ${cp.delta >= 0 ? '+' : ''}${cp.delta}일`);
  for (const s of rep.items) {
    if (!s.doneDays) continue;
    L.push(s.type === 'check'
      ? `· ${s.name}: ${s.doneDays}일`
      : `· ${s.name}: ${s.doneDays}일, 총 ${s.total.toLocaleString('ko-KR')}${s.unit} (하루 평균 ${s.perDay}${s.unit}), 목표 달성 ${s.goalDays}일`);
  }
  if (rep.poomsaeCount) {
    L.push(`품새 연습 ${rep.poomsaeCount}회, 평균 ${rep.poomsaeAvg}점`);
    for (const p of rep.poomsae) L.push(p.count > 1 ? `· ${p.name} ${p.count}회: ${p.firstScore}점 → ${p.lastScore}점` : `· ${p.name} 1회: ${p.lastScore}점`);
  }
  return L.join('\n');
}
