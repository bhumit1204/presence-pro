// @ts-nocheck
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getInstituteToken, getInstituteProfile, clearInstituteSession } from "./protected_route";
import Sidebar from "../../../components/Inst_SideBar";
import "./subjects.css";

const INSTITUTE_API = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";

async function apiFetch(path, options = {}) {
  const token = getInstituteToken();
  const res   = await fetch(`${INSTITUTE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── Course avatar (same logic as Courses page) ────────────────────────
const COLOR_MAP = {
  MCA:   { bg: "#EEF2FF", fg: "#4F46E5" },
  BCA:   { bg: "#ECFDF5", fg: "#059669" },
  MBA:   { bg: "#FFF7ED", fg: "#EA580C" },
  BSC:   { bg: "#F0FDF4", fg: "#16A34A" },
  BE:    { bg: "#EFF6FF", fg: "#2563EB" },
  BTECH: { bg: "#EFF6FF", fg: "#2563EB" },
  BBA:   { bg: "#FDF4FF", fg: "#9333EA" },
  DCE:   { bg: "#FFF7ED", fg: "#D97706" },
  DCT:   { bg: "#EFF6FF", fg: "#0891B2" },
};

function getCourseStyle(abbr) {
  const upper = (abbr || "").toUpperCase();
  if (COLOR_MAP[upper]) return COLOR_MAP[upper];
  const key = Object.keys(COLOR_MAP).find((k) => upper.includes(k));
  return key ? COLOR_MAP[key] : { bg: "#F4F6FB", fg: "#5A6479" };
}

function CourseIcon({ abbr }) {
  const { bg, fg } = getCourseStyle(abbr);
  return (
    <div className="subj-course-icon" style={{ background: bg, color: fg }}>
      <span style={{ fontSize: 13, fontWeight: 800 }}>{(abbr || "—").slice(0, 3)}</span>
    </div>
  );
}

// ── Add/Edit Subject Panel ────────────────────────────────────────────
function SubjectPanel({ courses, editSubject, selectedCourseId, onClose, onSaved }) {
  const isEdit = !!editSubject;

  const [courseId,     setCourseId]     = useState(editSubject?.course_id     || selectedCourseId || "");
  const [name,         setName]         = useState(editSubject?.subject_name  || "");
  const [code,         setCode]         = useState(editSubject?.subject_code  || "");
  const [semester,     setSemester]     = useState(String(editSubject?.semester?.replace?.("Sem ", "") || ""));
  const [compulsory,   setCompulsory]   = useState(editSubject ? editSubject.compulsary : true);
  const [teacherId,    setTeacherId]    = useState(editSubject?.teacher_assigned || "");
  const [teachers,     setTeachers]     = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState("");

  // Get total semesters for selected course
  const selectedCourse = courses.find((c) => c.course_id === courseId);
  const totalSem = selectedCourse?.total_semesters || 8;
  const semOptions = Array.from({ length: totalSem }, (_, i) => i + 1);

  const [addingSem,    setAddingSem]    = useState(false);
  const [newSemCount,  setNewSemCount]  = useState("");
  const [semSaving,    setSemSaving]    = useState(false);

  const handleAddSemester = async () => {
    const count = parseInt(newSemCount);
    if (!count || count <= totalSem) {
      setError(`New semester count must be greater than current (${totalSem}).`);
      return;
    }
    setSemSaving(true);
    try {
      await apiFetch(`/institute/courses/${courseId}`, {
        method: "PUT",
        body: JSON.stringify({ total_semesters: count }),
      });
      // Refresh courses list in parent so dropdown updates
      window.dispatchEvent(new Event("courses-updated"));
      setAddingSem(false);
      setNewSemCount("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSemSaving(false);
    }
  };

  // Load approved teachers for this course
  useEffect(() => {
    if (!courseId) return;
    const course = courses.find((c) => c.course_id === courseId);
    if (!course) return;
    apiFetch(`/institute/teachers?status=approved`)
      .then((d) => {
        const filtered = (d.teachers || []).filter((t) =>
          Array.isArray(t.departments) && t.departments.includes(course.abbr)
        );
        setTeachers(filtered);
      })
      .catch(() => {});
  }, [courseId]);

  const handleSubmit = async () => {
    setError("");
    if (!courseId)      { setError("Please select a course."); return; }
    if (!name.trim())   { setError("Subject name is required."); return; }
    if (!code.trim())   { setError("Subject code is required."); return; }
    if (!semester)      { setError("Please select a semester."); return; }

    setLoading(true);
    try {
      const body = {
        course_id:        courseId,
        subject_name:     name.trim(),
        subject_code:     code.trim().toUpperCase(),
        semester:         `Sem ${semester}`,
        compulsary:       compulsory,
        teacher_assigned: teacherId || null,
      };

      if (isEdit) {
        await apiFetch(`/institute/subjects/${editSubject.subject_id}`, {
          method: "PUT", body: JSON.stringify(body),
        });
      } else {
        await apiFetch("/institute/subjects", {
          method: "POST", body: JSON.stringify(body),
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="subj-panel-overlay" onClick={onClose}>
      <div className="subj-panel" onClick={(e) => e.stopPropagation()}>
        <div className="subj-panel-header">
          <h3 className="subj-panel-title">{isEdit ? "Edit Subject" : "Add Subject"}</h3>
          <button className="subj-panel-close" onClick={onClose}>✕</button>
        </div>

        <div className="subj-panel-body">
          {error && <div className="subj-panel-error">{error}</div>}

          {/* Course */}
          {!isEdit && (
            <div className="subj-field">
              <label className="subj-label">Course <span className="req">*</span></label>
              <select className="subj-input subj-select" value={courseId}
                onChange={(e) => { setCourseId(e.target.value); setSemester(""); setTeacherId(""); }}>
                <option value="">Select course</option>
                {courses.map((c) => (
                  <option key={c.course_id} value={c.course_id}>{c.course_name} ({c.abbr})</option>
                ))}
              </select>
            </div>
          )}

          {/* Subject Name */}
          <div className="subj-field">
            <label className="subj-label">Subject Name <span className="req">*</span></label>
            <input className="subj-input" placeholder="e.g. Data Structures and Algorithms"
              value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {/* Subject Code */}
          <div className="subj-field">
            <label className="subj-label">Subject Code <span className="req">*</span></label>
            <input className="subj-input" placeholder="e.g. MCA-101"
              value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </div>

          {/* Semester */}
          <div className="subj-field">
            <label className="subj-label">Semester <span className="req">*</span></label>
            {!addingSem ? (
              <>
                <select className="subj-input subj-select" value={semester}
                  onChange={(e) => {
                    if (e.target.value === "__add__") { setAddingSem(true); return; }
                    setSemester(e.target.value);
                  }}
                  disabled={!courseId}>
                  <option value="">Select semester</option>
                  {semOptions.map((n) => (
                    <option key={n} value={n}>Semester {n}</option>
                  ))}
                  {courseId && (
                    <option value="__add__">+ Add more semesters…</option>
                  )}
                </select>
                <p className="subj-hint-sem">
                  This course has {totalSem} semester{totalSem !== 1 ? "s" : ""}
                </p>
              </>
            ) : (
              <div className="subj-add-sem-row">
                <div className="subj-add-sem-info">
                  Current: <strong>{totalSem} semesters</strong>. Set new total:
                </div>
                <div className="subj-add-sem-controls">
                  <input
                    className="subj-input"
                    type="number"
                    min={totalSem + 1}
                    max={20}
                    placeholder={`More than ${totalSem}`}
                    value={newSemCount}
                    onChange={(e) => setNewSemCount(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="subj-footer-btn subj-footer-btn--submit"
                    style={{ flex: "0 0 80px", height: 42 }}
                    disabled={semSaving}
                    onClick={handleAddSemester}>
                    {semSaving ? "…" : "Save"}
                  </button>
                  <button className="subj-footer-btn subj-footer-btn--cancel"
                    style={{ flex: "0 0 70px", height: 42 }}
                    onClick={() => { setAddingSem(false); setNewSemCount(""); }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Compulsory toggle */}
          <div className="subj-field">
            <label className="subj-label">Type <span className="req">*</span></label>
            <div className="subj-type-row">
              <button type="button"
                className={`subj-type-btn${compulsory ? " subj-type-btn--active" : ""}`}
                onClick={() => setCompulsory(true)}>
                Compulsory
              </button>
              <button type="button"
                className={`subj-type-btn${!compulsory ? " subj-type-btn--active-elective" : ""}`}
                onClick={() => setCompulsory(false)}>
                Elective
              </button>
            </div>
          </div>

          {/* Assign Teacher */}
          <div className="subj-field">
            <label className="subj-label">Assign Teacher <span className="subj-optional">(optional)</span></label>
            <select className="subj-input subj-select" value={teacherId}
              onChange={(e) => setTeacherId(e.target.value)}
              disabled={!courseId}>
              <option value="">Unassigned</option>
              {teachers.map((t) => (
                <option key={t.teacher_id} value={t.teacher_id}>
                  {t.first_name} {t.last_name} — {t.designation}
                </option>
              ))}
            </select>
            {courseId && teachers.length === 0 && (
              <p className="subj-hint">No approved teachers found for this course's department.</p>
            )}
          </div>
        </div>

        <div className="subj-panel-footer">
          <button className="subj-footer-btn subj-footer-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="subj-footer-btn subj-footer-btn--submit"
            disabled={loading} onClick={handleSubmit}>
            {loading ? "Saving…" : isEdit ? "Save Changes" : "Add Subject"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Assign Teacher Modal ──────────────────────────────────────────────
function AssignTeacherModal({ subject, courses, onClose, onSaved }) {
  const course    = courses.find((c) => c.course_id === subject.course_id);
  const [teachers, setTeachers]   = useState([]);
  const [selected, setSelected]   = useState(subject.teacher_assigned || "");
  const [loading,  setLoading]    = useState(false);
  const [error,    setError]      = useState("");

  useEffect(() => {
    if (!course) return;
    apiFetch(`/institute/teachers?status=approved`)
      .then((d) => {
        const filtered = (d.teachers || []).filter((t) =>
          Array.isArray(t.departments) && t.departments.includes(course.abbr)
        );
        setTeachers(filtered);
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setLoading(true);
    try {
      await apiFetch(`/institute/subjects/${subject.subject_id}/assign`, {
        method: "PUT",
        body: JSON.stringify({ teacher_id: selected || null }),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="subj-modal-overlay" onClick={onClose}>
      <div className="subj-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="subj-modal-title">Assign Teacher</h3>
        <p className="subj-modal-sub">{subject.subject_name} · {subject.subject_code}</p>
        {error && <div className="subj-panel-error" style={{ marginBottom: 12 }}>{error}</div>}
        <select className="subj-input subj-select" value={selected}
          onChange={(e) => setSelected(e.target.value)}>
          <option value="">Unassigned</option>
          {teachers.map((t) => (
            <option key={t.teacher_id} value={t.teacher_id}>
              {t.first_name} {t.last_name} — {t.designation}
            </option>
          ))}
        </select>
        {teachers.length === 0 && (
          <p className="subj-hint">No approved teachers found for this course's department.</p>
        )}
        <div className="subj-modal-actions">
          <button className="subj-footer-btn subj-footer-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="subj-footer-btn subj-footer-btn--submit"
            disabled={loading} onClick={handleSave}>
            {loading ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────
export default function SubjectsPage() {
  const navigate  = useNavigate();
  const institute = getInstituteProfile();

  const [courses,         setCourses]         = useState([]);
  const [selectedCourse,  setSelectedCourse]  = useState(null);
  const [subjects,        setSubjects]        = useState([]);
  const [teachers,        setTeachers]        = useState({}); // teacherId → teacher obj
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState("");

  // Filters
  const [semFilter,    setSemFilter]    = useState("");
  const [compFilter,   setCompFilter]   = useState(""); // "" | "true" | "false"
  const [search,       setSearch]       = useState("");
  const [page,         setPage]         = useState(1);
  const [limit,        setLimit]        = useState(10);

  // Panels
  const [showAdd,       setShowAdd]       = useState(false);
  const [editSubject,   setEditSubject]   = useState(null);
  const [assignSubject, setAssignSubject] = useState(null);
  const [deleteSubject, setDeleteSubject] = useState(null); // subject to confirm delete
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [actionMsg,     setActionMsg]     = useState("");

  // Load courses on mount
  useEffect(() => {
    const token = getInstituteToken();
    if (!token) { navigate("/institute-login", { replace: true }); return; }
    apiFetch("/institute/courses?limit=50")
      .then((d) => {
        const list = d.courses || [];
        setCourses(list);
        if (list.length > 0) setSelectedCourse(list[0]);
      })
      .catch((err) => setError(err.message));
  }, []);

  // Load subjects when course changes
  const loadSubjects = useCallback(async () => {
    if (!selectedCourse) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        course_id: selectedCourse.course_id,
        limit: 200, // fetch all, group by semester in frontend
      });
      if (semFilter)  params.set("semester",   `Sem ${semFilter}`);
      if (compFilter) params.set("compulsory",  compFilter);

      const [subjData, teachData] = await Promise.all([
        apiFetch(`/institute/subjects?${params}`),
        apiFetch("/institute/teachers?status=approved"),
      ]);

      setSubjects(subjData.subjects || []);

      // Build teacher lookup map
      const map = {};
      (teachData.teachers || []).forEach((t) => { map[t.teacher_id] = t; });
      setTeachers(map);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedCourse, semFilter, compFilter]);

  useEffect(() => { loadSubjects(); }, [loadSubjects]);

  // Client-side search
  const filtered = subjects.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.subject_name.toLowerCase().includes(q) ||
      (s.subject_code || "").toLowerCase().includes(q)
    );
  });

  // Group by semester
  const semesterGroups = {};
  filtered.forEach((s) => {
    const sem = s.semester || "Unknown";
    if (!semesterGroups[sem]) semesterGroups[sem] = [];
    semesterGroups[sem].push(s);
  });

  const sortedSems = Object.keys(semesterGroups).sort((a, b) => {
    const na = parseInt(a.replace("Sem ", "")) || 0;
    const nb = parseInt(b.replace("Sem ", "")) || 0;
    return na - nb;
  });

  // Pagination on full flat list
  const totalPages = Math.ceil(filtered.length / limit);
  const paginated  = filtered.slice((page - 1) * limit, page * limit);

  // Re-group paginated subjects by semester
  const pagedGroups = {};
  paginated.forEach((s) => {
    const sem = s.semester || "Unknown";
    if (!pagedGroups[sem]) pagedGroups[sem] = [];
    pagedGroups[sem].push(s);
  });

  const [collapsedSems, setCollapsedSems] = useState({});
  const toggleSem = (sem) => setCollapsedSems((p) => ({ ...p, [sem]: !p[sem] }));

  const handleDelete = async () => {
    if (!deleteSubject) return;
    setDeleteLoading(true);
    try {
      await apiFetch(`/institute/subjects/${deleteSubject.subject_id}`, { method: "DELETE" });
      setActionMsg(`"${deleteSubject.subject_name}" deleted.`);
      setDeleteSubject(null);
      loadSubjects();
    } catch (err) {
      setActionMsg(`Error: ${err.message}`);
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleToggleElective = async (subj) => {
    try {
      await apiFetch(`/institute/subjects/${subj.subject_id}`, {
        method: "PUT",
        body: JSON.stringify({ compulsary: !subj.compulsary }),
      });
      loadSubjects();
    } catch (err) {
      setActionMsg(`Error: ${err.message}`);
    }
  };

  const teacherName = (tid) => {
    if (!tid) return null;
    const t = teachers[tid];
    return t ? `${t.first_name} ${t.last_name}` : null;
  };

  const totalSem = selectedCourse?.total_semesters || 8;
  const semOptions = Array.from({ length: totalSem }, (_, i) => i + 1);

  return (
    <div className="db-shell">
      <Sidebar />

      <div className="db-main">
        <header className="db-topbar">
          <div className="db-topbar-left">
            <h1 className="db-topbar-title">Subjects</h1>
          </div>
          <div className="db-topbar-right">
            <BuildingIcon size={18} />
            <span className="db-topbar-college">{institute?.college_name}</span>
            <span className="db-topbar-aishe-badge">AISHE: {institute?.aishe_code}</span>
          </div>
        </header>

        <div className="subj-body">

          {/* ── Left: Course list ──────────────────────────────── */}
          <div className="subj-course-list">
            <div className="subj-course-list-header">
              <h3 className="subj-course-list-title">Courses</h3>
              <p className="subj-course-list-sub">Select a course to manage its subjects</p>
            </div>

            <div className="subj-course-items">
              {courses.map((course) => {
                const isActive = selectedCourse?.course_id === course.course_id;
                const { fg } = getCourseStyle(course.abbr);
                return (
                  <button
                    key={course.course_id}
                    className={`subj-course-item${isActive ? " subj-course-item--active" : ""}`}
                    onClick={() => { setSelectedCourse(course); setPage(1); setSemFilter(""); setSearch(""); }}
                  >
                    <CourseIcon abbr={course.abbr} />
                    <div className="subj-course-item-text">
                      <span className="subj-course-abbr">{course.abbr}</span>
                      <span className="subj-course-name">{course.course_name}</span>
                    </div>
                    <span className="subj-course-count" style={{ color: isActive ? fg : "#8A94A6" }}>
                      {subjects.filter((s) => s.course_id === course.course_id || selectedCourse?.course_id === course.course_id).length || course.subject_count || 0}
                    </span>
                  </button>
                );
              })}
            </div>

            <button className="subj-add-course-btn" onClick={() => navigate("/dashboard/courses")}>
              <PlusIcon size={14} /> Add Course
            </button>
          </div>

          {/* ── Right: Subjects panel ──────────────────────────── */}
          <div className="subj-right">
            {!selectedCourse ? (
              <div className="subj-empty-state">Select a course to view its subjects.</div>
            ) : (
              <>
                {/* Course header */}
                <div className="subj-course-header">
                  <div className="subj-course-header-left">
                    <div className="subj-course-header-avatar">
                      <CourseIcon abbr={selectedCourse.abbr} />
                    </div>
                    <div>
                      <div className="subj-course-header-title-row">
                        <h2 className="subj-course-header-name">
                          {selectedCourse.course_name} ({selectedCourse.abbr})
                        </h2>
                        <span className="subj-course-header-badge">{selectedCourse.abbr}</span>
                      </div>
                      <div className="subj-course-header-meta">
                        <span><ClockIcon size={13} /> Duration: {selectedCourse.duration}</span>
                        <span><GradIcon size={13} /> Qualification: {selectedCourse.qualification}</span>
                        <span><UserIcon size={13} /> Total Students: {selectedCourse.student_count ?? "—"}</span>
                      </div>
                    </div>
                  </div>
                  <button className="subj-add-btn" onClick={() => setShowAdd(true)}>
                    <PlusIcon size={15} /> Add Subject
                  </button>
                </div>

                {/* Filter bar */}
                <div className="subj-filter-bar">
                  <div className="subj-filter-group">
                    <label className="subj-filter-label">Semester</label>
                    <select className="subj-filter-select" value={semFilter}
                      onChange={(e) => { setSemFilter(e.target.value); setPage(1); }}>
                      <option value="">All Semesters</option>
                      {semOptions.map((n) => (
                        <option key={n} value={n}>Semester {n}</option>
                      ))}
                    </select>
                  </div>
                  <div className="subj-filter-group">
                    <label className="subj-filter-label">Compulsory</label>
                    <select className="subj-filter-select" value={compFilter}
                      onChange={(e) => { setCompFilter(e.target.value); setPage(1); }}>
                      <option value="">All</option>
                      <option value="true">Compulsory</option>
                      <option value="false">Elective</option>
                    </select>
                  </div>
                  <div className="subj-search-wrap">
                    <SearchIcon size={15} />
                    <input className="subj-search-input"
                      placeholder="Search subject name or code…"
                      value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
                  </div>
                  <button className="subj-clear-btn" onClick={() => { setSemFilter(""); setCompFilter(""); setSearch(""); setPage(1); }}>
                    <RefreshIcon size={13} /> Clear Filters
                  </button>
                </div>

                {error     && <div className="db-alert db-alert--error">{error}</div>}
                {actionMsg && <div className={`db-alert ${actionMsg.startsWith("Error") ? "db-alert--error" : "db-alert--ok"}`}>{actionMsg}</div>}

                {/* Grouped subject table */}
                {loading ? (
                  <div className="subj-loading">Loading subjects…</div>
                ) : filtered.length === 0 ? (
                  <div className="subj-empty-state">No subjects found.</div>
                ) : (
                  <div className="subj-groups">
                    {Object.keys(pagedGroups).sort((a, b) => {
                      return (parseInt(a.replace("Sem ",""))||0) - (parseInt(b.replace("Sem ",""))||0);
                    }).map((sem) => {
                      const isCollapsed = !!collapsedSems[sem];
                      const group       = pagedGroups[sem];
                      return (
                        <div key={sem} className="subj-group">
                          {/* Semester header */}
                          <button className="subj-group-header" onClick={() => toggleSem(sem)}>
                            <span className="subj-group-title">{sem}</span>
                            <span className="subj-group-count">({group.length} Subject{group.length !== 1 ? "s" : ""})</span>
                            <span className="subj-group-chevron">{isCollapsed ? "↓" : "↑"}</span>
                          </button>

                          {!isCollapsed && (
                            <table className="subj-table">
                              <thead>
                                <tr>
                                  <th>Subject Name</th>
                                  <th>Subject Code</th>
                                  <th>Compulsory</th>
                                  <th>Assigned Teacher</th>
                                  <th>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.map((subj) => {
                                  const tName = teacherName(subj.teacher_assigned);
                                  return (
                                    <tr key={subj.subject_id}>
                                      <td>
                                        <div className="subj-name-cell">
                                          <span className="subj-dot" />
                                          {subj.subject_name}
                                        </div>
                                      </td>
                                      <td className="subj-code">{subj.subject_code || "—"}</td>
                                      <td>
                                        <span className={`subj-comp-badge ${subj.compulsary ? "subj-comp-badge--yes" : "subj-comp-badge--no"}`}>
                                          {subj.compulsary ? "Yes" : "No"}
                                        </span>
                                      </td>
                                      <td className="subj-teacher">
                                        {tName || <span className="subj-unassigned">Unassigned</span>}
                                      </td>
                                      <td>
                                        <div className="subj-action-row">
                                          <button className="subj-action-btn subj-action-btn--edit"
                                            onClick={() => setEditSubject({ ...subj })}>
                                            <EditIcon size={13} /> Edit
                                          </button>
                                          <button className="subj-action-btn subj-action-btn--assign"
                                            onClick={() => setAssignSubject({ ...subj })}>
                                            <UserPlusIcon size={13} /> Assign Teacher
                                          </button>
                                          <button className="subj-action-btn subj-action-btn--delete"
                                            onClick={() => setDeleteSubject({ ...subj })}>
                                            <TrashIcon size={13} /> Delete
                                          </button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Pagination */}
                {filtered.length > 0 && (
                  <div className="subj-pagination">
                    <span className="subj-pagination-info">
                      Showing {Math.min((page-1)*limit+1, filtered.length)} to {Math.min(page*limit, filtered.length)} of {filtered.length} subjects
                    </span>
                    <div className="subj-pagination-controls">
                      <button className="subj-page-btn" disabled={page<=1} onClick={() => setPage(p=>p-1)}>‹</button>
                      {Array.from({ length: Math.min(totalPages,5) }, (_,i) => i+1).map((p) => (
                        <button key={p} className={`subj-page-btn${page===p?" subj-page-btn--active":""}`}
                          onClick={() => setPage(p)}>{p}</button>
                      ))}
                      <button className="subj-page-btn" disabled={page>=totalPages} onClick={() => setPage(p=>p+1)}>›</button>
                    </div>
                    <select className="subj-per-page" value={limit}
                      onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
                      {[10,25,50].map((n) => <option key={n} value={n}>{n} / page</option>)}
                    </select>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Add / Edit panel */}
      {(showAdd || editSubject) && (
        <SubjectPanel
          courses={courses}
          editSubject={editSubject || null}
          selectedCourseId={selectedCourse?.course_id}
          onClose={() => { setShowAdd(false); setEditSubject(null); }}
          onSaved={loadSubjects}
        />
      )}

      {/* Assign teacher modal */}
      {assignSubject && (
        <AssignTeacherModal
          subject={assignSubject}
          courses={courses}
          onClose={() => setAssignSubject(null)}
          onSaved={loadSubjects}
        />
      )}

      {/* Delete confirm modal */}
      {deleteSubject && (
        <div className="subj-modal-overlay" onClick={() => setDeleteSubject(null)}>
          <div className="subj-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="subj-modal-title">Delete Subject</h3>
            <p className="subj-modal-sub">
              Are you sure you want to delete <strong>"{deleteSubject.subject_name}"</strong>?
              This cannot be undone.
            </p>
            <div className="subj-modal-actions">
              <button className="subj-footer-btn subj-footer-btn--cancel"
                onClick={() => setDeleteSubject(null)}>
                Cancel
              </button>
              <button className="subj-footer-btn subj-footer-btn--danger"
                disabled={deleteLoading} onClick={handleDelete}>
                {deleteLoading ? "Deleting…" : "Yes, Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Icons ───────────────────────────────────────────────────────────── */
const Svg = ({ size=20, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

function BuildingIcon({ size=20 })  { return <Svg size={size}><path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/></Svg>; }
function PlusIcon({ size=20 })      { return <Svg size={size}><path d="M12 5v14M5 12h14"/></Svg>; }
function SearchIcon({ size=20 })    { return <Svg size={size}><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></Svg>; }
function RefreshIcon({ size=20 })   { return <Svg size={size}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></Svg>; }
function ClockIcon({ size=20 })     { return <Svg size={size}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></Svg>; }
function GradIcon({ size=20 })      { return <Svg size={size}><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></Svg>; }
function UserIcon({ size=20 })      { return <Svg size={size}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></Svg>; }
function EditIcon({ size=20 })      { return <Svg size={size}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></Svg>; }
function UserPlusIcon({ size=20 })  { return <Svg size={size}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></Svg>; }
function TrashIcon({ size=20 })     { return <Svg size={size}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></Svg>; }