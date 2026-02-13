export type ConfigRisk = "low" | "medium" | "high";

export type ConfigFieldDoc = {
  file: string;
  path: string;
  label: string;
  description: string;
  type: "string" | "number" | "boolean" | "enum";
  allowed?: string[];
  min?: number;
  max?: number;
  recommended?: string;
  risk: ConfigRisk;
  defaultValue?: string | number | boolean;
};

export type FieldValidation = {
  level: "ok" | "warning" | "error";
  messages: string[];
};

export type ConfigProfile = {
  id: string;
  label: string;
  description: string;
};

const DOCS: ConfigFieldDoc[] = [
  {
    file: "config/modpack.json",
    path: "graphics.preset",
    label: "Graphics preset",
    description: "Primary visual profile for this modpack.",
    type: "enum",
    allowed: ["performance", "balanced", "quality"],
    recommended: "balanced",
    risk: "low",
    defaultValue: "balanced",
  },
  {
    file: "config/modpack.json",
    path: "graphics.shadows",
    label: "Shadows",
    description: "Enable dynamic shadows. Disabling can improve FPS.",
    type: "boolean",
    recommended: "true",
    risk: "low",
    defaultValue: true,
  },
  {
    file: "config/modpack.json",
    path: "graphics.particles",
    label: "Particles",
    description: "Particle density setting used by the pack defaults.",
    type: "enum",
    allowed: ["minimal", "decreased", "all"],
    recommended: "all",
    risk: "low",
    defaultValue: "all",
  },
  {
    file: "config/modpack.json",
    path: "performance.chunkUpdates",
    label: "Chunk updates",
    description: "How many chunk updates can render per frame.",
    type: "number",
    min: 1,
    max: 10,
    recommended: "3",
    risk: "medium",
    defaultValue: 3,
  },
  {
    file: "config/modpack.json",
    path: "performance.asyncIO",
    label: "Async IO",
    description: "Enables asynchronous IO for smoother frame pacing.",
    type: "boolean",
    recommended: "true",
    risk: "low",
    defaultValue: true,
  },
  {
    file: "options.txt",
    path: "gamma",
    label: "Gamma",
    description: "Brightness multiplier for the game.",
    type: "number",
    min: 0,
    max: 1,
    recommended: "1",
    risk: "low",
    defaultValue: 1,
  },
  {
    file: "options.txt",
    path: "renderDistance",
    label: "Render distance",
    description: "Chunk render distance. Higher values impact performance.",
    type: "number",
    min: 2,
    max: 32,
    recommended: "12",
    risk: "medium",
    defaultValue: 12,
  },
  {
    file: "options.txt",
    path: "simulationDistance",
    label: "Simulation distance",
    description: "Simulation range for entities and redstone.",
    type: "number",
    min: 2,
    max: 24,
    recommended: "10",
    risk: "medium",
    defaultValue: 10,
  },
  {
    file: "options.txt",
    path: "graphicsMode",
    label: "Graphics mode",
    description: "Visual quality mode.",
    type: "enum",
    allowed: ["fast", "fancy", "fabulous"],
    recommended: "fancy",
    risk: "low",
    defaultValue: "fancy",
  },
  {
    file: "options.txt",
    path: "entityShadows",
    label: "Entity shadows",
    description: "Toggle small shadows under entities.",
    type: "boolean",
    recommended: "true",
    risk: "low",
    defaultValue: true,
  },
  {
    file: "options.txt",
    path: "fullscreen",
    label: "Fullscreen",
    description: "Starts game in fullscreen mode.",
    type: "boolean",
    recommended: "false",
    risk: "low",
    defaultValue: false,
  },
  {
    file: "options.txt",
    path: "fov",
    label: "Field of View",
    description: "Player camera field of view.",
    type: "number",
    min: 30,
    max: 110,
    recommended: "70",
    risk: "low",
    defaultValue: 70,
  },
];

