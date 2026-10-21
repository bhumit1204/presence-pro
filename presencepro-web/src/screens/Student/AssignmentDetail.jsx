// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { studentApi } from "../../services/studentApi";
import {
  StudentShell, useFeed, refreshFeed, Skeleton, Empty, ErrorBox, StatePill, Pill, Attachments, FileIcon, Modal,
  subjectColor, assignmentState, dueLabel, fmtDateTime, fmtSize, toast, useNow,
} from "./ui";

const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt";

export default function AssignmentDetail() {
  const { assignmentId } = useParams();
  const nav = useNavigate();
  const now = useNow(30000);
  const feed = useFeed();
  const fileInput = useRef(null);

  const a = (feed.data?.assignments || []).find((x) => x.assignment_id === assignmentId);

  // freshest copy of my submission (the feed may be a few seconds old)
  const [sub, setSub] = useState(undefined); // undefined = loading, null = none
  const [files, setFiles] = useState([]);    // File objects picked
  const [links, setLinks] = useState([]);
  const [removed, setRemoved] = useState([]); // keys of existing files to delete on resubmit
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [over, setOver] = useState(false);
  const [confirmUnsubmit, setConfirmUnsubmit] = useState(false);

  const loadSub = async () => {
    try {
      const r = await studentApi.mySubmission(assignmentId);
      setSub(r.submission || null);
    } catch {
      setSub(a?.my_submission || null);
    }
  };
  useEffect(() => { setSub(undefined); loadSub(); /* eslint-disable-next-line */ }, [assignmentId]);

  if (feed.loading || (a && sub === undefined)) {
    return <StudentShell title="Assignment"><Skeleton rows={4} height={110} /></StudentShell>;
  }
  if (!a) {
    return (
      <StudentShell title="Assignment">
        <ErrorBox error={feed.error && !feed.data ? feed.error : null} onRetry={feed.reload} />
        <Empty icon="🔍" title="Assignment not found" text="It may have been removed by your teacher." action={<button className="st-btn st-btn--primary" onClick={() => nav("/dashboard/student/assignments")}>Back to assignments</button>} />
      </StudentShell>
    );
  }

  const merged = { ...a, my_submission: sub };
  const state = assignmentState(merged, now);
  const color = subjectColor(a.subject_id);
  const dueMs = a.due_date ? new Date(a.due_date).getTime() : null;
  const overdue = dueMs != null && dueMs < now;
  const blocked = overdue && !a.allow_late && !sub;
  const graded = sub?.status === "graded";
  const formOpen = !graded && !blocked && (!sub || editing);

  /* ── file picking ── */
  const addFiles = (list) => {
    const picked = Array.from(list || []);
    const keep = [];
    for (const f of picked) {
      if (f.size > MAX_BYTES) { toast(`"${f.name}" is larger than 10 MB`, "err"); continue; }
      keep.push(f);
    }
    setFiles((cur) => {
      const next = [...cur];
      for (const f of keep) if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      const existing = (sub?.attachments || []).filter((x) => !removed.includes(x.key)).length;
      if (next.length + existing > MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files`, "err"); return next.slice(0, Math.max(0, MAX_FILES - existing)); }
      return next;
    });
  };
  const addLink = () => {
    let url = linkUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try { new URL(url); } catch { toast("That doesn't look like a valid link", "err"); return; }
    setLinks((l) => [...l, { url, label: linkLabel.trim() || url }]);
    setLinkUrl(""); setLinkLabel("");
  };

  const startEdit = () => {
    setEditing(true);
    setLinks((sub?.links || []).map((l) => ({ url: l.url, label: l.label })));
    setFiles([]); setRemoved([]);
  };
  const cancelEdit = () => { setEditing(false); setFiles([]); setLinks([]); setRemoved([]); };

  const afterChange = async () => {
    refreshFeed();
    await loadSub();
    feed.reload();
  };

  const turnIn = async () => {
    const keptExisting = sub ? (sub.attachments || []).filter((x) => !removed.includes(x.key)) : [];
    if (files.length + keptExisting.length + links.length === 0) { toast("Add a file or a link first", "err"); return; }
    setBusy("submit");
    try {
      let uploaded = [];
      if (files.length) {
        const up = await studentApi.uploadFiles(files, a.assignment_id);
        uploaded = up.files || [];
      }
      if (sub) {
        await studentApi.resubmitAssignment(a.assignment_id, { attachments: uploaded, links, deleted_keys: removed });
        toast(overdue ? "Resubmitted (late)" : "Your work was updated");
      } else {
        await studentApi.submitAssignment(a.assignment_id, { attachments: uploaded, links });
        toast(overdue ? "Turned in (late)" : "Turned in!");
      }
      setFiles([]); setLinks([]); setRemoved([]); setEditing(false);
      await afterChange();
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy("");
    }
  };

  const unsubmit = async () => {
    setBusy("unsubmit");
    try {
      await studentApi.unsubmitAssignment(a.assignment_id);
      toast("Unsubmitted — you can turn it in again");
      setConfirmUnsubmit(false); setEditing(false);
      await afterChange();
    } catch (e) {
      toast(e.message, "err");
    } finally {
      setBusy("");
    }
  };

  const keptExisting = sub ? (sub.attachments || []) : [];

  return (
    <StudentShell title="Assignment">
      <button className="st-link" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => nav(-1)}>← Back</button>

      <div className="st-split">
        {/* ── left: the assignment ── */}
        <div className="st-stack" style={{ gap: 16 }}>
          <div className="st-card">
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <span className="st-row-icon" style={{ background: color, width: 46, height: 46, fontSize: 20 }}>📝</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 className="st-work-title">{a.title}</h1>
                <div className="st-work-meta">
                  <button className="st-link" style={{ padding: 0 }} onClick={() => nav(`/dashboard/student/classes/${a.subject_id}`)}>{a.subject_name}</button>
                  {a.marks != null && <span>{a.marks} marks</span>}
                  <span style={{ color: overdue && !sub ? "#DC2626" : undefined }}>{sub && a.due_date ? `Due ${fmtDateTime(a.due_date)}` : dueLabel(a.due_date, now)}</span>
                  <span>Posted {fmtDateTime(a.created_at)}</span>
                  {a.kind === "lab_work" && <Pill tone="purple">Lab work</Pill>}
                  {a.allow_late && <Pill tone="amber">Late submissions allowed</Pill>}
                </div>
              </div>
              <StatePill state={state} />
            </div>
          </div>

          {a.instructions && (
            <div className="st-card">
              <div className="st-h2" style={{ marginBottom: 8 }}>Instructions</div>
              <div className="st-work-body">{a.instructions}</div>
            </div>
          )}
          {a.questions && (
            <div className="st-card">
              <div className="st-h2" style={{ marginBottom: 8 }}>Questions</div>
              <div className="st-work-body">{a.questions}</div>
            </div>
          )}
          {(a.attachments?.length > 0 || a.links?.length > 0) && (
            <div className="st-card">
              <div className="st-h2" style={{ marginBottom: 10 }}>Reference material</div>
              <Attachments files={a.attachments} links={a.links} />
            </div>
          )}
        </div>

        {/* ── right: your work ── */}
        <aside className="st-card st-yourwork">
          <div className="st-yourwork-head">
            <div className="st-h2">Your work</div>
            <StatePill state={state} />
          </div>

          {graded && (
            <div className="st-grade">
              <div className="st-grade-score">{sub.marks_obtained ?? "—"}<span style={{ fontSize: 16, opacity: 0.6 }}> / {a.marks}</span></div>
              <div className="st-grade-label">Graded {sub.graded_at ? fmtDateTime(sub.graded_at) : ""}</div>
              {sub.feedback && <div style={{ marginTop: 10, fontSize: 13.5, color: "#4C1D95", textAlign: "left", whiteSpace: "pre-wrap" }}><b>Feedback:</b> {sub.feedback}</div>}
            </div>
          )}

          {sub && !editing && (
            <>
              {(sub.attachments?.length > 0 || sub.links?.length > 0) ? (
                <Attachments files={sub.attachments} links={sub.links} />
              ) : <div className="st-sub">No files attached.</div>}
              <div className="st-sub">Turned in {fmtDateTime(sub.submitted_at)}{sub.status === "late" ? " (late)" : ""}</div>
            </>
          )}

          {blocked && (
            <div className="st-note st-note--warn">The deadline has passed and this assignment doesn't accept late work.</div>
          )}

          {formOpen && (
            <>
              {sub && editing && keptExisting.length > 0 && (
                <div className="st-filelist">
                  {keptExisting.map((f) => {
                    const gone = removed.includes(f.key);
                    return (
                      <div key={f.key || f.url} className={`st-fileitem${gone ? " st-fileitem--removed" : ""}`}>
                        <FileIcon name={f.name} type={f.type} />
                        <span className="st-fileitem-name">{f.name}</span>
                        <button className="st-x" title={gone ? "Keep" : "Remove"} onClick={() => setRemoved((r) => (gone ? r.filter((k) => k !== f.key) : [...r, f.key]))}>{gone ? "↺" : "×"}</button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div
                className={`st-drop${over ? " st-drop--over" : ""}`}
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}
              >
                <strong>Add files</strong> or drag them here
                <div style={{ marginTop: 4, fontSize: 12 }}>PDF, images, Word, PowerPoint, Excel, text · up to 10 MB each</div>
                <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              </div>

              {files.length > 0 && (
                <div className="st-filelist">
                  {files.map((f, i) => (
                    <div key={f.name + i} className="st-fileitem">
                      <FileIcon name={f.name} type={f.type} />
                      <span className="st-fileitem-name">{f.name}<span style={{ color: "#9CA3AF", fontWeight: 500 }}> · {fmtSize(f.size)}</span></span>
                      <button className="st-x" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>×</button>
                    </div>
                  ))}
                </div>
              )}

              {links.length > 0 && (
                <div className="st-filelist">
                  {links.map((l, i) => (
                    <div key={l.url + i} className="st-fileitem">
                      <span className="st-fileicon" style={{ background: "#E0F2FE", color: "#0369A1" }}>URL</span>
                      <span className="st-fileitem-name">{l.label}</span>
                      <button className="st-x" onClick={() => setLinks((cur) => cur.filter((_, j) => j !== i))}>×</button>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <label className="st-label">Add a link</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input className="st-input" placeholder="https://…" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addLink()} />
                  <button className="st-btn st-btn--ghost" onClick={addLink}>Add</button>
                </div>
              </div>

              <button className="st-btn st-btn--primary st-btn--block" disabled={busy === "submit"} onClick={turnIn}>
                {busy === "submit" ? "Uploading…" : sub ? (overdue ? "Resubmit (late)" : "Save & resubmit") : overdue ? "Turn in late" : "Turn in"}
              </button>
              {editing && <button className="st-btn st-btn--ghost st-btn--block" onClick={cancelEdit}>Cancel</button>}
            </>
          )}

          {sub && !graded && !editing && (
            <div className="st-stack" style={{ gap: 8 }}>
              {!blocked && <button className="st-btn st-btn--ghost st-btn--block" onClick={startEdit}>Edit &amp; resubmit</button>}
              <button className="st-btn st-btn--danger st-btn--block" onClick={() => setConfirmUnsubmit(true)}>Unsubmit</button>
            </div>
          )}
        </aside>
      </div>

      {confirmUnsubmit && (
        <Modal
          title="Unsubmit this assignment?"
          onClose={() => setConfirmUnsubmit(false)}
          footer={<>
            <button className="st-btn st-btn--ghost" onClick={() => setConfirmUnsubmit(false)}>Keep it</button>
            <button className="st-btn st-btn--danger" disabled={busy === "unsubmit"} onClick={unsubmit}>{busy === "unsubmit" ? "Working…" : "Unsubmit"}</button>
          </>}
        >
          Your turned-in work will be withdrawn. You can turn it in again any time before the deadline{a.allow_late ? " (or late)" : ""}.
        </Modal>
      )}
    </StudentShell>
  );
}