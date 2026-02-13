export type LogSeverity = "error" | "warn" | "info" | "debug" | "trace";

export type CrashSuspect = {
  id: string;
  label: string;
  matches: number;
  confidence: number;
  signals: string[];
};

export type LogLikelyCause = {
  id: string;
  title: string;
  confidence: number;
  reason: string;
  fixes: string[];
};

export type FailedMod = {
  id: string;
  label: string;
  reason: string;
  confidence: number;
};

export type LogAnalyzeResult = {
  analysisVersion?: "2";
  totalLines: number;
  errorCount: number;
  warnCount: number;
  infoCount: number;
  debugCount: number;
  traceCount: number;
  suspects: CrashSuspect[];
  keyErrors: string[];
  likelyCauses: LogLikelyCause[];
  failedMods: FailedMod[];
  evidenceByCause?: Record<string, string[]>;
  confidenceNotes?: string[];
};

type AnalyzeInputLine = {
  message: string;
  severity?: LogSeverity;
  source?: string;
  lineNo?: number | null;
  timestamp?: string | null;
};

type ParsedLine = {
  index: number;
  message: string;
  lower: string;
  severity: LogSeverity;
  source: string;
  lineNo: number | null;
  timestamp: string | null;
  thread: string | null;
  logger: string | null;
  inStackTrace: boolean;
};

type CauseRule = {
  id: string;
  title: string;
  patterns: RegExp[];
  weight: number;
  fixes: string[];
};

type ScoredCause = {
  id: string;
  title: string;
  score: number;
  reason: string;
  fixes: string[];
  evidence: string[];
};

const SUSPECT_BLOCKED = new Set([
  "minecraft",
  "java",
  "client",
  "server",
  "mixin",
  "thread",
  "launch",
  "error",
  "warn",
  "debug",
  "trace",
  "info",
  "render",
  "fabric",
  "forge",
  "quilt",
  "neoforge",
  "net",
  "com",
  "org",
]);

const SUSPECT_ALIAS_GROUPS: Array<{ canonical: string; tokens: string[] }> = [
  { canonical: "sodium", tokens: ["sodium", "rubidium", "embeddium", "magnesium", "chlorine"] },
  { canonical: "iris", tokens: ["iris", "oculus"] },
  { canonical: "architectury", tokens: ["architectury", "architectury_api"] },
  { canonical: "cloth_config", tokens: ["cloth_config", "clothconfig"] },
  { canonical: "forge_config_api_port", tokens: ["forge_config_api_port", "forgeconfigapiport"] },
];

