// @ts-nocheck
import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { clearInstituteSession } from "../screens/Institute/dashboard/protected_route";
import webLogo from "../assets/web_logo.png";
import "./Inst_Sidebar.css";

const NAV_ITEMS = [
  { path: "/",          label: "Overview", icon: <HomeIcon />    },
  { path: "/dashboard/teachers",  label: "Teachers", icon: <UserIcon />    },
  { path: "/dashboard/students",  label: "Students", icon: <GradCapIcon /> },
  { path: "/dashboard/courses",   label: "Courses",  icon: <BookIcon />    },
  { path: "/dashboard/subjects",  label: "Subjects", icon: <ListIcon />    },
  { path: "/dashboard/settings",  label: "Settings", icon: <SettingsIcon />},
];

export default function Sidebar({ pendingTeachers = 0, pendingStudents = 0 }) {
  const navigate  = useNavigate();
  const location  = useLocation();
  const [collapsed, setCollapsed] = useState(false);

  const handleLogout = async () => {
    const token = localStorage.getItem("institute_token");
    const API   = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";
    try {
      await fetch(`${API}/auth/institute-logout`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
    clearInstituteSession();
    navigate("/institute-login", { replace: true });
  };

  const badges = {
    "/dashboard/teachers": pendingTeachers,
    "/dashboard/students": pendingStudents,
  };

  return (
    <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>

      {/* Logo + toggle */}
      <div className="sidebar-brand">
        {!collapsed && <img src={webLogo} alt="PresencePro" className="sidebar-logo" />}
        <button
          className="sidebar-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ path, label, icon }) => {
          const isActive = location.pathname === path;
          const badge    = badges[path] || 0;
          return (
            <a
              key={path}
              href={path}
              className={`sidebar-nav-item${isActive ? " sidebar-nav-item--active" : ""}`}
              onClick={(e) => { e.preventDefault(); navigate(path); }}
              title={collapsed ? label : undefined}
            >
              <span className="sidebar-nav-icon">{icon}</span>
              {!collapsed && <span className="sidebar-nav-label">{label}</span>}
              {!collapsed && badge > 0 && (
                <span className="sidebar-nav-badge">{badge}</span>
              )}
              {collapsed && badge > 0 && (
                <span className="sidebar-nav-badge sidebar-nav-badge--dot" />
              )}
            </a>
          );
        })}
      </nav>

      {/* Logout */}
      <button className="sidebar-logout" onClick={handleLogout} title={collapsed ? "Logout" : undefined}>
        <LogoutIcon />
        {!collapsed && <span>Logout</span>}
      </button>

    </aside>
  );
}

/* ── Icons (18px default, consistent size) ───────────────────────────── */
const Ico = ({ d, extra }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {d}
    {extra}
  </svg>
);

function HomeIcon()      { return <Ico d={<><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>} />; }
function UserIcon()      { return <Ico d={<><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>} />; }
function GradCapIcon()   { return <Ico d={<><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></>} />; }
function BookIcon()      { return <Ico d={<><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></>} />; }
function ListIcon()      { return <Ico d={<><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></>} />; }
function SettingsIcon()  { return <Ico d={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>} />; }
function LogoutIcon()    { return <Ico d={<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>} />; }
function ChevronLeftIcon()  { return <Ico d={<polyline points="15 18 9 12 15 6"/>} />; }
function ChevronRightIcon() { return <Ico d={<polyline points="9 18 15 12 9 6"/>} />; }