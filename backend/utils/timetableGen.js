"use strict";
/**
 * Timetable generator (one semester at a time).
 *
 * Pure function: everything it needs is passed in, nothing is read from the database here.
 *
 *   solve({
 *     grid:      { days:["Monday",...], start:"09:00", end:"17:00", slot_minutes:60, breaks:[{start,end}], max_per_day:6 },
 *     divisions: [{ id, name, size, room? }]            one entry { id:null } when the semester has no divisions; room = home classroom
 *     subjects:  [{ id, name, code, teacher_id, teacher_name, teachers?:{ [division_id]:{ id, name } },
 *                   lecture, lecture_periods?, tutorial, lab:{ sessions, periods }, when? }]
 *     groups:    [{ group, periods, lecture_periods?, tutorial, lab?:{ sessions, periods }, when?,
 *                   options:[{ id, name, code, teacher_id, teacher_name, students, has_tutorial, has_lab }] }]
 *     common:    [{ id, title, sessions, periods, days?, when?, teacher_name? }]   all divisions together, no teacher or room
 *     when:      "any" | "morning" | "afternoon"   (a preference, not a rule)
 *     rooms:     { saved, classrooms:[{name,capacity}], labs:[{name,capacity}] }   saved=false -> rooms are not assigned
 *     external:  { teacher:{ [id]:[{day,s,e}] }, room:{ [KEY]:[{day,s,e}] } }       what other semesters/courses already use
 *     seed, attempts, time_ms
 *   }) -> { items, unplaced, warnings, stats }
 *
 * Hard rules: a teacher / room is never in two places at once (also across the college), a division is never in two
 * places at once, electives of a group run at the same time for every division (one room and teacher per option),
 * a subject appears once a day for a division (a lab or a lecture; tutorials are exempt), labs are one contiguous
 * block, batches of a division run different labs at the same time, rooms are big enough, nothing in a break.
 * Soft rules (scored): spread over the week, few gaps, labs later in the day, same room kept, smallest room that fits.
 */

const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const up = (v) => String(v || "").trim().toUpperCase();

function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The periods of one day: [{ s, e }] (minutes), breaks removed. */
function buildUnits(grid) {
  const step = Math.max(15, Number(grid.slot_minutes) || 60);
  const start = toMin(grid.start), end = toMin(grid.end);
  const breaks = (grid.breaks || []).map((b) => [toMin(b.start), toMin(b.end)]).filter(([a, b]) => b > a);
  const units = [];
  for (let s = start; s + step <= end; s += step) {
    const e = s + step;
    if (breaks.some(([a, b]) => s < b && a < e)) continue;
    units.push({ s, e });
  }
  return units;
}