const CAUSE_RULES: CauseRule[] = [
  {
    id: "mixin_failure",
    title: "Mixin apply or injection failure",
    patterns: [/mixinapplyerror/i, /mixin.*(?:failed|error|exception|target)/i, /org\.spongepowered\.asm/i],
    weight: 9,
    fixes: [
      "Update or remove the mod named in the first mixin error.",
      "Check for duplicate rendering/performance mods.",
      "Match every mod to the exact loader and Minecraft version.",
    ],
  },
  {
    id: "missing_mixin_target",
    title: "Mixin target missing (incompatible dependency)",
    patterns: [/invalidinjectorexception/i, /could not find target method/i, /target class .* was not found/i],
    weight: 8,
    fixes: [
      "Update the target mod and its addon mods together.",
      "Remove addons built for older API versions.",
      "Verify the loader family for every jar.",
    ],
  },
  {
    id: "missing_class_or_method",
    title: "Missing class or method dependency",
    patterns: [/noclassdeffounderror/i, /classnotfoundexception/i, /nosuchmethoderror/i, /nosuchfielderror/i],
    weight: 9,
    fixes: [
      "Install the required dependency mod or matching API library.",
      "Update dependent mods as a compatible set.",
      "Remove stale jars from old pack versions.",
    ],
  },
  {
    id: "dependency_mismatch",
    title: "Dependency version mismatch",
    patterns: [/requires .* but .* is present/i, /depends on .* versions?/i, /missing mandatory dependency/i],
    weight: 8,
    fixes: [
      "Install the dependency version requested by the failing mod.",
      "Use one modpack version set instead of mixed versions.",
    ],
  },
  {
    id: "wrong_loader",
    title: "Wrong loader or wrong side mod",
    patterns: [/mod .* requires .* (fabric|forge|quilt|neoforge)/i, /not a valid mod file/i, /wrong side/i],
    weight: 8,
    fixes: [
      "Use the correct Fabric/Forge/Quilt/NeoForge build.",
      "Remove client-only mods from server contexts (and vice versa).",
    ],
  },
  {
    id: "duplicate_mods",
    title: "Duplicate or conflicting mod jars",
    patterns: [/duplicate mod/i, /already present/i, /found conflicting files/i, /re-registered/i],
    weight: 7,
    fixes: [
      "Keep only one jar per mod.",
      "Delete old jars with version suffixes that overlap.",
    ],
  },
  {
    id: "mod_metadata_mismatch",
    title: "Invalid mod metadata",
    patterns: [/invalid mod metadata/i, /mod metadata parsing failed/i, /mods\.toml/i, /fabric\.mod\.json/i],
    weight: 7,
    fixes: [
      "Replace the broken jar with a fresh download.",
      "Check loader metadata format support for this version.",
    ],
  },
  {
    id: "service_loader_failure",
    title: "Service loader initialization failure",
    patterns: [/serviceconfigurationerror/i, /failed to load service/i, /spi/i],
    weight: 6,
    fixes: [
      "Update mods that register Java services.",
      "Remove duplicate core libraries bundled by multiple mods.",
    ],
  },
  {
    id: "config_parse_error",
    title: "Config parsing or validation failed",
    patterns: [/parse.*config/i, /invalid config/i, /toml.*error/i, /json.*error/i, /properties.*error/i],
    weight: 8,
    fixes: [
      "Fix or reset the referenced config file.",
      "Use Config Editor formatting and validation before launching again.",
    ],
  },
  {
    id: "access_transformer_failure",
    title: "Access transformer / class transform failure",
    patterns: [/accesstransformer/i, /transformer.*failed/i, /failed to transform class/i],
    weight: 7,
    fixes: [
      "Update loader and core mods together.",
      "Remove recently added coremods and retry.",
    ],
  },
  {
    id: "java_mismatch",
    title: "Java runtime mismatch",
    patterns: [/unsupportedclassversionerror/i, /needs java/i, /class file version/i, /java \d+ detected/i],
    weight: 10,
    fixes: [
      "Switch the instance Java path to the required version.",
      "For modern packs, use Java 17 or 21 when requested.",
    ],
  },
  {
    id: "memory_oom",
    title: "Out of memory",
    patterns: [/outofmemoryerror/i, /java heap space/i, /gc overhead limit exceeded/i, /unable to allocate/i],
    weight: 9,
    fixes: [
      "Increase memory allocation for the instance.",
      "Disable heavy shaders/resource packs and retry.",
    ],
  },
  {
    id: "shader_render_conflict",
    title: "Render or shader stack conflict",
    patterns: [/opengl/i, /shader/i, /iris/i, /oculus/i, /embeddium|sodium|rubidium/i, /rendering overlay/i],
    weight: 6,
    fixes: [
      "Disable shaders and test vanilla rendering first.",
      "Use known-compatible versions of render mods together.",
    ],
  },
  {
    id: "native_crash",
    title: "Native JVM or driver crash",
    patterns: [/sigsegv/i, /fatal error has been detected by the java runtime environment/i, /exit code -1/i],
    weight: 8,
    fixes: [
      "Update GPU drivers and Java runtime.",
      "Isolate recently added native-heavy mods.",
    ],
  },
];

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function toConfidence(score: number) {
  const normalized = 0.14 + Math.log10(1 + Math.max(0, score)) * 0.34;
  return Math.round(clamp01(normalized) * 100) / 100;
}

function severityWeight(severity: LogSeverity) {
  if (severity === "error") return 2.35;
  if (severity === "warn") return 1.2;
  if (severity === "debug") return 0.74;
  if (severity === "trace") return 0.6;
  return 0.94;
}

function normalizeModToken(raw: string) {
  const normalized = String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/\.jar$/i, "")
    .replace(/[-_]?mc\d[\w.-]*/i, "")
    .replace(/[-_]\d+(?:\.\d+){1,4}.*/i, "")
    .replace(/[^a-z0-9._-]/g, "");
  if (!normalized || normalized.length < 2 || SUSPECT_BLOCKED.has(normalized)) return "";
  for (const group of SUSPECT_ALIAS_GROUPS) {
    if (group.tokens.includes(normalized)) return group.canonical;
  }
  return normalized;
}

function modLabel(id: string) {
  return id
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function normalizeLineForDedupe(message: string) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[0-9a-f]{16,}/g, "<hex>")
    .replace(/\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}:\d{2}/g, "<ts>")
    .trim();
}

