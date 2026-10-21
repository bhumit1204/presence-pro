// @ts-nocheck
import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../services/firebase";
import { clearUserSession, getUserSession } from "../services/session";
import webLogo from "../assets/web_logo.png";
import "./AppSidebar.css";
import "./AppSidebarManage.css";
import { useSessionVersion } from "../services/refreshSession";

const NAV = {
  teacher: [
    { path: "/dashboard/teacher", label: "Dashboard", icon: <GridIcon /> },
    {
      path: "/dashboard/teacher/schedule",
      label: "Schedule",
      icon: <CalIcon />,
    },
    // Public full-screen QR page for the classroom projector. Opens in a new tab and needs no extra login.
    { path: "/qr", label: "QR Display", icon: <QrIcon />, external: true },
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
  student: [
    { path: "/dashboard/student", label: "Home", icon: <GridIcon /> },
    { path: "/dashboard/student/classes", label: "My Classes", icon: <ClassIcon /> },
    { path: "/dashboard/student/timetable", label: "Timetable", icon: <ClockIcon /> },
    { path: "/dashboard/student/calendar", label: "Academic Calendar", icon: <CalIcon /> },
    {
      path: "/dashboard/student/assignments",
      label: "Assignments",
      icon: <FileIcon />,
      badgeKey: "todo",
    },
    {
      path: "/dashboard/student/tests",
      label: "Tests",
      icon: <QuizIcon />,
      badgeKey: "liveTests",
    },
    {
      path: "/dashboard/student/announcements",
      label: "Announcements",
      icon: <MegIcon />,
      badgeKey: "unread",
    },
    { path: "/dashboard/student/profile", label: "My Profile", icon: <UserIcon /> },
  ],
};

// Head-only management section (collapsible group in the sidebar).
// Routes are placeholders until each page is built.
const MANAGE_ITEMS = [
  { path: "/dashboard/teacher/manage/semesters", label: "Semesters",          area: "semesters" },
  { path: "/dashboard/teacher/manage/subjects",  label: "Subjects & Faculty", area: "subjects" },
  { path: "/dashboard/teacher/manage/divisions", label: "Divisions",          area: "divisions" },
  { path: "/dashboard/teacher/manage/timetable", label: "Timetable",          area: "timetable" },
  { path: "/dashboard/teacher/manage/calendar",  label: "Academic Calendar",  area: "calendar" },
  { path: "/dashboard/teacher/manage/reports",   label: "Student Reports",    area: "reports" },
  { path: "/dashboard/teacher/manage/delegation", label: "Delegation",        headOnly: true },
];

// "Master of Computer Applications" -> "MCA" (short names like "B.Tech" / "MCA" are kept as they are)
const COURSE_STOP = new Set(["of", "in", "and", "the", "for", "&"]);
function courseAbbr(name) {
  const n = String(name || "").trim();
  if (!n || n.length <= 6 || !/\s/.test(n)) return n;
  const letters = n.split(/\s+/).filter((w) => !COURSE_STOP.has(w.toLowerCase())).map((w) => w[0].toUpperCase()).join("");
  return letters.length >= 2 ? letters : n;
}
const TAG_TONES = {
  course: { background: "#EDE9FE", color: "#6D28D9" },
  sem: { background: "#D1FAE5", color: "#047857" },
};

export default function AppSidebar({ role = "teacher", pendingOD = 0, badges: extraBadges = {} }) {
  const navigate = useNavigate();
  const location = useLocation();
  useSessionVersion(); // re-render when head status etc. changes server-side
  const session = getUserSession();
  const profile = session?.profile || {};
  const user = session?.user || {};
  const [collapsed, setCollapsed] = useState(false);

  // A head uses the teacher pages; the only difference is the Manage group.
  const baseRole = role === "head" ? "teacher" : role;
  const isHead =
    baseRole === "teacher" &&
    (role === "head" ||
      !!user.is_head ||
      user.role === "hod" ||
      user.role === "head_teacher" ||
      // The institute app marks a head with head_of (e.g. "MCA"); the
      // designation can be anything ("head", "Professor"...), so don't use it.
      !!String(profile.head_of || "").trim());
  // A teacher the head delegated areas to sees just those items under Manage.
  const delegatedAreas = new Set(
    (Array.isArray(user.delegations) ? user.delegations : []).map((d) => (typeof d === "string" ? d : d?.area)),
  );
  const isDelegate = baseRole === "teacher" && !isHead && delegatedAreas.size > 0;
  const manageItems = MANAGE_ITEMS.filter((i) => (isHead ? true : !i.headOnly && delegatedAreas.has(i.area)));
  const [manageOpen, setManageOpen] = useState(() =>
    location.pathname.includes("/manage"),
  );

  const displayName = profile.first_name
    ? `${profile.first_name} ${profile.last_name || ""}`.trim()
    : profile.name || user.email || "User";

  const roleLabel =
    isHead
      ? "Head Teacher"
      : baseRole === "teacher"
        ? "Teacher"
        : "Student";

  const navItems = NAV[baseRole] || NAV.teacher;
  const tagList =
    baseRole === "student"
      ? [
          profile.course_name ? { text: courseAbbr(profile.course_code || profile.course_name), tone: "course", title: profile.course_name } : null,
          profile.semester ? { text: `Sem ${profile.semester}`, tone: "sem" } : null,
        ].filter(Boolean)
      : (profile.departments || []).map((d) => ({ text: d }));

  // "/dashboard/student" (home) only matches exactly; every other item also matches its sub-pages
  const isHomePath = (p) => p === "/dashboard/teacher" || p === "/dashboard/student";
  const isActivePath = (p) =>
    isHomePath(p) ? location.pathname === p : location.pathname === p || location.pathname.startsWith(p + "/");
  const badges = { pendingOD, ...extraBadges };

  const handleLogout = () => {
    clearUserSession();
    signOut(auth).catch(() => {}); // end the Firebase session too, not just the stored copy
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
            {tagList.length > 0 && (
              <div className="app-sidebar-depts">
                {tagList.map((t) => (
                  <span key={t.text} className="app-sidebar-dept-tag" title={t.title} style={TAG_TONES[t.tone]}>
                    {t.text}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="app-sidebar-nav">
        {navItems.map(({ path, label, icon, badgeKey, external }) => {
          const isActive = !external && isActivePath(path);
          const badge = badgeKey ? badges[badgeKey] || 0 : 0;
          return (
            <a
              key={path}
              href={path}
              className={`app-sidebar-nav-item${isActive ? " app-sidebar-nav-item--active" : ""}`}
              {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              onClick={(e) => {
                if (external) return; // let the browser open the new tab
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

        {/* Manage — heads, and teachers the head delegated areas to; collapsible */}
        {(isHead || isDelegate) && (
          <div className="app-sidebar-group">
            <button
              type="button"
              className={`app-sidebar-nav-item app-sidebar-group-toggle${
                location.pathname.includes("/manage")
                  ? " app-sidebar-nav-item--active"
                  : ""
              }`}
              onClick={() => {
                if (collapsed) {
                  setCollapsed(false);
                  setManageOpen(true);
                } else {
                  setManageOpen((v) => !v);
                }
              }}
              aria-expanded={manageOpen}
              title={collapsed ? "Manage" : undefined}
            >
              <span className="app-sidebar-nav-icon">
                <SettingsIcon />
              </span>
              {!collapsed && (
                <>
                  <span className="app-sidebar-nav-label">Manage</span>
                  <span
                    className={`app-sidebar-chevron${manageOpen ? " app-sidebar-chevron--open" : ""}`}
                  >
                    <ChevronDownIcon />
                  </span>
                </>
              )}
            </button>

            {!collapsed && manageOpen && (
              <div className="app-sidebar-sub">
                {manageItems.map(({ path, label }) => (
                  <a
                    key={path}
                    href={path}
                    className={`app-sidebar-nav-item app-sidebar-sub-item${
                      location.pathname === path
                        ? " app-sidebar-nav-item--active"
                        : ""
                    }`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(path);
                    }}
                  >
                    <span className="app-sidebar-nav-label">{label}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
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
function SettingsIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  );
}
function QrIcon() {
  return (
    <Svg>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
    </Svg>
  );
}
function ClockIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </Svg>
  );
}
function ClassIcon() {
  return (
    <Svg>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </Svg>
  );
}
function UserIcon() {
  return (
    <Svg>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  );
}
function ChevronDownIcon() {
  return (
    <Svg size={14}>
      <polyline points="6 9 12 15 18 9" />
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