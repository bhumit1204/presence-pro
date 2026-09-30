// @ts-nocheck
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getInstituteToken, getInstituteProfile, clearInstituteSession } from "./protected_route";
import Sidebar from "../../../components/Inst_SideBar";
import "./Courses.css";

const INSTITUTE_API = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";

const QUALIFICATIONS = [
  { value: "PostGraduate",  label: "Post Graduate",  icon: <GradIcon />    },
  { value: "UnderGraduate", label: "Under Graduate", icon: <DegreeIcon />  },
  { value: "Diploma",       label: "Diploma",        icon: <DiplomaIcon /> },
  { value: "Certificate",   label: "Certificate",    icon: <CertIcon />    },
];

const DURATION_OPTS = [
  { label: "1 Year",  years: 1 },
  { label: "2 Years", years: 2 },
  { label: "3 Years", years: 3 },
  { label: "4 Years", years: 4 },
  { label: "5 Years", years: 5 },
  { label: "6 Years", years: 6 },
];

const PER_PAGE_OPTS = [6, 12, 24];

const COLOR_MAP = {
  MCA:   { bg: "#EEF2FF", fg: "#4F46E5", icon: <MonitorIcon /> },
  BCA:   { bg: "#ECFDF5", fg: "#059669", icon: <CodeIcon />    },
  MBA:   { bg: "#FFF7ED", fg: "#EA580C", icon: <BriefIcon />   },
  BSC:   { bg: "#F0FDF4", fg: "#16A34A", icon: <FlaskIcon />   },
  BE:    { bg: "#EFF6FF", fg: "#2563EB", icon: <CpuIcon />     },
  BTECH: { bg: "#EFF6FF", fg: "#2563EB", icon: <CpuIcon />     },
  BBA:   { bg: "#FDF4FF", fg: "#9333EA", icon: <ChartIcon />   },
  DCE:   { bg: "#FFF7ED", fg: "#D97706", icon: <GearIcon />    },
  BED:   { bg: "#F0FDF4", fg: "#15803D", icon: <BookIcon />    },
  LLB:   { bg: "#FEF9C3", fg: "#CA8A04", icon: <ScaleIcon />   },
};

function getCourseStyle(abbr) {
  const upper = (abbr || "").toUpperCase();
  if (COLOR_MAP[upper]) return COLOR_MAP[upper];
  const key = Object.keys(COLOR_MAP).find((k) => upper.includes(k));
  return key ? COLOR_MAP[key] : { bg: "#F4F6FB", fg: "#5A6479", icon: <BookIcon /> };
}

function CourseAvatar({ abbr }) {
  const style = getCourseStyle(abbr);
  return (
    <div className="course-avatar" style={{ background: style.bg, color: style.fg }}>
      {style.icon}
    </div>
  );
}

function QualBadge({ abbr }) {
  const style = getCourseStyle(abbr);
  return (
    <span className="course-abbr-badge" style={{ color: style.fg, background: style.fg + "18" }}>
      {abbr}
    </span>
  );
}

function qualLabel(q) {
  return QUALIFICATIONS.find((x) => x.value === q)?.label || q || "—";
}

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

