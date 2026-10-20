// @ts-nocheck
/**
 * DivisionsPage.jsx — head ▸ Manage ▸ Divisions
 * A division (A, B, C …) splits one semester of a course into sections. Students pick theirs in the
 * app (registration / profile); the head creates them here and can assign or move students.
 *
 *   GET    /divisions?course_id&semester → { divisions[], unassigned[{course_id, semester, count}] }
 *   POST   /divisions                    { course_id, semester, name | names[] }
 *   PUT    /divisions/:id                { name }
 *   DELETE /divisions/:id
 *   GET    /divisions/:id/students       → { students, candidates }
 *   POST   /divisions/assign             { division_id | null, student_ids }
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ManageShell from "../../../components/ManageShell";
import { headApi } from "../../../services/headApi";
import "./SubjectsPage.css";
import "./DivisionsPage.css";

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const semName = (n) => `Semester ${n}`;

function NameModal({ title, initial, existing, onClose, onSave }) {
  const [name, setName] = useState(initial || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const adding = !initial;
  const names = adding ? name.split(/[,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean) : [name.trim().toUpperCase()];
  const dup = names.find((n) => existing.includes(n) && n !== (initial || "").toUpperCase());
  const valid = names.length > 0 && names.every((n) => /^[A-Z0-9 -]{1,10}$/.test(n)) && !dup;
  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true); setError("");
    try { await onSave(names); } catch (e) { setError(e.message); setSaving(false); }
  };
  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <form className="mg-modal" role="dialog" aria-modal="true" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="mg-modal-header">
          <h3 className="mg-modal-title">{title}</h3>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={saving} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">
          <div className="mg-field">
            <label className="mg-label" htmlFor="dv-name">{adding ? "Division names" : "Division name"}</label>
            <input id="dv-name" className="mg-input" autoFocus value={name} maxLength={adding ? 60 : 10} disabled={saving}
                   style={{ textTransform: "uppercase" }} placeholder={adding ? "A, B, C" : "A"} onChange={(e) => setName(e.target.value)} />
            <span className="mg-help">{adding ? "Type one or several, separated by commas (A, B, C). " : ""}Up to 10 letters, digits, spaces or dashes.</span>
            {dup && <span className="sf-stale">{dup} already exists in this semester.</span>}
          </div>
          {error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {error}</span></div>}
        </div>
        <div className="mg-modal-footer">
          <button type="button" className="mg-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="mg-btn mg-btn--primary" disabled={!valid || saving}>{saving ? "Saving…" : adding ? "Create" : "Rename"}</button>
        </div>
      </form>
    </div>
  );
}

function MembersModal({ division, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [tab, setTab] = useState("members");
  const [picked, setPicked] = useState(() => new Set());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await headApi.get(`/divisions/${division.division_id}/students`)); setError(""); setPicked(new Set()); }
    catch (e) { setError(e.message); }
  }, [division.division_id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const k = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [busy, onClose]);

  const list = useMemo(() => {
    const src = !data ? [] : tab === "members" ? data.students : data.candidates;
    const n = q.trim().toLowerCase();
    return n ? src.filter((s) => [s.name, s.roll_no, s.division].some((x) => String(x || "").toLowerCase().includes(n))) : src;
  }, [data, tab, q]);
  const allOn = list.length > 0 && list.every((s) => picked.has(s.student_id));
  const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const act = async (remove) => {
    if (!picked.size || busy) return;
    setBusy(true); setError(""); setMsg("");
    try {
      await headApi.post("/divisions/assign", { division_id: remove ? null : division.division_id, student_ids: [...picked] });
      setMsg(remove ? `${plural(picked.size, "student")} removed from ${division.name}.` : `${plural(picked.size, "student")} added to ${division.name}.`);
      await load(); onChanged();
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mg-modal mg-modal--wide" role="dialog" aria-modal="true" aria-label="Division students">
        <div className="mg-modal-header">
          <div>
            <h3 className="mg-modal-title">Division {division.name}</h3>
            <p className="mg-modal-sub">{semName(division.semester)} · {data ? plural(data.students.length, "student") : "…"}</p>
          </div>
          <button type="button" className="mg-modal-close" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <div className="mg-modal-body">
          <div className="sf-seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "members"} className={`sf-seg-btn${tab === "members" ? " sf-seg-btn--on" : ""}`}
                    onClick={() => { setTab("members"); setPicked(new Set()); }}>In {division.name} ({data ? data.students.length : "…"})</button>
            <button type="button" role="tab" aria-selected={tab === "add"} className={`sf-seg-btn${tab === "add" ? " sf-seg-btn--on" : ""}`}
                    onClick={() => { setTab("add"); setPicked(new Set()); }}>Add students ({data ? data.candidates.length : "…"})</button>
          </div>
          <input className="mg-input" placeholder="Search name, roll number or division…" aria-label="Search students" value={q} onChange={(e) => setQ(e.target.value)} />
          {!data && !error && <div className="mg-loading">Loading students…</div>}
          {data && (
            <div className="sf-st-wrap">
              <table className="sf-st">
                <thead><tr>
                  <th className="sf-st-chk"><input type="checkbox" aria-label="Select all" checked={allOn}
                    onChange={() => setPicked(allOn ? new Set() : new Set(list.map((s) => s.student_id)))} /></th>
                  <th>Roll</th><th>Name</th>{tab === "add" && <th>Now in</th>}
                </tr></thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.student_id} className={picked.has(s.student_id) ? "sf-st-on" : ""}>
                      <td className="sf-st-chk"><input type="checkbox" aria-label={`Select ${s.name}`} checked={picked.has(s.student_id)} onChange={() => toggle(s.student_id)} /></td>
                      <td>{s.roll_no || "—"}</td><td>{s.name}</td>{tab === "add" && <td>{s.division || "No division"}</td>}
                    </tr>
                  ))}
                  {!list.length && <tr><td colSpan={4} className="sf-st-empty">{tab === "add" ? "No other students in this semester." : "No students yet."}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {picked.size > 0 && (
            <div className="sf-bulk">
              <strong>{plural(picked.size, "student")} selected</strong>
              <div className="sf-bulk-row">
                {tab === "add"
                  ? <button type="button" className="mg-btn mg-btn--primary" disabled={busy} onClick={() => act(false)}>{busy ? "Working…" : `Put in ${division.name}`}</button>
                  : <button type="button" className="mg-btn mg-btn--danger" disabled={busy} onClick={() => act(true)}>{busy ? "Working…" : "Remove from division"}</button>}
              </div>
            </div>
          )}
          {msg && <div className="mg-banner mg-banner--success" role="status"><span className="mg-banner-text">✓ {msg}</span></div>}
          {error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {error}</span></div>}
        </div>
        <div className="mg-modal-footer"><button type="button" className="mg-btn" onClick={onClose} disabled={busy}>Close</button></div>
      </div>
    </div>
  );
}

export default function DivisionsPage() {
  const [ctx, setCtx] = useState(null);
  const [ctxError, setCtxError] = useState("");
  const [courseId, setCourseId] = useState(null);
  const [divisions, setDivisions] = useState([]);
  const [unassigned, setUnassigned] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [sem, setSem] = useState(1);
  const [modal, setModal] = useState(null);
  const seq = useRef(0);

  useEffect(() => {
    headApi.get("/context").then((d) => { setCtx(d); setCourseId((c) => c || d.courses[0]?.course_id || null); if (!d.courses.length) setLoading(false); })
      .catch((e) => { setCtxError(e.message); setLoading(false); });
  }, []);

  const course = ctx?.courses.find((c) => c.course_id === courseId) || null;
  const total = course?.total_semesters || 1;

  const load = useCallback(async () => {
    if (!courseId) return;
    const mine = ++seq.current;
    setLoading(true); setError("");
    try {
      const d = await headApi.get(`/divisions?course_id=${encodeURIComponent(courseId)}`);
      if (mine !== seq.current) return;
      setDivisions(d.divisions || []); setUnassigned(d.unassigned || []);
    } catch (e) { if (mine === seq.current) setError(e.message); }
    if (mine === seq.current) setLoading(false);
  }, [courseId]);
  useEffect(() => { setDivisions([]); setUnassigned([]); setSem(1); load(); }, [load]);

  const inSem = divisions.filter((d) => d.semester === sem).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const noDiv = unassigned.find((u) => u.semester === sem)?.count || 0;
  const studentsInSem = inSem.reduce((n, d) => n + d.student_count, 0) + noDiv;

  const create = async (names) => {
    await headApi.post("/divisions", { course_id: courseId, semester: sem, names });
    setModal(null); await load();
    setNotice({ type: "success", text: `${names.join(", ")} created in ${semName(sem)}. Students can now choose it in the app.` });
  };
  const rename = (d) => async ([name]) => {
    await headApi.put(`/divisions/${d.division_id}`, { name });
    setModal(null); await load();
    setNotice({ type: "success", text: `Division renamed to ${name}.` });
  };
  const remove = (d) => setModal({ type: "confirm", division: d });

  return (
    <ManageShell
      title="Divisions"
      subtitle="Split a semester into sections (A, B, C). Each division gets its own timetable; subjects stay the same."
      actions={course && <button className="mg-btn mg-btn--primary" onClick={() => setModal({ type: "add" })}>+ Add divisions</button>}
    >
      {ctxError && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {ctxError}</span></div>}
      {notice && (
        <div className={`mg-banner mg-banner--${notice.type}`} role="status">
          <span className="mg-banner-text">{notice.type === "success" ? "✓ " : ""}{notice.text}</span>
          <button className="mg-banner-action" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {ctx && ctx.courses.length > 1 && (
        <div className="mg-pills" role="tablist" aria-label="Course">
          {ctx.courses.map((c) => (
            <button key={c.course_id} role="tab" aria-selected={c.course_id === courseId}
                    className={`mg-pill${c.course_id === courseId ? " mg-pill--active" : ""}`} onClick={() => setCourseId(c.course_id)}>
              {c.course_name || c.abbr} <span className="mg-pill-code">{c.abbr}</span>
            </button>
          ))}
        </div>
      )}
      {course && (
        <>
          <div className="sf-sems" role="tablist" aria-label="Semester">
            {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
              <button key={n} role="tab" aria-selected={sem === n} className={`sf-sem${sem === n ? " sf-sem--on" : ""}`} onClick={() => setSem(n)}>Sem {n}</button>
            ))}
          </div>
          {error && (
            <div className="mg-banner mg-banner--error" role="alert">
              <span className="mg-banner-text">⚠ {error}</span><button className="mg-banner-action" onClick={load}>Retry</button>
            </div>
          )}
          {loading && !divisions.length && !error && <div className="mg-loading">Loading divisions…</div>}

          {!loading && !error && (
            <>
              <p className="dv-sum">
                {semName(sem)} · {plural(studentsInSem, "student")}
                {noDiv > 0 && <> · <span className="sf-warn">{noDiv} without a division</span></>}
              </p>
              {inSem.length === 0 ? (
                <div className="mg-empty">
                  <div className="mg-empty-title">No divisions in {semName(sem)}</div>
                  Create A, B, C … here first. Students then pick their division in the app. Until then they see only lectures that apply to everyone.
                  <div style={{ marginTop: 14 }}><button className="mg-btn mg-btn--primary" onClick={() => setModal({ type: "add" })}>+ Add divisions</button></div>
                </div>
              ) : (
                <div className="dv-grid">
                  {inSem.map((d) => (
                    <div className="dv-card" key={d.division_id}>
                      <div className="dv-name">{d.name}</div>
                      <div className="dv-meta">
                        <span><b>{d.student_count}</b> students</span>
                        <span><b>{d.lecture_count}</b> timetable slots</span>
                      </div>
                      <div className="dv-actions">
                        <button className="mg-btn mg-btn--sm" onClick={() => setModal({ type: "members", division: d })}>Students</button>
                        <button className="sf-link" onClick={() => setModal({ type: "rename", division: d })}>Rename</button>
                        <button className="sf-link sf-link--danger" onClick={() => remove(d)}>Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {modal?.type === "add" && <NameModal title={`Add divisions · ${semName(sem)}`} existing={inSem.map((d) => d.name)} onClose={() => setModal(null)} onSave={create} />}
      {modal?.type === "rename" && <NameModal title="Rename division" initial={modal.division.name} existing={inSem.map((d) => d.name)} onClose={() => setModal(null)} onSave={rename(modal.division)} />}
      {modal?.type === "members" && <MembersModal division={modal.division} onClose={() => setModal(null)} onChanged={load} />}
      {modal?.type === "confirm" && (
        <ConfirmDelete division={modal.division} onClose={() => setModal(null)}
          onDone={async () => { setModal(null); await load(); setNotice({ type: "success", text: `Division ${modal.division.name} deleted. Its students have no division now.` }); }} />
      )}
    </ManageShell>
  );
}

function ConfirmDelete({ division, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true); setError("");
    try { await headApi.del(`/divisions/${division.division_id}`); await onDone(); } catch (e) { setError(e.message); setBusy(false); }
  };
  return (
    <div className="mg-modal-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mg-modal" role="dialog" aria-modal="true">
        <div className="mg-modal-header"><h3 className="mg-modal-title">Delete division {division.name}</h3></div>
        <div className="mg-modal-body">
          <p>{division.student_count} students will be left without a division and can pick another one in the app.
            {division.lecture_count > 0 && ` It still has ${plural(division.lecture_count, "timetable slot")}; remove or move those first.`}</p>
          {error && <div className="mg-banner mg-banner--error" role="alert"><span className="mg-banner-text">⚠ {error}</span></div>}
        </div>
        <div className="mg-modal-footer">
          <button className="mg-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="mg-btn mg-btn--danger" onClick={go} disabled={busy}>{busy ? "Deleting…" : "Delete division"}</button>
        </div>
      </div>
    </div>
  );
}