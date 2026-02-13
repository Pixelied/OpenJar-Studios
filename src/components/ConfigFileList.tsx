import { useMemo } from "react";

export type ConfigFileListItem = {
  path: string;
  group: string;
  typeLabel: string;
  disabled?: boolean;
  unsaved?: boolean;
  editable?: boolean;
  readonlyReason?: string | null;
};

const CORE_GROUP_ORDER = ["Minecraft", "Loader", "Mods"];

function fileIcon(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "{}";
  if (lower.endsWith(".toml")) return "Tm";
  if (lower.endsWith(".properties")) return "Pr";
  if (lower.endsWith(".txt")) return "Tx";
  if (lower.endsWith(".dat")) return "Dt";
  return "Fi";
}

export default function ConfigFileList({
  files,
  query,
  onQueryChange,
  selectedPath,
  onSelect,
  onNewFile,
  allowNewFile,
}: {
  files: ConfigFileListItem[];
  query: string;
  onQueryChange: (next: string) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onNewFile: () => void;
  allowNewFile?: boolean;
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) => file.path.toLowerCase().includes(q));
  }, [files, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, ConfigFileListItem[]>();
    for (const group of CORE_GROUP_ORDER) map.set(group, []);
    for (const file of filtered) {
      const group = file.group || "Other";
      if (!map.has(group)) map.set(group, []);
      map.get(group)?.push(file);
    }
    const groups = Array.from(map.keys());
    groups.sort((a, b) => {
      const ai = CORE_GROUP_ORDER.indexOf(a);
      const bi = CORE_GROUP_ORDER.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b);
    });
    return groups.map((group) => ({
      group,
      files: map.get(group) ?? [],
    })).filter((entry) => entry.files.length > 0);
  }, [filtered]);

  return (
    <div className="configWorkspacePanel configFilesPanel">
      <div className="configPanelHead">
        <div className="settingTitle">Files</div>
        <button className="btn" type="button" onClick={onNewFile} disabled={allowNewFile === false}>
          New file
        </button>
      </div>
      <input
        className="input"
        placeholder="Search files..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />

      <div className="configFileGroups">
        {grouped.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>No files match your search.</div>
        ) : null}
        {grouped.map((section) => (
          <div key={section.group} className="configFileGroup">
            <div className="configGroupTitle">{section.group}</div>
            <div className="configFileRows">
              {section.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={`configFileRow ${selectedPath === file.path ? "active" : ""} ${
                    file.editable === false ? "readonly" : ""
                  }`}
                  onClick={() => onSelect(file.path)}
                  disabled={file.disabled}
                  title={file.path}
                >
                  <span className="configFileIcon">{fileIcon(file.path)}</span>
                  <span className="configFileMeta">
                    <span className="configFilePath">{file.path}</span>
                    <span className="configFileBadges">
                      {file.unsaved ? <span className="chip">Unsaved</span> : null}
                      <span className="chip subtle">{file.typeLabel}</span>
                      {file.editable === false ? <span className="chip subtle">Read-only</span> : null}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
