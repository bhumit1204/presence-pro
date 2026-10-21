// @ts-nocheck
/**
 * DelegationPage.jsx — Manage ▸ Delegation (head only).
 * Per course and area, the head hands the work to other teachers. They create
 * and edit; the head can still edit and leaves suggestions (see SuggestionsPanel).
 */
import { useCallback, useEffect, useState } from "react";
import ManageShell from "../../../components/ManageShell";
import { headApi } from "../../../services/headApi";
import "./DelegationPage.css";

const errMsg = (e) => e?.response?.data?.error || e?.data?.error || e?.message || "Something went wrong";

export default function DelegationPage() {
  const [data, setData] = useState(null);
  const [teachers, setTeachers] = useState([]);
  const [loadErr, setLoadErr] = useState("");
  const [pick, setPick] = useState({}); // "course|area" -> teacher_id
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null); // {kind, text}

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([headApi.get("/delegations"), headApi.get("/teachers")]);
      setData(d); setTeachers(t.teachers || []); setLoadErr("");
    } catch (e) { setLoadErr(errMsg(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (key, fn, okText) => {
    setBusy(key); setMsg(null);
    try { await fn(); await load(); if (okText) setMsg({ kind: "success", text: okText }); }
    catch (e) { setMsg({ kind: "error", text: errMsg(e) }); }
    finally { setBusy(""); }
  };

  const add = (course, area) => {
    const key = `${course.course_id}|${area.key}`;
    const teacher_id = pick[key];
    if (!teacher_id) return;
    run(key, async () => {
      await headApi.post("/delegations", { course_id: course.course_id, area: area.key, teacher_id });
      setPick((p) => ({ ...p, [key]: "" }));
    }, `${area.label} delegated`);
  };
  const remove = (d, area) => {
    if (!window.confirm(`Take ${area.label} back from ${d.teacher_name || "this teacher"}? Their work stays as it is.`)) return;
    run(`del|${d.id}`, () => headApi.del(`/delegations/${encodeURIComponent(d.id)}`), `${area.label} taken back`);
  };

  const sorted = [...teachers].sort((a, b) =>
    (b.in_department ? 1 : 0) - (a.in_department ? 1 : 0) || String(a.name).localeCompare(String(b.name)));

  return (
    <ManageShell
      title="Delegation"
      subtitle="Hand an area to another teacher. They create and edit it; you can still edit, and you can leave suggestions on the page."
    >
      {loadErr && <div className="mg-banner mg-banner--error"><span className="mg-banner-text">{loadErr}</span></div>}
      {msg && <div className={`mg-banner mg-banner--${msg.kind}`}><span className="mg-banner-text">{msg.text}</span></div>}
      {!data && !loadErr && <div className="mg-loading">Loading...</div>}

      {data && data.courses.length === 0 && <div className="mg-empty"><div className="mg-empty-title">No courses found</div></div>}

      {data && data.courses.map((course) => (
        <section key={course.course_id} className="mg-card dg-card">
          <h3 className="dg-course">{course.abbr || course.course_name}{course.abbr && course.course_name ? <span className="dg-course-full">{course.course_name}</span> : null}</h3>

          {data.areas.map((area) => {
            const key = `${course.course_id}|${area.key}`;
            const dels = data.delegations.filter((d) => d.course_id === course.course_id && d.area === area.key);
            const open = data.open_notes?.[key] || 0;
            const taken = new Set(dels.map((d) => d.teacher_id));
            const options = sorted.filter((t) => !taken.has(t.teacher_id));
            return (
              <div key={area.key} className="dg-row">
                <div className="dg-area">
                  <span className="dg-area-name">{area.label}</span>
                  {open > 0 && <span className="mg-badge mg-badge--amber">{open} open suggestion{open > 1 ? "s" : ""}</span>}
                </div>

                <div className="dg-chips">
                  {dels.length === 0 && <span className="dg-none">You</span>}
                  {dels.map((d) => (
                    <span key={d.id} className="dg-chip">
                      {d.teacher_name || "Teacher"}
                      <button type="button" className="dg-chip-x" disabled={busy === `del|${d.id}`} onClick={() => remove(d, area)} aria-label={`Remove ${d.teacher_name}`}>×</button>
                    </span>
                  ))}
                </div>

                {dels.length < (data.max_delegates || 5) && (
                  <div className="dg-add">
                    <select className="mg-input dg-select" value={pick[key] || ""} onChange={(e) => setPick((p) => ({ ...p, [key]: e.target.value }))}>
                      <option value="">Delegate to...</option>
                      {options.map((t) => (
                        <option key={t.teacher_id} value={t.teacher_id}>{t.name}{t.in_department ? "" : " (other department)"}</option>
                      ))}
                    </select>
                    <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" disabled={!pick[key] || busy === key} onClick={() => add(course, area)}>Add</button>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </ManageShell>
  );
}