export type ConfigFormatDiagnostic = {
  level: "info" | "warning" | "error";
  message: string;
};

export type ConfigFormatSupport = {
  supported: boolean;
  reason?: string;
  canFormat: boolean;
  diagnostics: ConfigFormatDiagnostic[];
};

export type ConfigFormatResult = {
  changed: boolean;
  output: string;
  diagnostics: ConfigFormatDiagnostic[];
  blockingError?: string;
};

type FormatKind = "json" | "properties" | "toml" | "kv-colon" | "none";

function detectKind(filePath: string, content: string): FormatKind {
  const lower = String(filePath ?? "").toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".properties")) return "properties";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith("options.txt")) return "kv-colon";
  if (lower.endsWith(".txt")) {
    const lines = String(content ?? "").split(/\r?\n/);
    const kvLike = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
      const idx = trimmed.indexOf(":");
      return idx > 0;
    });
    if (kvLike.length > 0) return "kv-colon";
  }
  return "none";
}

function normalizeJson(content: string): ConfigFormatResult {
  try {
    const parsed = JSON.parse(content);
    const output = JSON.stringify(parsed, null, 2);
    return {
      changed: output !== content,
      output,
      diagnostics: output === content ? [] : [{ level: "info", message: "JSON formatting normalized." }],
    };
  } catch (err: any) {
    return {
      changed: false,
      output: content,
      diagnostics: [{ level: "error", message: "Invalid JSON. Fix syntax before formatting." }],
      blockingError: String(err?.message ?? err ?? "Invalid JSON"),
    };
  }
}

function splitComment(line: string): { body: string; comment: string } {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble) {
      return {
        body: line.slice(0, i),
        comment: line.slice(i),
      };
    }
  }
  return { body: line, comment: "" };
}

function normalizeProperties(content: string): ConfigFormatResult {
  const lines = String(content ?? "").split(/\r?\n/);
  let changed = false;
  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) return line;
    const idxEq = line.indexOf("=");
    const idxColon = line.indexOf(":");
    const idx =
      idxEq < 0
        ? idxColon
        : idxColon < 0
          ? idxEq
          : Math.min(idxEq, idxColon);
    if (idx <= 0) return line;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const normalized = `${key}=${value}`;
    if (normalized !== line) changed = true;
    return normalized;
  });
  return {
    changed,
    output: output.join("\n"),
    diagnostics: changed ? [{ level: "info", message: "Normalized key/value spacing for .properties." }] : [],
  };
}

function normalizeToml(content: string): ConfigFormatResult {
  const lines = String(content ?? "").split(/\r?\n/);
  let changed = false;
  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^\[[^\]]+\]$/.test(trimmed)) return line;
    const { body, comment } = splitComment(line);
    const idx = body.indexOf("=");
    if (idx <= 0) return line;
    const key = body.slice(0, idx).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) return line;
    const value = body.slice(idx + 1).trim();
    if (!value) return line;
    const rebuilt = `${key} = ${value}${comment ? ` ${comment.trimStart()}` : ""}`;
    if (rebuilt !== line) changed = true;
    return rebuilt;
  });
  return {
    changed,
    output: output.join("\n"),
    diagnostics: changed
      ? [{ level: "info", message: "Normalized simple key/value spacing for TOML." }]
      : [],
  };
}

function normalizeKeyValueColon(content: string): ConfigFormatResult {
  const lines = String(content ?? "").split(/\r?\n/);
  let changed = false;
  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return line;
    const idx = line.indexOf(":");
    if (idx <= 0) return line;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    const normalized = `${key}:${value}`;
    if (normalized !== line) changed = true;
    return normalized;
  });
  return {
    changed,
    output: output.join("\n"),
    diagnostics: changed
      ? [{ level: "info", message: "Normalized key:value spacing for text config." }]
      : [],
  };
}

export function formatConfigContent(filePath: string, content: string): ConfigFormatResult {
  const kind = detectKind(filePath, content);
  if (kind === "json") return normalizeJson(content);
  if (kind === "properties") return normalizeProperties(content);
  if (kind === "toml") return normalizeToml(content);
  if (kind === "kv-colon") return normalizeKeyValueColon(content);
  return {
    changed: false,
    output: content,
    diagnostics: [],
    blockingError: "Formatting not available for this file type.",
  };
}

export function getFormatterSupport(filePath: string, content: string): ConfigFormatSupport {
  const kind = detectKind(filePath, content);
  if (kind === "none") {
    return {
      supported: false,
      reason: "Unsupported file type for safe formatting.",
      canFormat: false,
      diagnostics: [],
    };
  }
  const result = formatConfigContent(filePath, content);
  const canFormat = !result.blockingError && (result.changed || result.diagnostics.length > 0);
  return {
    supported: true,
    reason: result.blockingError,
    canFormat,
    diagnostics: result.diagnostics,
  };
}
