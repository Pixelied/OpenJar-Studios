export const CONFIG_STORAGE_KEY = "modpack.instanceConfigs.v1";
export const SERVERS_DAT_PATH = "servers.dat";

export type ConfigFileRecord = {
  content: string;
  updatedAt: number;
  draft?: string;
  draftUpdatedAt?: number;
};

export type InstanceConfigStore = Record<string, Record<string, ConfigFileRecord>>;

export type JsonPath = Array<string | number>;

export type JsonParseIssue = {
  message: string;
  position?: number;
  line?: number;
  column?: number;
};

export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: JsonParseIssue };

const DEFAULT_CONFIG_FILES: Record<string, string> = {
  "options.txt": [
    "gamma:1.0",
    "fov:0",
    "renderDistance:16",
    "simulationDistance:12",
    "graphicsMode:fancy",
    "entityShadows:true",
    "fullscreen:false",
  ].join("\n"),
  "servers.dat": JSON.stringify(
    {
      servers: [],
    },
    null,
    2
  ),
  "config/modpack.json": JSON.stringify(
    {
      profile: {
        name: "Custom Modpack",
        channel: "stable",
        autoJoinServer: false,
      },
      graphics: {
        preset: "balanced",
        shadows: true,
        particles: "all",
      },
      performance: {
        chunkUpdates: 3,
        asyncIO: true,
      },
    },
    null,
    2
  ),
  "config/examplemod.json": JSON.stringify(
    {
      enabled: true,
      difficultyMultiplier: 1,
      uiScale: 1,
      features: {
        gadgets: true,
        particles: true,
      },
    },
    null,
    2
  ),
  "config/examplemod.toml": [
    "enabled = true",
    "spawn_rate = 0.55",
    "allow_special_mobs = true",
    "",
    "[worldgen]",
    "ore_multiplier = 1.0",
    "structure_weight = 24",
  ].join("\n"),
  "config/examplemod.properties": [
    "enabled=true",
    "max-mob-count=80",
    "spawn-radius=12",
    "enable-extra-drops=false",
  ].join("\n"),
};

export function readConfigStore(): InstanceConfigStore {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const normalized: InstanceConfigStore = {};
    for (const [instanceId, files] of Object.entries(parsed as Record<string, any>)) {
      if (!instanceId || !files || typeof files !== "object") continue;
      const outFiles: Record<string, ConfigFileRecord> = {};
      for (const [filePath, file] of Object.entries(files as Record<string, any>)) {
        if (!filePath || !file || typeof file !== "object") continue;
        const content = String((file as any).content ?? "");
        const updatedAt = Number((file as any).updatedAt ?? Date.now());
        const draft =
          typeof (file as any).draft === "string" ? String((file as any).draft) : undefined;
        const draftUpdatedAt = Number((file as any).draftUpdatedAt ?? Date.now());
        outFiles[filePath] = {
          content,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
          draft,
          draftUpdatedAt: draft ? (Number.isFinite(draftUpdatedAt) ? draftUpdatedAt : Date.now()) : undefined,
        };
      }
      normalized[instanceId] = outFiles;
    }
    return normalized;
  } catch {
    return {};
  }
}

export function writeConfigStore(store: InstanceConfigStore) {
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(store));
}

export function seedDefaultsForInstance(
  store: InstanceConfigStore,
  instanceId: string
): InstanceConfigStore {
  if (!instanceId) return store;
  const existing = store[instanceId];
  if (existing && Object.keys(existing).length > 0) return store;
  const now = Date.now();
  const seeded: Record<string, ConfigFileRecord> = {};
  for (const [path, content] of Object.entries(DEFAULT_CONFIG_FILES)) {
    seeded[path] = {
      content,
      updatedAt: now,
    };
  }
  return {
    ...store,
    [instanceId]: seeded,
  };
}

export function isJsonFilePath(filePath: string): boolean {
  return String(filePath).trim().toLowerCase().endsWith(".json");
}

export function fileGroupForPath(filePath: string): "Minecraft" | "Loader" | "Mods" {
  const path = String(filePath).trim().toLowerCase();
  if (path === "options.txt" || path === "servers.dat") return "Minecraft";
  if (path === "config/modpack.json") return "Loader";
  return "Mods";
}