/** Start indexes where `d` consecutive periods fit without a break in between. */
function runsOf(units, d) {
  const out = [];
  for (let i = 0; i + d <= units.length; i++) {
    let ok = true;
    for (let k = 1; k < d; k++) if (units[i + k].s !== units[i + k - 1].e) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

const overlap = (aS, aE, bS, bE) => aS < bE && bS < aE;

function buildLabRounds(labs, n) {
  // labs: [{ id, periods, sessions, teacher_id }]; every batch must do every lab `sessions` times.
  const remaining = [];
  for (let b = 0; b < n; b++) { remaining.push({}); labs.forEach((l) => { remaining[b][l.id] = l.sessions; }); }
  const rounds = [];
  const total = () => remaining.reduce((a, r) => a + Object.values(r).reduce((x, y) => x + y, 0), 0);
  let guard = 0;
  while (total() > 0 && guard++ < 500) {
    // the lab with the most work left decides the length of this round
    const left = {};
    labs.forEach((l) => { left[l.id] = remaining.reduce((a, r) => a + r[l.id], 0); });
    const lead = labs.filter((l) => left[l.id] > 0).sort((a, b) => left[b.id] - left[a.id])[0];
    const pool = labs.filter((l) => l.periods === lead.periods && left[l.id] > 0);
    const usedLab = new Set(), usedTeacher = new Set(), picks = [];
    const order = [...Array(n).keys()].sort((a, b) =>
      Object.values(remaining[b]).reduce((x, y) => x + y, 0) - Object.values(remaining[a]).reduce((x, y) => x + y, 0) || a - b);
    order.forEach((b) => {
      const cand = pool.filter((l) => remaining[b][l.id] > 0 && !usedLab.has(l.id) && !(l.teacher_id && usedTeacher.has(l.teacher_id)))
        .sort((x, y) => remaining[b][y.id] - remaining[b][x.id] || left[y.id] - left[x.id]);
      if (!cand.length) return;
      const l = cand[0];
      usedLab.add(l.id); if (l.teacher_id) usedTeacher.add(l.teacher_id);
      remaining[b][l.id]--; picks.push({ batch: b, lab: l });
    });
    if (!picks.length) break;
    rounds.push({ periods: lead.periods, picks });
  }
  return rounds;
}

function solve(input) {
  const grid = input.grid;
  const days = grid.days;
  const units = buildUnits(grid);
  const maxPerDay = Math.max(1, Number(grid.max_per_day) || units.length);
  const divisions = input.divisions && input.divisions.length ? input.divisions : [{ id: null, name: "", size: 0 }];
  const rooms = input.rooms || { saved: false, classrooms: [], labs: [] };
  const ext = input.external || { teacher: {}, room: {} };
  const warnings = [];
  const runCache = {};
  const runs = (d) => runCache[d] || (runCache[d] = runsOf(units, d));

  const common = input.common || [];
  const FULL = Number(grid.max_per_day) && Number(grid.max_per_day) < units.length ? "the per-day limit is already reached" : "every day is already full";
  // the teacher of a subject for one division (falls back to the subject's default teacher)
  const tOf = (s, dv) => {
    const t = dv && s.teachers && s.teachers[dv.id];
    return t && t.id ? t : { id: s.teacher_id, name: s.teacher_name };
  };
  // morning = before the first break (or the middle of the day when there is none)
  const brk = (grid.breaks || []).map((b) => toMin(b.start)).sort((a, b) => a - b);
  const noon = brk.length ? brk[0] : Math.floor((toMin(grid.start) + toMin(grid.end)) / 2);
  const whenPenalty = (when, u) => (when === "morning" ? (u.s >= noon ? 30 : 0) : when === "afternoon" ? (u.s < noon ? 30 : 0) : 0);

  // ── what has to be placed ────────────────────────────────────────────────
  const labSubjectsFor = (dv) => input.subjects.filter((s) => s.lab && s.lab.sessions > 0)
    .map((s) => { const t = tOf(s, dv); return { id: s.id, name: s.name, code: s.code, teacher_id: t.id, teacher_name: t.name, sessions: s.lab.sessions, periods: s.lab.periods || 1, when: s.lab.when || s.when }; });
  const labSubjects = labSubjectsFor(null);
  const maxLabCap = Math.max(0, ...(rooms.labs || []).map((r) => r.capacity || 0));
  const plans = divisions.map((dv) => {
    let n = 1;
    if (rooms.saved && maxLabCap > 0 && dv.size > maxLabCap) n = Math.ceil(dv.size / maxLabCap);
    if (n > 3) { warnings.push(`${dv.name ? "Division " + dv.name : "This semester"} has ${dv.size} students but the biggest lab holds ${maxLabCap}: it would need ${n} batches (the limit is 3). Add a bigger lab or split the division.`); n = 3; }
    if (n > 1 && labSubjects.length && labSubjects.length < n) {
      warnings.push(`${dv.name ? "Division " + dv.name : "This semester"} needs ${n} lab batches but has only ${labSubjects.length} lab subject(s): batches will take their lab in turns, so labs take longer.`);
    }
    return { dv, n, batchSize: Math.ceil((dv.size || 0) / n), rounds: labSubjects.length ? buildLabRounds(labSubjectsFor(dv), n) : [] };
  });

  const need = { lecture: 0, tutorial: 0, lab: 0, elective: 0, common: 0 };
  const eventsTpl = [];
  input.groups.forEach((g) => {
    for (let i = 0; i < g.periods; i++) { eventsTpl.push({ type: "elective", g, units: g.lecture_periods || 1, when: g.when, label: `Elective group ${g.group}` }); need.elective++; }
    // labs of an elective group: the options that have a lab meet together in lab rooms
    const labOpts = (g.options || []).filter((o) => o.has_lab);
    for (let i = 0; g.lab && i < (g.lab.sessions || 0) && labOpts.length; i++) { eventsTpl.push({ type: "elective", lab: true, g, opts: labOpts, units: g.lab.periods || 1, when: g.lab.when || g.when, label: `Elective group ${g.group} lab` }); need.elective++; }
    // tutorials of an elective group: the options that have a tutorial meet together, the others are simply free
    const tut = (g.options || []).filter((o) => o.has_tutorial);
    for (let i = 0; i < (g.tutorial || 0) && tut.length; i++) { eventsTpl.push({ type: "elective", tutorial: true, g, opts: tut, units: 1, when: g.when, label: `Elective group ${g.group} tutorial` }); need.elective++; }
  });
  common.forEach((c) => { for (let i = 0; i < (c.sessions || 0); i++) { eventsTpl.push({ type: "common", c, units: c.periods || 1, when: c.when, label: c.title }); need.common = (need.common || 0) + 1; } });
  plans.forEach((p) => p.rounds.forEach((r, ri) => {
    eventsTpl.push({ type: "lab", p, r, ri, units: r.periods, when: r.picks.map((x) => x.lab.when).find(Boolean), label: `Lab session${p.dv.name ? ", division " + p.dv.name : ""}` });
    need.lab += r.picks.length;
  }));
  divisions.forEach((dv) => input.subjects.forEach((s) => {
    for (let i = 0; i < (s.lecture || 0); i++) { eventsTpl.push({ type: "lecture", dv, s, units: s.lecture_periods || 1, when: s.when, label: s.name }); need.lecture++; }
    for (let i = 0; i < (s.tutorial || 0); i++) { eventsTpl.push({ type: "tutorial", dv, s, units: 1, label: `${s.name} tutorial` }); need.tutorial++; }
  }));

  // ── quick feasibility notes ──────────────────────────────────────────────
  const perDayPeriods = units.length;
  divisions.forEach((dv, di) => {
    let total = 0;
    input.groups.forEach((g) => {
      total += g.periods * (g.lecture_periods || 1) + ((g.options || []).some((o) => o.has_tutorial) ? (g.tutorial || 0) : 0);
      if (g.lab && (g.options || []).some((o) => o.has_lab)) total += (g.lab.sessions || 0) * (g.lab.periods || 1);
    });
    common.forEach((c) => { total += (c.sessions || 0) * (c.periods || 1); });
    input.subjects.forEach((s) => { total += (s.lecture || 0) * (s.lecture_periods || 1) + (s.tutorial || 0); });
    plans[di].rounds.forEach((r) => { total += r.periods; });
    const cap = Math.min(days.length * perDayPeriods, days.length * maxPerDay);
    if (total > cap) {
      const per = Math.min(units.length, maxPerDay);
      const limited = maxPerDay < units.length ? ` Your limit of ${maxPerDay} period${maxPerDay === 1 ? "" : "s"} a day is part of the reason: raise or remove it.` : "";
      warnings.push(`${dv.name ? "Division " + dv.name : "This semester"} needs ${total} periods a week but the week only has room for ${cap} (${days.length} day${days.length === 1 ? "" : "s"} × ${per} period${per === 1 ? "" : "s"}).${limited} Reduce some hours, add a working day, or lengthen the day.`);
    }
  });
  input.subjects.forEach((s) => {
    if (s.lecture + (s.lab ? s.lab.sessions || 0 : 0) > days.length && s.lecture > 0) warnings.push(`${s.name}: ${s.lecture} lectures${s.lab && s.lab.sessions ? " and " + s.lab.sessions + " lab sessions" : ""} a week can't fit in ${days.length} days (a subject appears once a day). Tutorials are exempt.`);
  });
  input.groups.forEach((g) => {
    const gl = g.lab && (g.options || []).some((o) => o.has_lab) ? (g.lab.sessions || 0) : 0;
    if (g.periods + gl > days.length) warnings.push(`Elective group ${g.group}: ${g.periods} lectures${gl ? " and " + gl + " lab sessions" : ""} a week can't fit in ${days.length} days (once a day).`);
  });
  const tLoad = {};
  const addLoad = (tid, name, n) => { if (!tid) return; (tLoad[tid] = tLoad[tid] || { name, n: 0 }).n += n; };
  input.subjects.forEach((s) => divisions.forEach((dv) => {
    const t = tOf(s, dv);
    addLoad(t.id, t.name, (s.lecture || 0) * (s.lecture_periods || 1) + (s.tutorial || 0) + (s.lab ? (s.lab.sessions || 0) * (s.lab.periods || 1) : 0));
  }));
  input.groups.forEach((g) => g.options.forEach((o) => addLoad(o.teacher_id, o.teacher_name, g.periods * (g.lecture_periods || 1) + (o.has_lab && g.lab ? (g.lab.sessions || 0) * (g.lab.periods || 1) : 0) + (o.has_tutorial ? g.tutorial || 0 : 0))));
  Object.entries(tLoad).forEach(([tid, t]) => {
    let free = 0;
    days.forEach((d) => units.forEach((u) => { if (!((ext.teacher[tid] || []).some((b) => b.day === d && overlap(u.s, u.e, b.s, b.e)))) free++; }));
    if (t.n > free) warnings.push(`${t.name || "A teacher"} is needed for ${t.n} periods but is only free for ${free} in this week's grid. Give some of their subjects to another teacher.`);
  });

  // ── one attempt ──────────────────────────────────────────────────────────
  function attempt(seed) {
    const rand = rng(seed);
    const classBusy = new Set();            // `${div}|${day}|${p}`
    const dayLoad = new Map();              // `${div}|${day}`
    const tBusy = new Map(), rBusy = new Map();   // key -> Set of `${day}|${p}`
    const tDay = new Map();                 // teacher|day -> periods
    const commonDay = new Set(), lectDay = new Set(), labAnyDay = new Set(), labBatchDay = new Set(), groupDay = new Set();
    const home = new Map();                 // `${div}` -> classroom, `lab|${sid}` -> lab
    divisions.forEach((dv) => { if (dv.room) home.set(`div|${String(dv.id)}`, dv.room); });
    const placed = [];
    const unplaced = [];
    let soft = 0;

    const key = (dv) => String(dv.id);
    const setHas = (m, k, v) => (m.get(k) || new Set()).has(v);
    const setAdd = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };

    const teacherFree = (tid, day, i, d) => {
      if (!tid) return true;
      for (let k = 0; k < d; k++) {
        const u = units[i + k];
        if (setHas(tBusy, tid, `${day}|${i + k}`)) return false;
        if ((ext.teacher[tid] || []).some((b) => b.day === day && overlap(u.s, u.e, b.s, b.e))) return false;
      }
      return true;
    };
    const roomFree = (name, day, i, d) => {
      const k0 = up(name);
      for (let k = 0; k < d; k++) {
        const u = units[i + k];
        if (setHas(rBusy, k0, `${day}|${i + k}`)) return false;
        if ((ext.room[k0] || []).some((b) => b.day === day && overlap(u.s, u.e, b.s, b.e))) return false;
      }
      return true;
    };
    const pickRoom = (list, needCap, day, i, d, usedNow, preferred) => {
      if (!rooms.saved) return { name: "" };
      const ok = list.filter((r) => (!needCap || !r.capacity || r.capacity >= needCap) && !usedNow.has(up(r.name)) && roomFree(r.name, day, i, d));
      if (!ok.length) return null;
      const pref = preferred && ok.find((r) => up(r.name) === up(preferred));
      if (pref) return pref;
      return ok.sort((a, b) => (a.capacity || 1e9) - (b.capacity || 1e9) || a.name.localeCompare(b.name))[0];
    };
    const divsLoad = (divs, day) => Math.max(0, ...divs.map((dv) => dayLoad.get(`${key(dv)}|${day}`) || 0));
    const divsDayCount = (dv, day) => dayLoad.get(`${key(dv)}|${day}`) || 0;
    const occupied = (dv, day, p) => classBusy.has(`${key(dv)}|${day}|${p}`);
    const gapScore = (divs, day, i, d) => {
      let g = 0;
      divs.forEach((dv) => {
        let any = false, near = false;
        for (let p = 0; p < units.length; p++) if (occupied(dv, day, p)) { any = true; if (p === i - 1 || p === i + d) near = true; }
        if (!any) g += i * 1.5; else if (!near) g += 5;
      });
      return g / divs.length;
    };

    const commit = (ev, day, i, d, divs, extra) => {
      divs.forEach((dv) => {
        for (let k = 0; k < d; k++) classBusy.add(`${key(dv)}|${day}|${i + k}`);
        dayLoad.set(`${key(dv)}|${day}`, (dayLoad.get(`${key(dv)}|${day}`) || 0) + d);
      });
      (extra.teachers || []).forEach((tid) => { for (let k = 0; k < d; k++) setAdd(tBusy, tid, `${day}|${i + k}`); tDay.set(`${tid}|${day}`, (tDay.get(`${tid}|${day}`) || 0) + d); });
      (extra.rooms || []).forEach((r) => { if (r) for (let k = 0; k < d; k++) setAdd(rBusy, up(r), `${day}|${i + k}`); });
    };

    const tally = (t, why) => { t[why] = (t[why] || 0) + 1; };
    const reasonOf = (t) => {
      const best = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
      return best ? best[0] : "no free time";
    };

    // order: hardest first
    const prio = { common: 0, elective: 0, lab: 1, lecture: 2, tutorial: 3 };
    const shuffled = eventsTpl.map((e) => ({ e, r: rand() })).sort((a, b) => prio[a.e.type] - prio[b.e.type] || a.r - b.r).map((x) => x.e);

    shuffled.forEach((ev) => {
      const d = ev.units;
      const starts = runs(d);
      const why = {};
      let best = null;

      days.forEach((day) => {
        starts.forEach((i) => {
          let divs, jitter = rand() * 2.5, base = 0;
          if (ev.type === "common") {
            divs = divisions;
            if (ev.c.days && ev.c.days.length && !ev.c.days.includes(day)) return;
            if (commonDay.has(`${ev.c.id}|${day}`)) { tally(why, `${ev.c.title} is already on every day it can be`); return; }
            if (divs.some((dv) => divsDayCount(dv, day) + d > maxPerDay)) { tally(why, FULL); return; }
            for (let k = 0; k < d; k++) if (divs.some((dv) => occupied(dv, day, i + k))) { tally(why, "no time is free for every division at once"); return; }
            base = divsLoad(divs, day) * 3 + gapScore(divs, day, i, d) + whenPenalty(ev.when, units[i]);
            const sc = base + jitter;
            if (!best || sc < best.sc) best = { sc, day, i, divs };
            return;
          }
          if (ev.type === "elective") {
            divs = divisions;
            if (!ev.tutorial && groupDay.has(`${ev.g.group}|${day}`)) { tally(why, `Elective group ${ev.g.group} already meets on every day that is free`); return; }
            if (divs.some((dv) => divsDayCount(dv, day) + d > maxPerDay)) { tally(why, FULL); return; }
            for (let k = 0; k < d; k++) if (divs.some((dv) => occupied(dv, day, i + k))) { tally(why, "no time is free for every division at once"); return; }
            const used = new Set(), picks = [];
            for (const o of (ev.opts || ev.g.options)) {
              if (!teacherFree(o.teacher_id, day, i, d)) { tally(why, `${o.teacher_name || "a teacher"} is busy`); return; }
              const r = pickRoom(ev.lab ? rooms.labs : rooms.classrooms, o.students, day, i, d, used, home.get(`el|${ev.lab ? "L|" : ""}${o.id}`));
              if (!r) { tally(why, ev.lab ? "no free lab room big enough" : "no free classroom big enough"); return; }
              if (r.name) used.add(up(r.name));
              picks.push({ o, room: r.name });
            }
            base = divsLoad(divs, day) * 3 + gapScore(divs, day, i, d) + picks.reduce((a, p) => a + (tDay.get(`${p.o.teacher_id}|${day}`) || 0), 0) + whenPenalty(ev.when, units[i]) - (ev.lab ? i * 0.6 : 0);
            const sc = base + jitter;
            if (!best || sc < best.sc) best = { sc, day, i, divs, picks };
            return;
          }
          if (ev.type === "lab") {
            divs = [ev.p.dv];
            const dv = ev.p.dv;
            if (divsDayCount(dv, day) + d > maxPerDay) { tally(why, FULL); return; }
            for (let k = 0; k < d; k++) if (occupied(dv, day, i + k)) { tally(why, "no free time left for this class"); return; }
            const used = new Set(), picks = [];
            for (const pk of ev.r.picks) {
              const lab = pk.lab;
              if (lectDay.has(`${key(dv)}|${lab.id}|${day}`)) { tally(why, `${lab.name} already has a lecture that day`); return; }
              if (labBatchDay.has(`${key(dv)}|${pk.batch}|${lab.id}|${day}`)) { tally(why, `${lab.name} lab already that day`); return; }
              if (!teacherFree(lab.teacher_id, day, i, d)) { tally(why, `${lab.teacher_name || "a teacher"} is busy`); return; }
              const r = pickRoom(rooms.labs, ev.p.batchSize, day, i, d, used, home.get(`lab|${lab.id}`));
              if (!r) { tally(why, "no free lab room big enough"); return; }
              if (r.name) used.add(up(r.name));
              picks.push({ pk, room: r.name });
            }
            base = divsLoad(divs, day) * 3 + gapScore(divs, day, i, d) - i * 0.6 + picks.reduce((a, p) => a + (tDay.get(`${p.pk.lab.teacher_id}|${day}`) || 0), 0) + whenPenalty(ev.when, units[i]);
            const sc = base + jitter;
            if (!best || sc < best.sc) best = { sc, day, i, divs, picks };
            return;
          }
          // lecture / tutorial
          const dv = ev.dv, s = ev.s;
          divs = [dv];
          const tch = tOf(s, dv);
          if (divsDayCount(dv, day) + d > maxPerDay) { tally(why, FULL); return; }
          for (let k = 0; k < d; k++) if (occupied(dv, day, i + k)) { tally(why, "no free time left for this class"); return; }
          if (ev.type === "lecture") {
            if (lectDay.has(`${key(dv)}|${s.id}|${day}`) || labAnyDay.has(`${key(dv)}|${s.id}|${day}`)) { tally(why, "the subject is already on every day that is free"); return; }
          }
          if (!teacherFree(tch.id, day, i, d)) { tally(why, `${tch.name || "the teacher"} is busy`); return; }
          const r = pickRoom(rooms.classrooms, dv.size, day, i, d, new Set(), home.get(`div|${key(dv)}`));
          if (!r) { tally(why, "no free classroom big enough"); return; }
          base = divsLoad(divs, day) * 3 + gapScore(divs, day, i, d) + (tDay.get(`${tch.id}|${day}`) || 0) + whenPenalty(ev.when, units[i]);
          const sc = base + jitter;
          if (!best || sc < best.sc) best = { sc, day, i, divs, room: r.name };
        });
      });

      if (!best) { unplaced.push({ ev, reason: reasonOf(why) }); return; }
      soft += best.sc;
      const { day, i } = best;
      const start = fmt(units[i].s), end = fmt(units[i + d - 1].e);
      if (ev.type === "common") {
        commonDay.add(`${ev.c.id}|${day}`);
        commit(ev, day, i, d, best.divs, {});
        placed.push({ type: "common", c: ev.c, day, start_time: start, end_time: end, slot_key: `common|${ev.c.id}|${day}|${i}` });
      } else if (ev.type === "elective") {
        if (!ev.tutorial) groupDay.add(`${ev.g.group}|${day}`);
        commit(ev, day, i, d, best.divs, { teachers: best.picks.map((p) => p.o.teacher_id).filter(Boolean), rooms: best.picks.map((p) => p.room) });
        best.picks.forEach((p) => { if (p.room) home.set(`el|${ev.lab ? "L|" : ""}${p.o.id}`, p.room); });
        placed.push({ type: "elective", tutorial: !!ev.tutorial, lab: !!ev.lab, group: ev.g.group, day, start_time: start, end_time: end, slot_key: `${ev.g.group}|${ev.tutorial ? "T|" : ev.lab ? "L|" : ""}${day}|${i}`,
          options: best.picks.map((p) => ({ subject_id: p.o.id, teacher_id: p.o.teacher_id, room: p.room })) });
      } else if (ev.type === "lab") {
        const dv = ev.p.dv;
        commit(ev, day, i, d, [dv], { teachers: best.picks.map((p) => p.pk.lab.teacher_id).filter(Boolean), rooms: best.picks.map((p) => p.room) });
        best.picks.forEach((p) => {
          labBatchDay.add(`${key(dv)}|${p.pk.batch}|${p.pk.lab.id}|${day}`);
          labAnyDay.add(`${key(dv)}|${p.pk.lab.id}|${day}`);
          if (p.room) home.set(`lab|${p.pk.lab.id}`, p.room);
        });
        placed.push({ type: "lab", division_id: dv.id, day, start_time: start, end_time: end, slot_key: `lab|${key(dv)}|${ev.ri}`, batch_of: ev.p.n,
          batches: best.picks.map((p) => ({ batch_no: ev.p.n > 1 ? p.pk.batch + 1 : null, subject_id: p.pk.lab.id, teacher_id: p.pk.lab.teacher_id, room: p.room })) });
      } else {
        const dv = ev.dv, s = ev.s, tch = tOf(s, dv);
        commit(ev, day, i, d, [dv], { teachers: [tch.id].filter(Boolean), rooms: [best.room] });
        if (ev.type === "lecture") lectDay.add(`${key(dv)}|${s.id}|${day}`);
        if (best.room) home.set(`div|${key(dv)}`, best.room);
        placed.push({ type: ev.type, subject_id: s.id, division_id: dv.id, teacher_id: tch.id, day, start_time: start, end_time: end, room: best.room });
      }
    });

    const missing = unplaced.reduce((a, u) => a + (u.ev.type === "lab" ? u.ev.units * u.ev.r.picks.length : u.ev.units * (u.ev.type === "common" ? 2 : 1)), 0);
    return { placed, unplaced, soft, missing };
  }

  // ── search: several randomised attempts, keep the best ─────────────────────
  const t0 = Date.now();
  const maxAttempts = Math.max(1, Number(input.attempts) || 60);
  const limit = Math.max(200, Number(input.time_ms) || 4000);
  let best = null, perfectAfter = 0;
  for (let a = 0; a < maxAttempts && Date.now() - t0 < limit; a++) {
    const r = attempt((Number(input.seed) || 1) * 7919 + a * 104729);
    if (!best || r.missing < best.missing || (r.missing === best.missing && r.soft < best.soft)) best = r;
    if (best.missing === 0 && ++perfectAfter >= 12) break;
  }

  // ── turn the result into plain items ──────────────────────────────────────
  const subjectsById = Object.fromEntries(input.subjects.map((s) => [s.id, s]));
  const items = [];
  best.placed.forEach((p) => {
    if (p.type === "elective") {
      p.options.forEach((o) => items.push({ type: "elective", kind: p.tutorial ? "tutorial" : p.lab ? "lab" : undefined, group: p.group, slot_key: p.slot_key, subject_id: o.subject_id, teacher_id: o.teacher_id, room: o.room, day: p.day, start_time: p.start_time, end_time: p.end_time }));
    } else if (p.type === "common") {
      divisions.forEach((dv) => items.push({ type: "common", title: p.c.title, common_id: p.c.id, teacher_name: p.c.teacher_name || "", division_id: dv.id, slot_key: p.slot_key, day: p.day, start_time: p.start_time, end_time: p.end_time }));
    } else if (p.type === "lab") {
      p.batches.forEach((b) => items.push({ type: "lab", slot_key: p.slot_key, division_id: p.division_id, batch_no: b.batch_no, batch_of: p.batch_of, subject_id: b.subject_id, teacher_id: b.teacher_id, room: b.room, day: p.day, start_time: p.start_time, end_time: p.end_time }));
    } else {
      items.push({ type: p.type, subject_id: p.subject_id, division_id: p.division_id, teacher_id: p.teacher_id, room: p.room, day: p.day, start_time: p.start_time, end_time: p.end_time });
    }
  });

  // what could not be placed, grouped
  const miss = new Map();
  best.unplaced.forEach(({ ev, reason }) => {
    let k, row;
    if (ev.type === "common") { k = `common|${ev.c.id}`; row = { kind: "common", subject: ev.c.title, division: "", missing: 0, reason }; }
    else if (ev.type === "elective") { k = `el|${ev.g.group}|${ev.tutorial ? "T" : ev.lab ? "B" : "L"}`; row = { kind: "elective", subject: `Elective group ${ev.g.group}${ev.tutorial ? " (tutorial)" : ev.lab ? " (lab)" : ""}`, division: "", missing: 0, reason }; }
    else if (ev.type === "lab") { k = `lab|${ev.p.dv.id}|${ev.ri}`; row = { kind: "lab", subject: ev.r.picks.map((p) => p.lab.name).join(" / "), division: ev.p.dv.name, missing: 0, reason }; }
    else { k = `${ev.type}|${ev.dv.id}|${ev.s.id}`; row = { kind: ev.type, subject: ev.s.name, division: ev.dv.name, missing: 0, reason }; }
    if (!miss.has(k)) miss.set(k, row);
    miss.get(k).missing++;
  });

  const placedCount = { lecture: 0, tutorial: 0, lab: 0, elective: 0, common: 0 };
  best.placed.forEach((p) => { placedCount[p.type] += p.type === "elective" ? 1 : p.type === "lab" ? p.batches.length : 1; });

  return {
    items,
    unplaced: [...miss.values()],
    warnings,
    stats: {
      need, placed: placedCount, complete: best.unplaced.length === 0,
      batches: plans.map((p) => ({ division_id: p.dv.id, division: p.dv.name, batches: p.n, rounds: p.rounds.length })),
      periods_per_day: units.length, slot_minutes: Number(grid.slot_minutes) || 60,
      subjects: Object.keys(subjectsById).length, ms: Date.now() - t0,
    },
  };
}

module.exports = { solve, buildUnits, buildLabRounds, toMin, fmt };
