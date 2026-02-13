import { formatConfigContent } from "./configFormatting";

export type ConfigIssueSeverity = "error" | "warning" | "info";

export type ConfigIssue = {
  path: string;
  message: string;
  severity: ConfigIssueSeverity;
  line?: number;
};

export type ConfigDoc = {
  title: string;
  type: string;
  description: string;
  recommendations?: string[];
};

export type SafeFixResult = {
  changed: boolean;
  output: string;
  notes: string[];
  issues: ConfigIssue[];
  blockingError?: string;
};

export type ConfigPreset = "performance" | "balanced" | "quality";

type ValueRule = {
  keyPattern: RegExp;
  type: "number" | "boolean" | "enum";
  min?: number;
  max?: number;
  allowed?: string[];
  defaultValue?: number | boolean | string;
};

type TextEntry = {
  lineIndex: number;
  key: string;
  value: string;
  delimiter: ":" | "=";
  path: string;
  rawLine: string;
};

const VALUE_RULES: ValueRule[] = [
  {
    keyPattern: /(^|\.)(renderDistance|max-mob-count|spawn-radius)$/i,
    type: "number",
    min: 2,
    max: 128,
    defaultValue: 12,
  },
  {
    keyPattern: /(^|\.)(simulationDistance)$/i,
    type: "number",
    min: 2,
    max: 64,
    defaultValue: 10,
  },
  {
    keyPattern: /(^|\.)(chunkUpdates)$/i,
    type: "number",
    min: 1,
    max: 20,
    defaultValue: 3,
  },
  {
    keyPattern: /(^|\.)(gamma)$/i,
    type: "number",
    min: 0,
    max: 2,
    defaultValue: 1,
  },
  {
    keyPattern: /(^|\.)(fov)$/i,
    type: "number",
    min: -1,
    max: 110,
    defaultValue: 0,
  },
  {
    keyPattern: /(^|\.)(entityShadows|fullscreen|enableVsync|enabled|asyncIO|autoJoinServer)$/i,
    type: "boolean",
    defaultValue: true,
  },
  {
    keyPattern: /(^|\.)(graphicsMode)$/i,
    type: "enum",
    allowed: ["fast", "fancy", "fabulous"],
    defaultValue: "fancy",
  },
  {
    keyPattern: /(^|\.)(particles)$/i,
    type: "enum",
    allowed: ["all", "decreased", "minimal"],
    defaultValue: "all",
  },
  {
    keyPattern: /(^|\.)(preset)$/i,
    type: "enum",
    allowed: ["performance", "balanced", "quality"],
    defaultValue: "balanced",
  },
];

const DOCS: Array<{ pattern: RegExp; doc: ConfigDoc }> = [
  {
    pattern: /(^|\.)(renderDistance)$/i,
    doc: {
      title: "Render distance",
      type: "number",
      description: "Controls how many chunks are rendered around the player.",
      recommendations: ["Low-end: 8-12", "Balanced: 12-20", "High-end: 24+"],
    },
  },
  {
    pattern: /(^|\.)(simulationDistance)$/i,
    doc: {
      title: "Simulation distance",
      type: "number",
      description: "Controls entity/tick simulation radius around the player.",
      recommendations: ["Lower value improves CPU performance", "Balanced default is around 10-12"],
    },
  },
  {
    pattern: /(^|\.)(entityShadows)$/i,
    doc: {
      title: "Entity shadows",
      type: "boolean",
      description: "Enables dynamic shadows under entities.",
      recommendations: ["Disable for extra FPS", "Enable for better visual quality"],
    },
  },
  {
    pattern: /(^|\.)(graphicsMode)$/i,
    doc: {
      title: "Graphics mode",
      type: "enum",
      description: "Switches base rendering quality presets.",
      recommendations: ["fast", "fancy", "fabulous"],
    },
  },
  {
    pattern: /(^|\.)(particles)$/i,
    doc: {
      title: "Particles",
      type: "enum",
      description: "Controls number of visible particles.",
      recommendations: ["all", "decreased", "minimal"],
    },
  },
  {
    pattern: /(^|\.)(enabled)$/i,
    doc: {
      title: "Enabled",
      type: "boolean",
      description: "Toggles whether this feature/module is active.",
      recommendations: ["Set false when debugging a problematic feature"],
    },
  },
  {
    pattern: /(^|\.)(preset)$/i,
    doc: {
      title: "Graphics preset",
      type: "enum",
      description: "High-level quality/performance profile.",
      recommendations: ["performance", "balanced", "quality"],
    },
  },
];

