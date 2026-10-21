// @ts-nocheck
/**
 * SuggestionsPanel.jsx — topbar button + drawer listing every note for the
 * current Manage area. Reads the shared state from SuggestionsProvider, so it
 * always matches the hover comment pins on the page.
 */
import { useState } from "react";
import { NoteCard, useSuggestions } from "./SuggestionsProvider";
import "./SuggestionsPanel.css";

export default function SuggestionsPanel() {
  const ctx = useSuggestions();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("open");
  const [text, setText] = useState("");
  const [about, setAbout] = useState("");

  if (!ctx || !ctx.ready) return null; // nothing delegated here, nothing to discuss

  const shown = ctx.notes.filter((n) => tab === "all" || n.status === tab);
  const send = async () => { if (await ctx.post(text, about)) { setText(""); setAbout(""); setTab("open"); } };

  return (
    <>
      <button type="button" className="sp-btn" onClick={() => setOpen(true)}>
        {ctx.isHead ? "Suggestions" : "From head"}
        {ctx.open > 0 && <span className="sp-count">{ctx.open}</span>}
      </button>

      {open && (
        <div className="sp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <aside className="sp-drawer" role="dialog" aria-label="Suggestions">
            <div className="sp-head">
              <div>
                <h3 className="sp-title">{ctx.areaLabel || "Suggestions"}</h3>
                <p className="sp-sub">
                  {ctx.isHead
                    ? `Managed by ${ctx.delegates.map((d) => d.name).filter(Boolean).join(", ") || "a delegate"}`
                    : "Notes between you and the head"}
                </p>
              </div>
              <button type="button" className="sp-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>

            {ctx.courses.length > 1 && (
              <select className="sp-input" value={ctx.courseId} onChange={(e) => ctx.setCourseId(e.target.value)}>
                {ctx.courses.map((c) => <option key={c.course_id} value={c.course_id}>{c.abbr || c.course_name}</option>)}
              </select>
            )}

            <p className="sp-hint">Tip: hover any item on the page and click its comment icon to comment on that item.</p>

            <div className="sp-compose">
              <textarea
                className="sp-input sp-ta" rows={3} maxLength={1000} value={text}
                placeholder={ctx.isHead ? "A general suggestion for this page" : "A general note for the head"}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="sp-compose-row">
                <input className="sp-input" maxLength={120} value={about} placeholder="About (optional)" onChange={(e) => setAbout(e.target.value)} />
                <button type="button" className="sp-send" disabled={ctx.busy || !text.trim()} onClick={send}>Send</button>
              </div>
            </div>

            {ctx.err && <div className="sp-err">{ctx.err}</div>}

            <div className="sp-tabs">
              {[["open", "Open"], ["done", "Done"], ["all", "All"]].map(([k, l]) => (
                <button key={k} type="button" className={`sp-tab${tab === k ? " sp-tab--on" : ""}`} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>

            <div className="sp-list">
              {shown.length === 0 && <p className="sp-empty">{tab === "open" ? "Nothing open." : "Nothing here."}</p>}
              {shown.map((n) => <NoteCard key={n.id} n={n} ctx={ctx} />)}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}