const PROFILE_PATCHES: Record<string, Record<string, Record<string, string | number | boolean>>> = {
  "config/modpack.json": {
    performance: {
      "graphics.preset": "performance",
      "graphics.shadows": false,
      "graphics.particles": "minimal",
      "performance.chunkUpdates": 2,
      "performance.asyncIO": true,
    },
    balanced: {
      "graphics.preset": "balanced",
      "graphics.shadows": true,
      "graphics.particles": "decreased",
      "performance.chunkUpdates": 3,
      "performance.asyncIO": true,
    },
    quality: {
      "graphics.preset": "quality",
      "graphics.shadows": true,
      "graphics.particles": "all",
      "performance.chunkUpdates": 5,
      "performance.asyncIO": true,
    },
  },
  "options.txt": {
    performance: {
      renderDistance: 8,
      simulationDistance: 6,
      graphicsMode: "fast",
      entityShadows: false,
      gamma: 1,
      fullscreen: false,
      fov: 70,
    },
    balanced: {
      renderDistance: 12,
      simulationDistance: 10,
      graphicsMode: "fancy",
      entityShadows: true,
      gamma: 1,
      fullscreen: false,
      fov: 70,
    },
    quality: {
      renderDistance: 20,
      simulationDistance: 14,
      graphicsMode: "fabulous",
      entityShadows: true,
      gamma: 1,
      fullscreen: false,
      fov: 80,
    },
  },
};

function normalizeFile(filePath: string) {
  return String(filePath ?? "").replace(/\\/g, "/").trim().toLowerCase();
}

function pathToDot(path: Array<string | number>) {
  return path
    .map((part, idx) => {
      if (typeof part === "number") return `[${part}]`;
      if (idx === 0) return part;
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? `.${part}` : `['${part}']`;
    })
    .join("");
}

function boolFrom(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(lower)) return true;
    if (["false", "0", "no", "off"].includes(lower)) return false;
  }
  return null;
}

function numberFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getByDotPath(root: any, path: string) {
  const parts = path.split(".");
  let current = root;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function setByDotPath(root: any, path: string, value: unknown) {
  const parts = path.split(".");
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function docFor(filePath: string, fieldPath: string): ConfigFieldDoc | null {
  const file = normalizeFile(filePath);
  const path = String(fieldPath ?? "").trim();
  const exact = DOCS.find((entry) => normalizeFile(entry.file) === file && entry.path === path);
  if (exact) return exact;
  if (/distance|radius|count|max|min|threads|memory|volume|size/i.test(path)) {
    return {
      file,
      path,
      label: path,
      description: "Numeric tuning value.",
      type: "number",
      risk: "medium",
    };
  }
  if (/enable|enabled|shadow|fullscreen|vsync|async|debug/i.test(path)) {
    return {
      file,
      path,
      label: path,
      description: "Boolean toggle setting.",
      type: "boolean",
      risk: "low",
    };
  }
  return null;
}

function validateWithDoc(doc: ConfigFieldDoc, value: unknown): FieldValidation {
  const messages: string[] = [];
  let level: FieldValidation["level"] = "ok";

  if (doc.type === "boolean") {
    if (boolFrom(value) == null) {
      level = "error";
      messages.push("Expected boolean value.");
    }
  } else if (doc.type === "number") {
    const n = numberFrom(value);
    if (n == null) {
      level = "error";
      messages.push("Expected numeric value.");
    } else {
      if (typeof doc.min === "number" && n < doc.min) {
        level = "warning";
        messages.push(`Below recommended minimum (${doc.min}).`);
      }
      if (typeof doc.max === "number" && n > doc.max) {
        level = "warning";
        messages.push(`Above recommended maximum (${doc.max}).`);
      }
    }
  } else if (doc.type === "enum") {
    const token = String(value ?? "").trim().toLowerCase();
    const allowed = (doc.allowed ?? []).map((v) => v.toLowerCase());
    if (!token || (allowed.length > 0 && !allowed.includes(token))) {
      level = "warning";
      messages.push(`Use one of: ${(doc.allowed ?? []).join(", ")}`);
    }
  } else if (doc.type === "string") {
    if (String(value ?? "").trim() === "") {
      level = "warning";
      messages.push("Value is empty.");
    }
  }

  if (messages.length === 0) {
    messages.push("Looks good.");
  }
  return { level, messages };
}

export function getConfigFieldDoc(filePath: string, fieldPath: string): ConfigFieldDoc | null {
  return docFor(filePath, fieldPath);
}

export function getConfigProfiles(filePath: string): ConfigProfile[] {
  const file = normalizeFile(filePath);
  if (!PROFILE_PATCHES[file]) return [];
  return [
    { id: "performance", label: "Performance", description: "Higher FPS, lighter visuals." },
    { id: "balanced", label: "Balanced", description: "Good visuals and stability." },
    { id: "quality", label: "Quality", description: "Best visuals, heavier settings." },
  ];
}

function parseKv(content: string, delimiter: ":" | "=") {
  const lines = String(content ?? "").split(/\r?\n/);
  const entries: Record<string, { lineIndex: number; rawValue: string }> = {};
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("!")) return;
    const idx = line.indexOf(delimiter);
    if (idx <= 0) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) return;
    entries[key] = { lineIndex, rawValue: value };
  });
  return { lines, entries };
}

