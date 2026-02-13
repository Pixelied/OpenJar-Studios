import {
  describePath,
  getAtPath,
  type JsonPath,
  valueKind,
} from "../pages/configEditorHelpers";

function previewValue(value: unknown) {
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}...` : value;
  try {
    const text = JSON.stringify(value);
    if (!text) return String(value);
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
  } catch {
    return String(value);
  }
}

function warningsFor(path: string, value: unknown): string[] {
  const warnings: string[] = [];
  if (typeof value === "string" && value.trim() === "") {
    warnings.push("Value is an empty string.");
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) warnings.push("Number is not finite.");
    const keyHint = /(size|count|max|min|width|height|distance|radius|amount|limit|volume|threads|port)/i.test(path);
    if (value < 0 && keyHint) warnings.push("Negative value might be invalid for this setting.");
    if (Math.abs(value) > 1_000_000) warnings.push("Number is very large and may cause issues.");
  }
  return warnings;
}

export default function InspectorPanel({
  filePath,
  isJson,
  rootValue,
  selectedPath,
  nonJsonPath,
  nonJsonValue,
  nonJsonType,
  doc,
  pathIssues,
}: {
  filePath: string;
  isJson: boolean;
  rootValue: unknown;
  selectedPath: JsonPath | null;
  nonJsonPath?: string | null;
  nonJsonValue?: string | null;
  nonJsonType?: string | null;
  doc?: {
    title: string;
    type: string;
    description: string;
    recommendations?: string[];
  } | null;
  pathIssues?: Array<{ message: string; severity: string; line?: number }>;
}) {
  const pathText = describePath(selectedPath);
  const value = isJson ? getAtPath(rootValue, selectedPath ?? []) : undefined;
  const type = isJson ? valueKind(value) : (nonJsonType || "text");
  const valuePreview = isJson ? previewValue(value) : (nonJsonValue || "Text editor file");
  const issues = isJson ? warningsFor(pathText, value) : [];
  const copyPathText = isJson ? pathText : String(nonJsonPath ?? "line");

  async function onCopyPath() {
    try {
      await navigator.clipboard.writeText(copyPathText);
    } catch {
      // ignore clipboard errors in restricted contexts
    }
  }

  return (
    <div className="configWorkspacePanel configInspectorPanel">
      <div className="settingTitle">Inspector</div>
      <div className="configInspectorRows">
        <div className="configInspectorRow">
          <span>File</span>
          <strong>{filePath}</strong>
        </div>
        <div className="configInspectorRow">
          <span>Path</span>
          <strong>{isJson ? pathText : (nonJsonPath ?? "line")}</strong>
        </div>
        <div className="configInspectorRow">
          <span>Type</span>
          <strong>{type}</strong>
        </div>
      </div>

      <div className="configInspectorPreview">
        <div className="configInspectorLabel">Value preview</div>
        <pre>{valuePreview}</pre>
      </div>

      <button className="btn" type="button" onClick={onCopyPath} disabled={!copyPathText}>
        Copy path
      </button>

      <div className="configInspectorWarnings">
        <div className="configInspectorLabel">Warnings</div>
        {issues.length === 0 ? (
          <div className="muted">No obvious issues detected.</div>
        ) : (
          issues.map((issue) => (
            <div key={issue} className="noticeBox">
              {issue}
            </div>
          ))
        )}
      </div>

      {pathIssues && pathIssues.length > 0 ? (
        <div className="configInspectorWarnings">
          <div className="configInspectorLabel">Path checks</div>
          {pathIssues.map((issue, index) => (
            <div key={`${issue.message}:${index}`} className="noticeBox">
              {issue.message}
              {issue.line ? ` (line ${issue.line})` : ""}
            </div>
          ))}
        </div>
      ) : null}

      {doc ? (
        <div className="configInspectorDoc">
          <div className="configInspectorLabel">Smart docs</div>
          <div className="settingTitle">{doc.title}</div>
          <div className="muted">{doc.description}</div>
          {doc.recommendations && doc.recommendations.length > 0 ? (
            <div className="configInspectorDocList">
              {doc.recommendations.slice(0, 4).map((item) => (
                <span key={item} className="chip subtle">{item}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
