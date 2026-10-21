// @ts-nocheck
/**
 * ManageShell.jsx — shared layout for every page in the head "Manage" section.
 * Same shell as the teacher pages (sidebar + sticky topbar + scrolling main),
 * so Semesters / Subjects / Timetable / Calendar / Reports all look alike.
 *
 *   <ManageShell title="Semesters" subtitle="…" actions={<button/>}>
 *     …page content…
 *   </ManageShell>
 */
import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { getUserSession } from "../services/session";
import AppSidebar from "./AppSidebar";
import SuggestionsPanel from "./SuggestionsPanel";
import { SuggestionsProvider } from "./SuggestionsProvider";
import "./ManageShell.css";

// Which Manage area the current page belongs to (for the suggestions panel)
const AREA_BY_PATH = {
  semesters: "semesters", subjects: "subjects", divisions: "divisions",
  timetable: "timetable", calendar: "calendar", reports: "reports",
};

export default function ManageShell({ title, subtitle, actions, children }) {
  const navigate = useNavigate();
  const session = getUserSession();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!session) navigate("/", { replace: true });
  }, []);
  if (!session) return null;

  const profile = session.profile || {};
  const user = session.user || {};
  const displayName = profile.first_name
    ? `${profile.first_name} ${profile.last_name || ""}`.trim()
    : user.email || "H";
  const department = String(profile.head_of || "").trim();
  // Same rule as ProtectedRoute: is_head flag, hod/head_teacher role, or head_of on the profile
  const isHead =
    !!user.is_head || user.role === "hod" || user.role === "head_teacher" || !!department;
  const area = AREA_BY_PATH[pathname.split("/manage/")[1]?.split("/")[0]] || null;
  const delegated = Array.isArray(user.delegations) ? user.delegations : [];
  const delegatedLabels = [...new Set(delegated.map((d) => (typeof d === "string" ? d : d?.area)))]
    .map((k) => ({ semesters: "Semesters", subjects: "Subjects", divisions: "Divisions", timetable: "Timetable", calendar: "Calendar", reports: "Reports" }[k]))
    .filter(Boolean);

  const todayStr = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <SuggestionsProvider area={area}>
    <div className="mg-page">
      <AppSidebar role={isHead ? "head" : "teacher"} pendingOD={0} />

      <div className="mg-main-wrap">
        <header className="mg-topbar">
          <div className="mg-topbar-left">
            <h1 className="mg-topbar-title">Manage</h1>
            <span className="mg-topbar-date">{todayStr}</span>
          </div>
          <div className="mg-topbar-right">
            <SuggestionsPanel />
            <span className="mg-role-pill">
              {isHead
                ? `Head Teacher${department ? ` · ${department}` : ""}`
                : `Delegate${delegatedLabels.length ? ` · ${delegatedLabels.join(", ")}` : ""}`}
            </span>
            <div className="mg-topbar-avatar">{(displayName[0] || "H").toUpperCase()}</div>
          </div>
        </header>

        <main className="mg-main">
          <div className="mg-heading">
            <div>
              <h2 className="mg-title">{title}</h2>
              {subtitle && <p className="mg-sub">{subtitle}</p>}
            </div>
            {actions && <div className="mg-heading-actions">{actions}</div>}
          </div>
          {children}
        </main>
      </div>
    </div>
    </SuggestionsProvider>
  );
}