function normalizeToDocValue(doc: ConfigFieldDoc, value: unknown) {
  if (doc.type === "boolean") {
    const bool = boolFrom(value);
    return bool == null ? doc.defaultValue ?? false : bool;
  }
  if (doc.type === "number") {
    let num = numberFrom(value);
    if (num == null) num = typeof doc.defaultValue === "number" ? doc.defaultValue : 0;
    if (typeof doc.min === "number" && num < doc.min) num = doc.min;
    if (typeof doc.max === "number" && num > doc.max) num = doc.max;
    return num;
  }
  if (doc.type === "enum") {
    const token = String(value ?? "").trim();
    const allowed = doc.allowed ?? [];
    if (allowed.length === 0) return token;
    const matched = allowed.find((v) => v.toLowerCase() === token.toLowerCase());
    return matched ?? doc.recommended ?? allowed[0];
  }
  return String(value ?? doc.defaultValue ?? "");
}

export function buildFieldValidationMap(filePath: string, content: string): Record<string, FieldValidation> {
  const file = normalizeFile(filePath);
  const map: Record<string, FieldValidation> = {};

  if (file.endsWith(".json")) {
    try {
      const parsed = JSON.parse(content);
      const walk = (node: any, path: Array<string | number>) => {
        if (node == null) return;
        if (Array.isArray(node)) {
          node.forEach((item, idx) => walk(item, [...path, idx]));
          return;
        }
        if (typeof node === "object") {
          for (const [key, val] of Object.entries(node)) {
            const nextPath = [...path, key];
            const pathText = pathToDot(nextPath);
            const doc = docFor(filePath, pathText);
            if (doc) map[pathText] = validateWithDoc(doc, val);
            walk(val, nextPath);
          }
        }
      };
      walk(parsed, []);

      for (const doc of DOCS.filter((entry) => normalizeFile(entry.file) === file)) {
        const value = getByDotPath(parsed, doc.path);
        if (value === undefined) {
          map[doc.path] = {
            level: "warning",
            messages: ["Missing field. Use Fix issues to add a safe default."],
          };
        }
      }
    } catch (err: any) {
      map.root = {
        level: "error",
        messages: [String(err?.message ?? err ?? "Invalid JSON")],
      };
    }
    return map;
  }

  if (file === "options.txt") {
    const parsed = parseKv(content, ":");
    for (const [key, entry] of Object.entries(parsed.entries)) {
      const doc = docFor(filePath, key);
      if (doc) {
        map[key] = validateWithDoc(doc, entry.rawValue);
      }
    }
    for (const doc of DOCS.filter((entry) => normalizeFile(entry.file) === file)) {
      if (!parsed.entries[doc.path]) {
        map[doc.path] = {
          level: "warning",
          messages: ["Missing key. Use Fix issues to add default."],
        };
      }
    }
    return map;
  }

  return map;
}

