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
import { useNavigate } from "react-router-dom";
import { getUserSession } from "../services/session";
import AppSidebar from "./AppSidebar";
import "./ManageShell.css";

export default function ManageShell({ title, subtitle, actions, children }) {
  const navigate = useNavigate();
  const session = getUserSession();

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

  const todayStr = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <div className="mg-page">
      <AppSidebar role="head" pendingOD={0} />

      <div className="mg-main-wrap">
        <header className="mg-topbar">
          <div className="mg-topbar-left">
            <h1 className="mg-topbar-title">Manage</h1>
            <span className="mg-topbar-date">{todayStr}</span>
          </div>
          <div className="mg-topbar-right">
            <span className="mg-role-pill">Head Teacher{department ? ` · ${department}` : ""}</span>
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
  );
}