function parseThreadAndLogger(message: string) {
  const line = String(message ?? "").trim();
  const bracket = line.match(/^\[([^\]]+)\]\s*\[([^\]/]+)\/([^\]]+)\]/);
  if (bracket) {
    return {
      thread: bracket[2]?.trim() || null,
      logger: bracket[1]?.trim() || null,
    };
  }
  const loggerPrefix = line.match(/^([a-z0-9._$-]+):\s/i);
  if (loggerPrefix) {
    return {
      thread: null,
      logger: loggerPrefix[1],
    };
  }
  return { thread: null, logger: null };
}

function isStackTraceLine(message: string) {
  return /^\s*at\s+[\w$_.]+\([^)]*\)/.test(message) || /^\s*\.\.\.\s*\d+\s*more/.test(message);
}

function buildExceptionAnchors(lines: ParsedLine[]) {
  const anchors = new Set<number>();
  let openUntil = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const msg = lines[i].message;
    const lower = lines[i].lower;
    const starts =
      /exception in thread/i.test(msg) ||
      /^caused by:/i.test(msg) ||
      /\bfatal\b/i.test(lower) ||
      /\bmod loading has failed\b/i.test(lower);
    if (starts) {
      anchors.add(i);
      openUntil = Math.max(openUntil, i + 12);
    }
    if (isStackTraceLine(msg) || /^\s*caused by:/i.test(msg)) {
      anchors.add(i);
      openUntil = Math.max(openUntil, i + 8);
    }
    if (i <= openUntil) {
      anchors.add(i);
    }
  }
  return anchors;
}

function firstFatalIndex(lines: ParsedLine[]) {
  for (const line of lines) {
    if (/\b(caused by|exception|fatal|mod loading has failed|crash report)\b/i.test(line.message)) {
      return line.index;
    }
  }
  return null;
}

function causalBoost(index: number, anchors: Set<number>, firstFatal: number | null) {
  let boost = anchors.has(index) ? 1.45 : 1;
  if (firstFatal != null) {
    const delta = Math.abs(index - firstFatal);
    if (delta <= 16) boost *= 1.25;
    else if (delta <= 50) boost *= 1.1;
  }
  return boost;
}

function boilerplatePenalty(lower: string) {
  if (
    /\b(starting|loading|loaded|found|using|detected|launching|progress|handshake|auth)\b/.test(lower) &&
    !/\b(error|warn|failed|exception|fatal|caused by|missing)\b/.test(lower)
  ) {
    return 0.65;
  }
  if (/\b(stacktrace omitted|suppressed|continuing)\b/.test(lower)) {
    return 0.7;
  }
  return 1;
}

export function inferLogSeverity(message: string): LogSeverity {
  const lower = String(message ?? "").toLowerCase();
  if (
    /\bfatal\b/.test(lower) ||
    /\berror\b/.test(lower) ||
    /\bexception\b/.test(lower) ||
    /\bcrash(?:ed)?\b/.test(lower)
  ) {
    return "error";
  }
  if (/\bwarn(?:ing)?\b/.test(lower)) return "warn";
  if (/\bdebug\b/.test(lower)) return "debug";
  if (/\btrace\b/.test(lower)) return "trace";
  return "info";
}

export function extractLogTimestamp(message: string): string | null {
  const line = String(message ?? "").trim();
  if (!line) return null;
  const bracket = line.match(/^\[([^\]]{4,48})\]/);
  if (bracket?.[1]) return bracket[1].trim();
  const isoLike = line.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
  if (isoLike?.[1]) return isoLike[1];
  return null;
}

function parseLines(input: AnalyzeInputLine[]) {
  return input
    .map((line, index) => {
      const message = String(line.message ?? "").replace(/\u0000/g, "").trimEnd();
      const lower = message.toLowerCase();
      const parsed = parseThreadAndLogger(message);
      const rawLineNo = Number(line.lineNo ?? NaN);
      return {
        index,
        message,
        lower,
        severity: line.severity ?? inferLogSeverity(message),
        source: String(line.source ?? "live") || "live",
        lineNo: Number.isFinite(rawLineNo) && rawLineNo > 0 ? Math.floor(rawLineNo) : null,
        timestamp: line.timestamp ?? extractLogTimestamp(message),
        thread: parsed.thread,
        logger: parsed.logger,
        inStackTrace: isStackTraceLine(message),
      } as ParsedLine;
    })
    .filter((line) => line.message.length > 0);
}