export function fileTypeForPath(filePath: string): string {
  const path = String(filePath).trim().toLowerCase();
  if (path.endsWith(".json")) return "JSON";
  if (path.endsWith(".toml")) return "TOML";
  if (path.endsWith(".properties")) return "PROPS";
  if (path.endsWith(".txt")) return "TXT";
  if (path.endsWith(".dat")) return "DAT";
  return "FILE";
}

export function normalizeNewJsonFilePath(input: string): string {
  let next = String(input ?? "").trim().replace(/^\/+/, "");
  if (!next) return "";
  if (!next.toLowerCase().endsWith(".json")) return "";
  if (!next.includes("/")) {
    next = `config/${next}`;
  }
  return next;
}

export function getEffectiveFileContent(record: ConfigFileRecord | undefined): string {
  if (!record) return "";
  return typeof record.draft === "string" ? record.draft : record.content;
}

export function hasUnsavedDraft(record: ConfigFileRecord | undefined): boolean {
  if (!record) return false;
  return typeof record.draft === "string" && record.draft !== record.content;
}

export function parseJsonWithError(input: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (err: any) {
    const message = String(err?.message ?? err ?? "Invalid JSON");
    const position = extractErrorPosition(message);
    if (typeof position === "number" && Number.isFinite(position)) {
      const loc = positionToLineColumn(input, position);
      return {
        ok: false,
        error: {
          message,
          position,
          line: loc.line,
          column: loc.column,
        },
      };
    }
    return {
      ok: false,
      error: {
        message,
      },
    };
  }
}

function extractErrorPosition(message: string): number | null {
  const lower = message.toLowerCase();
  const posMatch = lower.match(/position\s+(\d+)/);
  if (posMatch && posMatch[1]) {
    const value = Number(posMatch[1]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function positionToLineColumn(text: string, position: number) {
  const safePos = Math.max(0, Math.min(position, text.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < safePos; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

export function describePath(path: JsonPath | null | undefined): string {
  if (!path || path.length === 0) return "root";
  return path
    .map((part, idx) => {
      if (typeof part === "number") return `[${part}]`;
      if (idx === 0) return part;
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? `.${part}` : `["${part}"]`;
    })
    .join("");
}

export function getAtPath(root: unknown, path: JsonPath): unknown {
  let current: any = root;
  for (const part of path) {
    if (current == null) return undefined;
    current = current[part as any];
  }
  return current;
}

export function setAtPath(root: unknown, path: JsonPath, nextValue: unknown): unknown {
  if (path.length === 0) return deepClone(nextValue);
  const cloneRoot = deepClone(root);
  let current: any = cloneRoot;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (current[key as any] == null || typeof current[key as any] !== "object") {
      current[key as any] = typeof nextKey === "number" ? [] : {};
    }
    current = current[key as any];
  }
  current[path[path.length - 1] as any] = deepClone(nextValue);
  return cloneRoot;
}

export function deleteAtPath(root: unknown, path: JsonPath): unknown {
  if (path.length === 0) return deepClone(root);
  const cloneRoot = deepClone(root);
  let current: any = cloneRoot;
  for (let i = 0; i < path.length - 1; i += 1) {
    current = current?.[path[i] as any];
    if (current == null || typeof current !== "object") return cloneRoot;
  }
  const key = path[path.length - 1];
  if (Array.isArray(current) && typeof key === "number") {
    current.splice(key, 1);
  } else if (current && typeof current === "object") {
    delete current[key as any];
  }
  return cloneRoot;
}

export function moveArrayItem(root: unknown, path: JsonPath, fromIdx: number, toIdx: number): unknown {
  const cloneRoot = deepClone(root);
  const arr = getAtPath(cloneRoot, path);
  if (!Array.isArray(arr)) return cloneRoot;
  if (fromIdx < 0 || fromIdx >= arr.length || toIdx < 0 || toIdx >= arr.length) return cloneRoot;
  const [item] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, item);
  return cloneRoot;
}

export function deepClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

export function valueKind(value: unknown): "string" | "number" | "boolean" | "array" | "object" | "null" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}

export function asPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
