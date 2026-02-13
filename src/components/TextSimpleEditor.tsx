import { useId, useMemo } from "react";
import { getSuggestions } from "../lib/configSuggestions";

type ParsedEntry = {
  lineIndex: number;
  key: string;
  value: string;
  delimiter: ":" | "=";
  section?: string;
};

function detectDelimiter(filePath: string): ":" | "=" {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".properties")) return "=";
  if (lower.endsWith(".toml")) return "=";
  return ":";
}

function parseEntries(filePath: string, content: string): ParsedEntry[] {
  const lines = content.split(/\r?\n/);
  const delimiter = detectDelimiter(filePath);
  const entries: ParsedEntry[] = [];
  let section = "";
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    if (filePath.toLowerCase().endsWith(".toml") && /^\[[^\]]+\]$/.test(trimmed)) {
      section = trimmed.slice(1, -1).trim();
      return;
    }
    const idx = line.indexOf(delimiter);
    if (idx <= 0) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) return;
    entries.push({
      lineIndex,
      key,
      value,
      delimiter,
      section: section || undefined,
    });
  });
  return entries;
}

function setLineValue(content: string, entry: ParsedEntry, nextValue: string): string {
  const lines = content.split(/\r?\n/);
  const left = entry.key;
  lines[entry.lineIndex] = `${left}${entry.delimiter}${nextValue}`;
  return lines.join("\n");
}

export default function TextSimpleEditor({
  filePath,
  value,
  onChange,
  issuesByPath,
  onSelectField,
  readOnly,
}: {
  filePath: string;
  value: string;
  onChange: (next: string) => void;
  issuesByPath?: Record<string, Array<{ message: string; severity: string }>>;
  onSelectField: (selection: { path: string; value: string; type: string } | null) => void;
  readOnly?: boolean;
}) {
  const entries = useMemo(() => parseEntries(filePath, value), [filePath, value]);
  const delimiter = detectDelimiter(filePath);
  const valueListId = useId();
  const keyHints = useMemo(() => {
    const suggestions = getSuggestions({
      filePath,
      content: value,
      cursorIndex: value.length,
      mode: "simple",
      limit: 10,
    });
    const blocked = new Set(["true", "false", "on", "off", "yes", "no", "null"]);
    const out: string[] = [];
    for (const item of suggestions) {
      const token = item.value.trim();
      if (!token || blocked.has(token.toLowerCase())) continue;
      if (out.includes(token)) continue;
      out.push(token);
      if (out.length >= 6) break;
    }
    return out;
  }, [filePath, value]);
  const valueHints = useMemo(() => {
    const out = new Set<string>(["true", "false", "on", "off", "yes", "no"]);
    for (const entry of entries) {
      const token = entry.value.trim();
      if (token && token.length < 60) out.add(token);
      if (out.size >= 18) break;
    }
    return [...out];
  }, [entries]);

  return (
    <div className="configSimpleEditor">
      <div className="configSimpleToolbar">
        <span className="chip subtle">{entries.length} setting{entries.length === 1 ? "" : "s"}</span>
        <button
          className="btn"
          type="button"
          disabled={readOnly}
          onClick={() => onChange(`${value}${value.endsWith("\n") || !value ? "" : "\n"}new_key${delimiter}`)}
        >
          Add field
        </button>
      </div>
      {keyHints.length > 0 ? (
        <div className="configSuggestHintRow">
          <span className="chip subtle">Suggested keys</span>
          {keyHints.map((hint) => (
            <button
              key={hint}
              className="configSuggestHintBtn"
              type="button"
              disabled={readOnly}
              onClick={() =>
                onChange(
                  `${value}${value.endsWith("\n") || !value ? "" : "\n"}${hint}${delimiter}`
                )
              }
            >
              {hint}
            </button>
          ))}
        </div>
      ) : null}
      {entries.length === 0 ? (
        <div className="configSimpleEmpty">
          <div className="settingTitle">No key/value pairs detected</div>
          <div className="muted">Use Advanced mode or add entries in `key{delimiter}value` format.</div>
        </div>
      ) : (
        <div className="configSimpleRows">
          {entries.map((entry) => {
            const path = entry.section ? `${entry.section}.${entry.key}` : entry.key;
            return (
              <div key={`${entry.lineIndex}:${entry.key}`} className="configSimpleRow">
                <div className="configSimpleRowHead">
                  <button
                    type="button"
                    className="configFieldPathBtn"
                    onClick={() => onSelectField({ path, value: entry.value, type: "text" })}
                  >
                    {path}
                  </button>
                  {(issuesByPath?.[path]?.length ?? 0) > 0 ? (
                    <span className="chip danger">
                      {issuesByPath?.[path]?.length} issue{(issuesByPath?.[path]?.length ?? 0) === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  <span className="chip subtle">{entry.section ? "section" : "entry"}</span>
                </div>
                <input
                  className="input"
                  value={entry.value}
                  list={valueListId}
                  readOnly={readOnly}
                  onChange={(event) => {
                    const next = setLineValue(value, entry, event.target.value);
                    onChange(next);
                    onSelectField({ path, value: event.target.value, type: "text" });
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      <datalist id={valueListId}>
        {valueHints.map((hint) => (
          <option key={hint} value={hint} />
        ))}
      </datalist>
      <div className="configSimpleFooter">
        <div className="muted">Simple mode edits detected key/value lines only.</div>
      </div>
    </div>
  );
}
