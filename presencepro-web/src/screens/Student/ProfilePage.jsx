// @ts-nocheck
import { QRCodeSVG } from "qrcode.react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../../services/firebase";
import { clearUserSession } from "../../services/session";
import { StudentShell, PageHeader, useProfile, useStudentInfo, Skeleton, ErrorBox, Pill } from "./ui";

export default function ProfilePage() {
  const nav = useNavigate();
  const { uid, profile: cached, email } = useStudentInfo();
  const q = useProfile();
  const p = { ...cached, ...(q.data?.profile || {}) };
  const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(" ") || email || "Student";
  const roll = p.roll_no || p.roll_number;

  const rows = [
    ["Full name", name],
    ["Roll number", roll],
    ["Email", p.email || email],
    ["Phone", p.phone],
    ["Institution", p.college_name],
    ["University", p.university_name],
    ["Course", p.course_name],
    ["Semester", p.semester ? `Semester ${p.semester}` : null],
    ["Academic year", p.year],
  ].filter(([, v]) => v);

  return (
    <StudentShell title="My Profile">
      <PageHeader title="My profile" sub="Your details as registered with your institute." />
      <ErrorBox error={q.error && !q.data && !cached?.name ? q.error : null} onRetry={q.reload} />
      {q.loading && !cached?.name ? <Skeleton rows={3} height={120} /> : (
        <div className="st-split st-split--profile">
          <div className="st-idcard">
            <div className="st-idavatar">{(name[0] || "S").toUpperCase()}</div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>{name}</div>
            {roll && <div className="st-sub" style={{ margin: 0 }}>Roll no. {roll}</div>}
            {p.approval_status === "approved" && <Pill tone="green">✓ Verified student</Pill>}
            <div style={{ background: "#fff", padding: 14, borderRadius: 16, border: "1px solid #E5E7EB", marginTop: 8 }}>
              <QRCodeSVG value={JSON.stringify({ uid, type: "student_id" })} size={180} fgColor="#1E293B" />
            </div>
            <div className="st-sub" style={{ margin: 0, fontSize: 12 }}>Show this QR to your teacher to verify your identity</div>
          </div>

          <div className="st-card">
            <div className="st-h2" style={{ marginBottom: 6 }}>Details</div>
            <div className="st-info">
              {rows.flatMap(([k, v]) => [<div key={k}>{k}</div>, <div key={k + "v"}>{String(v)}</div>])}
            </div>
            <div style={{ marginTop: 18 }}>
              <button className="st-btn st-btn--danger" onClick={() => { clearUserSession(); signOut(auth).catch(() => {}); nav("/", { replace: true }); }}>Log out</button>
            </div>
          </div>
        </div>
      )}
    </StudentShell>
  );
}
