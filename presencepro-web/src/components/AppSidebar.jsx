// @ts-nocheck
import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { clearUserSession, getUserSession } from "../services/session";
import webLogo from "../assets/web_logo.png";
import "./AppSidebar.css";

const NAV = {
  teacher: [
    { path: "/dashboard/teacher", label: "Dashboard", icon: <GridIcon /> },
    {
      path: "/dashboard/teacher/schedule",
      label: "Schedule",
      icon: <CalIcon />,
    },
    {
      path: "/dashboard/teacher/assignments",
      label: "Assignments",
      icon: <FileIcon />,
    },
    { path: "/dashboard/teacher/tests", label: "Tests", icon: <QuizIcon /> },
    {
      path: "/dashboard/teacher/od",
      label: "OD Requests",
      icon: <OdIcon />,
      badgeKey: "pendingOD",
    },
    {
      path: "/dashboard/teacher/announcements",
      label: "Announcements",
      icon: <MegIcon />,
    },
    {
      path: "/dashboard/teacher/reports",
      label: "Reports",
      icon: <ReportIcon />,
    },
  ],
  head: [
    { path: "/dashboard/head", label: "Dashboard", icon: <GridIcon /> },
    { path: "/dashboard/head/schedule", label: "Schedule", icon: <CalIcon /> },
    {
      path: "/dashboard/head/assignments",
      label: "Assignments",
      icon: <FileIcon />,
    },
    { path: "/dashboard/head/tests", label: "Tests", icon: <QuizIcon /> },
    {
      path: "/dashboard/head/od",
      label: "OD Requests",
      icon: <OdIcon />,
      badgeKey: "pendingOD",
    },
    {
      path: "/dashboard/head/announcements",
      label: "Announcements",
      icon: <MegIcon />,
    },
    { path: "/dashboard/head/reports", label: "Reports", icon: <ReportIcon /> },
  ],
  student: [
    { path: "/dashboard/student", label: "Home", icon: <GridIcon /> },
    {
      path: "/dashboard/student/attendance",
      label: "Attendance",
      icon: <CalIcon />,
    },
    {
      path: "/dashboard/student/assignments",
      label: "Assignments",
      icon: <FileIcon />,
    },
    { path: "/dashboard/student/tests", label: "Tests", icon: <QuizIcon /> },
    { path: "/dashboard/student/od", label: "OD Requests", icon: <OdIcon /> },
    {
      path: "/dashboard/student/announcements",
      label: "Announcements",
      icon: <MegIcon />,
    },
  ],
};

export default function AppSidebar({ role = "teacher", pendingOD = 0 }) {
  const navigate = useNavigate();
  const location = useLocation();
  const session = getUserSession();
  const profile = session?.profile || {};
  const user = session?.user || {};
  const [collapsed, setCollapsed] = useState(false);

  const displayName = profile.first_name
    ? `${profile.first_name} ${profile.last_name || ""}`.trim()
    : user.email || "User";

  const roleLabel =
    role === "head"
      ? "Head of Department"
      : role === "teacher"
        ? "Teacher"
        : "Student";

  const navItems = NAV[role] || NAV.teacher;
  const badges = { pendingOD };

  const handleLogout = () => {
    clearUserSession();
    navigate("/", { replace: true });
  };

  return (
    <aside
      className={`app-sidebar${collapsed ? " app-sidebar--collapsed" : ""}`}
    >
      {/* Brand + toggle */}
      <div className="app-sidebar-brand">
        {!collapsed && (
          <img src={webLogo} alt="PresencePro" className="app-sidebar-logo" />
        )}
        <button
          className="app-sidebar-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        </button>
      </div>

      {/* Profile */}
      <div className="app-sidebar-profile">
        <div className="app-sidebar-avatar">
          {(displayName[0] || "U").toUpperCase()}
        </div>
        {!collapsed && (
          <div className="app-sidebar-profile-info">
            <span className="app-sidebar-profile-name">{displayName}</span>
            <span className="app-sidebar-profile-role">{roleLabel}</span>
            {profile.departments?.length > 0 && (
              <div className="app-sidebar-depts">
                {profile.departments.map((d) => (
                  <span key={d} className="app-sidebar-dept-tag">
                    {d}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="app-sidebar-nav">
        {navItems.map(({ path, label, icon, badgeKey }) => {
          const isActive = location.pathname === path;
          const badge = badgeKey ? badges[badgeKey] || 0 : 0;
          return (
            <a
              key={path}
              href={path}
              className={`app-sidebar-nav-item${isActive ? " app-sidebar-nav-item--active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(path);
              }}
              title={collapsed ? label : undefined}
            >
              <span className="app-sidebar-nav-icon">{icon}</span>
              {!collapsed && (
                <span className="app-sidebar-nav-label">{label}</span>
              )}
              {!collapsed && badge > 0 && (
                <span className="app-sidebar-nav-badge">{badge}</span>
              )}
              {collapsed && badge > 0 && (
                <span className="app-sidebar-nav-badge app-sidebar-nav-badge--dot" />
              )}
            </a>
          );
        })}
      </nav>

      {/* Logout */}
      <button
        className="app-sidebar-logout"
        onClick={handleLogout}
        title={collapsed ? "Logout" : undefined}
      >
        <LogoutIcon />
        {!collapsed && <span>Logout</span>}
      </button>
    </aside>
  );
}

const Svg = ({ size = 18, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
function GridIcon() {
  return (
    <Svg>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </Svg>
  );
}
function CalIcon() {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </Svg>
  );
}
function FileIcon() {
  return (
    <Svg>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Svg>
  );
}
function QuizIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  );
}
function OdIcon() {
  return (
    <Svg>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </Svg>
  );
}
function MegIcon() {
  return (
    <Svg>
      <path d="M3 11l19-9-9 19-2-8-8-2z" />
    </Svg>
  );
}
function ReportIcon() {
  return (
    <Svg>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </Svg>
  );
}
function LogoutIcon() {
  return (
    <Svg>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </Svg>
  );
}
function ChevronLeftIcon() {
  return (
    <Svg>
      <polyline points="15 18 9 12 15 6" />
    </Svg>
  );
}
function ChevronRightIcon() {
  return (
    <Svg>
      <polyline points="9 18 15 12 9 6" />
    </Svg>
  );
}
