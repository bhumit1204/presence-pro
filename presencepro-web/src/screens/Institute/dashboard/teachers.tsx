// @ts-nocheck
import { useEffect, useState, useCallback } from "react";
import { useNavigate }                      from "react-router-dom";
import { getInstituteToken, getInstituteProfile, clearInstituteSession } from "./protected_route";
import Sidebar from "../../../components/Inst_SideBar";
import "./Teachers.css";

const INSTITUTE_API  = import.meta.env.VITE_INSTITUTE_API_URL || "http://localhost:5001";
const PER_PAGE_OPTS  = [10, 25, 50];
const DESIGNATIONS   = [
  "Assistant Professor",
  "Associate Professor",
  "Professor",
  "Senior Professor",
];

// ── API helper ────────────────────────────────────────────────────────
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
    approved: { cls: "t-badge--green",  label: "Approved"  },
    pending:  { cls: "t-badge--orange", label: "Pending"   },
    rejected: { cls: "t-badge--red",    label: "Rejected"  },
    removed:  { cls: "t-badge--gray",   label: "Removed"   },
  };
  const { cls, label } = map[status] || { cls: "t-badge--gray", label: status };
  return <span className={`t-badge ${cls}`}>{label}</span>;
}

// ── Department tag ────────────────────────────────────────────────────
function DeptTag({ dept, isHead }) {
  return (
    <span className={`t-dept-tag${isHead ? " t-dept-tag--head" : ""}`}>
      {dept}
      {isHead && <span className="t-head-pip">Head</span>}
    </span>
  );
}