function normalizePath(path: string): string {
  const raw = String(path ?? "").trim();
  if (!raw) return "root";
  return raw.replace(/^root\.?/, "").replace(/^\./, "") || "root";
}

function describePath(parts: Array<string | number>): string {
  if (parts.length === 0) return "root";
  return parts
    .map((part, idx) => {
      if (typeof part === "number") return `[${part}]`;
      if (idx === 0) return part;
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? `.${part}` : `[\"${part}\"]`;
    })
    .join("");
}

function detectKind(filePath: string) {
  const lower = String(filePath ?? "").toLowerCase();
  if (lower.endsWith(".json")) return "json" as const;
  if (lower.endsWith(".properties")) return "properties" as const;
  if (lower.endsWith(".toml")) return "toml" as const;
  if (lower.endsWith("options.txt")) return "options" as const;
  if (lower.endsWith(".txt")) return "txt" as const;
  return "other" as const;
}

function getRule(path: string): ValueRule | null {
  const normalized = normalizePath(path);
  return VALUE_RULES.find((rule) => rule.keyPattern.test(normalized)) ?? null;
}

function parseMaybeNumber(input: string): number | null {
  const value = Number(String(input).trim());
  return Number.isFinite(value) ? value : null;
}

function parseMaybeBoolean(input: string): boolean | null {
  const value = String(input).trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(value)) return true;
  if (["false", "off", "no", "0"].includes(value)) return false;
  return null;
}

function splitComment(line: string): { body: string; comment: string } {
  const hashIdx = line.indexOf("#");
  if (hashIdx < 0) return { body: line, comment: "" };
  return {
    body: line.slice(0, hashIdx),
    comment: line.slice(hashIdx),
  };
}

function parseTextEntries(filePath: string, content: string): TextEntry[] {
  const lower = String(filePath ?? "").toLowerCase();
  const delimiter: ":" | "=" = lower.endsWith(".properties") || lower.endsWith(".toml") ? "=" : ":";
  const lines = String(content ?? "").split(/\r?\n/);
  let section = "";
  const out: TextEntry[] = [];

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("!")) return;
    if (lower.endsWith(".toml") && /^\[[^\]]+\]$/.test(trimmed)) {
      section = trimmed.slice(1, -1).trim();
      return;
    }
    const body = lower.endsWith(".toml") ? splitComment(line).body : line;
    const idx = body.indexOf(delimiter);
    if (idx <= 0) return;
    const key = body.slice(0, idx).trim();
    const value = body.slice(idx + 1).trim();
    if (!key) return;
    const path = section ? `${section}.${key}` : key;
    out.push({
      lineIndex,
      key,
      value,
      delimiter,
      path,
      rawLine: line,
    });
  });

  return out;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function collectJsonIssues(node: unknown, parts: Array<string | number>, out: ConfigIssue[]) {
  const path = describePath(parts);
  if (typeof node === "string") {
    if (node.trim() === "") {
      out.push({ path, severity: "warning", message: "Value is an empty string." });
    }
  }
  if (typeof node === "number") {
    if (!Number.isFinite(node)) {
      out.push({ path, severity: "error", message: "Number is not finite." });
    }
  }

  const rule = getRule(path);
  if (rule && typeof node !== "object") {
    if (rule.type === "number") {
      if (typeof node !== "number") {
        out.push({ path, severity: "warning", message: "Expected a numeric value." });
      } else {
        if (rule.min != null && node < rule.min) {
          out.push({ path, severity: "warning", message: `Value is below recommended minimum (${rule.min}).` });
        }
        if (rule.max != null && node > rule.max) {
          out.push({ path, severity: "warning", message: `Value is above recommended maximum (${rule.max}).` });
        }
      }
    }
    if (rule.type === "boolean" && typeof node !== "boolean") {
      out.push({ path, severity: "warning", message: "Expected a boolean value." });
    }
    if (rule.type === "enum" && typeof node === "string") {
      const allowed = rule.allowed ?? [];
      if (allowed.length > 0 && !allowed.includes(node.toLowerCase())) {
        out.push({
          path,
          severity: "warning",
          message: `Unexpected value. Recommended: ${allowed.join(", ")}.`,
        });
      }
    }
  }

  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectJsonIssues(entry, [...parts, index], out));
    return;
  }

  if (node && typeof node === "object") {
    Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
      collectJsonIssues(value, [...parts, key], out);
    });
  }
}

