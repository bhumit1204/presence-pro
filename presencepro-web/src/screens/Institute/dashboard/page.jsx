import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./page.css";
import {
  getInstituteToken,
  getInstituteProfile,
  clearInstituteSession,
} from "./protected_route";
import Sidebar from "../../../components/Inst_SideBar";

const INSTITUTE_API = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";

// ── API helper ────────────────────────────────────────────────────────
async function apiFetch(path) {
  const token = getInstituteToken();
  const res   = await fetch(`${INSTITUTE_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── Course icon based on abbreviation ─────────────────────────────────
function CourseIcon({ abbr }) {
  const icons = {
    MCA:   <MonitorIcon />,
    BCA:   <CodeIcon />,
    MBA:   <BriefcaseIcon />,
    BSC:   <FlaskIcon />,
    BE:    <CpuIcon />,
    BTECH: <CpuIcon />,
    default: <BookOpenIcon />,
  };
  const key = Object.keys(icons).find((k) => abbr?.toUpperCase().includes(k)) || "default";
  return icons[key];
}

export default function InstituteDashboard() {
  const navigate  = useNavigate();
  const institute = getInstituteProfile();

  const [stats,    setStats]    = useState(null);
  const [courses,  setCourses]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState("");


  useEffect(() => {
    const token = getInstituteToken();
    if (!token) { navigate("/institute-login", { replace: true }); return; }
    loadOverview();
  }, []);

  const loadOverview = async () => {
    setLoading(true);
    setError("");
    try {
      const [statsData, coursesData] = await Promise.all([
        apiFetch("/institute/stats"),
        apiFetch("/institute/courses"),
      ]);
      setStats(statsData.stats);
      setCourses(coursesData.courses);
    } catch (err) {
      if (err.message.includes("token") || err.message.includes("401")) {
        clearInstituteSession();
        navigate("/institute-login", { replace: true });
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    const token = getInstituteToken();
    try {
      await fetch(`${INSTITUTE_API}/auth/institute-logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
    clearInstituteSession();
    navigate("/institute-login", { replace: true });
  };

  const hasPending = stats && (stats.pending_teachers > 0 || stats.pending_students > 0);

  return (
    <div className="db-shell">

      {/* ── Sidebar ────────────────────────────────────────────── */}
      <Sidebar
        pendingTeachers={stats?.pending_teachers || 0}
        pendingStudents={stats?.pending_students || 0}
      />

      {/* ── Main ───────────────────────────────────────────────── */}
      <div className="db-main">

        {/* Topbar */}
        <header className="db-topbar">
          <div className="db-topbar-left">
            <h1 className="db-topbar-title">Overview</h1>
          </div>
          <div className="db-topbar-right">
            <BuildingIcon size={18} />
            <span className="db-topbar-college">{institute?.college_name || "—"}</span>
            <span className="db-topbar-aishe-badge">AISHE: {institute?.aishe_code || "—"}</span>
          </div>
        </header>

        {/* Content */}
        <main className="db-content">

          {error && <div className="db-alert db-alert--error">{error}</div>}

          {/* ── College Info Card ──────────────────────────────── */}
          <div className="db-card db-college-card">
            <div className="db-college-card-icon">
              <BuildingIcon size={32} />
            </div>
            <div className="db-college-card-body">
              <div className="db-college-card-title-row">
                <h2 className="db-college-name">{institute?.college_name || "—"}</h2>
                <span className="db-aishe-badge">AISHE: {institute?.aishe_code || "—"}</span>
              </div>
              <div className="db-college-meta-row">
                <span className="db-college-meta-item">
                  <UniversityIcon size={14} />
                  University : <strong>{institute?.university_name || "—"}</strong>
                </span>
                <span className="db-college-meta-item">
                  <TagIcon size={14} />
                  Institute Type : <strong>{institute?.type || "—"}</strong>
                </span>
                <span className="db-college-meta-item">
                  <MapPinIcon size={14} />
                  District : <strong>{institute?.district || "—"}</strong>
                </span>
                <span className="db-college-meta-item">
                  <BookIcon size={14} />
                  State : <strong>{institute?.state || "—"}</strong>
                </span>
              </div>
              <div className="db-college-detail-row">
                <span className="db-college-meta-item">
                  <MailIcon size={14} />
                  Email : <strong>{institute?.email || "—"}</strong>
                </span>
              </div>
              <div className="db-college-detail-row">
                <span className="db-college-meta-item">
                  <MapPinIcon size={14} />
                  Address : <strong>{institute?.full_address ? `${institute.full_address}, ${institute.city}` : "—"}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* ── Stats Row ─────────────────────────────────────── */}
          <div className="db-stats-row">
            <div className="db-stat-card db-stat-card--purple">
              <div className="db-stat-icon db-stat-icon--purple"><GradCapIcon size={24} /></div>
              <div className="db-stat-body">
                <span className="db-stat-label">Total Approved Students</span>
                <span className="db-stat-value db-stat-value--purple">
                  {loading ? "—" : (stats?.approved_students ?? 0).toLocaleString()}
                </span>
              </div>
            </div>
            <div className="db-stat-card db-stat-card--green">
              <div className="db-stat-icon db-stat-icon--green"><UserCheckIcon size={24} /></div>
              <div className="db-stat-body">
                <span className="db-stat-label">Total Approved Teachers</span>
                <span className="db-stat-value db-stat-value--green">
                  {loading ? "—" : (stats?.approved_teachers ?? 0).toLocaleString()}
                </span>
              </div>
            </div>
            <div className="db-stat-card db-stat-card--blue">
              <div className="db-stat-icon db-stat-icon--blue"><BookOpenIcon size={24} /></div>
              <div className="db-stat-body">
                <span className="db-stat-label">Total Courses</span>
                <span className="db-stat-value db-stat-value--blue">
                  {loading ? "—" : stats?.total_courses ?? 0}
                </span>
              </div>
            </div>
            <div className="db-stat-card db-stat-card--orange">
              <div className="db-stat-icon db-stat-icon--orange"><ListIcon size={24} /></div>
              <div className="db-stat-body">
                <span className="db-stat-label">Total Subjects</span>
                <span className="db-stat-value db-stat-value--orange">
                  {loading ? "—" : stats?.total_subjects ?? 0}
                </span>
              </div>
            </div>
          </div>

          {/* ── Pending Approvals Banner ───────────────────────── */}
          {!loading && hasPending && (
            <div className="db-pending-banner">
              <div className="db-pending-icon"><WarningIcon size={22} /></div>
              <div className="db-pending-content">
                <span className="db-pending-title">Pending Approvals</span>
                <div className="db-pending-items">
                  {stats.pending_teachers > 0 && (
                    <span className="db-pending-item">
                      <strong>{stats.pending_teachers}</strong> teachers pending approval
                      <a href="/teachers" className="db-pending-btn">Go to Teachers</a>
                    </span>
                  )}
                  {stats.pending_students > 0 && (
                    <span className="db-pending-item">
                      <strong>{stats.pending_students}</strong> students pending approval
                      <a href="/students" className="db-pending-btn">Go to Students</a>
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Courses Quick View ─────────────────────────────── */}
          <div className="db-card db-courses-section">
            <div className="db-courses-header">
              <h3 className="db-section-title">Courses Quick View</h3>
              <a href="/courses" className="db-view-all-btn">
                View All Courses <ArrowRightIcon size={14} />
              </a>
            </div>

            <div className="db-courses-scroll">
              {loading ? (
                <div className="db-courses-loading">Loading courses…</div>
              ) : courses.length === 0 ? (
                <div className="db-courses-empty">No courses added yet.</div>
              ) : (
                <>
                  {courses.map((course) => (
                    <div key={course.course_id} className="db-course-card">
                      <div className="db-course-card-icon">
                        <CourseIcon abbr={course.abbr} />
                      </div>
                      <div className="db-course-card-name">{course.course_name}</div>
                      <span className="db-course-abbr-badge">{course.abbr}</span>
                      <div className="db-course-card-meta">
                        <span><CalendarIcon size={12} /> Duration</span>
                        <strong>{course.duration}</strong>
                      </div>
                      <div className="db-course-card-meta">
                        <span><GradCapIcon size={12} /> Qualification</span>
                        <strong>{course.qualification}</strong>
                      </div>
                    </div>
                  ))}

                  {/* View All card */}
                  <a href="/dashboard/courses" className="db-course-card db-course-card--viewall">
                    <div className="db-course-viewall-icon"><PlusCircleIcon size={32} /></div>
                    <span className="db-course-viewall-text">View All Courses</span>
                    <ArrowRightIcon size={16} />
                  </a>
                </>
              )}
            </div>
          </div>

        </main>
      </div>
    </div>
  );
}

/* ── SVG Icons ───────────────────────────────────────────────────────── */
const ic = (d, extra = "") => ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

function BuildingIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/><path d="M9 11h.01"/><path d="M15 11h.01"/><path d="M12 11h.01"/><path d="M9 8h.01"/><path d="M15 8h.01"/><path d="M12 8h.01"/></svg>);
}
function HomeIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>);
}
function UserIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>);
}
function UserCheckIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>);
}
function GradCapIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>);
}
function BookOpenIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>);
}
function ListIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>);
}
function SettingsIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>);
}
function LogoutIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>);
}
function MenuIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>);
}
function UniversityIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"/></svg>);
}
function TagIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>);
}
function MapPinIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>);
}
function BookIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>);
}
function MailIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>);
}
function WarningIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>);
}
function ArrowRightIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>);
}
function PlusCircleIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>);
}
function CalendarIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>);
}
function MonitorIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>);
}
function CodeIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>);
}
function BriefcaseIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>);
}
function FlaskIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6m-6 0v6l-4 9a1 1 0 0 0 .9 1.5h12.2A1 1 0 0 0 19 18l-4-9V3"/></svg>);
}
function CpuIcon({ size = 20 }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>);
}