// ── Shared course form fields ─────────────────────────────────────────
function CourseForm({ name, setName, abbr, setAbbr, durYears, setDurYears, qual, setQual, error, isEdit }) {
  const semesters = durYears ? Number(durYears) * 2 : null;
  return (
    <>
      {error && <div className="course-panel-error">{error}</div>}

      <div className="course-field">
        <label className="course-label">Course Name <span className="req">*</span></label>
        <input className="course-input" placeholder="Enter full course name"
          value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="course-field">
        <label className="course-label">Abbreviation <span className="req">*</span></label>
        <input className="course-input" placeholder="e.g. MCA"
          value={abbr} onChange={(e) => setAbbr(e.target.value.toUpperCase())} maxLength={10} />
      </div>

      <div className="course-field">
        <label className="course-label">Duration <span className="req">*</span></label>
        <select className="course-input course-select"
          value={durYears} onChange={(e) => setDurYears(e.target.value)}>
          <option value="">Select duration</option>
          {DURATION_OPTS.map((d) => (
            <option key={d.years} value={String(d.years)}>{d.label}</option>
          ))}
        </select>
      </div>

      {semesters && (
        <div className="course-sem-preview">
          <SemIcon size={14} />
          {semesters} semesters {isEdit ? "total" : "will be created automatically"}
        </div>
      )}

      <div className="course-field">
        <label className="course-label">Qualification <span className="req">*</span></label>
        <div className="course-qual-grid">
          {QUALIFICATIONS.map((q) => (
            <button key={q.value} type="button"
              className={`course-qual-btn${qual === q.value ? " course-qual-btn--active" : ""}`}
              onClick={() => setQual(q.value)}>
              {q.icon}{q.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Add Course Panel ──────────────────────────────────────────────────
function AddCoursePanel({ onClose, onAdded }) {
  const [name,     setName]     = useState("");
  const [abbr,     setAbbr]     = useState("");
  const [durYears, setDurYears] = useState("");
  const [qual,     setQual]     = useState("");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  const handleSubmit = async () => {
    setError("");
    if (!name.trim()) { setError("Course name is required."); return; }
    if (!abbr.trim()) { setError("Abbreviation is required."); return; }
    if (!durYears)    { setError("Please select duration."); return; }
    if (!qual)        { setError("Please select qualification."); return; }
    setLoading(true);
    try {
      await apiFetch("/institute/courses", {
        method: "POST",
        body: JSON.stringify({
          course_name:     name.trim(),
          abbr:            abbr.trim().toUpperCase(),
          duration:        DURATION_OPTS.find((d) => String(d.years) === durYears)?.label,
          duration_years:  Number(durYears),
          total_semesters: Number(durYears) * 2,
          qualification:   qual,
        }),
      });
      onAdded();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="course-panel-overlay" onClick={onClose}>
      <div className="course-panel" onClick={(e) => e.stopPropagation()}>
        <div className="course-panel-header">
          <h3 className="course-panel-title">Add Course</h3>
          <button className="course-panel-close" onClick={onClose}>✕</button>
        </div>
        <div className="course-panel-body">
          <CourseForm name={name} setName={setName} abbr={abbr} setAbbr={setAbbr}
            durYears={durYears} setDurYears={setDurYears} qual={qual} setQual={setQual}
            error={error} isEdit={false} />
        </div>
        <div className="course-panel-footer">
          <button className="course-footer-btn course-footer-btn--cancel" onClick={onClose}>Cancel</button>
          <button className="course-footer-btn course-footer-btn--submit"
            disabled={loading} onClick={handleSubmit}>
            {loading ? "Adding…" : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── View / Edit Course Detail Panel ──────────────────────────────────
function CourseDetailPanel({ course, onClose, onUpdated, onDeleted }) {
  const [editing,  setEditing]  = useState(false);
  const [name,     setName]     = useState(course.course_name);
  const [abbr,     setAbbr]     = useState(course.abbr);
  const [durYears, setDurYears] = useState(String(course.duration_years || ""));
  const [qual,     setQual]     = useState(course.qualification);
  const [saving,   setSaving]   = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [error,    setError]    = useState("");
  const [msg,      setMsg]      = useState("");

  const handleSave = async () => {
    setError("");
    if (!name.trim()) { setError("Course name is required."); return; }
    if (!abbr.trim()) { setError("Abbreviation is required."); return; }
    if (!durYears)    { setError("Please select duration."); return; }
    if (!qual)        { setError("Please select qualification."); return; }
    setSaving(true);
    try {
      await apiFetch(`/institute/courses/${course.course_id}`, {
        method: "PUT",
        body: JSON.stringify({
          course_name:     name.trim(),
          abbr:            abbr.trim().toUpperCase(),
          duration:        DURATION_OPTS.find((d) => String(d.years) === durYears)?.label,
          duration_years:  Number(durYears),
          total_semesters: Number(durYears) * 2,
          qualification:   qual,
        }),
      });
      setMsg("Course updated successfully.");
      setEditing(false);
      onUpdated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(`/institute/courses/${course.course_id}`, { method: "DELETE" });
      onDeleted();
      onClose();
    } catch (err) {
      setError(err.message);
      setConfirmDel(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="course-panel-overlay" onClick={onClose}>
      <div className="course-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="course-panel-header">
          <div className="course-detail-header-left">
            <CourseAvatar abbr={editing ? abbr : course.abbr} />
            <div>
              <h3 className="course-panel-title">{editing ? "Edit Course" : course.course_name}</h3>
              {!editing && <QualBadge abbr={course.abbr} />}
            </div>
          </div>
          <button className="course-panel-close" onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div className="course-panel-body">
          {msg   && <div className="course-panel-ok">{msg}</div>}
          {error && <div className="course-panel-error">{error}</div>}

          {editing ? (
            <CourseForm name={name} setName={setName} abbr={abbr} setAbbr={setAbbr}
              durYears={durYears} setDurYears={setDurYears} qual={qual} setQual={setQual}
              error="" isEdit={true} />
          ) : (
            /* Read-only detail view */
            <div className="course-detail-view">
              <div className="course-detail-row">
                <span className="course-detail-label">Course Name</span>
                <span className="course-detail-value">{course.course_name}</span>
              </div>
              <div className="course-detail-row">
                <span className="course-detail-label">Abbreviation</span>
                <span className="course-detail-value">{course.abbr}</span>
              </div>
              <div className="course-detail-row">
                <span className="course-detail-label">Duration</span>
                <span className="course-detail-value">{course.duration || "—"}</span>
              </div>
              <div className="course-detail-row">
                <span className="course-detail-label">Qualification</span>
                <span className="course-detail-value">{qualLabel(course.qualification)}</span>
              </div>
              <div className="course-detail-row">
                <span className="course-detail-label">Total Semesters</span>
                <span className="course-detail-value">{course.total_semesters || "—"}</span>
              </div>
              <div className="course-detail-stats">
                <div className="course-detail-stat">
                  <span className="course-stat-value">{course.student_count ?? 0}</span>
                  <span className="course-stat-label">Students</span>
                </div>
                <div className="course-stat-divider" />
                <div className="course-detail-stat">
                  <span className="course-stat-value">{course.subject_count ?? 0}</span>
                  <span className="course-stat-label">Subjects</span>
                </div>
              </div>
            </div>
          )}

          {/* Delete confirm */}
          {confirmDel && (
            <div className="course-delete-confirm">
              <p>⚠ This will permanently delete <strong>{course.course_name}</strong>. This cannot be undone.</p>
              <div className="course-delete-confirm-btns">
                <button className="course-footer-btn course-footer-btn--cancel"
                  onClick={() => setConfirmDel(false)}>Cancel</button>
                <button className="course-footer-btn course-footer-btn--delete"
                  disabled={deleting} onClick={handleDelete}>
                  {deleting ? "Deleting…" : "Yes, Delete"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="course-panel-footer">
          {!editing && !confirmDel && (
            <>
              <button className="course-footer-btn course-footer-btn--delete-ghost"
                onClick={() => setConfirmDel(true)}>
                <TrashIcon size={14} /> Delete
              </button>
              <button className="course-footer-btn course-footer-btn--submit"
                onClick={() => { setEditing(true); setMsg(""); setError(""); }}>
                <EditIcon size={14} /> Edit
              </button>
            </>
          )}
          {editing && (
            <>
              <button className="course-footer-btn course-footer-btn--cancel"
                onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
              <button className="course-footer-btn course-footer-btn--submit"
                disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────
export default function CoursesPage() {
  const navigate  = useNavigate();
  const institute = getInstituteProfile();

  const [courses,    setCourses]    = useState([]);
  const [total,      setTotal]      = useState(0);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState("");
  const [showAdd,    setShowAdd]    = useState(false);
  const [viewCourse, setViewCourse] = useState(null); // course object for detail panel
  const [page,       setPage]       = useState(1);
  const [limit,      setLimit]      = useState(6);

  const totalPages = Math.ceil(total / limit);

  const loadCourses = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page, limit });
      const data   = await apiFetch(`/institute/courses?${params}`);
      setCourses(data.courses || []);
      setTotal(data.total || data.courses?.length || 0);
    } catch (err) {
      if (err.message.includes("token")) {
        clearInstituteSession();
        navigate("/institute-login", { replace: true });
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }, [page, limit]);

  useEffect(() => {
    const token = getInstituteToken();
    if (!token) { navigate("/institute-login", { replace: true }); return; }
    loadCourses();
  }, [loadCourses]);

  return (
    <div className="db-shell">
      <Sidebar />

      <div className="db-main">
        <header className="db-topbar">
          <div className="db-topbar-left">
            <h1 className="db-topbar-title">Courses</h1>
          </div>
          <div className="db-topbar-right">
            <BuildingIcon size={18} />
            <span className="db-topbar-college">{institute?.college_name}</span>
            <span className="db-topbar-aishe-badge">AISHE: {institute?.aishe_code}</span>
          </div>
        </header>

        <main className="db-content">

          {/* Heading */}
          <div className="course-page-header">
            <div>
              <div className="course-title-row">
                <h2 className="course-page-title">Courses</h2>
                <span className="course-count-badge">{total}</span>
              </div>
              <p className="course-page-subtitle">Manage all courses offered by your institute</p>
            </div>
            <button className="course-add-btn" onClick={() => setShowAdd(true)}>
              <PlusIcon size={16} /> Add Course
            </button>
          </div>

          {error && <div className="db-alert db-alert--error">{error}</div>}

          {/* Grid */}
          {loading ? (
            <div className="course-loading">Loading courses…</div>
          ) : courses.length === 0 ? (
            <div className="course-empty">
              <BookIcon size={40} />
              <p>No courses added yet.</p>
              <button className="course-add-btn" onClick={() => setShowAdd(true)}>
                <PlusIcon size={16} /> Add your first course
              </button>
            </div>
          ) : (
            <div className="course-grid">
              {courses.map((course) => (
                <div key={course.course_id} className="course-card">
                  <div className="course-card-top">
                    <CourseAvatar abbr={course.abbr} />
                    <div className="course-card-title-wrap">
                      <h3 className="course-card-name">{course.course_name}</h3>
                      <QualBadge abbr={course.abbr} />
                    </div>
                  </div>

                  <div className="course-card-meta">
                    <div className="course-meta-item">
                      <ClockIcon size={14} />
                      <div>
                        <span className="course-meta-label">Duration</span>
                        <span className="course-meta-value">{course.duration || "—"}</span>
                      </div>
                    </div>
                    <div className="course-meta-item">
                      <GradIcon size={14} />
                      <div>
                        <span className="course-meta-label">Qualification</span>
                        <span className="course-meta-value">{qualLabel(course.qualification)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="course-card-stats">
                    <div className="course-stat">
                      <span className="course-stat-label">Students</span>
                      <span className="course-stat-value">{course.student_count ?? "—"}</span>
                    </div>
                    <div className="course-stat-divider" />
                    <div className="course-stat">
                      <span className="course-stat-label">Subjects</span>
                      <span className="course-stat-value">{course.subject_count ?? "—"}</span>
                    </div>
                    {course.total_semesters && (
                      <>
                        <div className="course-stat-divider" />
                        <div className="course-stat">
                          <span className="course-stat-label">Semesters</span>
                          <span className="course-stat-value">{course.total_semesters}</span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* View Details — opens inline panel, no navigation */}
                  <button className="course-view-btn" onClick={() => setViewCourse(course)}>
                    View Details <ArrowRightIcon size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {!loading && total > 0 && (
            <div className="course-pagination">
              <span className="course-pagination-info">
                Showing {Math.min((page-1)*limit+1, total)} to {Math.min(page*limit, total)} of {total} courses
              </span>
              <div className="course-pagination-controls">
                <button className="course-page-btn" disabled={page<=1} onClick={() => setPage((p)=>p-1)}>‹</button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i+1).map((p) => (
                  <button key={p} className={`course-page-btn${page===p?" course-page-btn--active":""}`}
                    onClick={() => setPage(p)}>{p}</button>
                ))}
                <button className="course-page-btn" disabled={page>=totalPages} onClick={() => setPage((p)=>p+1)}>›</button>
              </div>
              <select className="course-per-page" value={limit}
                onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
                {PER_PAGE_OPTS.map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
            </div>
          )}
        </main>
      </div>

      {/* Add Course panel */}
      {showAdd && (
        <AddCoursePanel onClose={() => setShowAdd(false)} onAdded={loadCourses} />
      )}

      {/* View/Edit Course panel */}
      {viewCourse && (
        <CourseDetailPanel
          course={viewCourse}
          onClose={() => setViewCourse(null)}
          onUpdated={() => { loadCourses(); setViewCourse(null); }}
          onDeleted={() => { loadCourses(); setViewCourse(null); }}
        />
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
function BuildingIcon({ size=20 })   { return <Svg size={size}><path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/></Svg>; }
function PlusIcon({ size=20 })       { return <Svg size={size}><path d="M12 5v14M5 12h14"/></Svg>; }
function BookIcon({ size=20 })       { return <Svg size={size}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></Svg>; }
function ClockIcon({ size=20 })      { return <Svg size={size}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></Svg>; }
function ArrowRightIcon({ size=20 }) { return <Svg size={size}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></Svg>; }
function SemIcon({ size=20 })        { return <Svg size={size}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></Svg>; }
function TrashIcon({ size=20 })      { return <Svg size={size}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></Svg>; }
function EditIcon({ size=20 })       { return <Svg size={size}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></Svg>; }
function MonitorIcon()  { return <Svg size={22}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></Svg>; }
function CodeIcon()     { return <Svg size={22}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></Svg>; }
function BriefIcon()    { return <Svg size={22}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></Svg>; }
function FlaskIcon()    { return <Svg size={22}><path d="M9 3h6m-6 0v6l-4 9a1 1 0 0 0 .9 1.5h12.2A1 1 0 0 0 19 18l-4-9V3"/></Svg>; }
function CpuIcon()      { return <Svg size={22}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/></Svg>; }
function ChartIcon()    { return <Svg size={22}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></Svg>; }
function GearIcon()     { return <Svg size={22}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></Svg>; }
function ScaleIcon()    { return <Svg size={22}><line x1="12" y1="3" x2="12" y2="21"/><path d="M3 8h18M3 16h18"/></Svg>; }
function GradIcon({ size=16 })    { return <Svg size={size}><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></Svg>; }
function DegreeIcon({ size=16 })  { return <Svg size={size}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></Svg>; }
function DiplomaIcon({ size=16 }) { return <Svg size={size}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></Svg>; }
function CertIcon({ size=16 })    { return <Svg size={size}><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/></Svg>; }