function collectTextIssues(filePath: string, content: string): ConfigIssue[] {
  const entries = parseTextEntries(filePath, content);
  const issues: ConfigIssue[] = [];
  const seen = new Map<string, number>();

  for (const entry of entries) {
    const keyNorm = entry.path.toLowerCase();
    const prior = seen.get(keyNorm);
    if (typeof prior === "number") {
      issues.push({
        path: entry.path,
        line: entry.lineIndex + 1,
        severity: "warning",
        message: `Duplicate key. First defined on line ${prior + 1}.`,
      });
    } else {
      seen.set(keyNorm, entry.lineIndex);
    }

    const rule = getRule(entry.path);
    if (!rule) continue;
    if (rule.type === "number") {
      const numberValue = parseMaybeNumber(entry.value);
      if (numberValue == null) {
        issues.push({
          path: entry.path,
          line: entry.lineIndex + 1,
          severity: "warning",
          message: "Expected numeric value.",
        });
      } else {
        if (rule.min != null && numberValue < rule.min) {
          issues.push({
            path: entry.path,
            line: entry.lineIndex + 1,
            severity: "warning",
            message: `Value below recommended minimum (${rule.min}).`,
          });
        }
        if (rule.max != null && numberValue > rule.max) {
          issues.push({
            path: entry.path,
            line: entry.lineIndex + 1,
            severity: "warning",
            message: `Value above recommended maximum (${rule.max}).`,
          });
        }
      }
    } else if (rule.type === "boolean") {
      if (parseMaybeBoolean(entry.value) == null) {
        issues.push({
          path: entry.path,
          line: entry.lineIndex + 1,
          severity: "warning",
          message: "Expected boolean value (true/false).",
        });
      }
    } else if (rule.type === "enum") {
      const current = entry.value.toLowerCase();
      if ((rule.allowed ?? []).length > 0 && !rule.allowed!.includes(current)) {
        issues.push({
          path: entry.path,
          line: entry.lineIndex + 1,
          severity: "warning",
          message: `Unexpected value. Recommended: ${(rule.allowed ?? []).join(", ")}.`,
        });
      }
    }
  }

  return issues;
}

export function collectConfigIssues(filePath: string, content: string): ConfigIssue[] {
  const kind = detectKind(filePath);
  if (kind === "json") {
    try {
      const parsed = JSON.parse(content);
      const out: ConfigIssue[] = [];
      collectJsonIssues(parsed, [], out);
      return out;
    } catch (err: any) {
      return [
        {
          path: "root",
          severity: "error",
          message: `Invalid JSON: ${String(err?.message ?? err ?? "Parse error")}`,
        },
      ];
    }
  }
  if (kind === "properties" || kind === "toml" || kind === "txt" || kind === "options") {
    return collectTextIssues(filePath, content);
  }
  return [];
}

function clamp(value: number, min?: number, max?: number) {
  let next = value;
  if (typeof min === "number") next = Math.max(min, next);
  if (typeof max === "number") next = Math.min(max, next);
  return next;
}

function applyRuleToJson(path: string, value: unknown, notes: string[]): unknown {
  const rule = getRule(path);
  if (!rule) return value;

  if (rule.type === "number") {
    if (typeof value === "number") {
      const clamped = clamp(value, rule.min, rule.max);
      if (clamped !== value) {
        notes.push(`${normalizePath(path)} clamped to safe range.`);
      }
      return clamped;
    }
    if (typeof rule.defaultValue === "number") {
      notes.push(`${normalizePath(path)} reset to default numeric value.`);
      return rule.defaultValue;
    }
  }

  if (rule.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const parsed = parseMaybeBoolean(value);
      if (parsed != null) {
        notes.push(`${normalizePath(path)} normalized to boolean.`);
        return parsed;
      }
    }
    if (typeof rule.defaultValue === "boolean") {
      notes.push(`${normalizePath(path)} reset to default boolean.`);
      return rule.defaultValue;
    }
  }

  if (rule.type === "enum") {
    const allowed = rule.allowed ?? [];
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (allowed.length === 0 || allowed.includes(lower)) return lower;
      if (typeof rule.defaultValue === "string") {
        notes.push(`${normalizePath(path)} reset to recommended value.`);
        return rule.defaultValue;
      }
      return value;
    }
    if (typeof rule.defaultValue === "string") {
      notes.push(`${normalizePath(path)} reset to recommended value.`);
      return rule.defaultValue;
    }
  }

  return value;
}

