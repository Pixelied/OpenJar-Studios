import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export default function NewFileModal({
  open,
  onClose,
  onCreate,
  existingPaths,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (filePath: string) => void;
  existingPaths: string[];
}) {
  const [name, setName] = useState("new-config.json");

  useEffect(() => {
    if (!open) return;
    setName("new-config.json");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  if (!open) return null;

  const trimmed = name.trim();
  const endsWithJson = trimmed.toLowerCase().endsWith(".json");
  const normalized = trimmed.includes("/") ? trimmed : `config/${trimmed}`;
  const duplicate = existingPaths.some((item) => item.toLowerCase() === normalized.toLowerCase());
  const canCreate = Boolean(trimmed) && endsWithJson && !duplicate;

  return createPortal(
    <div className="modalOverlay" onMouseDown={onClose}>
      <div className="modal" style={{ width: "min(520px, calc(100vw - 30px))" }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modalHeader">
          <div className="modalTitle">New JSON config</div>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="modalBody">
          <div className="settingSub">Create a new JSON file for the selected instance.</div>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="config/new-config.json"
            autoFocus
          />
          {!trimmed ? <div className="muted">Enter a file name.</div> : null}
          {trimmed && !endsWithJson ? <div className="errorBox">Filename must end with <strong>.json</strong>.</div> : null}
          {duplicate ? <div className="errorBox">A file with this path already exists.</div> : null}
          <div className="muted">Path preview: {normalized}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" type="button" disabled={!canCreate} onClick={() => onCreate(normalized)}>
              Create file
            </button>
            <button className="btn" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
