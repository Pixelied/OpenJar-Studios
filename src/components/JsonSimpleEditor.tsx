import { useId, useMemo, useState } from "react";
import {
  asPrettyJson,
  deepClone,
  describePath,
  deleteAtPath,
  getAtPath,
  moveArrayItem,
  setAtPath,
  type JsonPath,
  valueKind,
} from "../pages/configEditorHelpers";
import { getSuggestions } from "../lib/configSuggestions";

type AddFieldType = "string" | "number" | "boolean" | "object" | "array";

function makeInitialValue(type: AddFieldType, raw: string, boolValue: boolean) {
  if (type === "string") return raw;
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === "boolean") return boolValue;
  if (type === "array") return [];
  return {};
}

function pathButtonLabel(part: string | number) {
  return typeof part === "number" ? `[${part}]` : part;
}

export default function JsonSimpleEditor({
  filePath,
  value,
  savedValue,
  focusPath,
  onFocusPathChange,
  onValueChange,
  onSelectPath,
  issuesByPath,
  readOnly,
}: {
  filePath: string;
  value: unknown;
  savedValue: unknown;
  focusPath: JsonPath;
  onFocusPathChange: (path: JsonPath) => void;
  onValueChange: (next: unknown) => void;
  onSelectPath: (path: JsonPath | null) => void;
  issuesByPath?: Record<string, Array<{ message: string; severity: string }>>;
  readOnly?: boolean;
}) {
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldType, setNewFieldType] = useState<AddFieldType>("string");
  const [newFieldValue, setNewFieldValue] = useState("");
  const [newFieldBool, setNewFieldBool] = useState(false);
  const keyListId = useId();
  const valueListId = useId();

  const currentValue = getAtPath(value, focusPath);
  const kind = valueKind(currentValue);

  const rootUnsupported = valueKind(value) !== "object" && valueKind(value) !== "array";

  const pathSegments = useMemo(() => {
    const entries: Array<{ label: string; path: JsonPath }> = [{ label: "root", path: [] }];
    for (let i = 0; i < focusPath.length; i += 1) {
      entries.push({
        label: pathButtonLabel(focusPath[i]),
        path: focusPath.slice(0, i + 1),
      });
    }
    return entries;
  }, [focusPath]);
  const keyHints = useMemo(() => {
    const suggestions = getSuggestions({
      filePath,
      content: asPrettyJson(value),
      cursorIndex: 0,
      mode: "simple",
      limit: 12,
    });
    const out: string[] = [];
    for (const item of suggestions) {
      const token = item.value.trim();
      if (!token || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(token)) continue;
      if (out.includes(token)) continue;
      out.push(token);
      if (out.length >= 8) break;
    }
    return out;
  }, [filePath, value]);
  const valueHints = useMemo(() => {
    const out = new Set<string>(["true", "false", "null", "balanced", "performance", "quality"]);
    try {
      const root = value as any;
      if (root && typeof root === "object") {
        const walk = (node: any) => {
          if (node == null) return;
          if (typeof node === "string") {
            if (node.length > 0 && node.length < 80) out.add(node);
            return;
          }
          if (Array.isArray(node)) {
            for (const entry of node.slice(0, 16)) walk(entry);
            return;
          }
          if (typeof node === "object") {
            for (const entry of Object.values(node).slice(0, 24)) walk(entry);
          }
        };
        walk(root);
      }
    } catch {
      // ignore hint extraction failures
    }
    return [...out].slice(0, 20);
  }, [value]);

  function updateAtPath(path: JsonPath, nextFieldValue: unknown) {
    const nextRoot = setAtPath(value, path, nextFieldValue);
    onValueChange(nextRoot);
    onSelectPath(path);
  }

  function resetField(path: JsonPath) {
    const parentSaved = getAtPath(savedValue, path.slice(0, -1));
    const key = path[path.length - 1];
    if (
      parentSaved &&
      typeof parentSaved === "object" &&
      Object.prototype.hasOwnProperty.call(parentSaved, key as any)
    ) {
      const restoreValue = (parentSaved as any)[key as any];
      onValueChange(setAtPath(value, path, deepClone(restoreValue)));
    } else {
      onValueChange(deleteAtPath(value, path));
    }
    onSelectPath(path);
  }

  function onCreateField() {
    if (!newFieldKey.trim()) return;
    const basePath = [...focusPath, newFieldKey.trim()];
    const nextFieldValue = makeInitialValue(newFieldType, newFieldValue, newFieldBool);
    onValueChange(setAtPath(value, basePath, nextFieldValue));
    onSelectPath(basePath);
    setNewFieldOpen(false);
    setNewFieldKey("");
    setNewFieldValue("");
    setNewFieldBool(false);
    setNewFieldType("string");
  }

  function onAddArrayItem() {
    if (!Array.isArray(currentValue)) return;
    const next = [...currentValue, ""];
    onValueChange(setAtPath(value, focusPath, next));
    onSelectPath([...focusPath, next.length - 1]);
  }

  function issueCountForPath(path: JsonPath) {
    const dotPath = describePath(path).replace(/^root\.?/, "") || "root";
    return (
      (issuesByPath?.[dotPath]?.length ?? 0) +
      (issuesByPath?.[describePath(path)]?.length ?? 0)
    );
  }

  if (rootUnsupported) {
    return (
      <div className="configSimpleEmpty">
        <div className="settingTitle">Simple mode supports JSON objects and arrays.</div>
        <div className="muted">Switch to Advanced mode to edit primitive JSON roots directly.</div>
      </div>
    );
  }

  return (
    <div className="configSimpleEditor">
      <div className="configSimpleBreadcrumbs">
        {pathSegments.map((segment, idx) => (
          <button
            type="button"
            key={`${segment.label}:${idx}`}
            className={`configCrumbBtn ${idx === pathSegments.length - 1 ? "active" : ""}`}
            onClick={() => {
              onFocusPathChange(segment.path);
              onSelectPath(segment.path);
            }}
          >
            {segment.label}
          </button>
        ))}
      </div>

      {kind === "object" ? (
        <div className="configSimpleSection">
          <div className="configSimpleToolbar">
            <span className="chip subtle">Object</span>
            <button className="btn" type="button" onClick={() => setNewFieldOpen(true)} disabled={readOnly}>
              Add field
            </button>
          </div>
          {keyHints.length > 0 ? (
            <div className="configSuggestHintRow">
              <span className="chip subtle">Suggested keys</span>
              {keyHints.slice(0, 6).map((hint) => (
                <button
                  key={hint}
                  type="button"
                  className="configSuggestHintBtn"
                  disabled={readOnly}
                  onClick={() => {
                    setNewFieldOpen(true);
                    setNewFieldKey(hint);
                  }}
                >
                  {hint}
                </button>
              ))}
            </div>
          ) : null}

          {newFieldOpen ? (
            <div className="configInlinePanel">
              <div className="configInlinePanelGrid">
                <input
                  className="input"
                  value={newFieldKey}
                  list={keyListId}
                  onChange={(event) => setNewFieldKey(event.target.value)}
                  placeholder="Field key"
                  readOnly={readOnly}
                />
                <div className="segmented">
                  {(["string", "number", "boolean", "object", "array"] as AddFieldType[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`segBtn ${newFieldType === option ? "active" : ""}`}
                      onClick={() => setNewFieldType(option)}
                      disabled={readOnly}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                {newFieldType === "boolean" ? (
                  <label className="toggleRow">
                    <input
                      type="checkbox"
                      checked={newFieldBool}
                      onChange={(event) => setNewFieldBool(event.target.checked)}
                      disabled={readOnly}
                    />
                    <span className="togglePill" />
                    <span>Initial value: {newFieldBool ? "true" : "false"}</span>
                  </label>
                ) : newFieldType === "object" || newFieldType === "array" ? (
                  <div className="muted">Initial value will be {newFieldType === "object" ? "{}" : "[]"}.</div>
                ) : (
                  <input
                    className="input"
                    value={newFieldValue}
                    list={valueListId}
                    onChange={(event) => setNewFieldValue(event.target.value)}
                    placeholder={newFieldType === "number" ? "0" : "Initial value"}
                    readOnly={readOnly}
                  />
                )}
              </div>
              <div className="row">
                <button
                  className="btn primary"
                  type="button"
                  onClick={onCreateField}
                  disabled={!newFieldKey.trim() || readOnly}
                >
                  Add
                </button>
                <button className="btn" type="button" onClick={() => setNewFieldOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {Object.keys((currentValue as Record<string, unknown>) ?? {}).length === 0 ? (
            <div className="muted">No fields yet.</div>
          ) : (
            <div className="configSimpleRows">
              {Object.entries((currentValue as Record<string, unknown>) ?? {}).map(([key, fieldValue]) => {
                const fieldPath = [...focusPath, key];
                const fieldKind = valueKind(fieldValue);
                return (
                  <div key={key} className="configSimpleRow">
                    <div className="configSimpleRowHead">
                      <button
                        type="button"
                        className="configFieldPathBtn"
                        onClick={() => onSelectPath(fieldPath)}
                      >
                        {key}
                      </button>
                      {issueCountForPath(fieldPath) > 0 ? (
                        <span className="chip danger">{issueCountForPath(fieldPath)} issue{issueCountForPath(fieldPath) === 1 ? "" : "s"}</span>
                      ) : null}
                      <span className="chip subtle">{fieldKind}</span>
                    </div>

                    {fieldKind === "string" ? (
                      <input
                        className="input"
                        value={String(fieldValue ?? "")}
                        list={valueListId}
                        onChange={(event) => updateAtPath(fieldPath, event.target.value)}
                        readOnly={readOnly}
                      />
                    ) : null}

                    {fieldKind === "number" ? (
                      <input
                        className="input"
                        type="number"
                        value={Number(fieldValue ?? 0)}
                        onChange={(event) => updateAtPath(fieldPath, Number(event.target.value))}
                        readOnly={readOnly}
                      />
                    ) : null}

                    {fieldKind === "boolean" ? (
                      <label className="toggleRow">
                        <input
                          type="checkbox"
                          checked={Boolean(fieldValue)}
                          onChange={(event) => updateAtPath(fieldPath, event.target.checked)}
                          disabled={readOnly}
                        />
                        <span className="togglePill" />
                        <span>{Boolean(fieldValue) ? "true" : "false"}</span>
                      </label>
                    ) : null}

                    {fieldKind === "object" || fieldKind === "array" ? (
                      <details className="configNestedDetails">
                        <summary>
                          {fieldKind === "array"
                            ? `Array (${Array.isArray(fieldValue) ? fieldValue.length : 0})`
                            : `Object (${Object.keys((fieldValue as Record<string, unknown>) ?? {}).length})`}
                        </summary>
                        <div className="row" style={{ marginTop: 8 }}>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => {
                              onFocusPathChange(fieldPath);
                              onSelectPath(fieldPath);
                            }}
                          >
                            Open section
                          </button>
                        </div>
                      </details>
                    ) : null}

                    <div className="row">
                      <button className="btn" type="button" onClick={() => resetField(fieldPath)} disabled={readOnly}>
                        Reset field
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      <datalist id={keyListId}>
        {keyHints.map((hint) => (
          <option key={hint} value={hint} />
        ))}
      </datalist>
      <datalist id={valueListId}>
        {valueHints.map((hint) => (
          <option key={hint} value={hint} />
        ))}
      </datalist>

      {kind === "array" ? (
        <div className="configSimpleSection">
          <div className="configSimpleToolbar">
            <span className="chip subtle">Array ({Array.isArray(currentValue) ? currentValue.length : 0})</span>
            <button className="btn" type="button" onClick={onAddArrayItem} disabled={readOnly}>
              Add item
            </button>
          </div>

          {!Array.isArray(currentValue) || currentValue.length === 0 ? (
            <div className="muted">Array is empty.</div>
          ) : (
            <div className="configSimpleRows">
              {currentValue.map((item, idx) => {
                const itemPath = [...focusPath, idx];
                const itemKind = valueKind(item);
                return (
                  <div key={idx} className="configSimpleRow">
                    <div className="configSimpleRowHead">
                      <button
                        type="button"
                        className="configFieldPathBtn"
                        onClick={() => onSelectPath(itemPath)}
                      >
                        [{idx}]
                      </button>
                      {issueCountForPath(itemPath) > 0 ? (
                        <span className="chip danger">{issueCountForPath(itemPath)} issue{issueCountForPath(itemPath) === 1 ? "" : "s"}</span>
                      ) : null}
                      <span className="chip subtle">{itemKind}</span>
                    </div>

                    {itemKind === "string" ? (
                      <input
                        className="input"
                        value={String(item ?? "")}
                        onChange={(event) => updateAtPath(itemPath, event.target.value)}
                        readOnly={readOnly}
                      />
                    ) : null}

                    {itemKind === "number" ? (
                      <input
                        className="input"
                        type="number"
                        value={Number(item ?? 0)}
                        onChange={(event) => updateAtPath(itemPath, Number(event.target.value))}
                        readOnly={readOnly}
                      />
                    ) : null}

                    {itemKind === "boolean" ? (
                      <label className="toggleRow">
                        <input
                          type="checkbox"
                          checked={Boolean(item)}
                          onChange={(event) => updateAtPath(itemPath, event.target.checked)}
                          disabled={readOnly}
                        />
                        <span className="togglePill" />
                        <span>{Boolean(item) ? "true" : "false"}</span>
                      </label>
                    ) : null}

                    {itemKind === "object" || itemKind === "array" ? (
                      <details className="configNestedDetails">
                        <summary>Complex value</summary>
                        <div className="row" style={{ marginTop: 8 }}>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => {
                              onFocusPathChange(itemPath);
                              onSelectPath(itemPath);
                            }}
                          >
                            Open section
                          </button>
                        </div>
                      </details>
                    ) : null}

                    <div className="row">
                      <button
                        className="btn"
                        type="button"
                        disabled={idx === 0 || readOnly}
                        onClick={() => onValueChange(moveArrayItem(value, focusPath, idx, idx - 1))}
                      >
                        Move up
                      </button>
                      <button
                        className="btn"
                        type="button"
                        disabled={idx >= currentValue.length - 1 || readOnly}
                        onClick={() => onValueChange(moveArrayItem(value, focusPath, idx, idx + 1))}
                      >
                        Move down
                      </button>
                      <button
                        className="btn danger"
                        type="button"
                        onClick={() => onValueChange(deleteAtPath(value, itemPath))}
                        disabled={readOnly}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      <div className="configSimpleFooter">
        <div className="muted">Simple mode writes to draft JSON. Use Save when ready.</div>
        <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(asPrettyJson(currentValue)).catch(() => null)}>
          Copy focused JSON
        </button>
      </div>
    </div>
  );
}