export function autoFixConfigContent(filePath: string, content: string): {
  changed: boolean;
  output: string;
  notes: string[];
  blockingError?: string;
} {
  const file = normalizeFile(filePath);
  const notes: string[] = [];

  if (file.endsWith(".json")) {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (err: any) {
      return {
        changed: false,
        output: content,
        notes: [],
        blockingError: String(err?.message ?? err ?? "Invalid JSON"),
      };
    }
    const docs = DOCS.filter((entry) => normalizeFile(entry.file) === file);
    let changed = false;
    for (const doc of docs) {
      const current = getByDotPath(parsed, doc.path);
      if (current === undefined) {
        if (doc.defaultValue !== undefined) {
          setByDotPath(parsed, doc.path, doc.defaultValue);
          notes.push(`Added missing ${doc.path}.`);
          changed = true;
        }
        continue;
      }
      const normalized = normalizeToDocValue(doc, current);
      if (JSON.stringify(normalized) !== JSON.stringify(current)) {
        setByDotPath(parsed, doc.path, normalized);
        notes.push(`Normalized ${doc.path}.`);
        changed = true;
      }
    }
    const output = JSON.stringify(parsed, null, 2);
    if (output !== content) changed = true;
    return {
      changed,
      output,
      notes,
    };
  }

  if (file === "options.txt") {
    const parsed = parseKv(content, ":");
    const docs = DOCS.filter((entry) => normalizeFile(entry.file) === file);
    let changed = false;
    for (const doc of docs) {
      const row = parsed.entries[doc.path];
      if (!row) {
        const defaultValue = normalizeToDocValue(doc, doc.defaultValue);
        parsed.lines.push(`${doc.path}:${String(defaultValue)}`);
        notes.push(`Added missing ${doc.path}.`);
        changed = true;
        continue;
      }
      const normalized = normalizeToDocValue(doc, row.rawValue);
      const nextLine = `${doc.path}:${String(normalized)}`;
      if (parsed.lines[row.lineIndex] !== nextLine) {
        parsed.lines[row.lineIndex] = nextLine;
        notes.push(`Normalized ${doc.path}.`);
        changed = true;
      }
    }
    return {
      changed,
      output: parsed.lines.join("\n"),
      notes,
    };
  }

  return {
    changed: false,
    output: content,
    notes: ["No safe auto-fixes defined for this file type yet."],
  };
}

export function applyConfigProfile(filePath: string, content: string, profileId: string): {
  changed: boolean;
  output: string;
  notes: string[];
  blockingError?: string;
} {
  const file = normalizeFile(filePath);
  const profile = PROFILE_PATCHES[file]?.[profileId];
  if (!profile) {
    return { changed: false, output: content, notes: ["No preset profile for this file."] };
  }

  if (file.endsWith(".json")) {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch (err: any) {
      return {
        changed: false,
        output: content,
        notes: [],
        blockingError: String(err?.message ?? err ?? "Invalid JSON"),
      };
    }
    let changed = false;
    const notes: string[] = [];
    for (const [path, nextValue] of Object.entries(profile)) {
      const current = getByDotPath(parsed, path);
      if (JSON.stringify(current) === JSON.stringify(nextValue)) continue;
      setByDotPath(parsed, path, nextValue);
      notes.push(`Set ${path}.`);
      changed = true;
    }
    return {
      changed,
      output: JSON.stringify(parsed, null, 2),
      notes,
    };
  }

  if (file === "options.txt") {
    const parsed = parseKv(content, ":");
    const notes: string[] = [];
    let changed = false;
    for (const [key, nextValue] of Object.entries(profile)) {
      const nextLine = `${key}:${String(nextValue)}`;
      const row = parsed.entries[key];
      if (!row) {
        parsed.lines.push(nextLine);
        notes.push(`Added ${key}.`);
        changed = true;
      } else if (parsed.lines[row.lineIndex] !== nextLine) {
        parsed.lines[row.lineIndex] = nextLine;
        notes.push(`Updated ${key}.`);
        changed = true;
      }
    }
    return {
      changed,
      output: parsed.lines.join("\n"),
      notes,
    };
  }

  return { changed: false, output: content, notes: ["No preset profile for this file."] };
}