function fixJsonValue(node: unknown, parts: Array<string | number>, notes: string[]): unknown {
  const path = describePath(parts);
  if (Array.isArray(node)) {
    return node.map((entry, index) => fixJsonValue(entry, [...parts, index], notes));
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
      out[key] = fixJsonValue(value, [...parts, key], notes);
    });
    return out;
  }
  return applyRuleToJson(path, node, notes);
}

function rewriteTextLine(entry: TextEntry, nextValue: string): string {
  return `${entry.key}${entry.delimiter}${nextValue}`;
}

function fixTextContent(filePath: string, content: string, notes: string[]) {
  const lines = String(content ?? "").split(/\r?\n/);
  const entries = parseTextEntries(filePath, content);
  let changed = false;

  for (const entry of entries) {
    const rule = getRule(entry.path);
    if (!rule) continue;
    let nextRawValue = entry.value;

    if (rule.type === "number") {
      const parsed = parseMaybeNumber(entry.value);
      const nextNum = clamp(parsed ?? Number(rule.defaultValue ?? 0), rule.min, rule.max);
      nextRawValue = String(nextNum);
      if (parsed == null) {
        notes.push(`${entry.path} reset to numeric default.`);
      } else if (nextNum !== parsed) {
        notes.push(`${entry.path} clamped to safe range.`);
      }
    } else if (rule.type === "boolean") {
      const parsed = parseMaybeBoolean(entry.value);
      const nextBool = parsed ?? Boolean(rule.defaultValue ?? true);
      nextRawValue = nextBool ? "true" : "false";
      if (parsed == null) {
        notes.push(`${entry.path} normalized to boolean default.`);
      }
    } else if (rule.type === "enum") {
      const lower = entry.value.toLowerCase();
      const allowed = rule.allowed ?? [];
      if (allowed.length > 0 && !allowed.includes(lower)) {
        nextRawValue = String(rule.defaultValue ?? allowed[0] ?? lower);
        notes.push(`${entry.path} reset to recommended value.`);
      } else {
        nextRawValue = lower;
      }
    }

    const rewritten = rewriteTextLine(entry, nextRawValue);
    if (rewritten !== entry.rawLine) {
      lines[entry.lineIndex] = rewritten;
      changed = true;
    }
  }

  const joined = lines.join("\n");
  const formatted = formatConfigContent(filePath, joined);
  return {
    changed: changed || formatted.changed,
    output: formatted.output,
  };
}

