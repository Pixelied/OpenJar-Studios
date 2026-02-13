export default function ConfigEditorTopBar({
  filePath,
  unsaved,
  mode,
  onModeChange,
  onSave,
  onReset,
  onUndo,
  onRedo,
  onFormat,
  canSave,
  canReset,
  canUndo,
  canRedo,
  canFormat,
  formatTitle,
  readOnly,
  virtualFile,
  readOnlyMessage,
}: {
  filePath: string;
  unsaved: boolean;
  mode: "simple" | "advanced";
  onModeChange: (next: "simple" | "advanced") => void;
  onSave: () => void;
  onReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFormat: () => void;
  canSave: boolean;
  canReset: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canFormat: boolean;
  formatTitle?: string;
  readOnly?: boolean;
  virtualFile?: boolean;
  readOnlyMessage?: string | null;
}) {
  return (
    <div className="configEditorTopBar">
      <div className="configEditorTitleWrap">
        <div className="configEditorFileName">{filePath}</div>
        {unsaved ? <span className="chip">Unsaved</span> : <span className="chip subtle">Saved</span>}
        {readOnly ? <span className="chip subtle">Read-only</span> : null}
        {virtualFile ? <span className="chip subtle">Virtual file</span> : null}
      </div>

      <div className="configEditorControlRow">
        <div className="configEditorActions">
          <button className="btn primary" type="button" onClick={onSave} disabled={!canSave || readOnly}>
            Save
          </button>
          <button className="btn" type="button" onClick={onReset} disabled={!canReset || readOnly}>
            Reset
          </button>
          <button className="btn" type="button" onClick={onUndo} disabled={!canUndo || readOnly}>
            Undo
          </button>
          <button className="btn" type="button" onClick={onRedo} disabled={!canRedo || readOnly}>
            Redo
          </button>
          <button
            className="btn"
            type="button"
            onClick={onFormat}
            disabled={!canFormat || readOnly}
            title={formatTitle}
          >
            Format
          </button>
        </div>

        <div className="segmented configModeToggle">
          <button
            type="button"
            className={`segBtn ${mode === "simple" ? "active" : ""}`}
            onClick={() => onModeChange("simple")}
          >
            Simple
          </button>
          <button
            type="button"
            className={`segBtn ${mode === "advanced" ? "active" : ""}`}
            onClick={() => onModeChange("advanced")}
          >
            Advanced
          </button>
        </div>
      </div>

      {readOnly && readOnlyMessage ? <div className="configEditorReadOnlyText">{readOnlyMessage}</div> : null}
    </div>
  );
}
