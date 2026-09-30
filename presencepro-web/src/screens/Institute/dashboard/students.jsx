// @ts-nocheck
import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getInstituteToken, getInstituteProfile, clearInstituteSession } from "./protected_route";
import Sidebar from "../../../components/Inst_SideBar";
import "./students.css";

const INSTITUTE_API = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";
const PER_PAGE_OPTS = [10, 25, 50];

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

// ── Status badge ──────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    approved: { cls: "s-badge--green",  label: "Approved" },
    pending:  { cls: "s-badge--orange", label: "Pending"  },
    rejected: { cls: "s-badge--red",    label: "Rejected" },
    removed:  { cls: "s-badge--gray",   label: "Removed"  },
  };
  const { cls, label } = map[status] || { cls: "s-badge--gray", label: status };
  return <span className={`s-badge ${cls}`}>{label}</span>;
}

// ── Confirm modal ─────────────────────────────────────────────────────
function ConfirmModal({ title, message, confirmLabel, confirmClass, onConfirm, onCancel }) {
  return (
    <div className="s-modal-overlay" onClick={onCancel}>
      <div className="s-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="s-modal-title">{title}</h3>
        <p className="s-modal-message">{message}</p>
        <div className="s-modal-actions">
          <button className="s-btn s-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className={`s-btn ${confirmClass}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ── Student Detail Drawer ─────────────────────────────────────────────
function StudentDrawer({ student, subjects, onClose, onAction, actionLoading }) {
  return (
    <div className="s-drawer-overlay" onClick={onClose}>
      <div className="s-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="s-drawer-header">
          <div>
            <h2 className="s-drawer-name">{student.first_name} {student.last_name}</h2>
            <span className="s-drawer-email">{student.email || "—"}</span>
          </div>
          <button className="s-drawer-close" onClick={onClose}>✕</button>
        </div>

        {/* Info grid */}
        <div className="s-drawer-info">
          <div className="s-drawer-info-item">
            <span className="s-drawer-info-label">Roll No</span>
            <span className="s-drawer-info-value">{student.roll_no || "—"}</span>
          </div>
          <div className="s-drawer-info-item">
            <span className="s-drawer-info-label">Course</span>
            <span className="s-drawer-info-value">{student.course_name || "—"} ({student.degree || "—"})</span>
          </div>
          <div className="s-drawer-info-item">
            <span className="s-drawer-info-label">Semester</span>
            <span className="s-drawer-info-value">Semester {student.semester || "—"}</span>
          </div>
          <div className="s-drawer-info-item">
            <span className="s-drawer-info-label">Year</span>
            <span className="s-drawer-info-value">{student.year || "—"}</span>
          </div>
          <div className="s-drawer-info-item">
            <span className="s-drawer-info-label">Phone</span>
            <span className="s-drawer-info-value">{student.phone || "—"}</span>
          </div>
          <div className="s-drawer-info-item">
            <span className="s-drawer-info-label">Status</span>
            <StatusBadge status={student.approval_status} />
          </div>
          <div className="s-drawer-info-item s-drawer-info-item--full">
            <span className="s-drawer-info-label">University</span>
            <span className="s-drawer-info-value">{student.university_name || "—"}</span>
          </div>
        </div>

        {/* Enrolled subjects */}
        <div className="s-drawer-section">
          <h4 className="s-drawer-section-title">Enrolled Subjects ({subjects.length})</h4>
          {subjects.length === 0 ? (
            <p className="s-drawer-empty">No subjects enrolled.</p>
          ) : (
            <div className="s-drawer-subjects">
              {subjects.map((s) => (
                <div key={s.subject_id} className="s-drawer-subject-item">
                  <span className="s-drawer-subject-name">{s.subject_name}</span>
                  <span className="s-drawer-subject-meta">{s.subject_code} · {s.semester}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        {student.approval_status !== "removed" && (
          <div className="s-drawer-actions-section">
            <h4 className="s-drawer-section-title">Actions</h4>
            <div className="s-drawer-action-grid">
              {student.approval_status === "pending" && (
                <>
                  <button className="s-btn s-btn--approve" disabled={actionLoading}
                    onClick={() => onAction("approve")}>✓ Approve</button>
                  <button className="s-btn s-btn--reject" disabled={actionLoading}
                    onClick={() => onAction("reject")}>✕ Reject</button>
                </>
              )}
              {student.approval_status === "approved" && (
                <button className="s-btn s-btn--reject" disabled={actionLoading}
                  onClick={() => onAction("reject")}>✕ Reject</button>
              )}
              <button className="s-btn s-btn--danger" disabled={actionLoading}
                onClick={() => onAction("remove")}>Remove Student</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────
export default function StudentsPage() {
  const navigate  = useNavigate();
  const institute = getInstituteProfile();

  // Data
  const [students,    setStudents]    = useState([]);
  const [courses,     setCourses]     = useState([]);
  const [total,       setTotal]       = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState("");
  const [actionMsg,   setActionMsg]   = useState("");

  // Auto-approve
  const [autoApproveEnabled, setAutoApproveEnabled] = useState(false);
  const [autoDomains,        setAutoDomains]        = useState([]);
  const [autoRunLoading,     setAutoRunLoading]     = useState(false);

  // Filters
  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [courseFilter, setCourseFilter] = useState("");
  const [semFilter,    setSemFilter]    = useState("");
  const [page,         setPage]         = useState(1);
  const [limit,        setLimit]        = useState(10);

  // Drawer
  const [selected,      setSelected]      = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Confirm modal
  const [confirmModal, setConfirmModal] = useState(null);

  // Bulk selection
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [bulkLoading,  setBulkLoading]  = useState(false);

  // Load courses + auto-approve domains on mount
  useEffect(() => {
    const token = getInstituteToken();
    if (!token) { navigate("/institute-login", { replace: true }); return; }

    apiFetch("/institute/courses")
      .then((d) => setCourses(d.courses || []))
      .catch(() => {});

    apiFetch("/settings/auto-approve")
      .then((d) => {
        setAutoApproveEnabled(d.auto_approve_enabled || false);
        setAutoDomains(d.auto_approve_domains || []);
      })
      .catch(() => {});
  }, []);

  const loadStudents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page, limit });
      if (statusFilter) params.set("status",   statusFilter);
      if (courseFilter) params.set("course",   courseFilter);
      if (semFilter)    params.set("semester", semFilter);

      const data = await apiFetch(`/institute/students?${params}`);
      setStudents(data.students || []);
      setTotal(data.pagination?.total || 0);
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
  }, [statusFilter, courseFilter, semFilter, page, limit]);

  useEffect(() => { loadStudents(); }, [loadStudents]);

  // Client-side search
  const filtered = students.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      `${s.first_name} ${s.last_name}`.toLowerCase().includes(q) ||
      (s.roll_no || "").toLowerCase().includes(q) ||
      (s.email   || "").toLowerCase().includes(q)
    );
  });

  const totalPages      = Math.ceil(total / limit);
  const pendingFiltered = filtered.filter((s) => s.approval_status === "pending");
  const allPendingSelected = pendingFiltered.length > 0 &&
    pendingFiltered.every((s) => bulkSelected.has(s.student_id));

  // Bulk helpers
  const toggleBulkOne = (id) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleBulkAll = () => {
    if (allPendingSelected) {
      setBulkSelected(new Set());
    } else {
      setBulkSelected(new Set(pendingFiltered.map((s) => s.student_id)));
    }
  };

  const handleBulkAction = async (action) => {
    if (bulkSelected.size === 0) return;
    setBulkLoading(true);
    setActionMsg("");
    try {
      await Promise.all(
        [...bulkSelected].map((id) =>
          apiFetch(`/institute/students/${id}/${action}`, { method: "PUT" })
        )
      );
      setActionMsg(`${bulkSelected.size} student(s) ${action === "approve" ? "approved" : "rejected"}.`);
      setBulkSelected(new Set());
      loadStudents();
    } catch (err) {
      setActionMsg(`Bulk action error: ${err.message}`);
    } finally {
      setBulkLoading(false);
    }
  };

  // Auto-approve run
  const handleAutoApprove = async () => {
    setAutoRunLoading(true);
    setActionMsg("");
    try {
      const data = await apiFetch("/institute/students/auto-approve-run", { method: "POST" });
      setActionMsg(data.message || `${data.approved} student(s) approved.`);
      loadStudents();
    } catch (err) {
      setActionMsg(`Auto-approve error: ${err.message}`);
    } finally {
      setAutoRunLoading(false);
    }
  };

  // Open detail drawer
  const openDetail = async (student) => {
    setSelected({ student, subjects: [] });
    setActionMsg("");
    try {
      const data = await apiFetch(`/institute/students/${student.student_id}`);
      setSelected({ student: data.student, subjects: data.subjects || [] });
    } catch {}
  };

  // Execute action from drawer
  const handleAction = async (action, payload = {}) => {
    if (!selected) return;
    const id = selected.student.student_id;

    if (["reject", "remove"].includes(action)) {
      setConfirmModal({ action, payload, id });
      return;
    }

    setActionLoading(true);
    setActionMsg("");
    try {
      const method = action === "remove" ? "DELETE" : "PUT";
      const path   = `/institute/students/${id}${action === "remove" ? "" : `/${action}`}`;
      const data   = await apiFetch(path, {
        method,
        body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
      });
      setActionMsg(data.message || "Done.");
      const fresh = await apiFetch(`/institute/students/${id}`);
      setSelected({ student: fresh.student, subjects: fresh.subjects || [] });
      loadStudents();
    } catch (err) {
      setActionMsg(`Error: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const confirmAction = async () => {
    if (!confirmModal) return;
    const { action, payload, id } = confirmModal;
    setConfirmModal(null);
    setActionLoading(true);
    setActionMsg("");
    try {
      const method = action === "remove" ? "DELETE" : "PUT";
      const path   = `/institute/students/${id}${action === "remove" ? "" : `/${action}`}`;
      const data   = await apiFetch(path, {
        method,
        body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
      });
      setActionMsg(data.message || "Done.");
      if (action === "remove") setSelected(null);
      else {
        const fresh = await apiFetch(`/institute/students/${id}`);
        setSelected({ student: fresh.student, subjects: fresh.subjects || [] });
      }
      loadStudents();
    } catch (err) {
      setActionMsg(`Error: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const clearFilters = () => {
    setSearch(""); setStatusFilter(""); setCourseFilter(""); setSemFilter(""); setPage(1);
  };

  const isAutoApproveOn = autoApproveEnabled && autoDomains.length > 0;

  return (
    <div className="db-shell">
      <Sidebar />

      <div className="db-main">
        <header className="db-topbar">
          <div className="db-topbar-left">
            <h1 className="db-topbar-title">Students</h1>
          </div>
          <div className="db-topbar-right">
            <BuildingIcon size={18} />
            <span className="db-topbar-college">{institute?.college_name}</span>
            <span className="db-topbar-aishe-badge">AISHE: {institute?.aishe_code}</span>
          </div>
        </header>

        <main className="db-content">

          {/* Page heading + auto-approve status */}
          <div className="s-page-header">
            <div>
              <div className="s-page-title-row">
                <h2 className="s-page-title">Students</h2>
                <span className="s-count-badge">{total}</span>
              </div>
              <p className="s-page-subtitle">Manage all students in your institute</p>
            </div>

            {/* Auto-approve status indicator + run button */}
            <div className="s-auto-approve-bar">
              <div className={`s-auto-status ${isAutoApproveOn ? "s-auto-status--on" : "s-auto-status--off"}`}>
                <span className="s-auto-dot" />
                {isAutoApproveOn
                  ? `Auto-approve ON · ${autoDomains.length} domain${autoDomains.length > 1 ? "s" : ""}`
                  : "Auto-approve OFF"}
              </div>
              {isAutoApproveOn && (
                <button
                  className="s-btn s-btn--auto"
                  disabled={autoRunLoading}
                  onClick={handleAutoApprove}
                >
                  {autoRunLoading ? "Running…" : "⚡ Run Auto-approve"}
                </button>
              )}
            </div>
          </div>

          {error     && <div className="db-alert db-alert--error">{error}</div>}
          {actionMsg && <div className={`db-alert ${actionMsg.startsWith("Error") ? "db-alert--error" : "db-alert--ok"}`}>{actionMsg}</div>}

          {/* Filter bar */}
          <div className="s-filter-bar">
            <div className="s-search-wrap">
              <SearchIcon size={16} />
              <input className="s-search-input" placeholder="Search by name, roll no or email…"
                value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
            </div>

            <select className="s-filter-select" value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
              <option value="">All Status</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>

            <select className="s-filter-select" value={courseFilter}
              onChange={(e) => { setCourseFilter(e.target.value); setPage(1); }}>
              <option value="">All Courses</option>
              {courses.map((c) => (
                <option key={c.course_id} value={c.abbr}>{c.abbr}</option>
              ))}
            </select>

            <select className="s-filter-select" value={semFilter}
              onChange={(e) => { setSemFilter(e.target.value); setPage(1); }}>
              <option value="">All Semesters</option>
              {[1,2,3,4,5,6,7,8].map((n) => (
                <option key={n} value={n}>Semester {n}</option>
              ))}
            </select>

            <button className="s-clear-btn" onClick={clearFilters}>
              <RefreshIcon size={14} /> Clear
            </button>
          </div>

          {/* Bulk action bar */}
          {bulkSelected.size > 0 && (
            <div className="s-bulk-bar">
              <span className="s-bulk-count">{bulkSelected.size} student(s) selected</span>
              <button className="s-btn s-btn--approve" disabled={bulkLoading}
                onClick={() => handleBulkAction("approve")}>✓ Approve All</button>
              <button className="s-btn s-btn--reject" disabled={bulkLoading}
                onClick={() => handleBulkAction("reject")}>✕ Reject All</button>
              <button className="s-btn s-btn--ghost"
                onClick={() => setBulkSelected(new Set())}>Clear</button>
            </div>
          )}

          {/* Table */}
          <div className="s-table-card">
            <table className="s-table">
              <thead>
                <tr>
                  <th className="s-th-check">
                    <input type="checkbox"
                      checked={allPendingSelected}
                      onChange={toggleBulkAll}
                      disabled={pendingFiltered.length === 0}
                      title="Select all pending"
                    />
                  </th>
                  <th>Name</th>
                  <th>Roll No</th>
                  <th>Course</th>
                  <th>Semester</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="s-table-center">Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7} className="s-table-center">No students found.</td></tr>
                ) : (
                  filtered.map((student) => {
                    const isPending = student.approval_status === "pending";
                    const isChecked = bulkSelected.has(student.student_id);
                    return (
                      <tr key={student.student_id} className={isChecked ? "s-tr--selected" : ""}>
                        <td className="s-td-check">
                          {isPending && (
                            <input type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleBulkOne(student.student_id)}
                            />
                          )}
                        </td>
                        <td>
                          <div className="s-name-cell">
                            <span className="s-name">{student.first_name} {student.last_name}</span>
                            <span className="s-email">{student.email || "—"}</span>
                          </div>
                        </td>
                        <td>{student.roll_no || "—"}</td>
                        <td>
                          <span className="s-course-tag">{student.degree || "—"}</span>
                        </td>
                        <td>Sem {student.semester || "—"}</td>
                        <td><StatusBadge status={student.approval_status} /></td>
                        <td>
                          <div className="s-action-row">
                            <button className="s-btn s-btn--view" onClick={() => openDetail(student)}>
                              <EyeIcon size={14} /> View
                            </button>
                            {isPending && (
                              <>
                                <button className="s-btn s-btn--approve"
                                  onClick={() => { setSelected({ student, subjects: [] }); handleAction("approve"); }}>
                                  ✓ Approve
                                </button>
                                <button className="s-btn s-btn--reject"
                                  onClick={() => { setSelected({ student, subjects: [] }); setConfirmModal({ action: "reject", payload: {}, id: student.student_id }); }}>
                                  ✕ Reject
                                </button>
                              </>
                            )}
                            {!isPending && <span className="s-dash">—</span>}
                            {!isPending && <span className="s-dash">—</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            {/* Pagination */}
            <div className="s-pagination">
              <span className="s-pagination-info">
                Showing {Math.min((page-1)*limit+1, total)} to {Math.min(page*limit, total)} of {total} students
              </span>
              <div className="s-pagination-controls">
                <button className="s-page-btn" disabled={page<=1} onClick={() => setPage((p)=>p-1)}>‹</button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map((p) => (
                  <button key={p} className={`s-page-btn${page===p?" s-page-btn--active":""}`}
                    onClick={() => setPage(p)}>{p}</button>
                ))}
                <button className="s-page-btn" disabled={page>=totalPages} onClick={() => setPage((p)=>p+1)}>›</button>
              </div>
              <select className="s-filter-select s-per-page" value={limit}
                onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
                {PER_PAGE_OPTS.map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
            </div>
          </div>

        </main>
      </div>

      {/* Detail Drawer */}
      {selected && (
        <StudentDrawer
          student={selected.student}
          subjects={selected.subjects}
          onClose={() => { setSelected(null); setActionMsg(""); }}
          onAction={handleAction}
          actionLoading={actionLoading}
        />
      )}

      {/* Confirm Modal */}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.action === "remove" ? "Remove Student" : "Reject Student"}
          message={
            confirmModal.action === "remove"
              ? "This will permanently remove the student from your institute."
              : "Are you sure you want to reject this student's application?"
          }
          confirmLabel={confirmModal.action === "remove" ? "Yes, Remove" : "Yes, Reject"}
          confirmClass={confirmModal.action === "remove" ? "s-btn--danger" : "s-btn--reject"}
          onConfirm={confirmAction}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
}

/* ── Icons ───────────────────────────────────────────────────────────── */
function BuildingIcon({ size=20 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/></svg>; }
function SearchIcon({ size=20 })   { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>; }
function EyeIcon({ size=20 })      { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>; }
function RefreshIcon({ size=20 })  { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>; }