function setPathValue(root: Record<string, any>, path: string, value: unknown) {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor: Record<string, any> = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

export function applyConfigPreset(filePath: string, content: string, preset: ConfigPreset): SafeFixResult {
  const kind = detectKind(filePath);
  const notes: string[] = [];

  const presetValues =
    preset === "performance"
      ? {
          renderDistance: 8,
          simulationDistance: 6,
          entityShadows: false,
          graphicsMode: "fast",
          particles: "minimal",
          "graphics.preset": "performance",
          "graphics.shadows": false,
          "graphics.particles": "minimal",
          "performance.chunkUpdates": 1,
        }
      : preset === "quality"
        ? {
            renderDistance: 24,
            simulationDistance: 14,
            entityShadows: true,
            graphicsMode: "fabulous",
            particles: "all",
            "graphics.preset": "quality",
            "graphics.shadows": true,
            "graphics.particles": "all",
            "performance.chunkUpdates": 4,
          }
        : {
            renderDistance: 16,
            simulationDistance: 10,
            entityShadows: true,
            graphicsMode: "fancy",
            particles: "all",
            "graphics.preset": "balanced",
            "graphics.shadows": true,
            "graphics.particles": "all",
            "performance.chunkUpdates": 3,
          };

  if (kind === "json") {
    try {
      const parsed = cloneJson(JSON.parse(content) as Record<string, any>);
      for (const [path, value] of Object.entries(presetValues)) {
        setPathValue(parsed, path, value);
      }
      const output = JSON.stringify(parsed, null, 2);
      if (output !== content) notes.push(`Applied ${preset} preset values.`);
      return {
        changed: output !== content,
        output,
        notes,
        issues: collectConfigIssues(filePath, output),
      };
    } catch (err: any) {
      return {
        changed: false,
        output: content,
        notes: [],
        issues: collectConfigIssues(filePath, content),
        blockingError: `Invalid JSON: ${String(err?.message ?? err ?? "Parse error")}`,
      };
    }
  }

  if (kind === "options" || kind === "txt" || kind === "properties") {
    const lines = String(content).split(/\r?\n/);
    let changed = false;
    const delimiter: ":" | "=" = kind === "options" || kind === "txt" ? ":" : "=";

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const idx = line.indexOf(delimiter);
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      const keyLower = key.toLowerCase();
      const match = Object.entries(presetValues).find(([path]) => {
        const leaf = path.split(".").pop() ?? path;
        return leaf.toLowerCase() === keyLower;
      });
      if (!match) continue;
      const next = `${key}${delimiter}${String(match[1])}`;
      if (next !== line) {
        lines[i] = next;
        changed = true;
      }
    }

    const output = lines.join("\n");
    if (changed) notes.push(`Applied ${preset} preset to matching keys.`);
    return {
      changed,
      output,
      notes,
      issues: collectConfigIssues(filePath, output),
    };
  }

  return {
    changed: false,
    output: content,
    notes: [],
    issues: collectConfigIssues(filePath, content),
    blockingError: "Presets are not available for this file type.",
  };
}

export function applySafeFixes(filePath: string, content: string): SafeFixResult {
  const kind = detectKind(filePath);
  const notes: string[] = [];

  if (kind === "json") {
    try {
      const parsed = JSON.parse(content);
      const fixed = fixJsonValue(parsed, [], notes);
      const output = JSON.stringify(fixed, null, 2);
      const formatted = formatConfigContent(filePath, output);
      const finalOutput = formatted.output;
      if (formatted.changed) notes.push("Normalized formatting.");
      return {
        changed: finalOutput !== content,
        output: finalOutput,
        notes,
        issues: collectConfigIssues(filePath, finalOutput),
      };
    } catch (err: any) {
      return {
        changed: false,
        output: content,
        notes: [],
        issues: collectConfigIssues(filePath, content),
        blockingError: `Invalid JSON: ${String(err?.message ?? err ?? "Parse error")}`,
      };
    }
  }

  if (kind === "properties" || kind === "toml" || kind === "txt" || kind === "options") {
    const fixed = fixTextContent(filePath, content, notes);
    return {
      changed: fixed.changed,
      output: fixed.output,
      notes,
      issues: collectConfigIssues(filePath, fixed.output),
    };
  }

  return {
    changed: false,
    output: content,
    notes: [],
    issues: collectConfigIssues(filePath, content),
    blockingError: "Safe fixes are not available for this file type.",
  };
}

export function getConfigDocForPath(filePath: string, path: string): ConfigDoc | null {
  const normalizedPath = normalizePath(path);
  const normalizedFile = String(filePath ?? "").toLowerCase();
  for (const entry of DOCS) {
    if (entry.pattern.test(normalizedPath)) {
      return entry.doc;
    }
  }

  if (normalizedFile.endsWith(".json")) {
    return {
      title: "JSON field",
      type: "json",
      description: "This key is part of the JSON config tree for this file.",
      recommendations: ["Use Simple mode for structured edits", "Save only when warnings are resolved"],
    };
  }
  if (normalizedFile.endsWith(".properties") || normalizedFile.endsWith(".toml") || normalizedFile.endsWith(".txt")) {
    return {
      title: "Text config field",
      type: "text",
      description: "This value is stored as plain text key/value config.",
      recommendations: ["Use Format to normalize spacing", "Keep comments and order intact"],
    };
  }

  return null;
}

export function groupIssuesByPath(issues: ConfigIssue[]) {
  const grouped: Record<string, ConfigIssue[]> = {};
  for (const issue of issues) {
    const key = normalizePath(issue.path) || "root";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(issue);
  }
  return grouped;
}