function collectCauseScores(lines: ParsedLine[]) {
  const anchors = buildExceptionAnchors(lines);
  const firstFatal = firstFatalIndex(lines);
  const lineRepeatCount = new Map<string, number>();
  for (const line of lines) {
    const key = normalizeLineForDedupe(line.message);
    lineRepeatCount.set(key, (lineRepeatCount.get(key) ?? 0) + 1);
  }

  const scores = new Map<string, ScoredCause>();
  for (const line of lines) {
    const repeatKey = normalizeLineForDedupe(line.message);
    const repeatCount = lineRepeatCount.get(repeatKey) ?? 1;
    const dedupePenalty = 1 / Math.sqrt(Math.max(1, repeatCount));
    const severity = severityWeight(line.severity);
    const proximity = causalBoost(line.index, anchors, firstFatal);
    const boilerplate = boilerplatePenalty(line.lower);

    for (const rule of CAUSE_RULES) {
      if (!rule.patterns.some((pattern) => pattern.test(line.message))) continue;
      const entry = scores.get(rule.id) ?? {
        id: rule.id,
        title: rule.title,
        score: 0,
        reason: line.message.trim(),
        fixes: rule.fixes,
        evidence: [],
      };
      const lineScore = rule.weight * severity * proximity * dedupePenalty * boilerplate;
      entry.score += lineScore;
      if (entry.evidence.length < 4 && !entry.evidence.includes(line.message.trim())) {
        entry.evidence.push(line.message.trim());
      }
      if (
        /\b(caused by|exception|fatal|failed|missing|could not)\b/i.test(line.message) ||
        line.severity === "error"
      ) {
        entry.reason = line.message.trim();
      }
      scores.set(rule.id, entry);
    }
  }
  return scores;
}

function collectLikelyCauses(lines: ParsedLine[]) {
  const scores = collectCauseScores(lines);
  const sorted = [...scores.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 6);
  const likelyCauses: LogLikelyCause[] = sorted.map((item) => ({
    id: item.id,
    title: item.title,
    confidence: toConfidence(item.score),
    reason: item.reason,
    fixes: item.fixes,
  }));
  const evidenceByCause: Record<string, string[]> = {};
  for (const item of sorted) {
    evidenceByCause[item.id] = item.evidence.slice(0, 3);
  }
  return { likelyCauses, evidenceByCause };
}

export function detectCrashSuspectsFromMessages(input: AnalyzeInputLine[]): CrashSuspect[] {
  const parsed = parseLines(input);
  const anchors = buildExceptionAnchors(parsed);
  const firstFatal = firstFatalIndex(parsed);
  const suspectMap = new Map<string, { matches: number; score: number; signals: string[] }>();

  const tokenPatterns = [
    /\b([a-z0-9._-]{2,})\.jar\b/gi,
    /\bmod(?:id)?\s*[:=]\s*([a-z0-9._-]{2,})\b/gi,
    /\bfrom mod\s+([a-z0-9._-]{2,})\b/gi,
    /\bloading\s+([a-z0-9._-]{2,})\s+failed\b/gi,
    /\bmod\s+([a-z0-9._-]{2,})\s+has\s+failed\b/gi,
    /\b([a-z0-9_.-]{3,})\.mixins?\.json\b/gi,
    /\bat\s+([a-z0-9_.-]{3,})\.[a-z0-9_$]+\(/gi,
  ];

  for (const line of parsed) {
    const severity = severityWeight(line.severity);
    const failBoost = /\b(failed|crash|fatal|exception|caused by|could not|missing|invalid)\b/.test(line.lower)
      ? 1.36
      : 0.78;
    const proximity = causalBoost(line.index, anchors, firstFatal);

    for (const regex of tokenPatterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line.lower)) !== null) {
        const token = normalizeModToken(match[1] ?? "");
        if (!token) continue;
        const prev = suspectMap.get(token) ?? { matches: 0, score: 0, signals: [] };
        prev.matches += 1;
        prev.score += severity * failBoost * proximity;
        if (prev.signals.length < 3 && !prev.signals.includes(line.message.trim())) {
          prev.signals.push(line.message.trim());
        }
        suspectMap.set(token, prev);
      }
    }
  }

  return [...suspectMap.entries()]
    .map(([id, value]) => ({
      id,
      label: modLabel(id),
      matches: value.matches,
      confidence: toConfidence(value.score),
      signals: value.signals,
    }))
    .sort((a, b) => b.confidence - a.confidence || b.matches - a.matches || a.label.localeCompare(b.label))
    .slice(0, 12);
}