// ── Confirm modal ─────────────────────────────────────────────────────
function ConfirmModal({ title, message, confirmLabel, confirmClass, onConfirm, onCancel, children }) {
  return (
    <div className="t-modal-overlay" onClick={onCancel}>
      <div className="t-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="t-modal-title">{title}</h3>
        <p className="t-modal-message">{message}</p>
        {children}
        <div className="t-modal-actions">
          <button className="t-btn t-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className={`t-btn ${confirmClass}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ── Teacher Detail Drawer ─────────────────────────────────────────────
function TeacherDrawer({ teacher, subjects, courses, deptHeads = new Set(), onClose, onAction, actionLoading }) {
  const [promoteVal,  setPromoteVal]  = useState(teacher.designation || "");
  const [headDept, setHeadDept] = useState(teacher.departments?.[0] || "");
  const isHead = teacher.designation === "head";

  return (
    <div className="t-drawer-overlay" onClick={onClose}>
      <div className="t-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="t-drawer-header">
          <div>
            <h2 className="t-drawer-name">{teacher.first_name} {teacher.last_name}</h2>
            <span className="t-drawer-email">{teacher.email || "—"}</span>
          </div>
          <button className="t-drawer-close" onClick={onClose}>✕</button>
        </div>

        {/* Info grid */}
        <div className="t-drawer-info">
          <div className="t-drawer-info-item">
            <span className="t-drawer-info-label">Designation</span>
            <span className="t-drawer-info-value">
              {isHead ? `Head — ${teacher.head_of || ""}` : teacher.designation}
            </span>
          </div>
          <div className="t-drawer-info-item">
            <span className="t-drawer-info-label">Gender</span>
            <span className="t-drawer-info-value" style={{ textTransform: "capitalize" }}>{teacher.gender || "—"}</span>
          </div>
          <div className="t-drawer-info-item">
            <span className="t-drawer-info-label">Phone</span>
            <span className="t-drawer-info-value">{teacher.contact_phone || "—"}</span>
          </div>
          <div className="t-drawer-info-item">
            <span className="t-drawer-info-label">Status</span>
            <StatusBadge status={teacher.approval_status} />
          </div>
          <div className="t-drawer-info-item t-drawer-info-item--full">
            <span className="t-drawer-info-label">Departments</span>
            <div className="t-drawer-dept-row">
              {(teacher.departments || []).map((d) => (
                <DeptTag key={d} dept={d} isHead={isHead && teacher.head_of === d} />
              ))}
            </div>
          </div>
        </div>

        {/* Assigned subjects */}
        <div className="t-drawer-section">
          <h4 className="t-drawer-section-title">Assigned Subjects ({subjects.length})</h4>
          {subjects.length === 0 ? (
            <p className="t-drawer-empty">No subjects assigned.</p>
          ) : (
            <div className="t-drawer-subjects">
              {subjects.map((s) => (
                <div key={s.subject_id} className="t-drawer-subject-item">
                  <span className="t-drawer-subject-name">{s.subject_name}</span>
                  <span className="t-drawer-subject-meta">{s.subject_code} · {s.semester}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        {teacher.approval_status !== "removed" && (
          <div className="t-drawer-actions-section">
            <h4 className="t-drawer-section-title">Actions</h4>
            <div className="t-drawer-action-grid">

              {/* Approve / Reject */}
              {teacher.approval_status === "pending" && (
                <>
                  <button className="t-btn t-btn--approve" disabled={actionLoading}
                    onClick={() => onAction("approve")}>✓ Approve</button>
                  <button className="t-btn t-btn--reject" disabled={actionLoading}
                    onClick={() => onAction("reject")}>✕ Reject</button>
                </>
              )}

              {/* Promote designation */}
              {teacher.approval_status === "approved" && !isHead && (
                <div className="t-drawer-promote-row">
                  <select className="t-select" value={promoteVal}
                    onChange={(e) => setPromoteVal(e.target.value)}>
                    <option value="">Select designation…</option>
                    {DESIGNATIONS.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <button className="t-btn t-btn--blue" disabled={actionLoading || !promoteVal || promoteVal === teacher.designation}
                    onClick={() => onAction("promote", { designation: promoteVal })}>
                    Promote
                  </button>
                </div>
              )}

              {/* Make Head */}
              {teacher.approval_status === "approved" && !isHead && (
                <div className="t-drawer-promote-row">
                  <select className="t-select" value={headDept}
                    onChange={(e) => setHeadDept(e.target.value)}>
                    <option value="">Select department…</option>
                    {(teacher.departments || []).map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <button
                    className="t-btn t-btn--purple"
                    disabled={actionLoading || !headDept || deptHeads.has(headDept)}
                    title={deptHeads.has(headDept) ? `${headDept} already has a Head. Remove existing Head first.` : ""}
                    onClick={() => onAction("make-head", { department: headDept })}>
                    Make Head
                  </button>
                </div>
              )}
              {/* Show warning if selected dept already has a head */}
              {teacher.approval_status === "approved" && !isHead && headDept && deptHeads.has(headDept) && (
                <p className="t-head-warning">
                  ⚠ {headDept} already has a Head. Remove the existing Head first.
                </p>
              )}

              {/* Remove Head */}
              {isHead && (
                <button className="t-btn t-btn--orange" disabled={actionLoading}
                  onClick={() => onAction("remove-head")}>
                  Remove Head Status
                </button>
              )}

              {/* Deactivate / Activate */}
              {teacher.approval_status === "approved" && (
                teacher.is_active !== false ? (
                  <button className="t-btn t-btn--ghost-red" disabled={actionLoading}
                    onClick={() => onAction("deactivate")}>
                    Deactivate
                  </button>
                ) : (
                  <button className="t-btn t-btn--ghost-green" disabled={actionLoading}
                    onClick={() => onAction("activate")}>
                    Activate
                  </button>
                )
              )}

              {/* Remove */}
              <button className="t-btn t-btn--danger" disabled={actionLoading}
                onClick={() => onAction("remove")}>
                Remove Teacher
              </button>

            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────
export default function TeachersPage() {
  const navigate  = useNavigate();
  const institute = getInstituteProfile(); // used for topbar only

  // Data
  const [teachers,    setTeachers]    = useState([]);
  const [courses,     setCourses]     = useState([]);
  const [total,       setTotal]       = useState(0);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState("");

  // Filters
  const [search,      setSearch]      = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [deptFilter,  setDeptFilter]  = useState("");
  const [headOnly, setHeadOnly] = useState(false);
  const [page,        setPage]        = useState(1);
  const [limit,       setLimit]       = useState(10);

  // Detail drawer
  const [selected,    setSelected]    = useState(null);  // { teacher, subjects }
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg,   setActionMsg]   = useState("");

  // Confirm modal
  const [confirmModal, setConfirmModal] = useState(null);

  // Bulk selection
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [bulkLoading,  setBulkLoading]  = useState(false);

  // Load courses for department dropdown
  useEffect(() => {
    apiFetch("/institute/courses")
      .then((d) => setCourses(d.courses || []))
      .catch(() => {});
  }, []);

  const loadTeachers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page, limit });
      if (statusFilter) params.set("status",     statusFilter);
      if (deptFilter)   params.set("department", deptFilter);
      if (headOnly)      params.set("head_only",   "true");

      const data = await apiFetch(`/institute/teachers?${params}`);
      setTeachers(data.teachers || []);
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
  }, [statusFilter, deptFilter, headOnly, page, limit]);

  useEffect(() => { loadTeachers(); }, [loadTeachers]);

  // Client-side search filter
  const filtered = teachers.filter((t) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      `${t.first_name} ${t.last_name}`.toLowerCase().includes(q) ||
      (t.email || "").toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(total / limit);

  // Open detail drawer
  const openDetail = async (teacher) => {
    setSelected({ teacher, subjects: [] });
    setActionMsg("");
    try {
      const data = await apiFetch(`/institute/teachers/${teacher.teacher_id}`);
      setSelected({ teacher: data.teacher, subjects: data.subjects || [] });
    } catch {}
  };

  // Execute action
  const handleAction = async (action, payload = {}) => {
    if (!selected) return;
    const id = selected.teacher.teacher_id;

    const method = action === "remove" ? "DELETE" : "PUT";
    const path   = `/institute/teachers/${id}${action === "remove" ? "" : `/${action}`}`;

    // Confirm destructive actions
    if (["reject", "deactivate", "remove"].includes(action)) {
      setConfirmModal({ action, payload, id });
      return;
    }

    setActionLoading(true);
    setActionMsg("");
    try {
      const data = await apiFetch(path, {
        method,
        body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
      });
      setActionMsg(data.message || "Done.");
      // Refresh teacher data in drawer + list
      const fresh = await apiFetch(`/institute/teachers/${id}`);
      setSelected({ teacher: fresh.teacher, subjects: fresh.subjects || [] });
      loadTeachers();
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
      const path   = `/institute/teachers/${id}${action === "remove" ? "" : `/${action}`}`;
      const data   = await apiFetch(path, {
        method,
        body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
      });
      setActionMsg(data.message || "Done.");
      if (action === "remove") {
        setSelected(null);
      } else {
        const fresh = await apiFetch(`/institute/teachers/${id}`);
        setSelected({ teacher: fresh.teacher, subjects: fresh.subjects || [] });
      }
      loadTeachers();
    } catch (err) {
      setActionMsg(`Error: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const clearFilters = () => {
    setSearch(""); setStatusFilter(""); setDeptFilter(""); setHeadOnly(false); setPage(1);
  };

  // Bulk selection helpers
  const pendingFiltered    = filtered.filter((t) => t.approval_status === "pending");
  const allPendingSelected = pendingFiltered.length > 0 &&
    pendingFiltered.every((t) => bulkSelected.has(t.teacher_id));

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
      setBulkSelected(new Set(pendingFiltered.map((t) => t.teacher_id)));
    }
  };

  const handleBulkAction = async (action) => {
    if (bulkSelected.size === 0) return;
    setBulkLoading(true);
    setActionMsg("");
    try {
      await Promise.all(
        [...bulkSelected].map((id) =>
          apiFetch(`/institute/teachers/${id}/${action}`, { method: "PUT" })
        )
      );
      setActionMsg(`${bulkSelected.size} teacher(s) ${action === "approve" ? "approved" : "rejected"}.`);
      setBulkSelected(new Set());
      loadTeachers();
    } catch (err) {
      setActionMsg(`Bulk action error: ${err.message}`);
    } finally {
      setBulkLoading(false);
    }
  };

  // Which departments already have a Head (from full teacher list)
  const deptHeads = new Set(
    teachers.filter((t) => t.designation === "head").map((t) => t.head_of)
  );

  // All unique departments from courses
  const allDepts = courses.map((c) => c.abbr);

  return (
    <div className="db-shell">

      {/* ── Sidebar ────────────────────────────────────────────── */}
      <Sidebar />

      {/* ── Main ───────────────────────────────────────────────── */}
      <div className="db-main">
        <header className="db-topbar">
          <div className="db-topbar-left">
            <h1 className="db-topbar-title">Teachers</h1>
          </div>
          <div className="db-topbar-right">
            <BuildingIcon size={18} />
            <span className="db-topbar-college">{institute?.college_name}</span>
            <span className="db-topbar-aishe-badge">AISHE: {institute?.aishe_code}</span>
          </div>
        </header>

        <main className="db-content">

          {/* Page heading */}
          <div className="t-page-header">
            <div>
              <div className="t-page-title-row">
                <h2 className="t-page-title">Teachers</h2>
                <span className="t-count-badge">{total}</span>
              </div>
              <p className="t-page-subtitle">Manage all teachers in your institute</p>
            </div>
          </div>

          {error && <div className="db-alert db-alert--error">{error}</div>}
          {actionMsg && <div className={`db-alert ${actionMsg.startsWith("Error") ? "db-alert--error" : "db-alert--ok"}`}>{actionMsg}</div>}

          {/* Filter bar */}
          <div className="t-filter-bar">
            <div className="t-search-wrap">
              <SearchIcon size={16} />
              <input className="t-search-input" placeholder="Search by name…"
                value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
            </div>

            <select className="t-filter-select" value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
              <option value="">All Status</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>

            <select className="t-filter-select" value={deptFilter}
              onChange={(e) => { setDeptFilter(e.target.value); setPage(1); }}>
              <option value="">All Departments</option>
              {allDepts.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>

            <label className="t-head-toggle">
              <input type="checkbox" checked={headOnly}
                onChange={(e) => { setHeadOnly(e.target.checked); setPage(1); }} />
              Heads only
            </label>

            <button className="t-clear-btn" onClick={clearFilters}>
              <RefreshIcon size={14} /> Clear Filters
            </button>
          </div>

          {/* Bulk action bar — only shown when items selected */}
          {bulkSelected.size > 0 && (
            <div className="t-bulk-bar">
              <span className="t-bulk-count">{bulkSelected.size} teacher(s) selected</span>
              <button className="t-btn t-btn--approve" disabled={bulkLoading}
                onClick={() => handleBulkAction("approve")}>✓ Approve All</button>
              <button className="t-btn t-btn--reject" disabled={bulkLoading}
                onClick={() => handleBulkAction("reject")}>✕ Reject All</button>
              <button className="t-btn t-btn--ghost"
                onClick={() => setBulkSelected(new Set())}>Clear</button>
            </div>
          )}

          {/* Table */}
          <div className="t-table-card">
            <table className="t-table">
              <thead>
                <tr>
                  <th className="t-th-check">
                    <input type="checkbox"
                      checked={allPendingSelected}
                      onChange={toggleBulkAll}
                      title="Select all pending"
                      disabled={pendingFiltered.length === 0}
                    />
                  </th>
                  <th>Name</th>
                  <th>Designation</th>
                  <th>Departments</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="t-table-center">Loading…</td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={7} className="t-table-center">No teachers found.</td></tr>
                ) : (
                  filtered.map((teacher) => {
                    const isPending = teacher.approval_status === "pending";
                    const isHead    = teacher.designation === "head";
                    const isChecked = bulkSelected.has(teacher.teacher_id);
                    return (
                      <tr key={teacher.teacher_id} className={isChecked ? "t-tr--selected" : ""}>
                        <td className="t-td-check">
                          {isPending && (
                            <input type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleBulkOne(teacher.teacher_id)}
                            />
                          )}
                        </td>
                        <td>
                          <div className="t-name-cell">
                            <span className="t-name">{teacher.first_name} {teacher.last_name}</span>
                            <span className="t-email">{teacher.email || "—"}</span>
                          </div>
                        </td>
                        <td>
                          {isHead
                            ? <span className="t-head-label">Head — {teacher.head_of}</span>
                            : teacher.designation}
                        </td>
                        <td>
                          <div className="t-dept-row">
                            {(teacher.departments || []).map((d) => (
                              <DeptTag key={d} dept={d} isHead={isHead && teacher.head_of === d} />
                            ))}
                          </div>
                        </td>
                        <td>{teacher.contact_phone || "—"}</td>
                        <td><StatusBadge status={teacher.approval_status} /></td>
                        <td>
                          <div className="t-action-row">
                            <button className="t-btn t-btn--view" onClick={() => openDetail(teacher)}>
                              <EyeIcon size={14} /> View
                            </button>
                            {isPending && (
                              <>
                                <button className="t-btn t-btn--approve"
                                  onClick={() => { setSelected({ teacher, subjects: [] }); handleAction("approve"); }}>
                                  ✓ Approve
                                </button>
                                <button className="t-btn t-btn--reject"
                                  onClick={() => { setSelected({ teacher, subjects: [] }); setConfirmModal({ action: "reject", payload: {}, id: teacher.teacher_id }); }}>
                                  ✕ Reject
                                </button>
                              </>
                            )}
                            {!isPending && <span className="t-dash">—</span>}
                            {!isPending && <span className="t-dash">—</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>

            {/* Pagination */}
            <div className="t-pagination">
              <span className="t-pagination-info">
                Showing {Math.min((page - 1) * limit + 1, total)} to {Math.min(page * limit, total)} of {total} teachers
              </span>

              <div className="t-pagination-controls">
                <button className="t-page-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  const p = i + 1;
                  return (
                    <button key={p} className={`t-page-btn${page === p ? " t-page-btn--active" : ""}`}
                      onClick={() => setPage(p)}>{p}</button>
                  );
                })}
                <button className="t-page-btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>›</button>
              </div>

              <select className="t-filter-select t-per-page"
                value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}>
                {PER_PAGE_OPTS.map((n) => <option key={n} value={n}>{n} / page</option>)}
              </select>
            </div>
          </div>

        </main>
      </div>

      {/* ── Teacher Detail Drawer ──────────────────────────────── */}
      {selected && (
        <TeacherDrawer
          teacher={selected.teacher}
          subjects={selected.subjects}
          courses={courses}
          deptHeads={deptHeads}
          onClose={() => { setSelected(null); setActionMsg(""); }}
          onAction={handleAction}
          actionLoading={actionLoading}
        />
      )}

      {/* ── Confirm Modal ──────────────────────────────────────── */}
      {confirmModal && (
        <ConfirmModal
          title={
            confirmModal.action === "remove"     ? "Remove Teacher" :
            confirmModal.action === "reject"     ? "Reject Teacher" :
            confirmModal.action === "deactivate" ? "Deactivate Teacher" : "Confirm"
          }
          message={
            confirmModal.action === "remove"     ? "This will permanently remove the teacher from your institute. This cannot be undone." :
            confirmModal.action === "reject"     ? "Are you sure you want to reject this teacher's application?" :
            confirmModal.action === "deactivate" ? "The teacher will not be able to log in once deactivated." : "Are you sure?"
          }
          confirmLabel={
            confirmModal.action === "remove"     ? "Yes, Remove" :
            confirmModal.action === "reject"     ? "Yes, Reject" :
            confirmModal.action === "deactivate" ? "Yes, Deactivate" : "Confirm"
          }
          confirmClass={confirmModal.action === "remove" ? "t-btn--danger" : "t-btn--reject"}
          onConfirm={confirmAction}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
}

/* ── Icons ───────────────────────────────────────────────────────────── */
/* ── Page-specific icons (sidebar icons live in Sidebar.jsx) ─────────── */
function BuildingIcon({ size=20 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18"/><path d="M5 21V8l7-4 7 4v13"/><path d="M9 21v-6h6v6"/></svg>; }
function SearchIcon({ size=20 })   { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>; }
function EyeIcon({ size=20 })      { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z"/><circle cx="12" cy="12" r="3"/></svg>; }
function RefreshIcon({ size=20 })  { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>; }