export type ConfigSuggestionKind = "key" | "value" | "keyword";

export type ConfigSuggestion = {
  value: string;
  label: string;
  kind: ConfigSuggestionKind;
  score: number;
  detail?: string;
};

export type ConfigSuggestionsContext = {
  filePath: string;
  content: string;
  cursorIndex: number;
  mode: "simple" | "advanced";
  siblingContents?: Array<{ path: string; content: string }>;
  limit?: number;
};

const JSON_KEYWORDS = ["true", "false", "null"];
const COMMON_MC_KEYS = [
  "renderDistance",
  "simulationDistance",
  "graphicsMode",
  "entityShadows",
  "fullscreen",
  "fov",
  "gamma",
  "maxFps",
  "resourcePacks",
  "soundDevice",
  "enableVsync",
  "particles",
  "mipmapLevels",
  "chunkUpdates",
  "biomeBlendRadius",
  "screenEffectScale",
  "sensitivity",
  "showSubtitles",
  "autoJump",
];
const COMMON_BOOL_VALUES = ["true", "false", "on", "off", "yes", "no"];
const COMMON_TOML_KEYS = [
  "enabled",
  "debug",
  "spawn_rate",
  "max_count",
  "difficulty",
  "allow_special_mobs",
  "ore_multiplier",
  "structure_weight",
];

function sanitizeToken(input: string) {
  return String(input ?? "").trim();
}

function currentTokenBounds(content: string, cursorIndex: number) {
  const safeIndex = Math.max(0, Math.min(cursorIndex, content.length));
  const isTokenChar = (ch: string) => /[A-Za-z0-9_.:\-]/.test(ch);
  let start = safeIndex;
  let end = safeIndex;
  while (start > 0 && isTokenChar(content[start - 1])) start -= 1;
  while (end < content.length && isTokenChar(content[end])) end += 1;
  return {
    start,
    end,
    token: content.slice(start, end),
  };
}

function detectFileKind(filePath: string) {
  const lower = String(filePath ?? "").toLowerCase();
  if (lower.endsWith(".json")) return "json" as const;
  if (lower.endsWith(".properties")) return "properties" as const;
  if (lower.endsWith(".toml")) return "toml" as const;
  if (lower.endsWith(".txt")) return "txt" as const;
  return "other" as const;
}

function collectLearnedTokens(content: string, fileKind: ReturnType<typeof detectFileKind>) {
  const out = new Set<string>();
  if (fileKind === "json") {
    const keyRegex = /"([A-Za-z0-9_.-]{2,})"\s*:/g;
    let match: RegExpExecArray | null;
    while ((match = keyRegex.exec(content)) !== null) {
      out.add(match[1]);
    }
  }
  const lineRegex = /^\s*([A-Za-z0-9_.-]{2,})\s*[:=]/gm;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRegex.exec(content)) !== null) {
    out.add(lineMatch[1]);
  }
  const wordRegex = /\b([A-Za-z_][A-Za-z0-9_.-]{2,})\b/g;
  let wordMatch: RegExpExecArray | null;
  while ((wordMatch = wordRegex.exec(content)) !== null) {
    if (out.size > 180) break;
    out.add(wordMatch[1]);
  }
  return [...out];
}

function collectDefaultTokens(fileKind: ReturnType<typeof detectFileKind>) {
  if (fileKind === "json") return [...JSON_KEYWORDS, ...COMMON_MC_KEYS];
  if (fileKind === "toml") return [...COMMON_TOML_KEYS, ...COMMON_BOOL_VALUES];
  if (fileKind === "properties") return [...COMMON_MC_KEYS, ...COMMON_BOOL_VALUES];
  if (fileKind === "txt") return [...COMMON_MC_KEYS, ...COMMON_BOOL_VALUES];
  return [];
}

function rankSuggestion(value: string, token: string, sourceWeight: number) {
  const lowerValue = value.toLowerCase();
  const lowerToken = token.toLowerCase();
  if (!lowerToken) return sourceWeight + Math.max(0, 40 - lowerValue.length * 0.2);
  if (lowerValue === lowerToken) return sourceWeight + 160;
  if (lowerValue.startsWith(lowerToken)) return sourceWeight + 120 - (lowerValue.length - lowerToken.length) * 0.3;
  if (lowerValue.includes(lowerToken)) return sourceWeight + 70;
  return sourceWeight + 10;
}

export function getSuggestions(context: ConfigSuggestionsContext): ConfigSuggestion[] {
  const content = String(context.content ?? "");
  const fileKind = detectFileKind(context.filePath);
  const bounds = currentTokenBounds(content, context.cursorIndex);
  const token = sanitizeToken(bounds.token);
  const limit = Math.max(4, Math.min(30, context.limit ?? 14));

  const pool = new Map<string, ConfigSuggestion>();
  const push = (value: string, kind: ConfigSuggestionKind, sourceWeight: number, detail?: string) => {
    const clean = sanitizeToken(value);
    if (!clean) return;
    const key = clean.toLowerCase();
    const score = rankSuggestion(clean, token, sourceWeight);
    const prev = pool.get(key);
    if (!prev || prev.score < score) {
      pool.set(key, {
        value: clean,
        label: clean,
        kind,
        score,
        detail,
      });
    }
  };

  for (const value of collectDefaultTokens(fileKind)) {
    const kind: ConfigSuggestionKind = JSON_KEYWORDS.includes(value) ? "keyword" : "key";
    push(value, kind, 68, "default");
  }

  for (const value of collectLearnedTokens(content, fileKind)) {
    push(value, "key", 92, "current file");
  }

  for (const sibling of context.siblingContents ?? []) {
    if (!sibling || !sibling.content) continue;
    const siblingKind = detectFileKind(sibling.path);
    for (const value of collectLearnedTokens(sibling.content, siblingKind).slice(0, 80)) {
      push(value, "key", 54, "related file");
    }
  }

  if (fileKind !== "json") {
    for (const value of COMMON_BOOL_VALUES) {
      push(value, "value", 80, "common value");
    }
  }

  const suggestions = [...pool.values()]
    .filter((item) => {
      if (!token) return true;
      const lowerValue = item.value.toLowerCase();
      const lowerToken = token.toLowerCase();
      return lowerValue.startsWith(lowerToken) || lowerValue.includes(lowerToken);
    })
    .sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
    .slice(0, limit);

  return suggestions;
}

export function applySuggestionAtCursor(args: {
  content: string;
  cursorIndex: number;
  value: string;
}) {
  const content = String(args.content ?? "");
  const value = String(args.value ?? "");
  const bounds = currentTokenBounds(content, args.cursorIndex);
  const next = `${content.slice(0, bounds.start)}${value}${content.slice(bounds.end)}`;
  const nextCursor = bounds.start + value.length;
  return {
    content: next,
    cursor: nextCursor,
    replacedToken: bounds.token,
  };
}