function collectFailedMods(lines: ParsedLine[]) {
  const anchors = buildExceptionAnchors(lines);
  const firstFatal = firstFatalIndex(lines);
  const map = new Map<string, { reason: string; score: number }>();
  const patterns = [
    /\bmod file\s+([a-z0-9._-]{2,}\.jar)\s+failed\b/i,
    /\bloading\s+([a-z0-9._-]{2,})\s+failed\b/i,
    /\bfrom mod\s+([a-z0-9._-]{2,})\b/i,
    /\bmod(?:id)?\s*[:=]\s*([a-z0-9._-]{2,})\b/i,
    /\bmod\s+([a-z0-9._-]{2,})\s+has\s+failed\b/i,
  ];

  for (const line of lines) {
    if (!/\b(fail|error|exception|crash|missing|could not|invalid)\b/.test(line.lower)) continue;
    const proximity = causalBoost(line.index, anchors, firstFatal);
    for (const pattern of patterns) {
      const match = line.lower.match(pattern);
      if (!match?.[1]) continue;
      const id = normalizeModToken(match[1]);
      if (!id) continue;
      const score = severityWeight(line.severity) * 2.15 * proximity;
      const prev = map.get(id);
      if (!prev || prev.score < score) {
        map.set(id, { reason: line.message.trim(), score });
      }
    }
  }

  return [...map.entries()]
    .map(([id, value]) => ({
      id,
      label: modLabel(id),
      reason: value.reason,
      confidence: toConfidence(value.score),
    }))
    .sort((a, b) => b.confidence - a.confidence || a.label.localeCompare(b.label))
    .slice(0, 10);
}

function summarizeCounts(lines: ParsedLine[]) {
  return {
    errorCount: lines.filter((line) => line.severity === "error").length,
    warnCount: lines.filter((line) => line.severity === "warn").length,
    infoCount: lines.filter((line) => line.severity === "info").length,
    debugCount: lines.filter((line) => line.severity === "debug").length,
    traceCount: lines.filter((line) => line.severity === "trace").length,
  };
}

function collectKeyErrors(lines: ParsedLine[]) {
  const anchors = buildExceptionAnchors(lines);
  const firstFatal = firstFatalIndex(lines);
  const sorted = [...lines]
    .filter(
      (line) =>
        line.severity === "error" ||
        /\b(exception|fatal|failed|crash|caused by|could not|missing|invalid)\b/i.test(line.message)
    )
    .sort((a, b) => {
      const aw = severityWeight(a.severity) * causalBoost(a.index, anchors, firstFatal);
      const bw = severityWeight(b.severity) * causalBoost(b.index, anchors, firstFatal);
      if (aw !== bw) return bw - aw;
      return a.index - b.index;
    });

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const line of sorted) {
    const text = line.message.trim();
    if (!text) continue;
    const dedupe = normalizeLineForDedupe(text);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    unique.push(text);
    if (unique.length >= 10) break;
  }
  return unique;
}

function buildConfidenceNotes(result: {
  likelyCauses: LogLikelyCause[];
  suspects: CrashSuspect[];
  failedMods: FailedMod[];
}) {
  const notes: string[] = [];
  const topCause = result.likelyCauses[0];
  if (topCause) {
    notes.push(`Top cause: ${topCause.title} (${Math.round(topCause.confidence * 100)}%)`);
  }
  const topSuspect = result.suspects[0];
  if (topSuspect) {
    notes.push(`Top suspect: ${topSuspect.label} (${topSuspect.matches} signals)`);
  }
  if (result.failedMods.length > 0) {
    notes.push(`Detected ${result.failedMods.length} failed mod candidate${result.failedMods.length === 1 ? "" : "s"}.`);
  }
  return notes;
}

export function analyzeLogLines(input: AnalyzeInputLine[]): LogAnalyzeResult {
  const parsed = parseLines(input);
  const counts = summarizeCounts(parsed);
  const { likelyCauses, evidenceByCause } = collectLikelyCauses(parsed);
  const suspects = detectCrashSuspectsFromMessages(
    parsed.map((line) => ({
      message: line.message,
      severity: line.severity,
      source: line.source,
      lineNo: line.lineNo,
      timestamp: line.timestamp,
    }))
  );
  const failedMods = collectFailedMods(parsed);
  const confidenceNotes = buildConfidenceNotes({ likelyCauses, suspects, failedMods });

  return {
    analysisVersion: "2",
    totalLines: parsed.length,
    ...counts,
    suspects,
    keyErrors: collectKeyErrors(parsed),
    likelyCauses,
    failedMods,
    evidenceByCause,
    confidenceNotes,
  };
}

export function analyzeLogText(input: string): LogAnalyzeResult {
  const lines = String(input ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return analyzeLogLines(lines.map((line) => ({ message: line })));
}
