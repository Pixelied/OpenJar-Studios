import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/api/dialog";
import { open as shellOpen } from "@tauri-apps/api/shell";
import { convertFileSrc } from "@tauri-apps/api/tauri";
import type {
  AccountDiagnostics,
  CreateInstanceFromModpackFileResult,
  CreatorPreset,
  CreatorPresetEntry,
  CreatorPresetSettings,
  CurseforgeApiStatus,
  CurseforgeProjectDetail,
  DiscoverContentType,
  DiscoverSearchHit,
  DiscoverSource,
  InstanceWorld,
  LaunchMethod,
  LauncherAccount,
  LauncherImportSource,
  LauncherSettings,
  PresetApplyPreview,
  PresetApplyResult,
  ReadInstanceLogsLine,
  ReadInstanceLogsResult,
  RollbackResult,
  WorldRollbackResult,
  ImportInstanceFromLauncherResult,
  InstanceLogSourceApi,
  RunningInstance,
  BeginMicrosoftLoginResult,
  MicrosoftLoginState,
  InstallPlanPreview,
  Instance,
  InstanceSettings,
  InstallProgressEvent,
  InstalledMod,
  JavaRuntimeCandidate,
  LaunchResult,
  Loader,
  ModUpdateCheckResult,
  SnapshotMeta,
} from "./types";
import {
  beginMicrosoftLogin,
  cancelInstanceLaunch,
  checkModrinthUpdates,
  createInstance,
  createInstanceFromModpackFile,
  deleteInstance,
  exportPresetsJson,
  exportInstanceModsZip,
  getCurseforgeApiStatus,
  getCurseforgeProjectDetail,
  getSelectedAccountDiagnostics,
  getLauncherSettings,
  importPresetsJson,
  importLocalModFile,
  importInstanceFromLauncher,
  installCurseforgeMod,
  installDiscoverContent,
  installModrinthMod,
  importProviderModpackTemplate,
  previewPresetApply,
  applyPresetToInstance,
  launchInstance,
  listInstanceWorlds,
  listInstanceSnapshots,
  listLauncherAccounts,
  listLauncherImportSources,
  listRunningInstances,
  listInstalledMods,
  listInstances,
  logoutMicrosoftAccount,
  rollbackInstance,
  rollbackInstanceWorldBackup,
  pollMicrosoftLogin,
  previewModrinthInstall,
  readInstanceLogs,
  readLocalImageDataUrl,
  openInstancePath,
  searchDiscoverContent,
  selectLauncherAccount,
  setLauncherSettings,
  setInstanceIcon,
  setInstalledModEnabled,
  stopRunningInstance,
  detectJavaRuntimes,
  updateAllModrinthMods,
  updateInstance,
} from "./tauri";
import {
  getProject,
  getProjectMembers,
  getProjectVersions,
  type ModrinthIndex,
  type Project,
  type ProjectMember,
  type ProjectVersion,
} from "./modrinth";
import { IdleAnimation, NameTagObject, SkinViewer } from "skinview3d";
import ModpacksConfigEditor from "./pages/ModpacksConfigEditor";
import {
  analyzeLogLines,
  analyzeLogText,
  detectCrashSuspectsFromMessages,
  extractLogTimestamp,
  inferLogSeverity,
  type CrashSuspect,
  type LogAnalyzeResult,
  type LogSeverity,
} from "./lib/logAnalysis";

type Route = "discover" | "modpacks" | "library" | "updates" | "skins" | "instance" | "account" | "settings";
type AccentPreset = "neutral" | "blue" | "emerald" | "amber" | "rose" | "violet" | "teal";
type AccentStrength = "subtle" | "normal" | "vivid" | "max";
type MotionPreset = "calm" | "standard" | "expressive";
type DensityPreset = "comfortable" | "compact";
type ProjectDetailTab = "overview" | "versions" | "changelog";
type CurseforgeDetailTab = "overview" | "files" | "changelog";
type SchedulerCadence =
  | "off"
  | "hourly"
  | "every_3_hours"
  | "every_6_hours"
  | "every_12_hours"
  | "daily"
  | "weekly";
type SchedulerAutoApplyMode = "never" | "opt_in_instances" | "all_instances";
type SchedulerApplyScope = "scheduled_only" | "scheduled_and_manual";

type VersionItem = {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha" | string;
  release_time?: string;
};

type InstallTarget = {
  source: DiscoverSource;
  projectId: string;
  title: string;
  contentType: DiscoverContentType;
  targetWorlds?: string[];
  iconUrl?: string | null;
  description?: string | null;
};

type InstanceLaunchStateEvent = {
  instance_id: string;
  launch_id?: string | null;
  method?: string | null;
  status?: string | null;
  message?: string | null;
};

type LaunchHealthChecks = {
  auth: boolean;
  assets: boolean;
  libraries: boolean;
  starting_java: boolean;
};

type LaunchHealthRecord = {
  first_success_at: string;
  checks: LaunchHealthChecks;
};

type LaunchFailureRecord = {
  status: string;
  method: string;
  message: string;
  updated_at: number;
};

type InstanceActivityEntry = {
  id: string;
  message: string;
  at: number;
  tone: "info" | "success" | "warn" | "error";
};

type ScheduledUpdateCheckEntry = {
  instance_id: string;
  instance_name: string;
  checked_at: string;
  checked_mods: number;
  update_count: number;
  updates: ModUpdateCheckResult["updates"];
  error?: string | null;
};

function emptyLaunchHealthChecks(): LaunchHealthChecks {
  return {
    auth: false,
    assets: false,
    libraries: false,
    starting_java: false,
  };
}

function mergeLaunchChecksFromMessage(
  prev: LaunchHealthChecks,
  message?: string | null
): LaunchHealthChecks {
  const text = String(message ?? "").toLowerCase();
  return {
    auth: prev.auth || text.includes("refreshing microsoft"),
    assets: prev.assets || text.includes("installing assets"),
    libraries: prev.libraries || text.includes("installing libraries"),
    starting_java: prev.starting_java || text.includes("starting java process"),
  };
}

function launchStageBadgeLabel(status?: string | null, message?: string | null) {
  const state = String(status ?? "").toLowerCase();
  const text = String(message ?? "").toLowerCase();
  if (state === "running") return "Running";
  if (state === "stopped") return "Stopped";
  if (state === "exited") return "Exited";
  if (text.includes("refreshing microsoft")) return "Auth";
  if (text.includes("installing game version")) return "Version";
  if (text.includes("installing assets")) return "Assets";
  if (text.includes("installing libraries")) return "Libraries";
  if (text.includes("starting java process")) return "Starting Java";
  if (text.includes("preparing runtime")) return "Runtime";
  if (text.includes("preparing native launch")) return "Preparing";
  if (text.includes("preparing prism")) return "Prism Sync";
  if (state === "starting") return "Launching";
  return "";
}

function inferActivityTone(message: string): InstanceActivityEntry["tone"] {
  const lower = message.toLowerCase();
  if (/\b(fail|failed|error|exception|fatal|crash)\b/.test(lower)) return "error";
  if (/\b(warn|warning|retry)\b/.test(lower)) return "warn";
  if (/\b(success|ready|launched|started|complete|completed|saved|updated|refreshed|connected)\b/.test(lower)) {
    return "success";
  }
  return "info";
}

type MicrosoftCodePrompt = {
  code: string;
  verificationUrl: string;
};

type LibraryGroupBy = "none" | "loader" | "version";

type LibraryContextMenuState = {
  instanceId: string;
  x: number;
  y: number;
};

type UserPresetEntry = CreatorPresetEntry;
type UserPreset = CreatorPreset;

type PresetExportPayload = {
  format: "mpm-presets/v2";
  exported_at: string;
  presets: UserPreset[];
};

type AccountSkinOption = {
  id: string;
  label: string;
  skin_url: string;
  preview_url?: string | null;
  group: "saved" | "default";
  origin: "profile" | "custom" | "default";
};

type AccountSkinThumbSet = {
  front: string;
  back: string;
  mode: "3d" | "fallback";
};

type SavedCustomSkin = {
  id: string;
  label: string;
  skin_path: string;
};

type InstanceLaunchHooksDraft = {
  enabled: boolean;
  pre_launch: string;
  wrapper: string;
  post_exit: string;
};

function defaultPresetSettings(): CreatorPresetSettings {
  return {
    dependency_policy: "required",
    conflict_strategy: "replace",
    provider_priority: ["modrinth", "curseforge"],
    snapshot_before_apply: true,
    apply_order: ["mods", "resourcepacks", "shaderpacks", "datapacks"],
    datapack_target_policy: "choose_worlds",
  };
}

function defaultInstanceSettings(): InstanceSettings {
  return {
    keep_launcher_open_while_playing: true,
    close_launcher_on_game_exit: false,
    notes: "",
    auto_update_installed_content: false,
    prefer_release_builds: true,
    java_path: "",
    memory_mb: 4096,
    jvm_args: "",
    graphics_preset: "Balanced",
    enable_shaders: false,
    force_vsync: false,
    world_backup_interval_minutes: 10,
    world_backup_retention_count: 1,
  };
}

function defaultLaunchHooksDraft(): InstanceLaunchHooksDraft {
  return {
    enabled: false,
    pre_launch: "",
    wrapper: "",
    post_exit: "",
  };
}

function normalizeInstanceSettings(input?: Partial<InstanceSettings> | null): InstanceSettings {
  const merged = {
    ...defaultInstanceSettings(),
    ...(input ?? {}),
  };
  const normalizedMemory = Number.isFinite(Number(merged.memory_mb))
    ? Math.max(512, Math.min(65536, Math.round(Number(merged.memory_mb))))
    : 4096;
  const preset = String(merged.graphics_preset ?? "Balanced");
  const graphicsPreset = ["Performance", "Balanced", "Quality"].includes(preset) ? preset : "Balanced";
  const backupInterval = Number.isFinite(Number(merged.world_backup_interval_minutes))
    ? Math.max(5, Math.min(15, Math.round(Number(merged.world_backup_interval_minutes))))
    : 10;
  const backupRetention = Number.isFinite(Number(merged.world_backup_retention_count))
    ? Math.max(1, Math.min(2, Math.round(Number(merged.world_backup_retention_count))))
    : 1;
  return {
    ...merged,
    notes: String(merged.notes ?? ""),
    java_path: String(merged.java_path ?? "").trim(),
    jvm_args: String(merged.jvm_args ?? "").trim(),
    graphics_preset: graphicsPreset,
    memory_mb: normalizedMemory,
    world_backup_interval_minutes: backupInterval,
    world_backup_retention_count: backupRetention,
  };
}

function requiredJavaMajorForMcVersion(mcVersion: string): number {
  const parts = parseReleaseParts(mcVersion);
  if (!parts) return 17;
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if (major > 1 || (major === 1 && minor >= 20 && (parts[2] ?? 0) >= 5)) return 21;
  if (major > 1 || (major === 1 && minor >= 18)) return 17;
  return 8;
}

function normalizeCreatorEntryType(input?: string) {
  const value = String(input ?? "mods").trim().toLowerCase();
  if (value === "resourcepack" || value === "resourcepacks") return "resourcepacks";
  if (value === "shaderpack" || value === "shaderpacks" || value === "shaders") return "shaderpacks";
  if (value === "datapack" || value === "datapacks") return "datapacks";
  if (value === "modpack" || value === "modpacks") return "modpacks";
  return "mods";
}

function normalizeInstanceContentType(input?: string): "mods" | "resourcepacks" | "datapacks" | "shaders" {
  const value = normalizeCreatorEntryType(input);
  if (value === "shaderpacks") return "shaders";
  if (value === "resourcepacks") return "resourcepacks";
  if (value === "datapacks") return "datapacks";
  return "mods";
}

function creatorEntryTypeLabel(input?: string) {
  const normalized = normalizeCreatorEntryType(input);
  if (normalized === "resourcepacks") return "Resourcepacks";
  if (normalized === "shaderpacks") return "Shaderpacks";
  if (normalized === "datapacks") return "Datapacks";
  if (normalized === "modpacks") return "Modpacks";
  return "Mods";
}

function toLocalIconSrc(path?: string | null) {
  const value = String(path ?? "").trim();
  if (!value) return null;
  if (/^http:\/\//i.test(value)) return value.replace(/^http:\/\//i, "https://");
  if (/^(https?:|data:|blob:|asset:|tauri:)/i.test(value)) return value;
  try {
    return convertFileSrc(value);
  } catch {
    return value;
  }
}

const LOCAL_IMAGE_DATA_URL_CACHE = new Map<string, string>();
const LOCAL_IMAGE_DATA_URL_PENDING = new Map<string, Promise<string | null>>();

function isDirectImageSrc(value: string) {
  return /^(https?:|data:|blob:|asset:|tauri:)/i.test(value);
}

async function resolveLocalImageDataUrl(path: string): Promise<string | null> {
  const value = String(path ?? "").trim();
  if (!value) return null;
  if (isDirectImageSrc(value)) return value;
  const cached = LOCAL_IMAGE_DATA_URL_CACHE.get(value);
  if (cached) return cached;
  const inFlight = LOCAL_IMAGE_DATA_URL_PENDING.get(value);
  if (inFlight) return inFlight;
  const task = readLocalImageDataUrl({ path: value })
    .then((data) => {
      const normalized = String(data ?? "").trim();
      if (!normalized) return null;
      LOCAL_IMAGE_DATA_URL_CACHE.set(value, normalized);
      return normalized;
    })
    .catch(() => null)
    .finally(() => {
      LOCAL_IMAGE_DATA_URL_PENDING.delete(value);
    });
  LOCAL_IMAGE_DATA_URL_PENDING.set(value, task);
  return task;
}

function LocalImage({
  path,
  alt,
  fallback = null,
}: {
  path?: string | null;
  alt: string;
  fallback?: ReactNode;
}) {
  const normalizedPath = String(path ?? "").trim();
  const [src, setSrc] = useState<string | null>(() => {
    if (!normalizedPath) return null;
    if (isDirectImageSrc(normalizedPath)) return normalizedPath;
    return LOCAL_IMAGE_DATA_URL_CACHE.get(normalizedPath) ?? null;
  });

  useEffect(() => {
    let cancelled = false;
    if (!normalizedPath) {
      setSrc(null);
      return () => {
        cancelled = true;
      };
    }
    if (isDirectImageSrc(normalizedPath)) {
      setSrc(normalizedPath);
      return () => {
        cancelled = true;
      };
    }
    const cached = LOCAL_IMAGE_DATA_URL_CACHE.get(normalizedPath);
    if (cached) {
      setSrc(cached);
      return () => {
        cancelled = true;
      };
    }
    setSrc(null);
    void resolveLocalImageDataUrl(normalizedPath).then((resolved) => {
      if (!cancelled) setSrc(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedPath]);

  if (!src) return <>{fallback}</>;
  return <img src={src} alt={alt} loading="lazy" decoding="async" />;
}

async function openExternalLink(url: string) {
  try {
    await shellOpen(url);
    return;
  } catch {
    // Fallback for environments where shell.open is unavailable.
  }
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // no-op
  }
}

const FALLBACK_VERSIONS: VersionItem[] = [
  { id: "1.21.1", type: "release" },
  { id: "1.21", type: "release" },
  { id: "1.20.6", type: "release" },
  { id: "1.20.4", type: "release" },
  { id: "1.20.1", type: "release" },
  { id: "1.19.4", type: "release" },
  { id: "1.18.2", type: "release" },
  { id: "1.16.5", type: "release" },
  { id: "1.12.2", type: "release" },
  { id: "1.7.10", type: "release" },
];

function majorMinorGroup(id: string) {
  const m = id.match(/^(\d+)\.(\d+)/);
  if (!m) return "Other";
  return `${m[1]}.${m[2]}`;
}

function parseReleaseParts(id: string) {
  if (!/^\d+(?:\.\d+){1,3}$/.test(id)) return null;
  return id.split(".").map((n) => parseInt(n, 10));
}

function sameRunningInstances(a: RunningInstance[], b: RunningInstance[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.launch_id !== right.launch_id ||
      left.instance_id !== right.instance_id ||
      left.instance_name !== right.instance_name ||
      left.method !== right.method ||
      left.pid !== right.pid ||
      left.started_at !== right.started_at
    ) {
      return false;
    }
  }
  return true;
}

function normalizeRunningInstancesPayload(input: unknown): RunningInstance[] {
  if (!Array.isArray(input)) return [];
  return input.filter((row): row is RunningInstance => {
    if (!row || typeof row !== "object") return false;
    const item = row as Record<string, unknown>;
    return (
      typeof item.launch_id === "string" &&
      typeof item.instance_id === "string" &&
      typeof item.instance_name === "string" &&
      typeof item.method === "string" &&
      typeof item.started_at === "string" &&
      (typeof item.pid === "number" || typeof item.pid === "string")
    );
  });
}

function compareReleaseIdDesc(a: string, b: string) {
  const pa = parseReleaseParts(a);
  const pb = parseReleaseParts(b);
  if (pa && pb) {
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      const da = pa[i] ?? 0;
      const db = pb[i] ?? 0;
      if (da !== db) return db - da;
    }
    return 0;
  }
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}

function toTimestamp(input?: string) {
  if (!input) return Number.NaN;
  const ts = Date.parse(input);
  return Number.isFinite(ts) ? ts : Number.NaN;
}

function normalizeUpdateCheckCadence(input?: string | null): SchedulerCadence {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "off" || value === "disabled") return "off";
  if (value === "hourly" || value === "1h") return "hourly";
  if (value === "every_3_hours" || value === "3h") return "every_3_hours";
  if (value === "every_6_hours" || value === "6h") return "every_6_hours";
  if (value === "every_12_hours" || value === "12h") return "every_12_hours";
  if (value === "weekly") return "weekly";
  return "daily";
}

function normalizeUpdateAutoApplyMode(input?: string | null): SchedulerAutoApplyMode {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "opt_in_instances" || value === "opt-in" || value === "instance_opt_in") {
    return "opt_in_instances";
  }
  if (value === "all_instances" || value === "all") return "all_instances";
  return "never";
}

function normalizeUpdateApplyScope(input?: string | null): SchedulerApplyScope {
  const value = String(input ?? "").trim().toLowerCase();
  if (value === "scheduled_and_manual" || value === "scheduled+manual" || value === "scheduled_and_check_now") {
    return "scheduled_and_manual";
  }
  return "scheduled_only";
}

function updateCadenceLabel(cadence: SchedulerCadence): string {
  switch (cadence) {
    case "off":
      return "Disabled";
    case "hourly":
      return "Every hour";
    case "every_3_hours":
      return "Every 3 hours";
    case "every_6_hours":
      return "Every 6 hours";
    case "every_12_hours":
      return "Every 12 hours";
    case "weekly":
      return "Weekly";
    default:
      return "Daily";
  }
}

function updateAutoApplyModeLabel(mode: SchedulerAutoApplyMode): string {
  switch (mode) {
    case "opt_in_instances":
      return "Opt-in instances";
    case "all_instances":
      return "All instances";
    default:
      return "Never";
  }
}

function updateApplyScopeLabel(scope: SchedulerApplyScope): string {
  return scope === "scheduled_and_manual" ? "Scheduled + check now" : "Scheduled only";
}

function updateCadenceIntervalMs(cadence: SchedulerCadence): number {
  switch (cadence) {
    case "hourly":
      return 60 * 60 * 1000;
    case "every_3_hours":
      return 3 * 60 * 60 * 1000;
    case "every_6_hours":
      return 6 * 60 * 60 * 1000;
    case "every_12_hours":
      return 12 * 60 * 60 * 1000;
    case "weekly":
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function computeNextUpdateRunAt(lastRunAtIso: string | null, cadence: SchedulerCadence): string | null {
  if (cadence === "off") return null;
  const lastMs = toTimestamp(lastRunAtIso ?? undefined);
  if (!Number.isFinite(lastMs)) return null;
  return new Date(lastMs + updateCadenceIntervalMs(cadence)).toISOString();
}

function compareVersionItems(a: VersionItem, b: VersionItem) {
  const ta = toTimestamp(a.release_time);
  const tb = toTimestamp(b.release_time);
  const aHas = Number.isFinite(ta);
  const bHas = Number.isFinite(tb);
  if (aHas && bHas && ta !== tb) return tb - ta;
  if (aHas !== bHas) return aHas ? -1 : 1;
  return compareReleaseIdDesc(a.id, b.id);
}

function groupVersions(items: VersionItem[]) {
  const map = new Map<string, VersionItem[]>();
  for (const v of items) {
    const g = majorMinorGroup(v.id);
    const arr = map.get(g) ?? [];
    arr.push(v);
    map.set(g, arr);
  }

  const keys = Array.from(map.keys()).sort((a, b) => {
    const pa = a.split(".").map((n) => parseInt(n, 10));
    const pb = b.split(".").map((n) => parseInt(n, 10));
    if ((pa[0] ?? 0) !== (pb[0] ?? 0)) return (pb[0] ?? 0) - (pa[0] ?? 0);
    return (pb[1] ?? 0) - (pa[1] ?? 0);
  });

  return keys.map((k) => ({
    group: k,
    items: [...(map.get(k) ?? [])].sort((a, b) => compareReleaseIdDesc(a.id, b.id)),
  }));
}

function groupAllVersions(items: VersionItem[]) {
  const sorted = [...items].sort(compareVersionItems);
  const releases = sorted.filter((v) => v.type === "release");
  const releaseGroups = groupVersions(releases);

  const releaseCandidates = sorted.filter((v) => /-rc\d+$/i.test(v.id));
  const preReleases = sorted.filter((v) => /-pre\d+$/i.test(v.id));
  const weeklySnapshots = sorted.filter((v) => /^\d{2}w\d{2}[a-z]$/i.test(v.id));
  const oldBeta = sorted.filter((v) => v.type === "old_beta");
  const oldAlpha = sorted.filter((v) => v.type === "old_alpha");

  const releaseLike = new Set([
    ...releaseCandidates.map((v) => v.id),
    ...preReleases.map((v) => v.id),
    ...weeklySnapshots.map((v) => v.id),
  ]);
  const extraSnapshots = sorted.filter(
    (v) => v.type === "snapshot" && !releaseLike.has(v.id)
  );

  const out: { group: string; items: VersionItem[] }[] = [];
  out.push(
    ...releaseGroups.map((g) => ({
      group: `Stable releases • ${g.group}`,
      items: g.items,
    }))
  );
  if (releaseCandidates.length) out.push({ group: "Release candidates", items: releaseCandidates });
  if (preReleases.length) out.push({ group: "Pre-releases", items: preReleases });
  if (weeklySnapshots.length) out.push({ group: "Snapshots", items: weeklySnapshots });
  if (extraSnapshots.length) out.push({ group: "Experimental / dev builds", items: extraSnapshots });
  if (oldBeta.length) out.push({ group: "Old Beta", items: oldBeta });
  if (oldAlpha.length) out.push({ group: "Old Alpha", items: oldAlpha });
  return out;
}

async function fetchOfficialManifest(): Promise<VersionItem[]> {
  const parseMcVersionsHtml = (html: string): VersionItem[] => {
    const found = new Set<string>();
    const out: VersionItem[] = [];
    const re = /data-version="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const id = m[1]?.trim();
      if (!id || found.has(id)) continue;
      found.add(id);

      let type: VersionItem["type"] = "snapshot";
      if (/^b\d/i.test(id)) type = "old_beta";
      else if (/^a\d/i.test(id)) type = "old_alpha";
      else if (/^\d+(?:\.\d+){1,3}$/.test(id)) type = "release";

      out.push({ id, type });
    }
    return out;
  };

  try {
    const url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch versions (${res.status})`);
    const data = (await res.json()) as {
      versions: { id: string; type: VersionItem["type"]; releaseTime?: string }[];
    };
    if (!Array.isArray(data.versions) || data.versions.length < 50) {
      throw new Error("Version manifest response was unexpectedly small");
    }
    return data.versions.map((v) => ({
      id: v.id,
      type: v.type,
      release_time: v.releaseTime,
    }));
  } catch {
    const backup = await fetch("https://mcversions.net/");
    if (!backup.ok) throw new Error(`Failed to fetch backup versions (${backup.status})`);
    const html = await backup.text();
    const parsed = parseMcVersionsHtml(html);
    if (!parsed.length) throw new Error("Backup version parse returned 0 versions");
    return parsed;
  }
}

function formatCompact(n: number) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatPercent(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  return `${Math.max(0, Math.min(100, n)).toFixed(0)}%`;
}

function formatDate(input: string | null | undefined) {
  const d = parseDateLike(input);
  if (!d) return input ?? "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function parseDateLike(input: string | null | undefined): Date | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (raw.startsWith("unix:")) {
    const secs = Number(raw.slice(5).trim());
    if (Number.isFinite(secs) && secs > 0) {
      const fromUnix = new Date(secs * 1000);
      if (Number.isFinite(fromUnix.getTime())) return fromUnix;
    }
  }
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

function formatDateTime(input: string | null | undefined, fallback = "Unknown date") {
  const d = parseDateLike(input);
  if (!d) return fallback;
  return d.toLocaleString();
}

function formatFileSize(bytes: number | null | undefined) {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "Unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = value >= 10 || idx === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[idx]}`;
}

function humanizeToken(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function normalizeMinecraftUuid(uuid?: string | null) {
  if (!uuid) return null;
  return uuid.replace(/-/g, "").trim() || null;
}

const SKIN_HEAD_CACHE_MAX = 120;
const ACCOUNT_DIAGNOSTICS_CACHE_KEY = "mpm.account.diagnostics_cache.v1";
const SKIN_IMAGE_FETCH_TIMEOUT_MS = 4500;
const SKIN_VIEWER_LOAD_TIMEOUT_MS = 7000;
const SKIN_THUMB_3D_SIZE = 220;
const SKIN_THUMB_FRAMING_VERSION = "v2";
const skinHeadRenderCache = new Map<string, string>();
const skinHeadRenderPending = new Map<string, Promise<string | null>>();
const skin3dThumbCache = new Map<string, string>();
const skin3dThumbPending = new Map<string, Promise<string | null>>();

function skinThumbSourceCandidates(input?: string | null): string[] {
  const src = String(input ?? "").trim();
  if (!src) return [];
  const out = [src];
  const minotar = src.match(/minotar\.net\/skin\/([^/?#]+)/i);
  if (minotar?.[1]) out.push(`https://mc-heads.net/skin/${encodeURIComponent(minotar[1])}`);
  const mcHeads = src.match(/mc-heads\.net\/skin\/([^/?#]+)/i);
  if (mcHeads?.[1]) out.push(`https://minotar.net/skin/${encodeURIComponent(mcHeads[1])}`);
  return [...new Set(out)];
}

function readCachedAccountDiagnostics(): AccountDiagnostics | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(ACCOUNT_DIAGNOSTICS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<AccountDiagnostics>;
    if (
      typeof candidate.status !== "string" ||
      typeof candidate.last_refreshed_at !== "string" ||
      typeof candidate.token_exchange_status !== "string" ||
      typeof candidate.client_id_source !== "string" ||
      !Array.isArray(candidate.skins) ||
      !Array.isArray(candidate.capes)
    ) {
      return null;
    }
    return candidate as AccountDiagnostics;
  } catch {
    return null;
  }
}

async function renderMinecraftHeadFromSkin(
  skinUrl?: string | null,
  size = 128
): Promise<string | null> {
  const src = skinUrl?.trim();
  if (!src || typeof window === "undefined") return null;
  const cacheKey = `${size}:${src}`;
  const cached = skinHeadRenderCache.get(cacheKey);
  if (cached) return cached;
  const pending = skinHeadRenderPending.get(cacheKey);
  if (pending) return pending;

  const task = new Promise<string | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timeoutHandle);
      resolve(value);
    };
    const timeoutHandle = window.setTimeout(() => {
      finish(null);
    }, SKIN_IMAGE_FETCH_TIMEOUT_MS);
    img.onload = () => {
      try {
        if (img.naturalWidth < 64 || img.naturalHeight < 32) {
          finish(null);
          return;
        }
        const headCanvas = document.createElement("canvas");
        headCanvas.width = 8;
        headCanvas.height = 8;
        const headCtx = headCanvas.getContext("2d");
        if (!headCtx) {
          finish(null);
          return;
        }
        headCtx.imageSmoothingEnabled = false;
        // Base face + hat overlay from standard skin layout.
        headCtx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
        headCtx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);

        const out = document.createElement("canvas");
        out.width = size;
        out.height = size;
        const outCtx = out.getContext("2d");
        if (!outCtx) {
          finish(null);
          return;
        }
        outCtx.imageSmoothingEnabled = false;
        outCtx.drawImage(headCanvas, 0, 0, size, size);
        const dataUrl = out.toDataURL("image/png");
        skinHeadRenderCache.set(cacheKey, dataUrl);
        if (skinHeadRenderCache.size > SKIN_HEAD_CACHE_MAX) {
          const oldest = skinHeadRenderCache.keys().next().value as string | undefined;
          if (oldest) skinHeadRenderCache.delete(oldest);
        }
        finish(dataUrl);
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = src;
  });

  skinHeadRenderPending.set(cacheKey, task);
  return task.finally(() => {
    skinHeadRenderPending.delete(cacheKey);
  });
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("timeout"));
    }, ms);
    task
      .then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

async function renderMinecraftSkinThumb3d(args: {
  skinUrl?: string | null;
  view: "front" | "back";
  size?: number;
  capeUrl?: string | null;
}): Promise<string | null> {
  const src = String(args.skinUrl ?? "").trim();
  if (!src || typeof window === "undefined") return null;
  const size = Math.max(96, Math.round(args.size ?? SKIN_THUMB_3D_SIZE));
  const view = args.view;
  const cape = String(args.capeUrl ?? "").trim();
  const cacheKey = `${SKIN_THUMB_FRAMING_VERSION}:${size}:${view}:${src}:${cape}`;
  const cached = skin3dThumbCache.get(cacheKey);
  if (cached) return cached;
  const pending = skin3dThumbPending.get(cacheKey);
  if (pending) return pending;

  const task = (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    let viewer: SkinViewer | null = null;
    try {
      viewer = new SkinViewer({
        canvas,
        width: size,
        height: size,
        zoom: 1.02,
        fov: 34,
      });
      const renderer = (viewer as unknown as {
        renderer?: { setPixelRatio?: (ratio: number) => void };
      }).renderer;
      renderer?.setPixelRatio?.(1);
      viewer.background = null;
      viewer.globalLight.intensity = 1.18;
      viewer.cameraLight.intensity = 1.06;
      viewer.controls.enabled = false;
      viewer.playerWrapper.position.y = 0.48;
      viewer.playerWrapper.rotation.y = view === "back" ? Math.PI + 0.42 : -0.42;
      viewer.controls.target.set(0, 11.25, 0);
      viewer.controls.update();
      await withTimeout(viewer.loadSkin(src, { model: "auto-detect" }), SKIN_VIEWER_LOAD_TIMEOUT_MS);
      if (cape) {
        await withTimeout(
          viewer.loadCape(cape, { backEquipment: "cape" }),
          SKIN_VIEWER_LOAD_TIMEOUT_MS
        ).catch(() => null);
      }
      await new Promise<void>((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
      );
      viewer.render();
      const dataUrl = canvas.toDataURL("image/png");
      skin3dThumbCache.set(cacheKey, dataUrl);
      if (skin3dThumbCache.size > 240) {
        const oldest = skin3dThumbCache.keys().next().value as string | undefined;
        if (oldest) skin3dThumbCache.delete(oldest);
      }
      return dataUrl;
    } catch {
      return null;
    } finally {
      viewer?.dispose();
    }
  })();

  skin3dThumbPending.set(cacheKey, task);
  return task.finally(() => {
    skin3dThumbPending.delete(cacheKey);
  });
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeTimeOfDay(input: number) {
  if (!Number.isFinite(input)) return 14;
  let value = input % 24;
  if (value < 0) value += 24;
  return value;
}

function formatTimeOfDay(input: number) {
  const normalized = normalizeTimeOfDay(input);
  const minutesTotal = Math.round(normalized * 60);
  const hour24 = Math.floor(minutesTotal / 60) % 24;
  const minutes = minutesTotal % 60;
  const hour12 = hour24 % 12 || 12;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function describeTimeOfDay(input: number) {
  const t = normalizeTimeOfDay(input);
  if (t < 5) return "Night";
  if (t < 8) return "Dawn";
  if (t < 17) return "Day";
  if (t < 20) return "Sunset";
  return "Night";
}

function minecraftAvatarSources(uuid?: string | null) {
  const id = normalizeMinecraftUuid(uuid);
  const out: string[] = [];
  if (id) {
    out.push(`https://mc-heads.net/avatar/${id}/128`);
    out.push(`https://crafatar.com/avatars/${id}?size=128&overlay=true&default=MHF_Steve`);
    out.push(`https://visage.surgeplay.com/face/128/${id}`);
    out.push(`https://minotar.net/avatar/${id}/128`);
  }
  return out;
}

const DEFAULT_SKIN_LIBRARY: AccountSkinOption[] = [
  {
    id: "default:steve",
    label: "Steve",
    skin_url: "https://mc-heads.net/skin/Steve",
    preview_url: "https://mc-heads.net/body/Steve/right",
    group: "default",
    origin: "default",
  },
  {
    id: "default:alex",
    label: "Alex",
    skin_url: "https://mc-heads.net/skin/Alex",
    preview_url: "https://mc-heads.net/body/Alex/right",
    group: "default",
    origin: "default",
  },
  {
    id: "default:ari",
    label: "Ari",
    skin_url: "https://mc-heads.net/skin/Ari",
    preview_url: "https://mc-heads.net/body/Ari/right",
    group: "default",
    origin: "default",
  },
  {
    id: "default:efe",
    label: "Efe",
    skin_url: "https://mc-heads.net/skin/Efe",
    preview_url: "https://mc-heads.net/body/Efe/right",
    group: "default",
    origin: "default",
  },
  {
    id: "default:kai",
    label: "Kai",
    skin_url: "https://mc-heads.net/skin/Kai",
    preview_url: "https://mc-heads.net/body/Kai/right",
    group: "default",
    origin: "default",
  },
  {
    id: "default:noor",
    label: "Noor",
    skin_url: "https://mc-heads.net/skin/Noor",
    preview_url: "https://mc-heads.net/body/Noor/right",
    group: "default",
    origin: "default",
  },
  {
    id: "default:makena",
    label: "Makena",
    skin_url: "https://mc-heads.net/skin/Makena",
    preview_url: "https://mc-heads.net/body/Makena/right",
    group: "default",
    origin: "default",
  },
  {
    id: "default:sunny",
    label: "Sunny",
    skin_url: "https://mc-heads.net/skin/Sunny",
    preview_url: "https://mc-heads.net/body/Sunny/right",
    group: "default",
    origin: "default",
  },
  {
    id: "default:zuri",
    label: "Zuri",
    skin_url: "https://mc-heads.net/skin/Zuri",
    preview_url: "https://mc-heads.net/body/Zuri/right",
    group: "default",
    origin: "default",
  },
];

function basenameWithoutExt(input: string) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "Custom skin";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  const file = parts[parts.length - 1] ?? trimmed;
  return file.replace(/\.[^.]+$/, "") || "Custom skin";
}

function toReadableBody(markdown?: string | null) {
  if (!markdown) return "";
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/`{1,3}/g, "")
    .trim();
}

function toReadableHtml(html?: string | null) {
  if (!html) return "";
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DISCOVER_SORT_OPTIONS: { value: ModrinthIndex; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "downloads", label: "Downloads" },
  { value: "follows", label: "Followers" },
  { value: "newest", label: "Newest" },
  { value: "updated", label: "Recently updated" },
];

const DISCOVER_VIEW_OPTIONS: { value: string; label: string }[] = [
  { value: "10", label: "10" },
  { value: "20", label: "20" },
  { value: "30", label: "30" },
  { value: "50", label: "50" },
];

const DISCOVER_SOURCE_OPTIONS: { value: DiscoverSource; label: string }[] = [
  { value: "all", label: "All" },
  { value: "modrinth", label: "Modrinth" },
  { value: "curseforge", label: "CurseForge" },
];

const DISCOVER_CONTENT_OPTIONS: { value: DiscoverContentType; label: string }[] = [
  { value: "mods", label: "Mods" },
  { value: "shaderpacks", label: "Shaderpacks" },
  { value: "resourcepacks", label: "Resourcepacks" },
  { value: "datapacks", label: "Datapacks + Modpacks" },
];

const DISCOVER_LOADER_GROUPS: CatGroup[] = [
  {
    group: "Loaders",
    items: [
      { id: "fabric", label: "Fabric" },
      { id: "forge", label: "Forge" },
      { id: "quilt", label: "Quilt" },
      { id: "neoforge", label: "NeoForge" },
    ],
  },
];

const ACCENT_OPTIONS: { value: AccentPreset; label: string }[] = [
  { value: "neutral", label: "Neutral" },
  { value: "blue", label: "Blue" },
  { value: "emerald", label: "Emerald" },
  { value: "amber", label: "Amber" },
  { value: "rose", label: "Rose" },
  { value: "violet", label: "Violet" },
  { value: "teal", label: "Teal" },
];

const ACCENT_STRENGTH_OPTIONS: { value: AccentStrength; label: string }[] = [
  { value: "subtle", label: "Subtle" },
  { value: "normal", label: "Normal" },
  { value: "vivid", label: "Vivid" },
  { value: "max", label: "Max" },
];

const MOTION_OPTIONS: { value: MotionPreset; label: string }[] = [
  { value: "calm", label: "Calm" },
  { value: "standard", label: "Standard" },
  { value: "expressive", label: "Expressive" },
];

const DENSITY_OPTIONS: { value: DensityPreset; label: string }[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const UPDATE_CADENCE_OPTIONS: { value: SchedulerCadence; label: string }[] = [
  { value: "off", label: "Disabled" },
  { value: "hourly", label: "Every hour" },
  { value: "every_3_hours", label: "Every 3 hours" },
  { value: "every_6_hours", label: "Every 6 hours" },
  { value: "every_12_hours", label: "Every 12 hours" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const UPDATE_AUTO_APPLY_MODE_OPTIONS: { value: SchedulerAutoApplyMode; label: string }[] = [
  { value: "never", label: "Never auto-apply" },
  { value: "opt_in_instances", label: "Only opt-in instances" },
  { value: "all_instances", label: "All instances" },
];

const UPDATE_APPLY_SCOPE_OPTIONS: { value: SchedulerApplyScope; label: string }[] = [
  { value: "scheduled_only", label: "Scheduled runs only" },
  { value: "scheduled_and_manual", label: "Scheduled + Check now" },
];

const WORLD_BACKUP_INTERVAL_OPTIONS: { value: string; label: string }[] = [
  { value: "5", label: "Every 5 minutes" },
  { value: "10", label: "Every 10 minutes" },
  { value: "15", label: "Every 15 minutes" },
];

const WORLD_BACKUP_RETENTION_OPTIONS: { value: string; label: string }[] = [
  { value: "1", label: "Keep 1 backup per world" },
  { value: "2", label: "Keep 2 backups per world" },
];

const PROJECT_DETAIL_TABS: { value: string; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "versions", label: "Versions" },
  { value: "changelog", label: "Changelog" },
];

const CURSEFORGE_DETAIL_TABS: { value: string; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "files", label: "Files" },
  { value: "changelog", label: "Changelog" },
];

function isAccentPreset(value: string | null): value is AccentPreset {
  return (
    value === "neutral" ||
    value === "blue" ||
    value === "emerald" ||
    value === "amber" ||
    value === "rose" ||
    value === "violet" ||
    value === "teal"
  );
}

function isAccentStrength(value: string | null): value is AccentStrength {
  return value === "subtle" || value === "normal" || value === "vivid" || value === "max";
}

function isMotionPreset(value: string | null): value is MotionPreset {
  return value === "calm" || value === "standard" || value === "expressive";
}

function isDensityPreset(value: string | null): value is DensityPreset {
  return value === "comfortable" || value === "compact";
}

type UiSettingsSnapshot = {
  theme: "dark" | "light";
  accentPreset: AccentPreset;
  accentStrength: AccentStrength;
  motionPreset: MotionPreset;
  densityPreset: DensityPreset;
};

const UI_SETTINGS_STORAGE_KEY = "mpm.ui.settings.v2";

function defaultUiTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function defaultUiSettingsSnapshot(): UiSettingsSnapshot {
  return {
    theme: defaultUiTheme(),
    accentPreset: "neutral",
    accentStrength: "normal",
    motionPreset: "standard",
    densityPreset: "comfortable",
  };
}

function readUiSettingsSnapshot(): UiSettingsSnapshot {
  const fallback = defaultUiSettingsSnapshot();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const theme =
        parsed?.theme === "dark" || parsed?.theme === "light" ? parsed.theme : fallback.theme;
      const accentPreset = isAccentPreset(String(parsed?.accentPreset ?? ""))
        ? parsed.accentPreset
        : fallback.accentPreset;
      const accentStrength = isAccentStrength(String(parsed?.accentStrength ?? ""))
        ? parsed.accentStrength
        : fallback.accentStrength;
      const motionPreset = isMotionPreset(String(parsed?.motionPreset ?? ""))
        ? parsed.motionPreset
        : fallback.motionPreset;
      const densityPreset = isDensityPreset(String(parsed?.densityPreset ?? ""))
        ? parsed.densityPreset
        : fallback.densityPreset;
      return { theme, accentPreset, accentStrength, motionPreset, densityPreset };
    }

    const legacyTheme = localStorage.getItem("mpm.theme");
    const legacyAccent = localStorage.getItem("mpm.accent");
    const legacyAccentStrength = localStorage.getItem("mpm.accentStrength");
    const legacyMotion = localStorage.getItem("mpm.motionPreset");
    const legacyDensity = localStorage.getItem("mpm.densityPreset");
    return {
      theme:
        legacyTheme === "dark" || legacyTheme === "light" ? legacyTheme : fallback.theme,
      accentPreset: isAccentPreset(legacyAccent) ? legacyAccent : fallback.accentPreset,
      accentStrength: isAccentStrength(legacyAccentStrength)
        ? legacyAccentStrength
        : fallback.accentStrength,
      motionPreset: isMotionPreset(legacyMotion) ? legacyMotion : fallback.motionPreset,
      densityPreset: isDensityPreset(legacyDensity) ? legacyDensity : fallback.densityPreset,
    };
  } catch {
    return fallback;
  }
}

function persistUiSettingsSnapshot(next: UiSettingsSnapshot) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    // Keep legacy keys for backwards compatibility with older builds.
    localStorage.setItem("mpm.theme", next.theme);
    localStorage.setItem("mpm.accent", next.accentPreset);
    localStorage.setItem("mpm.accentStrength", next.accentStrength);
    localStorage.setItem("mpm.motionPreset", next.motionPreset);
    localStorage.setItem("mpm.densityPreset", next.densityPreset);
  } catch {
    // ignore storage failures
  }
}

function clearUiSettingsStorage() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(UI_SETTINGS_STORAGE_KEY);
    localStorage.removeItem("mpm.theme");
    localStorage.removeItem("mpm.accent");
    localStorage.removeItem("mpm.accentStrength");
    localStorage.removeItem("mpm.motionPreset");
    localStorage.removeItem("mpm.densityPreset");
  } catch {
    // ignore storage failures
  }
}

type InstanceLogSeverity = LogSeverity;
type InstanceLogSource = InstanceLogSourceApi;
type LogViewMode = "live" | "analyze";
type QuickLogFilter = "errors" | "warnings" | "suspects" | "crashes";

type InstanceLogLine = {
  id: string;
  source: InstanceLogSource;
  severity: InstanceLogSeverity;
  timestamp: string;
  message: string;
  lineNo: number | null;
};

const LOG_MAX_LINES_OPTIONS: { value: string; label: string }[] = [
  { value: "400", label: "400" },
  { value: "1200", label: "1,200" },
  { value: "2500", label: "2,500" },
  { value: "5000", label: "5,000" },
  { value: "8000", label: "8,000" },
  { value: "12000", label: "12,000" },
];

const LOG_SEVERITY_OPTIONS: { value: "all" | InstanceLogSeverity; label: string }[] = [
  { value: "all", label: "All" },
  { value: "error", label: "Error" },
  { value: "warn", label: "Warn" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
  { value: "trace", label: "Trace" },
];

const LOG_SOURCE_OPTIONS: { value: InstanceLogSource; label: string }[] = [
  { value: "live", label: "Live log" },
  { value: "latest_launch", label: "Latest launch" },
  { value: "latest_crash", label: "Latest crash" },
];

const QUICK_LOG_FILTER_OPTIONS: { id: QuickLogFilter; label: string }[] = [
  { id: "errors", label: "Errors" },
  { id: "warnings", label: "Warnings" },
  { id: "suspects", label: "Suspects" },
  { id: "crashes", label: "Crashes" },
];

function severityLabel(level: InstanceLogSeverity) {
  if (level === "error") return "Error";
  if (level === "warn") return "Warn";
  if (level === "info") return "Info";
  if (level === "debug") return "Debug";
  return "Trace";
}

function severityShort(level: InstanceLogSeverity) {
  if (level === "error") return "ERR";
  if (level === "warn") return "WRN";
  if (level === "info") return "INF";
  if (level === "debug") return "DBG";
  return "TRC";
}

function sourceLabel(source: InstanceLogSource) {
  if (source === "live") return "Live log";
  if (source === "latest_launch") return "Latest launch";
  return "Latest crash";
}

function formatLogTimestamp(iso: string) {
  const raw = String(iso ?? "").trim();
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isFinite(d.getTime())) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  return raw;
}

function toInstanceLogLine(args: {
  raw: string;
  source: InstanceLogSource;
  index: number;
  updatedAt: number;
  severity?: string | null;
  timestamp?: string | null;
  lineNo?: number | null;
}): InstanceLogLine {
  const message = String(args.raw ?? "")
    .replace(/\u0000/g, "")
    .trimEnd();
  const severityRaw = String(args.severity ?? "").trim().toLowerCase();
  const severity: InstanceLogSeverity =
    severityRaw === "error" ||
    severityRaw === "warn" ||
    severityRaw === "info" ||
    severityRaw === "debug" ||
    severityRaw === "trace"
      ? severityRaw
      : inferLogSeverity(message);
  const ts =
    String(args.timestamp ?? "").trim() ||
    extractLogTimestamp(message) ||
    new Date(args.updatedAt + args.index).toISOString();
  const numericLineNo = Number(args.lineNo);
  const lineNo = Number.isFinite(numericLineNo) && numericLineNo > 0 ? Math.floor(numericLineNo) : null;
  const idStem = message.slice(0, 80).replace(/\s+/g, " ");
  return {
    id:
      lineNo != null
        ? `${args.source}:${lineNo}`
        : `${args.source}:${args.updatedAt}:${args.index}:${idStem}`,
    source: args.source,
    severity,
    message,
    timestamp: ts,
    lineNo,
  };
}

function fallbackInstanceLogLines(args: {
  source: InstanceLogSource;
  instanceId: string;
  hasRunning: boolean;
  message?: string | null;
}): InstanceLogLine[] {
  const now = Date.now();
  const seedMessage =
    String(args.message ?? "").trim() ||
    (args.source === "live"
      ? args.hasRunning
        ? "Streaming live logs…"
        : "No live game process detected yet."
      : "No log file found for this source yet.");
  return [
    {
      id: `${args.source}:${args.instanceId}:fallback`,
      source: args.source,
      severity: "info",
      timestamp: new Date(now).toISOString(),
      message: seedMessage,
      lineNo: null,
    },
  ];
}

type LogWindowState = {
  nextBeforeLine: number | null;
  loadingOlder: boolean;
  fullyLoaded: boolean;
};

function normalizeLogLineNo(value: number | null | undefined) {
  const numeric = Number(value ?? NaN);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
}

function logLineIdentity(line: ReadInstanceLogsLine, source: string, index: number) {
  const lineNo = normalizeLogLineNo(line.line_no);
  if (lineNo != null) return `${source}:line:${lineNo}`;
  const raw = String(line.raw ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  const timestamp = String(line.timestamp ?? "").trim();
  return `${source}:raw:${timestamp}:${raw}:${index}`;
}

function mergeReadInstanceLogPayload(args: {
  existing: ReadInstanceLogsResult | null;
  incoming: ReadInstanceLogsResult;
  mode: "replace_tail" | "prepend_older";
}): ReadInstanceLogsResult {
  const { existing, incoming, mode } = args;
  if (!existing || existing.source !== incoming.source) {
    return incoming;
  }
  if (!incoming.available) {
    return existing.available ? existing : incoming;
  }
  if (!existing.available) {
    return incoming;
  }
  if (existing.path && incoming.path && existing.path !== incoming.path) {
    return incoming;
  }
  const existingStart = normalizeLogLineNo(existing.start_line_no);
  const incomingStart = normalizeLogLineNo(incoming.start_line_no);
  // If the incoming window starts later, this is usually a narrower/newer tail request
  // (for example, changing line depth from 2500 -> 400). Replace outright so depth changes apply.
  if (mode === "replace_tail" && existingStart != null && incomingStart != null && incomingStart > existingStart) {
    return incoming;
  }
  if (
    mode === "replace_tail" &&
    normalizeLogLineNo(existing.end_line_no) != null &&
    normalizeLogLineNo(incoming.end_line_no) != null &&
    normalizeLogLineNo(incoming.end_line_no)! < normalizeLogLineNo(existing.end_line_no)!
  ) {
    return incoming;
  }

  const dedupe = new Set<string>();
  const mergedLines: ReadInstanceLogsLine[] = [];
  const push = (line: ReadInstanceLogsLine, index: number) => {
    const key = logLineIdentity(line, incoming.source, index);
    if (dedupe.has(key)) return;
    dedupe.add(key);
    mergedLines.push(line);
  };
  if (mode === "replace_tail" && incomingStart != null) {
    existing.lines.forEach((line, index) => {
      const lineNo = normalizeLogLineNo(line.line_no);
      if (lineNo != null && lineNo >= incomingStart) return;
      push(line, index);
    });
    incoming.lines.forEach((line, index) => push(line, index + existing.lines.length));
  } else if (mode === "prepend_older") {
    incoming.lines.forEach((line, index) => push(line, index));
    existing.lines.forEach((line, index) => push(line, index + incoming.lines.length));
  } else {
    existing.lines.forEach((line, index) => push(line, index));
    incoming.lines.forEach((line, index) => push(line, index + existing.lines.length));
  }

  mergedLines.sort((a, b) => {
    const lineA = normalizeLogLineNo(a.line_no);
    const lineB = normalizeLogLineNo(b.line_no);
    if (lineA != null && lineB != null) return lineA - lineB;
    if (lineA != null) return -1;
    if (lineB != null) return 1;
    return 0;
  });

  const firstLineNo = mergedLines.length > 0 ? normalizeLogLineNo(mergedLines[0].line_no) : null;
  const lastLineNo =
    mergedLines.length > 0 ? normalizeLogLineNo(mergedLines[mergedLines.length - 1].line_no) : null;
  const preservedNext =
    mode === "replace_tail" && existing.next_before_line != null
      ? normalizeLogLineNo(existing.next_before_line)
      : null;
  const nextBeforeLine = normalizeLogLineNo(incoming.next_before_line) ?? preservedNext;

  return {
    ...incoming,
    lines: mergedLines,
    returned_lines: mergedLines.length,
    total_lines: Math.max(incoming.total_lines, existing.total_lines),
    truncated: nextBeforeLine != null,
    start_line_no: firstLineNo,
    end_line_no: lastLineNo,
    next_before_line: nextBeforeLine,
    updated_at: Math.max(existing.updated_at, incoming.updated_at),
  };
}

type Cat = { id: string; label: string };
type CatGroup = { group: string; items: Cat[] };

const MOD_CATEGORY_GROUPS: CatGroup[] = [
  {
    group: "Gameplay",
    items: [
      { id: "adventure", label: "Adventure" },
      { id: "combat", label: "Combat" },
      { id: "mobs", label: "Mobs" },
      { id: "magic", label: "Magic" },
      { id: "quests", label: "Quests" },
      { id: "minigame", label: "Minigame" },
      { id: "game-mechanics", label: "Game mechanics" },
      { id: "cursed", label: "Horror / Cursed" },
    ],
  },
  {
    group: "Performance",
    items: [
      { id: "optimization", label: "Optimization" },
      { id: "utility", label: "Utility" },
      { id: "management", label: "Management" },
    ],
  },
  {
    group: "World & Content",
    items: [
      { id: "worldgen", label: "Worldgen" },
      { id: "decoration", label: "Decoration" },
      { id: "food", label: "Food" },
      { id: "economy", label: "Economy" },
      { id: "technology", label: "Technology" },
      { id: "transportation", label: "Transportation" },
      { id: "social", label: "Social" },
      { id: "multiplayer", label: "Multiplayer" },
    ],
  },
];

function Icon(props: { name: "compass" | "box" | "books" | "skin" | "bell" | "plus" | "gear" | "user" | "search" | "x" | "play" | "download" | "sliders" | "cpu" | "sparkles" | "layers" | "folder" | "upload" | "trash"; size?: number; className?: string }) {
  const size = props.size ?? 22;
  const cls = props.className ?? "navIcon";

  const common = {
    xmlns: "http://www.w3.org/2000/svg",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.9",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: cls,
  };

  switch (props.name) {
    case "compass":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <polygon
            className="compassNeedle"
            points="15.6 8.4 13.5 13.5 8.4 15.6 10.5 10.5 15.6 8.4"
          />
        </svg>
      );
    case "box":
      return (
        <svg {...common}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73L13 2.27a2 2 0 0 0-2 0L4 6.27A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path d="M3.3 7l8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </svg>
      );
    case "books":
      return (
        <svg {...common}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H19.1A.9.9 0 0 1 20 2.9V22H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <path className="bookCornerMark" d="M13.35 2.2v5.8l1.7-1.25L16.75 8V2.2" />
        </svg>
      );
    case "skin":
      return (
        <svg {...common}>
          <rect x="5.2" y="4.8" width="13.6" height="13.6" rx="2.8" />
          <path d="M8.4 10.2h.01" />
          <path d="M15.6 10.2h.01" />
          <path d="M8.2 14.3c1.1.95 2.4 1.45 3.8 1.45s2.7-.5 3.8-1.45" />
        </svg>
      );
    case "bell":
      return (
        <svg {...common}>
          <path d="M15 17H9c-1.2 0-2-.8-2-2v-3.2a5 5 0 0 1 10 0V15c0 1.2-.8 2-2 2z" />
          <path d="M12 5V3.5" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "user":
      return (
        <svg {...common}>
          <circle className="userHead" cx="12" cy="8" r="3.4" />
          <path className="userBody" d="M5 19a7 7 0 0 1 14 0" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.2-3.2" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M18 6L6 18" />
          <path d="M6 6l12 12" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <path d="M8 5l12 7-12 7z" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path d="M12 3v12" />
          <path d="M7 10l5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
      );
    case "upload":
      return (
        <svg {...common}>
          <path d="M12 21V9" />
          <path d="M7 14l5-5 5 5" />
          <path d="M5 3h14" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M3 6h18" />
          <path d="M9 6V4.6A1.6 1.6 0 0 1 10.6 3h2.8A1.6 1.6 0 0 1 15 4.6V6" />
          <path d="M6.5 6l.8 12.7A2 2 0 0 0 9.3 20.6h5.4a2 2 0 0 0 2-1.9L17.5 6" />
          <path d="M10 10.2v6.4" />
          <path d="M14 10.2v6.4" />
        </svg>
      );
    case "sliders":
      return (
        <svg {...common}>
          <path d="M4 21v-7" />
          <path d="M4 10V3" />
          <path d="M12 21v-9" />
          <path d="M12 8V3" />
          <path d="M20 21v-5" />
          <path d="M20 12V3" />
          <path d="M2 14h4" />
          <path d="M10 12h4" />
          <path d="M18 16h4" />
        </svg>
      );
    case "cpu":
      return (
        <svg {...common}>
          <rect x="8" y="8" width="8" height="8" rx="1.5" />
          <path d="M12 2v3" />
          <path d="M12 19v3" />
          <path d="M2 12h3" />
          <path d="M19 12h3" />
          <path d="M4.5 4.5l2 2" />
          <path d="M17.5 17.5l2 2" />
          <path d="M19.5 4.5l-2 2" />
          <path d="M4.5 19.5l2-2" />
        </svg>
      );
    case "sparkles":
      return (
        <svg {...common}>
          <path d="M12 2l1.2 4.3L17.5 8l-4.3 1.2L12 13.5l-1.2-4.3L6.5 8l4.3-1.7z" />
          <path d="M19 13l.6 2.1L22 16l-2.4.9L19 19l-.6-2.1L16 16l2.4-.9z" />
          <path d="M4.5 13l.5 1.7L7 15l-2 .7-.5 1.8-.5-1.8L2 15l2-.3z" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common}>
          <path d="M12 2l10 6-10 6L2 8z" />
          <path d="M2 12l10 6 10-6" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

function NavButton(props: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: any;
  variant?: "default" | "accent";
  className?: string;
  badge?: number;
}) {
  return (
    <button
      className={`navBtn ${props.active ? "active" : ""} ${props.variant === "accent" ? "accent" : ""} ${props.className ?? ""}`}
      onClick={props.onClick}
    >
      {props.children}
      {(props.badge ?? 0) > 0 ? (
        <span className="navBadge" aria-label={`${props.badge} updates available`}>
          {(props.badge ?? 0) > 99 ? "99+" : props.badge}
        </span>
      ) : null}
      <div className="navTooltip">{props.label}</div>
    </button>
  );
}

function Modal({
  title,
  titleNode,
  onClose,
  children,
  size = "default",
  className,
}: {
  title: string;
  titleNode?: any;
  onClose: () => void;
  children: any;
  size?: "default" | "wide";
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modalOverlay" onMouseDown={onClose}>
      <div className={`modal ${size === "wide" ? "wide" : ""} ${className ?? ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          {titleNode ?? <div className="modalTitle">{title}</div>}
          <button className="iconBtn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SegTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; disabled?: boolean }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="pillRow" style={{ gap: 12 }}>
      {tabs.map((t) => {
        const cls = `pill ${t.disabled ? "disabled" : ""} ${
          active === t.id ? "active" : ""
        }`;
        return (
          <div
            key={t.id}
            className={cls}
            onClick={() => (t.disabled ? null : onChange(t.id))}
          >
            {active === t.id ? "✓ " : ""}
            {t.label}
          </div>
        );
      })}
    </div>
  );
}

type PanelPlacement = "top" | "bottom";

function usePortalDropdownLayout({
  open,
  rootRef,
  placement,
  estimatedHeight,
  minWidth,
  align,
}: {
  open: boolean;
  rootRef: { current: HTMLDivElement | null };
  placement?: PanelPlacement;
  estimatedHeight: number;
  minWidth: number;
  align?: "start" | "end";
}) {
  const [layout, setLayout] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: PanelPlacement;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }

    const EDGE = 10;
    const GAP = 10;
    const MIN_HEIGHT = 88;
    const MAX_HEIGHT = 460;

    const update = () => {
      const el = rootRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const doc = document.documentElement;
      const viewportWidth = doc?.clientWidth || window.innerWidth;
      const viewportHeight = doc?.clientHeight || window.innerHeight;
      const vw = Math.min(window.innerWidth, viewportWidth);
      const vh = Math.min(window.innerHeight, viewportHeight);

      const spaceBelow = Math.max(0, vh - rect.bottom - EDGE);
      const spaceAbove = Math.max(0, rect.top - EDGE);
      let computedPlacement: PanelPlacement = placement
        ? placement
        : spaceBelow < estimatedHeight && spaceAbove > spaceBelow
          ? "top"
          : "bottom";

      const preferredSpace = computedPlacement === "top" ? spaceAbove : spaceBelow;
      const fallbackSpace = computedPlacement === "top" ? spaceBelow : spaceAbove;
      if (!placement && preferredSpace < 120 && fallbackSpace > preferredSpace + 24) {
        computedPlacement = computedPlacement === "top" ? "bottom" : "top";
      }

      const maxViewportWidth = Math.max(180, vw - EDGE * 2);
      const width = Math.min(Math.max(minWidth, rect.width), maxViewportWidth);
      let left = align === "end" ? rect.right - width : rect.left;
      if (align === "end") left -= 8;
      if (left + width > vw - EDGE) left = Math.max(EDGE, rect.right - width);
      if (left < EDGE) left = EDGE;
      left = Math.min(left, Math.max(EDGE, vw - EDGE - width));

      const availableHeight = computedPlacement === "top" ? spaceAbove : spaceBelow;
      const panelSpace = Math.max(72, availableHeight - GAP);
      const maxHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, panelSpace));
      const top = computedPlacement === "top" ? rect.top - GAP : rect.bottom + GAP;

      setLayout({ top, left, width, maxHeight, placement: computedPlacement });
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, rootRef, placement, estimatedHeight, minWidth, align]);

  return layout;
}

function Dropdown({
  value,
  placeholder,
  groups,
  onPick,
  placement,
  includeAny = false,
}: {
  value: string | null;
  placeholder: string;
  groups: { group: string; items: VersionItem[] }[];
  onPick: (id: string | null) => void;
  placement?: "top" | "bottom";
  includeAny?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const layout = usePortalDropdownLayout({
    open,
    rootRef,
    placement,
    estimatedHeight: 380,
    minWidth: 280,
  });

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open) return;
      const target = e.target as Node;
      const el = rootRef.current;
      const panel = panelRef.current;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (el && path.includes(el)) return;
      if (panel && path.includes(panel)) return;
      if (el?.contains(target) || panel?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      setQ("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return groups;
    return groups
      .map((g) => ({
        group: g.group,
        items: g.items.filter((it) => it.id.toLowerCase().includes(qq)),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, q]);

  return (
    <div className={`dropdown ${open ? "open" : ""}`} ref={rootRef}>
      <div
        className={`dropBtn ${value ? "value" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <div>{value ?? placeholder}</div>
        <div style={{ opacity: 0.7 }}>▾</div>
      </div>

      {open && layout
        ? createPortal(
            <div
              ref={panelRef}
              className={`dropPanel portal ${layout.placement === "top" ? "top" : ""}`}
              style={{
                top: layout.top,
                left: layout.left,
                width: layout.width,
                maxHeight: layout.maxHeight,
                transform: layout.placement === "top" ? "translateY(-100%)" : "none",
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                className="input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search versions…"
                autoFocus
              />

              <div style={{ height: 10 }} />

              {filtered.length === 0 ? (
                <div style={{ padding: 10, color: "var(--muted)", fontWeight: 900 }}>
                  No matches
                </div>
              ) : (
                <>
                  {includeAny ? (
                    <div>
                      <div className="groupHdr">General</div>
                      <div
                        className={`dropItem ${value === null ? "active" : ""}`}
                        onClick={() => {
                          onPick(null);
                          setOpen(false);
                          setQ("");
                        }}
                      >
                        Any
                      </div>
                    </div>
                  ) : null}
                  {filtered.map((g) => (
                    <div key={g.group}>
                      <div className="groupHdr">{g.group}</div>
                      {g.items.map((it) => (
                        <div
                          key={it.id}
                          className={`dropItem ${it.id === value ? "active" : ""}`}
                          onClick={() => {
                            onPick(it.id);
                            setOpen(false);
                            setQ("");
                          }}
                        >
                          {it.id}
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function MultiSelectDropdown({
  values,
  placeholder,
  groups,
  onChange,
  placement,
}: {
  values: string[];
  placeholder: string;
  groups: { group: string; items: { id: string; label: string }[] }[];
  onChange: (v: string[]) => void;
  placement?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const layout = usePortalDropdownLayout({
    open,
    rootRef,
    placement,
    estimatedHeight: 420,
    minWidth: 300,
  });

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open) return;
      const target = e.target as Node;
      const el = rootRef.current;
      const panel = panelRef.current;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (el && path.includes(el)) return;
      if (panel && path.includes(panel)) return;
      if (el?.contains(target) || panel?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      setQ("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return groups;
    return groups
      .map((g) => ({
        group: g.group,
        items: g.items.filter(
          (it) =>
            it.id.toLowerCase().includes(qq) ||
            it.label.toLowerCase().includes(qq)
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, q]);

  const label = useMemo(() => {
    if (!values || values.length === 0) return placeholder;
    const map = new Map<string, string>();
    for (const g of groups) for (const it of g.items) map.set(it.id, it.label);
    const labels = values.map((v) => map.get(v) ?? v).filter(Boolean);
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]}, ${labels[1]}`;
    return `${labels[0]} +${labels.length - 1}`;
  }, [groups, placeholder, values]);

  const toggle = (id: string) => {
    const set = new Set(values);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange(Array.from(set));
  };

  return (
    <div className={`dropdown ${open ? "open" : ""}`} ref={rootRef}>
      <div
        className={`dropBtn ${values.length ? "value" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <div>{label}</div>
        <div style={{ opacity: 0.7 }}>▾</div>
      </div>

      {open && layout
        ? createPortal(
            <div
              ref={panelRef}
              className={`dropPanel portal ${layout.placement === "top" ? "top" : ""}`}
              style={{
                top: layout.top,
                left: layout.left,
                width: layout.width,
                maxHeight: layout.maxHeight,
                transform: layout.placement === "top" ? "translateY(-100%)" : "none",
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                className="input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search categories…"
                autoFocus
              />

              <div style={{ height: 10 }} />

              {filtered.length === 0 ? (
                <div style={{ padding: 10, color: "var(--muted)", fontWeight: 900 }}>
                  No matches
                </div>
              ) : (
                filtered.map((g) => (
                  <div key={g.group}>
                    <div className="groupHdr">{g.group}</div>
                    {g.items.map((it) => {
                      const checked = values.includes(it.id);
                      return (
                        <div
                          key={it.id}
                          className={`dropItem ${checked ? "active" : ""}`}
                          style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
                          onClick={() => toggle(it.id)}
                        >
                          <div style={{ paddingRight: 12 }}>{it.label}</div>
                          <div style={{ opacity: checked ? 1 : 0.35, fontWeight: 1000 }}>
                            {checked ? "✓" : ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}

              <div style={{ height: 12 }} />
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  className="dropMiniBtn"
                  onClick={() => {
                    onChange([]);
                    setQ("");
                  }}
                >
                  Clear
                </button>
                <div style={{ flex: 1 }} />
                <button
                  className="dropMiniBtn"
                  onClick={() => {
                    setOpen(false);
                    setQ("");
                  }}
                >
                  Done
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function MenuSelect({
  value,
  labelPrefix,
  options,
  onChange,
  placement,
  align,
}: {
  value: string;
  labelPrefix: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  placement?: "top" | "bottom";
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const layout = usePortalDropdownLayout({
    open,
    rootRef,
    placement,
    estimatedHeight: 260,
    minWidth: 190,
    align,
  });

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!open) return;
      const target = e.target as Node;
      const el = rootRef.current;
      const panel = panelRef.current;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (el && path.includes(el)) return;
      if (panel && path.includes(panel)) return;
      if (el?.contains(target) || panel?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const label = useMemo(() => {
    const hit = options.find((o) => o.value === value);
    return hit?.label ?? value;
  }, [options, value]);

  return (
    <div className={`dropdown ${open ? "open" : ""}`} ref={rootRef}>
      <div className="dropBtn value" onClick={() => setOpen((o) => !o)}>
        <div>
          {labelPrefix}: {label}
        </div>
        <div style={{ opacity: 0.7 }}>▾</div>
      </div>

      {open && layout
        ? createPortal(
            <div
              ref={panelRef}
              className={`dropPanel portal ${layout.placement === "top" ? "top" : ""}`}
              style={{
                top: layout.top,
                left: layout.left,
                width: layout.width,
                maxHeight: layout.maxHeight,
                transform: layout.placement === "top" ? "translateY(-100%)" : "none",
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {options.map((o) => (
                <div
                  key={o.value}
                  className={`menuItem ${o.value === value ? "active" : ""}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <div>{o.label}</div>
                  <div className="menuCheck">{o.value === value ? "✓" : ""}</div>
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function SegmentedControl({
  value,
  options,
  onChange,
  variant = "default",
  className,
}: {
  value: string | null;
  options: { value: string | null; label: string }[];
  onChange: (v: string | null) => void;
  variant?: "default" | "scroll";
  className?: string;
}) {
  return (
    <div className={`segmented ${variant === "scroll" ? "scroll" : ""} ${className ?? ""}`}>
      {options.map((o) => (
        <button
          key={o.label}
          className={`segBtn ${o.value === value ? "active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LoaderChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`btn ${active ? "primary" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

export default function App() {
  // theme
  const [uiSettingsSeed] = useState<UiSettingsSnapshot>(() => readUiSettingsSnapshot());
  const [theme, setTheme] = useState<"dark" | "light">(uiSettingsSeed.theme);
  const [accentPreset, setAccentPreset] = useState<AccentPreset>(uiSettingsSeed.accentPreset);
  const [accentStrength, setAccentStrength] = useState<AccentStrength>(
    uiSettingsSeed.accentStrength
  );
  const [motionPreset, setMotionPreset] = useState<MotionPreset>(uiSettingsSeed.motionPreset);
  const [densityPreset, setDensityPreset] = useState<DensityPreset>(uiSettingsSeed.densityPreset);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute("data-accent", accentPreset);
  }, [accentPreset]);
  useEffect(() => {
    document.documentElement.setAttribute("data-accent-strength", accentStrength);
  }, [accentStrength]);
  useEffect(() => {
    document.documentElement.setAttribute("data-motion", motionPreset);
  }, [motionPreset]);
  useEffect(() => {
    document.documentElement.setAttribute("data-density", densityPreset);
  }, [densityPreset]);
  useEffect(() => {
    persistUiSettingsSnapshot({
      theme,
      accentPreset,
      accentStrength,
      motionPreset,
      densityPreset,
    });
  }, [theme, accentPreset, accentStrength, motionPreset, densityPreset]);

  const [route, setRoute] = useState<Route>("library");

  // instances
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => instances.find((x) => x.id === selectedId) ?? null,
    [instances, selectedId]
  );

  // library UI state (frontend only)
  const [libraryScope, setLibraryScope] = useState<"all" | "downloaded" | "custom">("all");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [librarySort, setLibrarySort] = useState<"recent" | "name">("recent");
  const [libraryGroupBy, setLibraryGroupBy] = useState<LibraryGroupBy>("none");
  const [libraryContextMenu, setLibraryContextMenu] =
    useState<LibraryContextMenuState | null>(null);
  const libraryContextMenuRef = useRef<HTMLDivElement | null>(null);

  // instance page UI state (frontend only)
  const [instanceTab, setInstanceTab] = useState<"content" | "worlds" | "logs" | "settings">("content");
  const [instanceContentType, setInstanceContentType] = useState<"mods" | "resourcepacks" | "datapacks" | "shaders">("mods");
  const [instanceQuery, setInstanceQuery] = useState("");
  const [logFilterQuery, setLogFilterQuery] = useState("");
  const [logSeverityFilter, setLogSeverityFilter] = useState<"all" | InstanceLogSeverity>("all");
  const [logSourceFilter, setLogSourceFilter] = useState<InstanceLogSource>("live");
  const [logViewMode, setLogViewMode] = useState<LogViewMode>("live");
  const [logQuickFilters, setLogQuickFilters] = useState<Record<QuickLogFilter, boolean>>({
    errors: false,
    warnings: false,
    suspects: false,
    crashes: false,
  });
  const [logAnalyzeInput, setLogAnalyzeInput] = useState("");
  const [logAnalyzeResult, setLogAnalyzeResult] = useState<LogAnalyzeResult | null>(null);
  const [logAnalyzeBusy, setLogAnalyzeBusy] = useState(false);
  const [logAnalyzeSourcesUsed, setLogAnalyzeSourcesUsed] = useState<InstanceLogSource[]>([]);
  const [logAnalyzeMissingCrash, setLogAnalyzeMissingCrash] = useState(false);
  const [selectedCrashSuspect, setSelectedCrashSuspect] = useState<string | null>(null);
  const [logMaxLines, setLogMaxLines] = useState<number>(() => {
    if (typeof window === "undefined") return 2500;
    const raw = Number.parseInt(localStorage.getItem("mpm.logs.max_lines.v1") ?? "2500", 10);
    if (!Number.isFinite(raw)) return 2500;
    return Math.max(200, Math.min(12000, raw));
  });
  const [logLoadBusy, setLogLoadBusy] = useState(false);
  const [logLoadErr, setLogLoadErr] = useState<string | null>(null);
  const [rawLogLinesBySource, setRawLogLinesBySource] = useState<Record<string, ReadInstanceLogsResult>>({});
  const [logWindowBySource, setLogWindowBySource] = useState<Record<string, LogWindowState>>({});
  const logLoadRequestSeqRef = useRef(0);
  const [instanceSettingsOpen, setInstanceSettingsOpen] = useState(false);
  const [instanceSettingsSection, setInstanceSettingsSection] = useState<
    "general" | "installation" | "java" | "graphics" | "content"
  >("general");
  const [instanceSettingsBusy, setInstanceSettingsBusy] = useState(false);
  const [instanceNameDraft, setInstanceNameDraft] = useState("");
  const [instanceNotesDraft, setInstanceNotesDraft] = useState("");
  const [instanceJavaPathDraft, setInstanceJavaPathDraft] = useState("");
  const [instanceMemoryDraft, setInstanceMemoryDraft] = useState("4096");
  const [instanceJvmArgsDraft, setInstanceJvmArgsDraft] = useState("");
  const [javaRuntimeCandidates, setJavaRuntimeCandidates] = useState<JavaRuntimeCandidate[]>([]);
  const [javaRuntimeBusy, setJavaRuntimeBusy] = useState(false);

  function openInstance(id: string) {
    setLibraryContextMenu(null);
    setSelectedId(id);
    setRoute("instance");
  }

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshInstances() {
    const list = await listInstances();
    setInstances(list);
    if (selectedId && !list.some((x) => x.id === selectedId)) {
      setSelectedId(null);
    }
  }

  async function refreshLauncherData() {
    const [settings, accounts, running] = await Promise.all([
      getLauncherSettings(),
      listLauncherAccounts(),
      listRunningInstances(),
    ]);
    setLauncherSettingsState(settings);
    setLauncherAccounts(accounts);
    const runningSafe = normalizeRunningInstancesPayload(running);
    setRunningInstances((prev) => (sameRunningInstances(prev, runningSafe) ? prev : runningSafe));
    setJavaPathDraft(settings.java_path ?? "");
    setOauthClientIdDraft(settings.oauth_client_id ?? "");
    setLaunchMethodPick(settings.default_launch_method ?? "native");
    setUpdateCheckCadence(normalizeUpdateCheckCadence(settings.update_check_cadence));
    setUpdateAutoApplyMode(normalizeUpdateAutoApplyMode(settings.update_auto_apply_mode));
    setUpdateApplyScope(normalizeUpdateApplyScope(settings.update_apply_scope));
  }

  async function refreshAccountDiagnostics() {
    const startedAt = performance.now();
    setAccountDiagnosticsBusy(true);
    setAccountDiagnosticsErr(null);
    try {
      const info = await getSelectedAccountDiagnostics();
      setAccountDiagnostics(info);
      return info;
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setAccountDiagnosticsErr(msg);
      return null;
    } finally {
      const duration = Math.round(performance.now() - startedAt);
      if (duration > 900) {
        console.info(`[perf] account diagnostics took ${duration}ms`);
      }
      setAccountDiagnosticsBusy(false);
    }
  }

  useEffect(() => {
    Promise.all([refreshInstances(), refreshLauncherData()]).catch((e) =>
      setError(String(e))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const shouldDetect =
      route === "settings" || (instanceSettingsOpen && instanceSettingsSection === "java");
    if (!shouldDetect || javaRuntimeCandidates.length > 0 || javaRuntimeBusy) return;
    refreshJavaRuntimeCandidates().catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, instanceSettingsOpen, instanceSettingsSection, javaRuntimeCandidates.length, javaRuntimeBusy]);

  const [presets, setPresets] = useState<UserPreset[]>([]);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [modpacksStudioTab, setModpacksStudioTab] = useState<"creator" | "templates" | "saved" | "config">("creator");
  const [creatorDraft, setCreatorDraft] = useState<UserPreset | null>(null);
  const [instanceWorlds, setInstanceWorlds] = useState<InstanceWorld[]>([]);
  const [presetPreview, setPresetPreview] = useState<PresetApplyPreview | null>(null);
  const [presetPreviewBusy, setPresetPreviewBusy] = useState(false);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateQueryDebounced, setTemplateQueryDebounced] = useState("");
  const [templateSource, setTemplateSource] = useState<DiscoverSource>("all");
  const [templateType, setTemplateType] = useState<"modpacks" | "datapacks">("modpacks");
  const [templateHits, setTemplateHits] = useState<DiscoverSearchHit[]>([]);
  const [templateTotalHits, setTemplateTotalHits] = useState(0);
  const [templateOffset, setTemplateOffset] = useState(0);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateErr, setTemplateErr] = useState<string | null>(null);

  useEffect(() => {
    if (creatorDraft) return;
    const baseName = selected ? `${selected.name} custom preset` : "Custom preset";
    setCreatorDraft({
      id: `preset_${Date.now()}`,
      name: baseName,
      created_at: new Date().toISOString(),
      source_instance_id: selected?.id ?? "custom",
      source_instance_name: selected?.name ?? "Custom",
      entries: [],
      settings: defaultPresetSettings(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, creatorDraft]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("mpm.presets.v2") ?? localStorage.getItem("mpm.presets.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as UserPreset[];
      if (Array.isArray(parsed)) {
        setPresets(parsed);
      }
    } catch {
      // ignore invalid local preset data
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("mpm.presets.v2", JSON.stringify(presets));
  }, [presets]);

  useEffect(() => {
    const t = window.setTimeout(() => setTemplateQueryDebounced(templateQuery), 240);
    return () => window.clearTimeout(t);
  }, [templateQuery]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      listRunningInstances()
        .then((items) => {
          if (cancelled) return;
          const next = normalizeRunningInstancesPayload(items);
          setRunningInstances((prev) => (sameRunningInstances(prev, next) ? prev : next));
        })
        .catch(() => null);
    };
    const intervalMs = route === "library" || route === "instance" ? 3000 : 9000;
    poll();
    const t = window.setInterval(() => {
      if (document.hidden) return;
      poll();
    }, intervalMs);
    const onVisibility = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(t);
    };
  }, [route]);

  // create modal state
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<"custom" | "file" | "launcher">("custom");
  const [name, setName] = useState("");
  const [loader, setLoader] = useState<Loader>("fabric");
  const [createIconPath, setCreateIconPath] = useState<string | null>(null);
  const [createPackFilePath, setCreatePackFilePath] = useState<string | null>(null);
  const [launcherImportSources, setLauncherImportSources] = useState<LauncherImportSource[]>([]);
  const [launcherImportBusy, setLauncherImportBusy] = useState(false);
  const [selectedLauncherImportSourceId, setSelectedLauncherImportSourceId] = useState<string | null>(null);

  // versions list
  const [discoverAllVersions, setDiscoverAllVersions] = useState(false);
  const [createAllVersions, setCreateAllVersions] = useState(false);
  const [manifest, setManifest] = useState<VersionItem[]>(FALLBACK_VERSIONS);
  const [mcVersion, setMcVersion] = useState<string | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);

  useEffect(() => {
    fetchOfficialManifest()
      .then((list) => setManifest(list.length ? list : FALLBACK_VERSIONS))
      .catch((e) => setManifestError(String(e)));
  }, []);

  useEffect(() => {
    if (!showCreate || createMode !== "launcher") return;
    refreshLauncherImportSources().catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreate, createMode]);

  const visibleCreateVersions = useMemo(() => {
    return createAllVersions ? manifest : manifest.filter((v) => v.type === "release");
  }, [manifest, createAllVersions]);

  const visibleDiscoverVersions = useMemo(() => {
    return discoverAllVersions ? manifest : manifest.filter((v) => v.type === "release");
  }, [manifest, discoverAllVersions]);

  const groupedCreateVersions = useMemo(
    () =>
      createAllVersions
        ? groupAllVersions(visibleCreateVersions)
        : groupVersions(visibleCreateVersions),
    [visibleCreateVersions, createAllVersions]
  );

  const groupedDiscoverVersions = useMemo(
    () =>
      discoverAllVersions
        ? groupAllVersions(visibleDiscoverVersions)
        : groupVersions(visibleDiscoverVersions),
    [visibleDiscoverVersions, discoverAllVersions]
  );
  const instanceVersionOptions = useMemo(() => {
    const values = new Set<string>();
    for (const item of manifest) {
      if (item.type === "release") values.add(item.id);
    }
    if (selected?.mc_version) values.add(selected.mc_version);
    return Array.from(values)
      .sort(compareReleaseIdDesc)
      .slice(0, 80)
      .map((value) => ({ value, label: value }));
  }, [manifest, selected?.mc_version]);

  useEffect(() => {
    if (!instanceSettingsOpen || !selected) return;
    const normalized = normalizeInstanceSettings(selected.settings);
    setInstanceNameDraft(selected.name);
    setInstanceNotesDraft(normalized.notes);
    setInstanceJavaPathDraft(normalized.java_path);
    setInstanceMemoryDraft(String(normalized.memory_mb));
    setInstanceJvmArgsDraft(normalized.jvm_args);
  }, [instanceSettingsOpen, selected]);

  async function onPickCreateIcon() {
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setCreateIconPath(picked);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    }
  }

  async function onPickCreateModpackFile() {
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Modpack archive", extensions: ["mrpack", "zip"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setCreatePackFilePath(picked);
      if (!name.trim()) {
        setName(basenameWithoutExt(picked));
      }
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    }
  }

  async function refreshLauncherImportSources() {
    setLauncherImportBusy(true);
    setError(null);
    try {
      const list = await listLauncherImportSources();
      setLauncherImportSources(list);
      setSelectedLauncherImportSourceId((prev) => {
        if (prev && list.some((item) => item.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setLauncherImportBusy(false);
    }
  }

  async function onAddCustomSkin() {
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Minecraft skin", extensions: ["png"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      const entry: SavedCustomSkin = {
        id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        label: basenameWithoutExt(picked),
        skin_path: picked,
      };
      setCustomSkins((prev) => [entry, ...prev.filter((row) => row.skin_path !== entry.skin_path)]);
      setSelectedAccountSkinId(`custom:${entry.id}`);
      setInstallNotice(`Added custom skin "${entry.label}".`);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    }
  }

  function onCycleAccountCape() {
    if (capeOptions.length <= 1) return;
    setSelectedAccountCapeId((prev) => {
      const currentIdx = Math.max(
        0,
        capeOptions.findIndex((cape) => cape.id === prev)
      );
      const nextIdx = (currentIdx + 1) % capeOptions.length;
      return capeOptions[nextIdx]?.id ?? "none";
    });
  }

  function onRemoveSelectedCustomSkin() {
    if (!selectedAccountSkin || selectedAccountSkin.origin !== "custom") return;
    const token = selectedAccountSkin.id.replace(/^custom:/, "");
    setCustomSkins((prev) => prev.filter((row) => row.id !== token));
    setSelectedAccountSkinId(null);
    setInstallNotice(`Removed custom skin "${selectedAccountSkin.label}".`);
  }

  async function onSelectInstanceIcon(inst: Instance) {
    setError(null);
    setBusy("instance-icon");
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      await setInstanceIcon({ instanceId: inst.id, iconPath: picked });
      await refreshInstances();
      setInstallNotice(`Updated icon for ${inst.name}.`);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onRemoveInstanceIcon(inst: Instance) {
    setError(null);
    setBusy("instance-icon");
    try {
      await setInstanceIcon({ instanceId: inst.id, iconPath: null });
      await refreshInstances();
      setInstallNotice(`Removed icon for ${inst.name}.`);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function refreshJavaRuntimeCandidates() {
    setJavaRuntimeBusy(true);
    setLauncherErr(null);
    setError(null);
    try {
      const runtimes = await detectJavaRuntimes();
      const deduped = Array.from(new Map(runtimes.map((rt) => [rt.path, rt])).values()).sort(
        (a, b) => b.major - a.major || a.path.localeCompare(b.path)
      );
      setJavaRuntimeCandidates(deduped);
      if (deduped.length === 0) {
        setInstallNotice("No Java runtimes detected automatically. You can still choose one manually.");
      } else {
        setInstallNotice(
          `Detected ${deduped.length} Java runtime${deduped.length === 1 ? "" : "s"}.`
        );
      }
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setLauncherErr(msg);
      setError(msg);
    } finally {
      setJavaRuntimeBusy(false);
    }
  }

  async function onPickLauncherJavaPath() {
    setLauncherErr(null);
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
      });
      if (!picked || Array.isArray(picked)) return;
      setJavaPathDraft(picked);
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setLauncherErr(msg);
      setError(msg);
    }
  }

  async function onPickInstanceJavaPath(inst: Instance) {
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
      });
      if (!picked || Array.isArray(picked)) return;
      setInstanceJavaPathDraft(picked);
      await persistInstanceChanges(inst, {
        settings: {
          java_path: picked,
        },
      });
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    }
  }

  async function persistInstanceChanges(
    inst: Instance,
    patch: {
      name?: string;
      mcVersion?: string;
      loader?: Loader;
      settings?: Partial<InstanceSettings>;
    },
    successMessage?: string
  ) {
    setInstanceSettingsBusy(true);
    setError(null);
    try {
      const live = instances.find((x) => x.id === inst.id) ?? inst;
      const payload: {
        instanceId: string;
        name?: string;
        mcVersion?: string;
        loader?: Loader;
        settings?: InstanceSettings;
      } = { instanceId: live.id };
      if (typeof patch.name === "string") payload.name = patch.name;
      if (typeof patch.mcVersion === "string") payload.mcVersion = patch.mcVersion;
      if (typeof patch.loader === "string") payload.loader = patch.loader;
      if (patch.settings) {
        payload.settings = normalizeInstanceSettings({
          ...normalizeInstanceSettings(live.settings),
          ...patch.settings,
        });
      }
      const updated = await updateInstance(payload);
      setInstances((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      const normalized = normalizeInstanceSettings(updated.settings);
      setInstanceNameDraft(updated.name);
      setInstanceNotesDraft(normalized.notes);
      setInstanceJavaPathDraft(normalized.java_path);
      setInstanceMemoryDraft(String(normalized.memory_mb));
      setInstanceJvmArgsDraft(normalized.jvm_args);
      if (successMessage) setInstallNotice(successMessage);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setInstanceSettingsBusy(false);
    }
  }

  async function onCommitInstanceName(inst: Instance) {
    const trimmed = instanceNameDraft.trim();
    if (!trimmed) {
      setError("Instance name cannot be empty.");
      setInstanceNameDraft(inst.name);
      return;
    }
    if (trimmed === inst.name) return;
    await persistInstanceChanges(inst, { name: trimmed }, "Instance name saved.");
  }

  async function onCommitInstanceNotes(inst: Instance) {
    const current = normalizeInstanceSettings(inst.settings).notes;
    if (instanceNotesDraft === current) return;
    await persistInstanceChanges(
      inst,
      {
        settings: {
          notes: instanceNotesDraft,
        },
      },
      "Notes saved."
    );
  }

  async function onCommitInstanceJavaPath(inst: Instance) {
    const next = instanceJavaPathDraft.trim();
    const current = normalizeInstanceSettings(inst.settings).java_path;
    if (next === current) return;
    await persistInstanceChanges(
      inst,
      {
        settings: {
          java_path: next,
        },
      },
      next ? "Instance Java path updated." : "Instance Java override cleared."
    );
  }

  async function onCommitInstanceMemory(inst: Instance) {
    const parsed = Number(instanceMemoryDraft);
    if (!Number.isFinite(parsed)) {
      setError("Memory must be a number in MB.");
      setInstanceMemoryDraft(String(normalizeInstanceSettings(inst.settings).memory_mb));
      return;
    }
    const clamped = Math.max(512, Math.min(65536, Math.round(parsed)));
    setInstanceMemoryDraft(String(clamped));
    const current = normalizeInstanceSettings(inst.settings).memory_mb;
    if (clamped === current) return;
    await persistInstanceChanges(
      inst,
      {
        settings: {
          memory_mb: clamped,
        },
      },
      "Instance memory saved."
    );
  }

  async function onCommitInstanceJvmArgs(inst: Instance) {
    const next = instanceJvmArgsDraft.trim();
    const current = normalizeInstanceSettings(inst.settings).jvm_args;
    if (next === current) return;
    await persistInstanceChanges(
      inst,
      {
        settings: {
          jvm_args: next,
        },
      },
      "JVM args saved."
    );
  }

  async function onCreate() {
    setError(null);
    setBusy("create");
    try {
      let inst: Instance;
      if (createMode === "custom") {
        if (!name.trim()) throw new Error("Name is required");
        if (!mcVersion) throw new Error("Pick a game version");
        inst = await createInstance({ name, mcVersion, loader, iconPath: createIconPath });
      } else if (createMode === "file") {
        if (!createPackFilePath) throw new Error("Pick a modpack archive first.");
        const result: CreateInstanceFromModpackFileResult = await createInstanceFromModpackFile({
          filePath: createPackFilePath,
          name: name.trim() || undefined,
          iconPath: createIconPath,
        });
        inst = result.instance;
        if (result.warnings.length > 0) {
          setInstallNotice(
            `Imported ${result.imported_files} override file${result.imported_files === 1 ? "" : "s"} with warnings: ${result.warnings.join(" | ")}`
          );
        } else {
          setInstallNotice(
            `Imported modpack archive with ${result.imported_files} override file${result.imported_files === 1 ? "" : "s"}.`
          );
        }
      } else {
        if (!selectedLauncherImportSourceId) throw new Error("Select a launcher source first.");
        const result: ImportInstanceFromLauncherResult = await importInstanceFromLauncher({
          sourceId: selectedLauncherImportSourceId,
          name: name.trim() || undefined,
          iconPath: createIconPath,
        });
        inst = result.instance;
        setInstallNotice(
          `Imported ${result.imported_files} file${result.imported_files === 1 ? "" : "s"} from launcher source.`
        );
      }
      await refreshInstances();

      setSelectedId(inst.id);
      setShowCreate(false);
      setRoute("library");

      // reset
      setCreateMode("custom");
      setName("");
      setLoader("fabric");
      setCreateIconPath(null);
      setCreatePackFilePath(null);
      setSelectedLauncherImportSourceId(null);
      setCreateAllVersions(false);
      setMcVersion(null);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  function requestDelete(inst: Instance) {
    setLibraryContextMenu(null);
    setDeleteTarget(inst);
  }

  async function onDelete() {
    if (!deleteTarget) return;
    setError(null);
    setBusy("delete");
    try {
      await deleteInstance(deleteTarget.id);
      await refreshInstances();
      if (selectedId === deleteTarget.id) {
        setSelectedId(null);
        setRoute("library");
        setInstanceSettingsOpen(false);
      }
      setDeleteTarget(null);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  // Discover (Step 2)
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<DiscoverSearchHit[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(20);
  const [index, setIndex] = useState<ModrinthIndex>("relevance");
  const [discoverSource, setDiscoverSource] = useState<DiscoverSource>("all");
  const [discoverContentType, setDiscoverContentType] = useState<DiscoverContentType>("mods");
  const [filterLoaders, setFilterLoaders] = useState<string[]>([]);
  const [filterVersion, setFilterVersion] = useState<string | null>(null);
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [discoverErr, setDiscoverErr] = useState<string | null>(null);
  const [discoverBusy, setDiscoverBusy] = useState(false);

  const page = useMemo(() => Math.floor(offset / limit) + 1, [offset, limit]);
  const pages = useMemo(() => Math.max(1, Math.ceil(totalHits / limit)), [totalHits, limit]);

  const [projectOpen, setProjectOpen] = useState<Project | null>(null);
  const [projectVersions, setProjectVersions] = useState<ProjectVersion[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [projectDetailTab, setProjectDetailTab] = useState<ProjectDetailTab>("overview");
  const [projectCopyNotice, setProjectCopyNotice] = useState<string | null>(null);
  const [curseforgeOpen, setCurseforgeOpen] = useState<CurseforgeProjectDetail | null>(null);
  const [curseforgeDetailTab, setCurseforgeDetailTab] = useState<CurseforgeDetailTab>("overview");
  const [curseforgeBusy, setCurseforgeBusy] = useState(false);
  const [curseforgeErr, setCurseforgeErr] = useState<string | null>(null);
  const [projectOpenContentType, setProjectOpenContentType] = useState<DiscoverContentType>("mods");
  const [curseforgeOpenContentType, setCurseforgeOpenContentType] = useState<DiscoverContentType>("mods");

  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(null);
  const [installInstanceQuery, setInstallInstanceQuery] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectErr, setProjectErr] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Instance | null>(null);
  const [installedMods, setInstalledMods] = useState<InstalledMod[]>([]);
  const [selectedModVersionIds, setSelectedModVersionIds] = useState<string[]>([]);
  const [modsBusy, setModsBusy] = useState(false);
  const [modsErr, setModsErr] = useState<string | null>(null);
  const [toggleBusyVersion, setToggleBusyVersion] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<InstallProgressEvent | null>(null);
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [installNotice, setInstallNotice] = useState<string | null>(null);
  const [instanceActivityById, setInstanceActivityById] = useState<
    Record<string, InstanceActivityEntry[]>
  >({});
  const lastInstallNoticeRef = useRef<string | null>(null);
  const [importingInstanceId, setImportingInstanceId] = useState<string | null>(null);
  const [launchBusyInstanceId, setLaunchBusyInstanceId] = useState<string | null>(null);
  const [launchCancelBusyInstanceId, setLaunchCancelBusyInstanceId] = useState<string | null>(null);
  const [launchStageByInstance, setLaunchStageByInstance] = useState<
    Record<string, { status: string; label: string; message: string; updated_at: number }>
  >({});
  const [launchProgressChecksByInstance, setLaunchProgressChecksByInstance] = useState<
    Record<string, LaunchHealthChecks>
  >({});
  const [launchHealthByInstance, setLaunchHealthByInstance] = useState<Record<string, LaunchHealthRecord>>(() => {
    try {
      const raw = localStorage.getItem("mpm.launchHealth.v1");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as Record<string, LaunchHealthRecord>;
    } catch {
      return {};
    }
  });
  const [launchHealthDismissedByInstance, setLaunchHealthDismissedByInstance] = useState<
    Record<string, boolean>
  >(() => {
    try {
      const raw = localStorage.getItem("mpm.launchHealth.dismissed.v1");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const [launchFailureByInstance, setLaunchFailureByInstance] = useState<
    Record<string, LaunchFailureRecord>
  >({});
  const [launchMethodPick, setLaunchMethodPick] = useState<LaunchMethod>("native");
  const [updateCheckCadence, setUpdateCheckCadence] = useState<SchedulerCadence>("daily");
  const [updateAutoApplyMode, setUpdateAutoApplyMode] = useState<SchedulerAutoApplyMode>("never");
  const [updateApplyScope, setUpdateApplyScope] = useState<SchedulerApplyScope>("scheduled_only");
  const [launcherSettings, setLauncherSettingsState] = useState<LauncherSettings | null>(null);
  const [launcherAccounts, setLauncherAccounts] = useState<LauncherAccount[]>([]);
  const [runningInstances, setRunningInstances] = useState<RunningInstance[]>([]);
  const [launcherErr, setLauncherErr] = useState<string | null>(null);
  const [launcherBusy, setLauncherBusy] = useState(false);
  const [msLoginSessionId, setMsLoginSessionId] = useState<string | null>(null);
  const [msLoginState, setMsLoginState] = useState<MicrosoftLoginState | null>(null);
  const [msCodePrompt, setMsCodePrompt] = useState<MicrosoftCodePrompt | null>(null);
  const [msCodePromptVisible, setMsCodePromptVisible] = useState(false);
  const [msCodeCopied, setMsCodeCopied] = useState(false);
  const [javaPathDraft, setJavaPathDraft] = useState("");
  const [curseforgeApiStatus, setCurseforgeApiStatus] = useState<CurseforgeApiStatus | null>(null);
  const [curseforgeApiBusy, setCurseforgeApiBusy] = useState(false);
  const [oauthClientIdDraft, setOauthClientIdDraft] = useState("");
  const [showAdvancedClientId, setShowAdvancedClientId] = useState(false);
  const [accountDiagnostics, setAccountDiagnostics] = useState<AccountDiagnostics | null>(() =>
    readCachedAccountDiagnostics()
  );
  const [accountDiagnosticsBusy, setAccountDiagnosticsBusy] = useState(false);
  const [accountDiagnosticsErr, setAccountDiagnosticsErr] = useState<string | null>(null);
  const [accountAvatarFromSkin, setAccountAvatarFromSkin] = useState<string | null>(null);
  const [accountAvatarSourceIdx, setAccountAvatarSourceIdx] = useState(0);
  const [customSkins, setCustomSkins] = useState<SavedCustomSkin[]>(() => {
    try {
      const raw = localStorage.getItem("mpm.account.custom_skins.v1");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => ({
          id: String(item?.id ?? "").trim() || `custom:${Math.random().toString(36).slice(2)}`,
          label: String(item?.label ?? "").trim() || "Custom skin",
          skin_path: String(item?.skin_path ?? "").trim(),
        }))
        .filter((item) => item.skin_path);
    } catch {
      return [];
    }
  });
  const [instanceLaunchHooksById, setInstanceLaunchHooksById] = useState<
    Record<string, InstanceLaunchHooksDraft>
  >(() => {
    try {
      const raw = localStorage.getItem("mpm.instance.launch_hooks.v1");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      const normalized: Record<string, InstanceLaunchHooksDraft> = {};
      for (const [id, value] of Object.entries(parsed as Record<string, any>)) {
        if (!id) continue;
        normalized[id] = {
          enabled: Boolean(value?.enabled),
          pre_launch: String(value?.pre_launch ?? ""),
          wrapper: String(value?.wrapper ?? ""),
          post_exit: String(value?.post_exit ?? ""),
        };
      }
      return normalized;
    } catch {
      return {};
    }
  });
  const [selectedAccountSkinId, setSelectedAccountSkinId] = useState<string | null>(null);
  const [selectedAccountCapeId, setSelectedAccountCapeId] = useState<string>("none");
  const [accountSkinThumbs, setAccountSkinThumbs] = useState<Record<string, AccountSkinThumbSet>>(
    {}
  );
  const [previewTimeOfDay, setPreviewTimeOfDay] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("mpm.skinPreview.time_of_day.v1");
      if (!raw) return 14;
      return normalizeTimeOfDay(Number(raw));
    } catch {
      return 14;
    }
  });
  const [skinPreviewEnabled, setSkinPreviewEnabled] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem("mpm.skinPreview3d.enabled.v1");
      if (raw === null) {
        const nav = navigator as Navigator & { deviceMemory?: number };
        const cores = nav.hardwareConcurrency ?? 8;
        const memory = typeof nav.deviceMemory === "number" ? nav.deviceMemory : 8;
        return !(cores <= 4 || memory <= 4);
      }
      return raw === "1" || raw === "true";
    } catch {
      return true;
    }
  });
  const [skinViewerErr, setSkinViewerErr] = useState<string | null>(null);
  const [skinViewerPreparing, setSkinViewerPreparing] = useState(false);
  const [skinViewerBusy, setSkinViewerBusy] = useState(false);
  const [skinViewerEpoch, setSkinViewerEpoch] = useState(0);
  const accountSkinViewerStageRef = useRef<HTMLDivElement | null>(null);
  const accountSkinViewerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const accountSkinViewerRef = useRef<SkinViewer | null>(null);
  const accountSkinViewerResizeRef = useRef<ResizeObserver | null>(null);
  const skinViewerInputCleanupRef = useRef<(() => void) | null>(null);
  const skinTextureCacheRef = useRef<Map<string, string>>(new Map());
  const capeTextureCacheRef = useRef<Map<string, string>>(new Map());
  const skinViewerNameTagTextRef = useRef<string | null>(null);
  const lastLoadedSkinSrcRef = useRef<string | null>(null);
  const lastLoadedCapeSrcRef = useRef<string | null>(null);
  const [updateCheck, setUpdateCheck] = useState<ModUpdateCheckResult | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateAllBusy, setUpdateAllBusy] = useState(false);
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  const [scheduledUpdateEntriesByInstance, setScheduledUpdateEntriesByInstance] = useState<
    Record<string, ScheduledUpdateCheckEntry>
  >(() => {
    try {
      const raw = localStorage.getItem("mpm.scheduledUpdates.v1");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      return parsed as Record<string, ScheduledUpdateCheckEntry>;
    } catch {
      return {};
    }
  });
  const [scheduledUpdateLastRunAt, setScheduledUpdateLastRunAt] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem("mpm.scheduledUpdates.lastRunAt");
      if (!raw) return null;
      const iso = String(raw);
      return Number.isFinite(toTimestamp(iso)) ? iso : null;
    } catch {
      return null;
    }
  });
  const [scheduledUpdateBusy, setScheduledUpdateBusy] = useState(false);
  const [scheduledUpdateErr, setScheduledUpdateErr] = useState<string | null>(null);
  const [updatePrefsBusy, setUpdatePrefsBusy] = useState(false);
  const scheduledUpdateRunningRef = useRef(false);
  const [installPlanPreview, setInstallPlanPreview] = useState<
    Record<string, InstallPlanPreview>
  >({});
  const [installPlanPreviewBusy, setInstallPlanPreviewBusy] = useState<Record<string, boolean>>({});
  const [installPlanPreviewErr, setInstallPlanPreviewErr] = useState<Record<string, string>>({});
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [snapshotsBusy, setSnapshotsBusy] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackSnapshotId, setRollbackSnapshotId] = useState<string | null>(null);
  const [worldRollbackBusyById, setWorldRollbackBusyById] = useState<Record<string, boolean>>({});
  const [presetIoBusy, setPresetIoBusy] = useState(false);
  const normalizedInstanceQuery = useMemo(
    () => instanceQuery.trim().toLowerCase(),
    [instanceQuery]
  );
  const selectedModVersionIdSet = useMemo(
    () => new Set(selectedModVersionIds),
    [selectedModVersionIds]
  );
  const runningByInstanceId = useMemo(() => {
    const map = new Map<string, RunningInstance[]>();
    for (const item of runningInstances) {
      const key = item.instance_id;
      const prev = map.get(key);
      if (prev) {
        prev.push(item);
      } else {
        map.set(key, [item]);
      }
    }
    return map;
  }, [runningInstances]);
  const scheduledUpdateEntries = useMemo(
    () =>
      Object.values(scheduledUpdateEntriesByInstance).sort(
        (a, b) =>
          toTimestamp(b.checked_at) - toTimestamp(a.checked_at) ||
          a.instance_name.localeCompare(b.instance_name)
      ),
    [scheduledUpdateEntriesByInstance]
  );
  const scheduledUpdatesAvailableTotal = useMemo(
    () => scheduledUpdateEntries.reduce((sum, row) => sum + Math.max(0, row.update_count || 0), 0),
    [scheduledUpdateEntries]
  );
  const scheduledInstancesWithUpdatesCount = useMemo(
    () => scheduledUpdateEntries.filter((row) => (row.update_count ?? 0) > 0).length,
    [scheduledUpdateEntries]
  );
  const nextScheduledUpdateRunAt = useMemo(
    () => computeNextUpdateRunAt(scheduledUpdateLastRunAt, updateCheckCadence),
    [scheduledUpdateLastRunAt, updateCheckCadence]
  );
  const installedContentSummary = useMemo(() => {
    const modEntries: InstalledMod[] = [];
    const resourcepackEntries: InstalledMod[] = [];
    const shaderpackEntries: InstalledMod[] = [];
    const datapackEntries: InstalledMod[] = [];
    const visibleInstalledMods: InstalledMod[] = [];
    const selectableVisibleMods: InstalledMod[] = [];
    let selectedVisibleModCount = 0;
    let selectedInstalledModCount = 0;

    for (const entry of installedMods) {
      const normalized = normalizeCreatorEntryType(entry.content_type);
      if (normalized === "mods") modEntries.push(entry);
      else if (normalized === "resourcepacks") resourcepackEntries.push(entry);
      else if (normalized === "shaderpacks") shaderpackEntries.push(entry);
      else if (normalized === "datapacks") datapackEntries.push(entry);

      if (normalized === "mods" && selectedModVersionIdSet.has(entry.version_id)) {
        selectedInstalledModCount += 1;
      }

      if (normalizeInstanceContentType(entry.content_type) !== instanceContentType) continue;
      if (
        normalizedInstanceQuery &&
        !entry.name.toLowerCase().includes(normalizedInstanceQuery) &&
        !entry.version_number.toLowerCase().includes(normalizedInstanceQuery) &&
        !entry.filename.toLowerCase().includes(normalizedInstanceQuery)
      ) {
        continue;
      }

      visibleInstalledMods.push(entry);
      if (normalized === "mods" && entry.file_exists) {
        selectableVisibleMods.push(entry);
        if (selectedModVersionIdSet.has(entry.version_id)) {
          selectedVisibleModCount += 1;
        }
      }
    }

    return {
      modEntries,
      resourcepackEntries,
      shaderpackEntries,
      datapackEntries,
      visibleInstalledMods,
      selectableVisibleMods,
      selectedVisibleModCount,
      selectedInstalledModCount,
    };
  }, [installedMods, instanceContentType, normalizedInstanceQuery, selectedModVersionIdSet]);

  useEffect(() => {
    localStorage.setItem("mpm.launchHealth.v1", JSON.stringify(launchHealthByInstance));
  }, [launchHealthByInstance]);

  useEffect(() => {
    localStorage.setItem(
      "mpm.launchHealth.dismissed.v1",
      JSON.stringify(launchHealthDismissedByInstance)
    );
  }, [launchHealthDismissedByInstance]);

  useEffect(() => {
    localStorage.setItem("mpm.account.custom_skins.v1", JSON.stringify(customSkins));
  }, [customSkins]);

  useEffect(() => {
    if (accountDiagnostics) {
      localStorage.setItem(ACCOUNT_DIAGNOSTICS_CACHE_KEY, JSON.stringify(accountDiagnostics));
    } else {
      localStorage.removeItem(ACCOUNT_DIAGNOSTICS_CACHE_KEY);
    }
  }, [accountDiagnostics]);

  useEffect(() => {
    localStorage.setItem("mpm.skinPreview3d.enabled.v1", skinPreviewEnabled ? "1" : "0");
  }, [skinPreviewEnabled]);

  useEffect(() => {
    localStorage.setItem("mpm.logs.max_lines.v1", String(Math.max(200, Math.min(12000, logMaxLines))));
  }, [logMaxLines]);

  useEffect(() => {
    localStorage.setItem(
      "mpm.skinPreview.time_of_day.v1",
      String(normalizeTimeOfDay(previewTimeOfDay))
    );
  }, [previewTimeOfDay]);

  useEffect(() => {
    localStorage.setItem("mpm.instance.launch_hooks.v1", JSON.stringify(instanceLaunchHooksById));
  }, [instanceLaunchHooksById]);

  useEffect(() => {
    localStorage.setItem("mpm.scheduledUpdates.v1", JSON.stringify(scheduledUpdateEntriesByInstance));
  }, [scheduledUpdateEntriesByInstance]);

  useEffect(() => {
    if (!installNotice) {
      lastInstallNoticeRef.current = null;
      return;
    }
    if (route !== "instance" || !selectedId) return;
    const message = installNotice.trim();
    if (!message) return;
    if (lastInstallNoticeRef.current === message) return;
    lastInstallNoticeRef.current = message;
    const entry: InstanceActivityEntry = {
      id: `activity_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      message,
      at: Date.now(),
      tone: inferActivityTone(message),
    };
    setInstanceActivityById((prev) => {
      const nextItems = [entry, ...(prev[selectedId] ?? [])].slice(0, 20);
      return {
        ...prev,
        [selectedId]: nextItems,
      };
    });
  }, [installNotice, route, selectedId]);

  useEffect(() => {
    if (instances.length === 0) return;
    const nameById = new Map(instances.map((inst) => [inst.id, inst.name]));
    setScheduledUpdateEntriesByInstance((prev) => {
      let changed = false;
      const next: Record<string, ScheduledUpdateCheckEntry> = {};
      for (const [instanceId, entry] of Object.entries(prev)) {
        if (!nameById.has(instanceId)) {
          changed = true;
          continue;
        }
        const name = nameById.get(instanceId) ?? entry.instance_name;
        if (name !== entry.instance_name) {
          next[instanceId] = { ...entry, instance_name: name };
          changed = true;
        } else {
          next[instanceId] = entry;
        }
      }
      return changed ? next : prev;
    });
  }, [instances]);

  useEffect(() => {
    if (scheduledUpdateLastRunAt) {
      localStorage.setItem("mpm.scheduledUpdates.lastRunAt", scheduledUpdateLastRunAt);
    } else {
      localStorage.removeItem("mpm.scheduledUpdates.lastRunAt");
    }
  }, [scheduledUpdateLastRunAt]);

  useEffect(() => {
    if (!launcherSettings) return;
    if (instances.length === 0) return;
    const cadence = normalizeUpdateCheckCadence(updateCheckCadence);
    if (cadence === "off") return;
    const dueNow = () => {
      if (scheduledUpdateRunningRef.current || document.hidden) return;
      const lastMs = toTimestamp(scheduledUpdateLastRunAt ?? undefined);
      const intervalMs = updateCadenceIntervalMs(cadence);
      if (!Number.isFinite(lastMs) || Date.now() - lastMs >= intervalMs) {
        runScheduledUpdateChecks("scheduled").catch(() => null);
      }
    };
    dueNow();
    const timer = window.setInterval(dueNow, 60_000);
    const onVisibility = () => {
      if (!document.hidden) dueNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    launcherSettings,
    instances,
    updateCheckCadence,
    scheduledUpdateLastRunAt,
    updateAutoApplyMode,
    updateApplyScope,
  ]);

  async function refreshCurseforgeApiStatus() {
    setCurseforgeApiBusy(true);
    setLauncherErr(null);
    try {
      const status = await getCurseforgeApiStatus();
      setCurseforgeApiStatus(status);
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setLauncherErr(msg);
    } finally {
      setCurseforgeApiBusy(false);
    }
  }

  useEffect(() => {
    if (route !== "settings") return;
    if (curseforgeApiStatus || curseforgeApiBusy) return;
    refreshCurseforgeApiStatus().catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  const sortedProjectVersions = useMemo(
    () =>
      [...projectVersions].sort(
        (a, b) =>
          new Date(b.date_published).getTime() - new Date(a.date_published).getTime()
      ),
    [projectVersions]
  );

  const latestProjectVersion = sortedProjectVersions[0] ?? null;
  const selectedLauncherAccountId = launcherSettings?.selected_account_id ?? null;
  const selectedLauncherAccount = useMemo(
    () => launcherAccounts.find((acct) => acct.id === selectedLauncherAccountId) ?? null,
    [launcherAccounts, selectedLauncherAccountId]
  );
  useEffect(() => {
    const selectedId = selectedLauncherAccountId ?? null;
    setAccountDiagnostics((prev) => {
      if (!prev) return prev;
      const cachedId = prev.selected_account_id ?? null;
      if (cachedId === selectedId) return prev;
      return null;
    });
  }, [selectedLauncherAccountId]);

  const accountDisplayName =
    accountDiagnostics?.minecraft_username ??
    accountDiagnostics?.account?.username ??
    selectedLauncherAccount?.username ??
    "Player";
  const accountSkinOptions = useMemo<AccountSkinOption[]>(() => {
    const out: AccountSkinOption[] = [];
    const seen = new Set<string>();

    const pushOption = (next: AccountSkinOption) => {
      const key = next.skin_url.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(next);
    };

    const primarySkin = String(accountDiagnostics?.skin_url ?? "").trim();
    if (primarySkin) {
      pushOption({
        id: "saved:primary",
        label: accountDiagnostics?.minecraft_username?.trim() || "Current skin",
        skin_url: primarySkin,
        group: "saved",
        origin: "profile",
      });
    }

    for (const skin of accountDiagnostics?.skins ?? []) {
      const skinUrl = String(skin.url ?? "").trim();
      if (!skinUrl) continue;
      const variant = String(skin.variant ?? "").trim();
      const label = variant || "Saved skin";
      pushOption({
        id: `saved:${String(skin.id ?? skinUrl)}`,
        label,
        skin_url: skinUrl,
        group: "saved",
        origin: "profile",
      });
    }

    for (const skin of customSkins) {
      const raw = String(skin.skin_path ?? "").trim();
      if (!raw) continue;
      pushOption({
        id: `custom:${skin.id}`,
        label: skin.label || "Custom skin",
        skin_url: raw,
        group: "saved",
        origin: "custom",
      });
    }

    for (const preset of DEFAULT_SKIN_LIBRARY) {
      pushOption(preset);
    }

    return out;
  }, [accountDiagnostics?.minecraft_username, accountDiagnostics?.skin_url, accountDiagnostics?.skins, customSkins]);
  const savedSkinOptions = useMemo(
    () => accountSkinOptions.filter((skin) => skin.group === "saved"),
    [accountSkinOptions]
  );
  const defaultSkinOptions = useMemo(
    () => accountSkinOptions.filter((skin) => skin.group === "default"),
    [accountSkinOptions]
  );
  const selectedAccountSkin = useMemo(
    () =>
      accountSkinOptions.find((skin) => skin.id === selectedAccountSkinId) ??
      accountSkinOptions[0] ??
      null,
    [accountSkinOptions, selectedAccountSkinId]
  );
  const capeOptions = useMemo(
    () => [
      { id: "none", label: "No cape", url: null as string | null },
      ...(accountDiagnostics?.capes ?? []).map((cape, idx) => ({
        id: String(cape.id ?? `cape-${idx}`),
        label: String(cape.alias ?? "").trim() || `Cape ${idx + 1}`,
        url: String(cape.url ?? "").trim() || null,
      })),
    ],
    [accountDiagnostics?.capes]
  );
  const selectedAccountCape = useMemo(
    () => capeOptions.find((cape) => cape.id === selectedAccountCapeId) ?? capeOptions[0],
    [capeOptions, selectedAccountCapeId]
  );

  useEffect(() => {
    if (!accountSkinOptions.length) {
      setSelectedAccountSkinId(null);
      return;
    }
    if (!selectedAccountSkinId || !accountSkinOptions.some((skin) => skin.id === selectedAccountSkinId)) {
      setSelectedAccountSkinId(accountSkinOptions[0].id);
    }
  }, [accountSkinOptions, selectedAccountSkinId]);

  useEffect(() => {
    if (!capeOptions.length) {
      setSelectedAccountCapeId("none");
      return;
    }
    if (!capeOptions.some((cape) => cape.id === selectedAccountCapeId)) {
      setSelectedAccountCapeId(capeOptions[0].id);
    }
  }, [capeOptions, selectedAccountCapeId]);

  const libraryContextTarget = useMemo(
    () =>
      libraryContextMenu
        ? instances.find((inst) => inst.id === libraryContextMenu.instanceId) ?? null
        : null,
    [instances, libraryContextMenu]
  );
  const libraryContextMenuStyle = useMemo(() => {
    if (!libraryContextMenu || typeof window === "undefined") return null;
    const EDGE = 10;
    const MENU_WIDTH = 236;
    const MENU_HEIGHT = 326;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = libraryContextMenu.x;
    let top = libraryContextMenu.y;
    left = Math.min(left, Math.max(EDGE, vw - MENU_WIDTH - EDGE));
    left = Math.max(EDGE, left);
    if (top + MENU_HEIGHT > vh - EDGE) {
      top = Math.max(EDGE, vh - MENU_HEIGHT - EDGE);
    }
    return {
      left,
      top,
      width: MENU_WIDTH,
    };
  }, [libraryContextMenu]);

  const projectLoaderFacets = useMemo(() => {
    const set = new Set<string>();
    for (const v of sortedProjectVersions) {
      for (const loaderName of v.loaders) {
        if (loaderName) set.add(loaderName);
      }
      if (set.size >= 9) break;
    }
    return Array.from(set);
  }, [sortedProjectVersions]);

  const projectGameVersionFacets = useMemo(() => {
    const set = new Set<string>();
    for (const v of sortedProjectVersions) {
      for (const gameVersion of v.game_versions) {
        if (gameVersion) set.add(gameVersion);
      }
      if (set.size >= 10) break;
    }
    return Array.from(set);
  }, [sortedProjectVersions]);

  const latestPrimaryFile = useMemo(() => {
    if (!latestProjectVersion) return null;
    return (
      latestProjectVersion.files.find((f) => f.primary) ??
      latestProjectVersion.files[0] ??
      null
    );
  }, [latestProjectVersion]);

  const projectPageUrl = projectOpen
    ? `https://modrinth.com/mod/${projectOpen.slug || projectOpen.id}`
    : null;

  const changelogVersions = useMemo(
    () =>
      sortedProjectVersions
        .filter((v) => Boolean(toReadableBody(v.changelog).trim()))
        .slice(0, 10),
    [sortedProjectVersions]
  );

  function closeProjectOverlays() {
    setProjectBusy(false);
    setProjectOpen(null);
    setProjectVersions([]);
    setProjectMembers([]);
    setProjectDetailTab("overview");
    setProjectCopyNotice(null);
    setProjectErr(null);
    setCurseforgeBusy(false);
    setCurseforgeOpen(null);
    setProjectOpenContentType("mods");
    setCurseforgeOpenContentType("mods");
    setCurseforgeDetailTab("overview");
    setCurseforgeErr(null);
  }

  function normalizeImportedPreset(raw: any): UserPreset | null {
    if (!raw || typeof raw !== "object") return null;
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Imported preset";
    const entriesRaw = Array.isArray(raw.entries) ? raw.entries : [];
    const entries: UserPresetEntry[] = entriesRaw
      .filter((entry: any) => entry && typeof entry === "object")
      .map((entry: any) => {
        const source = String(entry.source ?? "").trim().toLowerCase();
        const normalizedSource = source === "curseforge" ? "curseforge" : source === "modrinth" ? "modrinth" : "";
        const project_id = String(entry.project_id ?? "").trim();
        const title = String(entry.title ?? project_id ?? "").trim();
        const content_type = String(entry.content_type ?? "mods").trim().toLowerCase();
        const normalizedContentType =
          content_type === "resourcepacks" || content_type === "resourcepack"
            ? "resourcepacks"
            : content_type === "shaderpacks" || content_type === "shaderpack" || content_type === "shaders"
              ? "shaderpacks"
              : content_type === "datapacks" || content_type === "datapack"
                ? "datapacks"
                : content_type === "modpacks" || content_type === "modpack"
                  ? "modpacks"
                  : "mods";
        const targetScope = normalizedContentType === "datapacks" ? "world" : "instance";
        const targetWorlds = Array.isArray(entry.target_worlds)
          ? entry.target_worlds
            .map((w: any) => String(w ?? "").trim())
            .filter((w: string) => Boolean(w))
          : [];
        if (!normalizedSource || !project_id) return null;
        return {
          source: normalizedSource,
          project_id,
          title: title || project_id,
          content_type: normalizedContentType,
          pinned_version: typeof entry.pinned_version === "string" ? entry.pinned_version : null,
          target_scope: targetScope,
          target_worlds: targetWorlds,
          enabled: entry.enabled !== false,
        } as UserPresetEntry;
      })
      .filter((entry): entry is UserPresetEntry => Boolean(entry));

    if (entries.length === 0) return null;

    const baseId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `preset_${Date.now()}`;
    return {
      id: baseId,
      name,
      created_at:
        typeof raw.created_at === "string" && raw.created_at.trim()
          ? raw.created_at
          : new Date().toISOString(),
      source_instance_id:
        typeof raw.source_instance_id === "string" ? raw.source_instance_id : "imported",
      source_instance_name:
        typeof raw.source_instance_name === "string" && raw.source_instance_name.trim()
          ? raw.source_instance_name
          : "Imported",
      entries,
      settings: {
        ...defaultPresetSettings(),
        ...(raw.settings && typeof raw.settings === "object" ? raw.settings : {}),
      },
    };
  }

  async function runSearch(newOffset: number) {
    setDiscoverErr(null);
    setDiscoverBusy(true);
    try {
      if (discoverContentType === "datapacks") {
        const windowLimit = Math.max(limit, newOffset + limit, 30);
        const [datapacksRes, modpacksRes] = await Promise.all([
          searchDiscoverContent({
            query: q,
            loaders: [],
            gameVersion: filterVersion,
            categories: filterCategories,
            index,
            limit: windowLimit,
            offset: 0,
            source: discoverSource,
            contentType: "datapacks",
          }).catch(() => ({ hits: [], total_hits: 0, offset: 0, limit: windowLimit })),
          searchDiscoverContent({
            query: q,
            loaders: [],
            gameVersion: filterVersion,
            categories: filterCategories,
            index,
            limit: windowLimit,
            offset: 0,
            source: discoverSource,
            contentType: "modpacks",
          }).catch(() => ({ hits: [], total_hits: 0, offset: 0, limit: windowLimit })),
        ]);
        const merged = [...datapacksRes.hits, ...modpacksRes.hits];
        merged.sort((a, b) => {
          if (index === "downloads") return (b.downloads ?? 0) - (a.downloads ?? 0);
          if (index === "follows") return (b.follows ?? 0) - (a.follows ?? 0);
          return String(b.date_modified ?? "").localeCompare(String(a.date_modified ?? ""));
        });
        const mergedTotalHits = Math.max(
          merged.length,
          (datapacksRes.total_hits ?? 0) + (modpacksRes.total_hits ?? 0)
        );
        setHits(merged.slice(newOffset, newOffset + limit));
        setTotalHits(mergedTotalHits);
        setOffset(newOffset);
      } else {
        const res = await searchDiscoverContent({
          query: q,
          loaders: discoverContentType === "mods" ? filterLoaders : [],
          gameVersion: filterVersion,
          categories: filterCategories,
          index,
          limit,
          offset: newOffset,
          source: discoverSource,
          contentType: discoverContentType,
        });
        setHits(res.hits);
        setTotalHits(res.total_hits);
        setOffset(res.offset);
      }
    } catch (e: any) {
      setDiscoverErr(e?.toString?.() ?? String(e));
    } finally {
      setDiscoverBusy(false);
    }
  }

  useEffect(() => {
    if (route !== "discover") return;
    runSearch(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, index, limit, filterLoaders, filterVersion, filterCategories, discoverSource, discoverContentType]);

  async function runTemplateSearch(newOffset: number, queryOverride?: string) {
    setTemplateErr(null);
    setTemplateBusy(true);
    try {
      const res = await searchDiscoverContent({
        query: queryOverride ?? templateQueryDebounced,
        loaders: [],
        gameVersion: filterVersion,
        categories: filterCategories,
        index,
        limit,
        offset: newOffset,
        source: templateSource,
        contentType: templateType as DiscoverContentType,
      });
      setTemplateHits(res.hits);
      setTemplateTotalHits(res.total_hits);
      setTemplateOffset(res.offset);
    } catch (e: any) {
      setTemplateErr(e?.toString?.() ?? String(e));
      setTemplateHits([]);
      setTemplateTotalHits(0);
    } finally {
      setTemplateBusy(false);
    }
  }

  useEffect(() => {
    if (route !== "modpacks" || modpacksStudioTab !== "templates") return;
    runTemplateSearch(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, modpacksStudioTab, templateQueryDebounced, templateSource, templateType, filterVersion, filterCategories, index, limit]);

  function ensureCreatorDraft(inst: Instance | null): UserPreset {
    if (creatorDraft) return creatorDraft;
    const draft: UserPreset = {
      id: `preset_${Date.now()}`,
      name: inst ? `${inst.name} custom preset` : "Custom preset",
      created_at: new Date().toISOString(),
      source_instance_id: inst?.id ?? "custom",
      source_instance_name: inst?.name ?? "Custom",
      entries: [],
      settings: defaultPresetSettings(),
    };
    setCreatorDraft(draft);
    return draft;
  }

  function addEntryToCreator(entry: UserPresetEntry, inst: Instance | null) {
    const base = ensureCreatorDraft(inst);
    const existingKey = `${entry.source}:${entry.project_id}:${entry.content_type}:${(entry.target_worlds ?? []).join("|")}`;
    const mergedEntries = [
      ...base.entries.filter((e) => {
        const k = `${e.source}:${e.project_id}:${e.content_type}:${(e.target_worlds ?? []).join("|")}`;
        return k !== existingKey;
      }),
      {
        ...entry,
        enabled: entry.enabled !== false,
        target_scope: entry.content_type === "datapacks" ? "world" : "instance",
      },
    ];
    const next = {
      ...base,
      // Preserve creator intent/order; users can manually reorder entries in the studio.
      entries: mergedEntries,
    };
    setCreatorDraft(next);
  }

  function addHitToCreator(hit: DiscoverSearchHit, inst: Instance | null) {
    const contentType =
      hit.content_type === "modpacks"
        ? "modpacks"
        : (hit.content_type as DiscoverContentType) || "mods";
    addEntryToCreator(
      {
        source: hit.source === "curseforge" ? "curseforge" : "modrinth",
        project_id: hit.project_id,
        title: hit.title,
        content_type: contentType,
        pinned_version: null,
        target_scope: contentType === "datapacks" ? "world" : "instance",
        target_worlds:
          contentType === "datapacks"
            ? (instanceWorlds.length ? [instanceWorlds[0].id] : [])
            : [],
        enabled: contentType !== "modpacks",
      },
      inst
    );
    setInstallNotice(`Added "${hit.title}" to creator draft.`);
  }

  async function importTemplateFromHit(hit: DiscoverSearchHit, inst: Instance | null) {
    setPresetBusy(true);
    setError(null);
    try {
      if (hit.content_type === "modpacks") {
        const preset = await importProviderModpackTemplate({
          source: hit.source === "curseforge" ? "curseforge" : "modrinth",
          projectId: hit.project_id,
          projectTitle: hit.title,
        });
        setCreatorDraft(preset);
        setInstallNotice(`Imported template "${preset.name}" with ${preset.entries.length} entries.`);
      } else {
        addHitToCreator(hit, inst);
      }
      setModpacksStudioTab("creator");
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setPresetBusy(false);
    }
  }

  function updateCreatorDraft(mutator: (current: UserPreset) => UserPreset) {
    const inst = instances.find((i) => i.id === selectedId) ?? null;
    const current = creatorDraft ?? ensureCreatorDraft(inst);
    const next = mutator(current);
    setCreatorDraft({
      ...next,
      settings: {
        ...defaultPresetSettings(),
        ...(next.settings ?? {}),
      },
    });
  }

  function onAddCreatorBlankEntry(inst: Instance | null) {
    const base = ensureCreatorDraft(inst);
    const next = {
      ...base,
      entries: [
        ...base.entries,
        {
          source: "modrinth",
          project_id: "",
          title: "Untitled entry",
          content_type: "mods",
          pinned_version: null,
          target_scope: "instance",
          target_worlds: [],
          enabled: true,
        },
      ],
    };
    setCreatorDraft(next);
  }

  function moveCreatorEntry(index: number, direction: -1 | 1) {
    if (!creatorDraft) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= creatorDraft.entries.length) return;
    updateCreatorDraft((current) => {
      const entries = [...current.entries];
      const [item] = entries.splice(index, 1);
      entries.splice(nextIndex, 0, item);
      return { ...current, entries };
    });
  }

  async function onSaveCreatorToPresets() {
    if (!creatorDraft) return;
    const cleanName = creatorDraft.name.trim() || "Custom preset";
    const next: UserPreset = {
      ...creatorDraft,
      id: creatorDraft.id?.trim() ? creatorDraft.id : `preset_${Date.now()}`,
      name: cleanName,
      created_at: creatorDraft.created_at || new Date().toISOString(),
      source_instance_id: creatorDraft.source_instance_id || "custom",
      source_instance_name: creatorDraft.source_instance_name || "Custom",
      settings: {
        ...defaultPresetSettings(),
        ...(creatorDraft.settings ?? {}),
      },
      entries: (creatorDraft.entries ?? []).filter((e) => Boolean(e.project_id?.trim())),
    };
    if (!next.entries.length) {
      setError("Creator draft has no valid entries yet.");
      return;
    }
    setPresets((prev) => {
      const without = prev.filter((p) => p.id !== next.id);
      return [next, ...without];
    });
    setInstallNotice(`Saved "${next.name}" (${next.entries.length} entries).`);
  }

  async function openProject(id: string, contentType?: DiscoverContentType) {
    closeProjectOverlays();
    setProjectErr(null);
    setProjectBusy(true);
    setProjectVersions([]);
    setProjectMembers([]);
    setProjectDetailTab("overview");
    setProjectCopyNotice(null);
    setProjectOpenContentType(contentType ?? "mods");
    try {
      const [p, versionsRes, membersRes] = await Promise.all([
        getProject(id),
        getProjectVersions(id).catch(() => [] as ProjectVersion[]),
        getProjectMembers(id).catch(() => [] as ProjectMember[]),
      ]);
      setProjectOpen(p);
      setProjectVersions(versionsRes);
      setProjectMembers(membersRes);
    } catch (e: any) {
      setProjectErr(e?.toString?.() ?? String(e));
    } finally {
      setProjectBusy(false);
    }
  }

  async function openCurseforgeProject(projectId: string, contentType?: DiscoverContentType) {
    closeProjectOverlays();
    setCurseforgeErr(null);
    setCurseforgeBusy(true);
    setCurseforgeDetailTab("overview");
    setCurseforgeOpenContentType(contentType ?? "mods");
    try {
      const detail = await getCurseforgeProjectDetail({ projectId });
      setCurseforgeOpen(detail);
    } catch (e: any) {
      setCurseforgeErr(e?.toString?.() ?? String(e));
    } finally {
      setCurseforgeBusy(false);
    }
  }

  function openInstall(target: InstallTarget) {
    // Close any open project modal so we only ever have one overlay active.
    closeProjectOverlays();

    setInstallTarget(target);
    setInstallInstanceQuery("");
  }

  useEffect(() => {
    if (!installTarget) {
      setInstallPlanPreview({});
      setInstallPlanPreviewBusy({});
      setInstallPlanPreviewErr({});
      return;
    }

    if (installTarget.contentType !== "mods") {
      const nextBusy: Record<string, boolean> = {};
      const nextPreview: Record<string, InstallPlanPreview> = {};
      for (const inst of instances) {
        nextBusy[inst.id] = false;
        nextPreview[inst.id] = {
          total_mods: 1,
          dependency_mods: 0,
          will_install_mods: 1,
        };
      }
      setInstallPlanPreview(nextPreview);
      setInstallPlanPreviewErr({});
      setInstallPlanPreviewBusy(nextBusy);
      return;
    }

    if (installTarget.source === "curseforge") {
      const nextBusy: Record<string, boolean> = {};
      const nextPreview: Record<string, InstallPlanPreview> = {};
      for (const inst of instances) {
        nextBusy[inst.id] = false;
        nextPreview[inst.id] = {
          total_mods: 1,
          dependency_mods: 0,
          will_install_mods: 1,
        };
      }
      setInstallPlanPreview(nextPreview);
      setInstallPlanPreviewErr({});
      setInstallPlanPreviewBusy(nextBusy);
      return;
    }

    let cancelled = false;
    const nextBusy: Record<string, boolean> = {};
    for (const inst of instances) {
      nextBusy[inst.id] = true;
    }

    setInstallPlanPreview({});
    setInstallPlanPreviewErr({});
    setInstallPlanPreviewBusy(nextBusy);

    for (const inst of instances) {
      previewModrinthInstall({
        instanceId: inst.id,
        projectId: installTarget.projectId,
        projectTitle: installTarget.title,
      })
        .then((preview) => {
          if (cancelled) return;
          setInstallPlanPreview((prev) => ({ ...prev, [inst.id]: preview }));
          setInstallPlanPreviewErr((prev) => {
            const { [inst.id]: _ignored, ...rest } = prev;
            return rest;
          });
        })
        .catch((e: any) => {
          if (cancelled) return;
          setInstallPlanPreviewErr((prev) => ({
            ...prev,
            [inst.id]: e?.toString?.() ?? String(e),
          }));
        })
        .finally(() => {
          if (cancelled) return;
          setInstallPlanPreviewBusy((prev) => ({ ...prev, [inst.id]: false }));
        });
    }

    return () => {
      cancelled = true;
    };
  }, [installTarget?.projectId, installTarget?.title, installTarget?.source, installTarget?.contentType, instances]);

  async function copyProjectText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setProjectCopyNotice(`${label} copied`);
    } catch {
      setProjectCopyNotice("Copy failed");
    }
    window.setTimeout(() => {
      setProjectCopyNotice((current) => (current ? null : current));
    }, 1400);
  }

  async function copyMicrosoftCode() {
    if (!msCodePrompt?.code) return;
    try {
      await navigator.clipboard.writeText(msCodePrompt.code);
      setMsCodeCopied(true);
    } catch {
      setLauncherErr("Couldn't copy code. Please copy it manually.");
    }
    window.setTimeout(() => {
      setMsCodeCopied(false);
    }, 1200);
  }

  async function refreshInstalledMods(instanceId: string) {
    setModsBusy(true);
    setModsErr(null);
    try {
      const mods = await listInstalledMods(instanceId);
      setInstalledMods(mods);
    } catch (e: any) {
      setModsErr(e?.toString?.() ?? String(e));
      setInstalledMods([]);
    } finally {
      setModsBusy(false);
    }
  }

  async function refreshSnapshots(instanceId: string) {
    setSnapshotsBusy(true);
    try {
      const list = await listInstanceSnapshots({ instanceId });
      setSnapshots(list);
      setRollbackSnapshotId((prev) =>
        prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? null
      );
    } catch {
      setSnapshots([]);
      setRollbackSnapshotId(null);
    } finally {
      setSnapshotsBusy(false);
    }
  }

  async function onInstallToInstance(inst: Instance) {
    const target = installTarget;
    if (!target) return;
    const key = `${inst.id}:${target.source}:${target.contentType}:${target.projectId}`;
    setInstallingKey(key);
    setInstallNotice(null);
    setError(null);
    setInstallProgress({
      instance_id: inst.id,
      project_id: target.projectId,
      stage: "resolving",
      downloaded: 0,
      total: null,
      percent: 0,
      message: "Resolving compatible version…",
    });

    try {
      const directDatapackWorlds =
        target.contentType === "datapacks"
          ? (
              target.targetWorlds?.length
                ? target.targetWorlds
                : (await listInstanceWorlds({ instanceId: inst.id })).map((w) => w.id)
            )
          : [];
      if (target.contentType === "datapacks" && directDatapackWorlds.length === 0) {
        throw new Error("No worlds found in this instance. Create a world first, or add this datapack to the creator and choose targets.");
      }
      const mod =
        target.contentType === "mods"
          ? target.source === "curseforge"
            ? await installCurseforgeMod({
                instanceId: inst.id,
                projectId: target.projectId,
                projectTitle: target.title,
              })
            : await installModrinthMod({
                instanceId: inst.id,
                projectId: target.projectId,
                projectTitle: target.title,
              })
          : await installDiscoverContent({
              instanceId: inst.id,
              source: target.source === "curseforge" ? "curseforge" : "modrinth",
              projectId: target.projectId,
              projectTitle: target.title,
              contentType: target.contentType,
              targetWorlds: directDatapackWorlds,
            });
      await refreshInstalledMods(inst.id);
      await refreshSnapshots(inst.id);
      await refreshInstances();
      setInstallNotice(`Installed ${mod.name} ${mod.version_number} in ${inst.name}.`);
      setInstallProgress({
        instance_id: inst.id,
        project_id: target.projectId,
        stage: "completed",
        downloaded: 1,
        total: 1,
        percent: 100,
        message: "Install complete",
      });
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
      setInstallProgress((prev) => ({
        instance_id: inst.id,
        project_id: target.projectId,
        stage: "error",
        downloaded: prev?.downloaded ?? 0,
        total: prev?.total ?? null,
        percent: prev?.percent ?? null,
        message: e?.toString?.() ?? String(e),
      }));
    } finally {
      setInstallingKey(null);
      window.setTimeout(() => {
        setInstallProgress((prev) => (prev?.stage === "completed" ? null : prev));
      }, 900);
    }
  }

  async function onRollbackToSnapshot(inst: Instance, snapshotId?: string | null) {
    setRollbackBusy(true);
    setError(null);
    try {
      const out: RollbackResult = await rollbackInstance({
        instanceId: inst.id,
        snapshotId: snapshotId ?? undefined,
      });
      await refreshInstalledMods(inst.id);
      await refreshSnapshots(inst.id);
      setUpdateCheck(null);
      setInstallNotice(
        `${out.message} Restored ${out.restored_files} file(s) from snapshot ${out.snapshot_id}.`
      );
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setRollbackBusy(false);
    }
  }

  async function onRollbackWorldBackup(inst: Instance, world: InstanceWorld) {
    const worldId = String(world.id ?? "").trim();
    if (!worldId) return;
    if (runningInstances.some((run) => run.instance_id === inst.id)) {
      setInstallNotice("Stop all running sessions for this instance before rolling back a world backup.");
      return;
    }
    setWorldRollbackBusyById((prev) => ({ ...prev, [worldId]: true }));
    setError(null);
    setInstallNotice(`Rolling back "${world.name}" to latest backup…`);
    try {
      const out: WorldRollbackResult = await rollbackInstanceWorldBackup({
        instanceId: inst.id,
        worldId,
        backupId: world.latest_backup_id ?? undefined,
      });
      const worlds = await listInstanceWorlds({ instanceId: inst.id }).catch(() => [] as InstanceWorld[]);
      setInstanceWorlds(worlds);
      setInstallNotice(
        `${out.message} Restored ${out.restored_files} file(s) in "${world.name}" from ${formatDateTime(out.created_at)}.`
      );
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setWorldRollbackBusyById((prev) => {
        const next = { ...prev };
        delete next[worldId];
        return next;
      });
    }
  }

  async function onCreatePresetFromInstance(inst: Instance) {
    setPresetBusy(true);
    setError(null);
    try {
      const mods = await listInstalledMods(inst.id);
      const entries: UserPresetEntry[] = mods
        .filter((m) => m.source === "modrinth" || m.source === "curseforge")
        .map((m) => ({
          source: m.source,
          project_id: m.project_id,
          title: m.name,
          content_type: (m.content_type as any) ?? "mods",
          pinned_version: m.pinned_version ?? null,
          target_scope: (m.target_scope as any) ?? ((m.content_type ?? "mods") === "datapacks" ? "world" : "instance"),
          target_worlds: m.target_worlds ?? [],
          enabled: true,
        }));
      if (entries.length === 0) {
        throw new Error("This instance has no Modrinth/CurseForge entries to save as a preset.");
      }
      const next: UserPreset = {
        id: `preset_${Date.now()}`,
        name: presetNameDraft.trim() || `${inst.name} preset`,
        created_at: new Date().toISOString(),
        source_instance_id: inst.id,
        source_instance_name: inst.name,
        entries,
        settings: defaultPresetSettings(),
      };
      setPresets((prev) => [next, ...prev]);
      setPresetNameDraft("");
      setCreatorDraft(next);
      setInstallNotice(`Created preset "${next.name}" with ${entries.length} entries.`);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setPresetBusy(false);
    }
  }

  async function onApplyPresetToInstance(preset: UserPreset, inst: Instance) {
    setPresetBusy(true);
    setError(null);
    try {
      const applyResult: PresetApplyResult = await applyPresetToInstance({
        instanceId: inst.id,
        preset,
      });
      await refreshInstalledMods(inst.id);
      await refreshSnapshots(inst.id);
      const byTypeText = Object.entries(applyResult.by_content_type)
        .map(([k, v]) => `${k}:${v}`)
        .join(", ");
      setInstallNotice(
        `${applyResult.message} Installed ${applyResult.installed_entries}, skipped ${applyResult.skipped_entries}, failed ${applyResult.failed_entries}.${byTypeText ? ` (${byTypeText})` : ""}`
      );
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setPresetBusy(false);
    }
  }

  async function onPreviewPresetApply(preset: UserPreset, inst: Instance) {
    setPresetPreviewBusy(true);
    setError(null);
    try {
      const preview = await previewPresetApply({
        instanceId: inst.id,
        preset,
      });
      setPresetPreview(preview);
      if (!preview.valid) {
        const msg = [
          ...preview.provider_warnings,
          preview.missing_world_targets.length
            ? `Missing datapack targets: ${preview.missing_world_targets.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join(" | ");
        setError(msg || "Preset preview found issues.");
      } else {
        setInstallNotice(
          `Preview OK: ${preview.installable_entries} installable, ${preview.skipped_disabled_entries} disabled, ${preview.duplicate_entries} duplicates.`
        );
      }
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
      setPresetPreview(null);
    } finally {
      setPresetPreviewBusy(false);
    }
  }

  async function onExportPresets() {
    setPresetIoBusy(true);
    setError(null);
    try {
      if (presets.length === 0) {
        throw new Error("No presets to export.");
      }
      const savePath = await saveDialog({
        defaultPath: "modpack-manager-presets.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!savePath || Array.isArray(savePath)) return;

      const payload: PresetExportPayload = {
        format: "mpm-presets/v2",
        exported_at: new Date().toISOString(),
        presets,
      };
      const out = await exportPresetsJson({
        outputPath: savePath,
        payload,
      });
      setInstallNotice(`Exported ${out.items} preset(s) to ${out.path}`);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setPresetIoBusy(false);
    }
  }

  async function onImportPresets() {
    setPresetIoBusy(true);
    setError(null);
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!picked || Array.isArray(picked)) return;

      const imported = await importPresetsJson({ inputPath: picked });
      const values = Array.isArray(imported)
        ? imported
        : Array.isArray((imported as any)?.presets)
          ? (imported as any).presets
          : [];

      const normalized = values
        .map((item) => normalizeImportedPreset(item))
        .filter((item): item is UserPreset => Boolean(item));
      if (normalized.length === 0) {
        throw new Error("No valid presets found in the selected file.");
      }

      setPresets((prev) => {
        const map = new Map<string, UserPreset>();
        for (const item of prev) map.set(item.id, item);
        for (const item of normalized) {
          const id = map.has(item.id) ? `${item.id}_${Date.now()}` : item.id;
          map.set(id, { ...item, id });
        }
        return Array.from(map.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
      setInstallNotice(`Imported ${normalized.length} preset(s).`);
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setPresetIoBusy(false);
    }
  }

  async function onToggleInstalledMod(inst: Instance, mod: InstalledMod, enabled: boolean) {
    setToggleBusyVersion(mod.version_id);
    setModsErr(null);
    try {
      await setInstalledModEnabled({
        instanceId: inst.id,
        versionId: mod.version_id,
        enabled,
      });
      await refreshInstalledMods(inst.id);
    } catch (e: any) {
      setModsErr(e?.toString?.() ?? String(e));
    } finally {
      setToggleBusyVersion(null);
    }
  }

  function onToggleModSelection(versionId: string, checked: boolean) {
    setSelectedModVersionIds((prev) => {
      if (checked) {
        if (prev.includes(versionId)) return prev;
        return [...prev, versionId];
      }
      return prev.filter((id) => id !== versionId);
    });
  }

  function onToggleAllVisibleModSelection(mods: InstalledMod[], checked: boolean) {
    const ids = mods
      .filter((m) => normalizeCreatorEntryType(m.content_type) === "mods" && m.file_exists)
      .map((m) => m.version_id);
    if (ids.length === 0) return;
    setSelectedModVersionIds((prev) => {
      if (checked) {
        const merged = new Set([...prev, ...ids]);
        return Array.from(merged);
      }
      const remove = new Set(ids);
      return prev.filter((id) => !remove.has(id));
    });
  }

  async function onBulkToggleSelectedMods(inst: Instance, enabled: boolean) {
    const candidates = installedMods.filter(
      (m) =>
        selectedModVersionIdSet.has(m.version_id) &&
        normalizeCreatorEntryType(m.content_type) === "mods" &&
        m.file_exists &&
        m.enabled !== enabled
    );
    if (candidates.length === 0) {
      setInstallNotice(
        selectedModVersionIds.length === 0
          ? "Select one or more mods first."
          : "No selected mods need changes."
      );
      return;
    }
    setToggleBusyVersion("__bulk__");
    setModsErr(null);
    const succeeded = new Set<string>();
    const failedNames: string[] = [];
    try {
      for (const mod of candidates) {
        try {
          await setInstalledModEnabled({
            instanceId: inst.id,
            versionId: mod.version_id,
            enabled,
          });
          succeeded.add(mod.version_id);
        } catch {
          failedNames.push(mod.name);
        }
      }
      await refreshInstalledMods(inst.id);
      if (succeeded.size > 0) {
        setInstallNotice(
          `${enabled ? "Enabled" : "Disabled"} ${succeeded.size} selected mod${
            succeeded.size === 1 ? "" : "s"
          }.`
        );
      }
      if (failedNames.length > 0) {
        setModsErr(
          `Could not update ${failedNames.length} mod${
            failedNames.length === 1 ? "" : "s"
          }: ${failedNames.slice(0, 3).join(", ")}${
            failedNames.length > 3 ? ` (+${failedNames.length - 3} more)` : ""
          }`
        );
      }
      if (succeeded.size > 0) {
        setSelectedModVersionIds((prev) => prev.filter((id) => !succeeded.has(id)));
      }
    } finally {
      setToggleBusyVersion(null);
    }
  }

  async function onAddModFromFile(inst: Instance) {
    setError(null);
    setModsErr(null);
    setInstallNotice(null);
    try {
      const picked = await openDialog({
        multiple: true,
        filters: [{ name: "Minecraft Mods", extensions: ["jar"] }],
      });
      if (!picked) return;
      const filePaths = Array.isArray(picked) ? picked : [picked];
      if (filePaths.length === 0) return;

      setImportingInstanceId(inst.id);
      let successCount = 0;
      const failedPaths: string[] = [];
      for (const filePath of filePaths) {
        try {
          await importLocalModFile({
            instanceId: inst.id,
            filePath,
          });
          successCount += 1;
        } catch {
          failedPaths.push(filePath);
        }
      }
      await refreshInstalledMods(inst.id);
      if (successCount > 0) {
        setInstallNotice(
          `Added ${successCount} mod file${successCount === 1 ? "" : "s"} from your computer.`
        );
      }
      if (failedPaths.length > 0) {
        const short = failedPaths
          .slice(0, 3)
          .map((path) => basenameWithoutExt(path))
          .join(", ");
        setModsErr(
          `Could not import ${failedPaths.length} file${failedPaths.length === 1 ? "" : "s"}: ${short}${
            failedPaths.length > 3 ? ` (+${failedPaths.length - 3} more)` : ""
          }`
        );
      }
    } catch (e: any) {
      setError(e?.toString?.() ?? String(e));
    } finally {
      setImportingInstanceId(null);
    }
  }

  async function onCancelPendingLaunch(inst: Instance) {
    setError(null);
    setLauncherErr(null);
    setLaunchCancelBusyInstanceId(inst.id);
    setLaunchStageByInstance((prev) => ({
      ...prev,
      [inst.id]: {
        status: "starting",
        label: "Cancelling",
        message: "Launch cancellation requested…",
        updated_at: Date.now(),
      },
    }));
    try {
      const message = await cancelInstanceLaunch({ instanceId: inst.id });
      setInstallNotice(message || `Launch cancellation requested for ${inst.name}.`);
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setError(msg);
      setLauncherErr(msg);
    } finally {
      setLaunchCancelBusyInstanceId(null);
    }
  }

  async function onPlayInstance(inst: Instance, method?: LaunchMethod) {
    if (launchBusyInstanceId === inst.id) {
      await onCancelPendingLaunch(inst);
      return;
    }
    if (launchBusyInstanceId && launchBusyInstanceId !== inst.id) {
      setInstallNotice("Another instance is currently launching. Cancel it first or wait.");
      return;
    }
    setError(null);
    setLauncherErr(null);
    setInstallNotice(null);
    setLaunchFailureByInstance((prev) => {
      if (!prev[inst.id]) return prev;
      const next = { ...prev };
      delete next[inst.id];
      return next;
    });
    setLaunchBusyInstanceId(inst.id);
    setLaunchStageByInstance((prev) => ({
      ...prev,
      [inst.id]: {
        status: "starting",
        label: "Preparing",
        message: "Preparing launch…",
        updated_at: Date.now(),
      },
    }));
    try {
      const res: LaunchResult = await launchInstance({
        instanceId: inst.id,
        method: method ?? launchMethodPick,
      });
      if (res.method === "prism" && res.prism_instance_id) {
        setInstallNotice(`${res.message} (Prism instance: ${res.prism_instance_id})`);
      } else {
        setInstallNotice(res.message);
      }
      setLaunchStageByInstance((prev) => ({
        ...prev,
        [inst.id]: {
          status: "running",
          label: "Running",
          message: res.message,
          updated_at: Date.now(),
        },
      }));
      const running = await listRunningInstances();
      const runningSafe = normalizeRunningInstancesPayload(running);
      setRunningInstances((prev) => (sameRunningInstances(prev, runningSafe) ? prev : runningSafe));
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      if (/cancelled by user|launch cancelled/i.test(msg)) {
        setInstallNotice("Launch cancelled.");
        setLaunchStageByInstance((prev) => {
          const next = { ...prev };
          delete next[inst.id];
          return next;
        });
      } else {
        setError(msg);
        setLauncherErr(msg);
        const launchMethod = String(method ?? launchMethodPick ?? "native").toLowerCase();
        setLaunchFailureByInstance((prev) => ({
          ...prev,
          [inst.id]: {
            status: "error",
            method: launchMethod,
            message: msg,
            updated_at: Date.now(),
          },
        }));
        setLaunchStageByInstance((prev) => ({
          ...prev,
          [inst.id]: {
            status: "error",
            label: "Error",
            message: msg,
            updated_at: Date.now(),
          },
        }));
      }
    } finally {
      setLaunchBusyInstanceId(null);
    }
  }

  async function onStopRunning(launchId: string) {
    setLauncherErr(null);
    try {
      await stopRunningInstance({ launchId });
      const running = await listRunningInstances();
      const runningSafe = normalizeRunningInstancesPayload(running);
      setRunningInstances((prev) => (sameRunningInstances(prev, runningSafe) ? prev : runningSafe));
      setInstallNotice("Stop signal sent.");
    } catch (e: any) {
      setLauncherErr(e?.toString?.() ?? String(e));
    }
  }

  async function onExportModsZip(inst: Instance) {
    setLauncherErr(null);
    setInstallNotice(null);
    try {
      const suggested = `${inst.name.replace(/\s+/g, "-") || "instance"}-mods.zip`;
      const savePath = await saveDialog({
        defaultPath: suggested,
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      });
      if (!savePath || Array.isArray(savePath)) return;
      const out = await exportInstanceModsZip({ instanceId: inst.id, outputPath: savePath });
      setInstallNotice(`Exported ${out.files_count} file(s) to ${out.output_path}`);
    } catch (e: any) {
      setLauncherErr(e?.toString?.() ?? String(e));
    }
  }

  async function onOpenInstancePath(
    inst: Instance,
    target: "instance" | "mods" | "resourcepacks" | "shaderpacks" | "saves" | "launch-log" | "crash-log"
  ) {
    setLauncherErr(null);
    setInstallNotice(null);
    try {
      const out = await openInstancePath({ instanceId: inst.id, target });
      setInstallNotice(
        out.target === "launch-log"
          ? `Opened launch log: ${out.path}`
          : out.target === "crash-log"
            ? `Opened latest crash report: ${out.path}`
          : `Opened ${out.target} folder: ${out.path}`
      );
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setLauncherErr(msg);
      setError(msg);
    }
  }

  async function onOpenLaunchLog(inst: Instance) {
    await onOpenInstancePath(inst, "launch-log");
  }

  async function persistUpdateSchedulerPrefs(next: {
    cadence?: SchedulerCadence;
    autoApplyMode?: SchedulerAutoApplyMode;
    applyScope?: SchedulerApplyScope;
  }) {
    setUpdatePrefsBusy(true);
    setScheduledUpdateErr(null);
    try {
      const settings = await setLauncherSettings({
        updateCheckCadence: next.cadence ?? updateCheckCadence,
        updateAutoApplyMode: next.autoApplyMode ?? updateAutoApplyMode,
        updateApplyScope: next.applyScope ?? updateApplyScope,
      });
      setLauncherSettingsState(settings);
      setUpdateCheckCadence(normalizeUpdateCheckCadence(settings.update_check_cadence));
      setUpdateAutoApplyMode(normalizeUpdateAutoApplyMode(settings.update_auto_apply_mode));
      setUpdateApplyScope(normalizeUpdateApplyScope(settings.update_apply_scope));
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setScheduledUpdateErr(msg);
      setError(msg);
    } finally {
      setUpdatePrefsBusy(false);
    }
  }

  async function onSaveLauncherPrefs() {
    setLauncherBusy(true);
    setLauncherErr(null);
    try {
      const next = await setLauncherSettings({
        defaultLaunchMethod: launchMethodPick,
        javaPath: javaPathDraft,
        oauthClientId: oauthClientIdDraft,
      });
      setLauncherSettingsState(next);
      setUpdateCheckCadence(normalizeUpdateCheckCadence(next.update_check_cadence));
      setUpdateAutoApplyMode(normalizeUpdateAutoApplyMode(next.update_auto_apply_mode));
      setUpdateApplyScope(normalizeUpdateApplyScope(next.update_apply_scope));
      setInstallNotice("Launcher settings saved.");
    } catch (e: any) {
      setLauncherErr(e?.toString?.() ?? String(e));
    } finally {
      setLauncherBusy(false);
    }
  }

  function onResetUiSettings() {
    const next = defaultUiSettingsSnapshot();
    clearUiSettingsStorage();
    setTheme(next.theme);
    setAccentPreset(next.accentPreset);
    setAccentStrength(next.accentStrength);
    setMotionPreset(next.motionPreset);
    setDensityPreset(next.densityPreset);
    setInstallNotice("UI settings reset to defaults.");
  }

  async function onBeginMicrosoftLogin() {
    setLauncherBusy(true);
    setLauncherErr(null);
    setMsLoginState(null);
    setMsCodePrompt(null);
    setMsCodePromptVisible(false);
    setMsCodeCopied(false);
    try {
      const start: BeginMicrosoftLoginResult = await beginMicrosoftLogin();
      setMsLoginSessionId(start.session_id);
      const verifyUrl = start.verification_uri ?? start.auth_url;
      if (start.user_code) {
        setMsCodePrompt({
          code: start.user_code,
          verificationUrl: verifyUrl,
        });
        setMsCodePromptVisible(true);
        setInstallNotice(
          `Microsoft sign-in started. Open ${verifyUrl} and enter code ${start.user_code}. If the browser says "Prism Launcher", that's expected when using the bundled client ID.`
        );
      } else {
        setInstallNotice("Microsoft sign-in started in your browser.");
      }
    } catch (e: any) {
      setLauncherErr(e?.toString?.() ?? String(e));
    } finally {
      setLauncherBusy(false);
    }
  }

  async function onSelectAccount(accountId: string) {
    setLauncherBusy(true);
    setLauncherErr(null);
    try {
      const settings = await selectLauncherAccount({ accountId });
      setLauncherSettingsState(settings);
      setUpdateCheckCadence(normalizeUpdateCheckCadence(settings.update_check_cadence));
      setUpdateAutoApplyMode(normalizeUpdateAutoApplyMode(settings.update_auto_apply_mode));
      setUpdateApplyScope(normalizeUpdateApplyScope(settings.update_apply_scope));
      await refreshAccountDiagnostics();
      setInstallNotice("Launcher account selected.");
    } catch (e: any) {
      setLauncherErr(e?.toString?.() ?? String(e));
    } finally {
      setLauncherBusy(false);
    }
  }

  async function onLogoutAccount(accountId: string) {
    setLauncherBusy(true);
    setLauncherErr(null);
    try {
      const accounts = await logoutMicrosoftAccount({ accountId });
      setLauncherAccounts(accounts);
      const settings = await getLauncherSettings();
      setLauncherSettingsState(settings);
      setUpdateCheckCadence(normalizeUpdateCheckCadence(settings.update_check_cadence));
      setUpdateAutoApplyMode(normalizeUpdateAutoApplyMode(settings.update_auto_apply_mode));
      setUpdateApplyScope(normalizeUpdateApplyScope(settings.update_apply_scope));
      await refreshAccountDiagnostics();
      setInstallNotice("Microsoft account disconnected.");
    } catch (e: any) {
      setLauncherErr(e?.toString?.() ?? String(e));
    } finally {
      setLauncherBusy(false);
    }
  }

  function storeScheduledUpdateResult(
    inst: Instance,
    result: ModUpdateCheckResult | null,
    checkedAtIso?: string,
    errorMessage?: string | null
  ) {
    const checkedAt = checkedAtIso ?? new Date().toISOString();
    setScheduledUpdateEntriesByInstance((prev) => ({
      ...prev,
      [inst.id]: {
        instance_id: inst.id,
        instance_name: inst.name,
        checked_at: checkedAt,
        checked_mods: result?.checked_mods ?? 0,
        update_count: result?.update_count ?? 0,
        updates: result?.updates ?? [],
        error: errorMessage ? String(errorMessage) : null,
      },
    }));
  }

  async function runScheduledUpdateChecks(reason: "manual" | "scheduled" = "manual") {
    if (scheduledUpdateRunningRef.current) return;
    if (instances.length === 0) return;
    scheduledUpdateRunningRef.current = true;
    setScheduledUpdateBusy(true);
    if (reason === "manual") setScheduledUpdateErr(null);
    const checkedAt = new Date().toISOString();
    let completed = 0;
    let autoAppliedInstances = 0;
    let autoAppliedMods = 0;
    const canAutoApplyInRun = updateAutoApplyMode !== "never" && (
      reason === "scheduled" || updateApplyScope === "scheduled_and_manual"
    );
    try {
      for (const inst of instances) {
        try {
          const result = await checkModrinthUpdates({ instanceId: inst.id });
          const shouldAutoApplyForInstance =
            canAutoApplyInRun &&
            result.update_count > 0 &&
            (updateAutoApplyMode === "all_instances" ||
              (updateAutoApplyMode === "opt_in_instances" &&
                Boolean(inst.settings?.auto_update_installed_content)));
          if (shouldAutoApplyForInstance) {
            try {
              const applyResult = await updateAllModrinthMods({ instanceId: inst.id });
              autoAppliedInstances += 1;
              autoAppliedMods += Math.max(0, applyResult.updated_mods ?? 0);
              const refreshed = await checkModrinthUpdates({ instanceId: inst.id });
              storeScheduledUpdateResult(inst, refreshed, checkedAt, null);
              if (route === "instance" && selectedId === inst.id) {
                setUpdateCheck(refreshed);
              }
            } catch (applyErr: any) {
              const applyMsg = applyErr?.toString?.() ?? String(applyErr);
              storeScheduledUpdateResult(
                inst,
                result,
                checkedAt,
                `Auto-apply failed: ${applyMsg}`
              );
              if (route === "instance" && selectedId === inst.id) {
                setUpdateCheck(result);
              }
            }
          } else {
            storeScheduledUpdateResult(inst, result, checkedAt, null);
            if (route === "instance" && selectedId === inst.id) {
              setUpdateCheck(result);
            }
          }
        } catch (err: any) {
          storeScheduledUpdateResult(
            inst,
            null,
            checkedAt,
            err?.toString?.() ?? String(err)
          );
        }
        completed += 1;
      }
      setScheduledUpdateLastRunAt(checkedAt);
      if (reason === "manual") {
        const autoAppliedMsg =
          autoAppliedInstances > 0
            ? ` Auto-applied ${autoAppliedMods} update${autoAppliedMods === 1 ? "" : "s"} across ${autoAppliedInstances} instance${autoAppliedInstances === 1 ? "" : "s"}.`
            : "";
        setInstallNotice(`Checked ${completed} instance${completed === 1 ? "" : "s"} for updates.${autoAppliedMsg}`);
      } else if (autoAppliedInstances > 0) {
        setInstallNotice(
          `Auto-applied ${autoAppliedMods} update${autoAppliedMods === 1 ? "" : "s"} across ${autoAppliedInstances} instance${autoAppliedInstances === 1 ? "" : "s"}.`
        );
      }
    } catch (err: any) {
      if (reason === "manual") {
        setScheduledUpdateErr(err?.toString?.() ?? String(err));
      }
    } finally {
      scheduledUpdateRunningRef.current = false;
      setScheduledUpdateBusy(false);
    }
  }

  async function onCheckUpdates(inst: Instance) {
    setUpdateBusy(true);
    setUpdateErr(null);
    try {
      const res = await checkModrinthUpdates({ instanceId: inst.id });
      setUpdateCheck(res);
      storeScheduledUpdateResult(inst, res, new Date().toISOString(), null);
      if (res.update_count === 0) {
        setInstallNotice("All Modrinth mods are up to date.");
      } else {
        setInstallNotice(
          `${res.update_count} update${res.update_count === 1 ? "" : "s"} available.`
        );
      }
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setUpdateErr(msg);
      storeScheduledUpdateResult(inst, null, new Date().toISOString(), msg);
    } finally {
      setUpdateBusy(false);
    }
  }

  async function onUpdateAll(inst: Instance) {
    setUpdateAllBusy(true);
    setUpdateErr(null);
    setError(null);
    try {
      const res = await updateAllModrinthMods({ instanceId: inst.id });
      await refreshInstalledMods(inst.id);
      const refreshed = await checkModrinthUpdates({ instanceId: inst.id });
      setUpdateCheck(refreshed);
      storeScheduledUpdateResult(inst, refreshed, new Date().toISOString(), null);
      setInstallNotice(
        `Updated ${res.updated_mods} mod${res.updated_mods === 1 ? "" : "s"} (${refreshed.update_count} remaining).`
      );
    } catch (e: any) {
      const msg = e?.toString?.() ?? String(e);
      setUpdateErr(msg);
      setError(msg);
      storeScheduledUpdateResult(inst, null, new Date().toISOString(), msg);
    } finally {
      setUpdateAllBusy(false);
    }
  }

  useEffect(() => {
    if (route !== "instance" || !selectedId) {
      setInstalledMods([]);
      setSelectedModVersionIds([]);
      setModsErr(null);
      setUpdateCheck(null);
      setUpdateErr(null);
      setSnapshots([]);
      setRollbackSnapshotId(null);
      setWorldRollbackBusyById({});
      return;
    }
    refreshInstalledMods(selectedId);
    refreshSnapshots(selectedId);
    listInstanceWorlds({ instanceId: selectedId })
      .then((worlds) => setInstanceWorlds(worlds))
      .catch(() => setInstanceWorlds([]));
    setUpdateCheck(null);
    setUpdateErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setInstanceWorlds([]);
      setSelectedModVersionIds([]);
      return;
    }
    // Instance route already fetches worlds in its dedicated effect above.
    if (route === "instance") return;
    if (route !== "modpacks") return;
    listInstanceWorlds({ instanceId: selectedId })
      .then((worlds) => setInstanceWorlds(worlds))
      .catch(() => setInstanceWorlds([]));
  }, [route, selectedId]);

  useEffect(() => {
    const valid = new Set(
      installedMods
        .filter((m) => normalizeCreatorEntryType(m.content_type) === "mods")
        .map((m) => m.version_id)
    );
    setSelectedModVersionIds((prev) =>
      prev.filter((id) => valid.has(id))
    );
  }, [installedMods]);

  useEffect(() => {
    if (instanceContentType !== "mods") {
      setSelectedModVersionIds([]);
    }
  }, [instanceContentType]);

  useEffect(() => {
    const off = listen<InstallProgressEvent>("mod_install_progress", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setInstallProgress(payload);
    });
    return () => {
      off.then((unlisten) => unlisten()).catch(() => null);
    };
  }, []);

  useEffect(() => {
    const off = listen<InstanceLaunchStateEvent>("instance_launch_state", (event) => {
      const payload = event.payload;
      if (!payload) return;
      const status = String(payload.status ?? "").toLowerCase();
      const method = String(payload.method ?? "").toLowerCase();
      const message = String(payload.message ?? "").trim();
      const instanceId = String(payload.instance_id ?? "").trim();

      if (instanceId) {
        if (status === "starting") {
          setLaunchProgressChecksByInstance((prev) => ({
            ...prev,
            [instanceId]: mergeLaunchChecksFromMessage(
              prev[instanceId] ?? emptyLaunchHealthChecks(),
              message
            ),
          }));
        }
        if (status === "running" || status === "stopped" || status === "exited") {
          setLaunchBusyInstanceId((prev) => (prev === instanceId ? null : prev));
          setLaunchCancelBusyInstanceId((prev) => (prev === instanceId ? null : prev));
        }
        if (status === "starting" || status === "running") {
          const label = launchStageBadgeLabel(status, message);
          setLaunchStageByInstance((prev) => ({
            ...prev,
            [instanceId]: {
              status,
              label: label || (status === "running" ? "Running" : "Launching"),
              message,
              updated_at: Date.now(),
            },
          }));
        } else if (status === "stopped" || status === "exited") {
          setLaunchStageByInstance((prev) => {
            const next = { ...prev };
            delete next[instanceId];
            return next;
          });
        }

        if (status === "running") {
          setLaunchFailureByInstance((prev) => {
            if (!prev[instanceId]) return prev;
            const next = { ...prev };
            delete next[instanceId];
            return next;
          });
          if (method === "native") {
            setLaunchHealthByInstance((prev) => {
              if (prev[instanceId]) return prev;
              return {
                ...prev,
                [instanceId]: {
                  first_success_at: new Date().toISOString(),
                  checks: {
                    auth: true,
                    assets: true,
                    libraries: true,
                    starting_java: true,
                  },
                },
              };
            });
          }
          setLaunchProgressChecksByInstance((prev) => {
            if (!prev[instanceId]) return prev;
            const next = { ...prev };
            delete next[instanceId];
            return next;
          });
        } else if (status === "stopped" || status === "exited") {
          setLaunchProgressChecksByInstance((prev) => {
            if (!prev[instanceId]) return prev;
            const next = { ...prev };
            delete next[instanceId];
            return next;
          });

          const lowerMessage = message.toLowerCase();
          const isCleanExit = /some\(0\)|status\s+0/i.test(message);
          const isExpectedStop =
            lowerMessage.includes("cancelled by user") ||
            lowerMessage.includes("stop requested");
          if (status === "exited" && !isCleanExit && message) {
            setLaunchFailureByInstance((prev) => ({
              ...prev,
              [instanceId]: {
                status,
                method,
                message,
                updated_at: Date.now(),
              },
            }));
          } else if (status === "stopped" && message && !isExpectedStop) {
            setLaunchFailureByInstance((prev) => ({
              ...prev,
              [instanceId]: {
                status,
                method,
                message,
                updated_at: Date.now(),
              },
            }));
          } else if (isExpectedStop) {
            setLaunchFailureByInstance((prev) => {
              if (!prev[instanceId]) return prev;
              const next = { ...prev };
              delete next[instanceId];
              return next;
            });
          }
        }
      }

      if (status === "starting" || status === "running") {
        if (message) setInstallNotice(message);
      } else if (status === "exited") {
        const isCleanExit = /some\(0\)|status\s+0/i.test(message);
        if (isCleanExit) {
          setInstallNotice(message || "Game exited normally.");
        } else if (message) {
          setLauncherErr(message);
        }
      } else if (status === "stopped") {
        if (message) setInstallNotice(message);
      }

      listRunningInstances()
        .then((items) => {
          const next = normalizeRunningInstancesPayload(items);
          setRunningInstances((prev) => (sameRunningInstances(prev, next) ? prev : next));
        })
        .catch(() => null);
    });
    return () => {
      off.then((unlisten) => unlisten()).catch(() => null);
    };
  }, []);

  useEffect(() => {
    if (!msLoginSessionId) return;
    let cancelled = false;
    const t = window.setInterval(async () => {
      try {
        const state = await pollMicrosoftLogin({ sessionId: msLoginSessionId });
        if (cancelled) return;
        setMsLoginState(state);
        if (state.status === "success") {
          const [accounts, settings] = await Promise.all([
            listLauncherAccounts(),
            getLauncherSettings(),
          ]);
          if (cancelled) return;
          setLauncherAccounts(accounts);
          setLauncherSettingsState(settings);
          setUpdateCheckCadence(normalizeUpdateCheckCadence(settings.update_check_cadence));
          setUpdateAutoApplyMode(normalizeUpdateAutoApplyMode(settings.update_auto_apply_mode));
          setUpdateApplyScope(normalizeUpdateApplyScope(settings.update_apply_scope));
          refreshAccountDiagnostics().catch(() => null);
          setInstallNotice(state.message ?? "Microsoft account connected.");
          setMsLoginSessionId(null);
          setMsCodePromptVisible(false);
          setMsCodePrompt(null);
          setMsCodeCopied(false);
        } else if (state.status === "error") {
          setLauncherErr(state.message ?? "Microsoft login failed.");
          setMsLoginSessionId(null);
          setMsCodePromptVisible(false);
          setMsCodePrompt(null);
          setMsCodeCopied(false);
        }
      } catch {
        // ignore transient polling failures
      }
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [msLoginSessionId]);

  const showSkinStudio = route === "skins";
  const showSkinViewer = showSkinStudio && skinPreviewEnabled;
  const normalizedPreviewTimeOfDay = useMemo(
    () => normalizeTimeOfDay(previewTimeOfDay),
    [previewTimeOfDay]
  );
  const previewTimeLabel = useMemo(
    () => describeTimeOfDay(normalizedPreviewTimeOfDay),
    [normalizedPreviewTimeOfDay]
  );
  const previewTimeText = useMemo(
    () => formatTimeOfDay(normalizedPreviewTimeOfDay),
    [normalizedPreviewTimeOfDay]
  );
  const skinViewerShadowStyle = useMemo(() => {
    const t = normalizedPreviewTimeOfDay / 24;
    const azimuth = t * Math.PI * 2;
    const elevation = clampNumber(Math.sin((t - 0.25) * Math.PI * 2), 0.12, 0.98);
    const daylight = clampNumber((elevation - 0.12) / 0.86, 0, 1);
    const length = 4 + (1 - daylight) * 26;
    const offsetX = Math.cos(azimuth) * length;
    const offsetY = Math.sin(azimuth) * length * 0.36;
    const scaleX = 1.02 + (1 - daylight) * 0.42;
    const scaleY = 0.84 + (1 - daylight) * 0.26;
    const blur = 3 + (1 - daylight) * 5;
    const alpha = 0.12 + (1 - daylight) * 0.16;
    return {
      "--shadow-x": `${offsetX.toFixed(1)}px`,
      "--shadow-y": `${offsetY.toFixed(1)}px`,
      "--shadow-scale-x": scaleX.toFixed(3),
      "--shadow-scale-y": scaleY.toFixed(3),
      "--shadow-blur": `${blur.toFixed(1)}px`,
      "--shadow-alpha": alpha.toFixed(3),
    } as CSSProperties;
  }, [normalizedPreviewTimeOfDay]);
  const skinViewerNameTag =
    accountDiagnostics?.minecraft_username ??
    selectedLauncherAccount?.username ??
    "Player";
  const skinViewerHintText = !skinPreviewEnabled
    ? "3D preview is disabled."
    : skinViewerPreparing
      ? "Preparing 3D preview…"
      : skinViewerBusy
        ? "Loading 3D preview…"
        : "Drag to rotate/tilt, scroll to zoom, click to punch, idle for emotes";

  const resolveViewerTexture = async (
    src: string | null,
    cacheRef: { current: Map<string, string> }
  ): Promise<string | null> => {
    if (!src) return null;
    if (!/^https?:/i.test(src)) return src;
    const cached = cacheRef.current.get(src);
    if (cached) return cached;
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), SKIN_IMAGE_FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(src, { cache: "force-cache", signal: controller.signal });
      } finally {
        window.clearTimeout(timeout);
      }
      if (!response.ok) return src;
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      cacheRef.current.set(src, objectUrl);
      if (cacheRef.current.size > 40) {
        const oldest = cacheRef.current.keys().next().value as string | undefined;
        if (oldest) {
          const stale = cacheRef.current.get(oldest);
          if (stale?.startsWith("blob:")) URL.revokeObjectURL(stale);
          cacheRef.current.delete(oldest);
        }
      }
      return objectUrl;
    } catch {
      return src;
    }
  };

  useEffect(() => {
    if (route !== "account") return;
    if (!selectedLauncherAccountId || accountDiagnosticsBusy || accountDiagnostics) return;

    let cancelled = false;
    let handle: number | null = null;
    const idleApi = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout?: number }
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const runRefresh = () => {
      if (cancelled) return;
      refreshAccountDiagnostics().catch(() => null);
    };

    if (idleApi.requestIdleCallback) {
      handle = idleApi.requestIdleCallback(runRefresh, { timeout: 2400 });
    } else {
      handle = window.setTimeout(runRefresh, 1800);
    }

    return () => {
      cancelled = true;
      if (handle == null) return;
      if (idleApi.requestIdleCallback && idleApi.cancelIdleCallback) {
        idleApi.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, [route, selectedLauncherAccountId, accountDiagnosticsBusy, accountDiagnostics]);

  useEffect(() => {
    return () => {
      for (const value of skinTextureCacheRef.current.values()) {
        if (value.startsWith("blob:")) URL.revokeObjectURL(value);
      }
      for (const value of capeTextureCacheRef.current.values()) {
        if (value.startsWith("blob:")) URL.revokeObjectURL(value);
      }
      skinTextureCacheRef.current.clear();
      capeTextureCacheRef.current.clear();
    };
  }, []);

  useEffect(() => {
    setLibraryContextMenu(null);
  }, [route]);

  useEffect(() => {
    setSelectedCrashSuspect(null);
  }, [
    selectedId,
    logSourceFilter,
    logSeverityFilter,
    logFilterQuery,
    logQuickFilters.errors,
    logQuickFilters.warnings,
    logQuickFilters.suspects,
    logQuickFilters.crashes,
  ]);

  useEffect(() => {
    if (route !== "instance" || instanceTab !== "logs" || !selectedId) return;
    let cancelled = false;
    let timer: number | null = null;
    const cacheKey = `${selectedId}:${logSourceFilter}`;
    const applyPayload = (incoming: ReadInstanceLogsResult, mode: "replace_tail" | "prepend_older") => {
      let merged: ReadInstanceLogsResult = incoming;
      setRawLogLinesBySource((prev) => {
        const existing = prev[cacheKey] ?? null;
        merged = mergeReadInstanceLogPayload({ existing, incoming, mode });
        return {
          ...prev,
          [cacheKey]: merged,
        };
      });
      const nextBeforeLine = normalizeLogLineNo(merged.next_before_line);
      setLogWindowBySource((prev) => ({
        ...prev,
        [cacheKey]: {
          nextBeforeLine,
          loadingOlder: prev[cacheKey]?.loadingOlder ?? false,
          fullyLoaded: nextBeforeLine == null,
        },
      }));
    };
    const pull = async (silent = false) => {
      const reqId = ++logLoadRequestSeqRef.current;
      if (!silent) setLogLoadBusy(true);
      try {
        const payload = await readInstanceLogs({
          instanceId: selectedId,
          source: logSourceFilter,
          maxLines: logMaxLines,
        });
        if (cancelled || reqId !== logLoadRequestSeqRef.current) return;
        applyPayload(payload, "replace_tail");
        setLogLoadErr(null);
      } catch (err: any) {
        if (cancelled || reqId !== logLoadRequestSeqRef.current) return;
        setLogLoadErr(err?.toString?.() ?? String(err));
      } finally {
        if (!silent && !cancelled && reqId === logLoadRequestSeqRef.current) {
          setLogLoadBusy(false);
        }
      }
    };

    void pull(false);
    if (logSourceFilter === "live") {
      timer = window.setInterval(() => {
        void pull(true);
      }, 1000);
    }

    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, [route, instanceTab, selectedId, logSourceFilter, logMaxLines]);

  useEffect(() => {
    if (route === "instance" && instanceTab === "logs") return;
    setLogLoadBusy(false);
  }, [route, instanceTab]);

  const onLoadOlderLogLines = async () => {
    if (route !== "instance" || instanceTab !== "logs" || !selectedId || logSourceFilter === "live") return;
    const cacheKey = `${selectedId}:${logSourceFilter}`;
    const currentWindow = logWindowBySource[cacheKey];
    const beforeLine = normalizeLogLineNo(
      currentWindow?.nextBeforeLine ?? rawLogLinesBySource[cacheKey]?.next_before_line
    );
    if (beforeLine == null) return;
    const reqId = ++logLoadRequestSeqRef.current;
    setLogWindowBySource((prev) => ({
      ...prev,
      [cacheKey]: {
        nextBeforeLine: prev[cacheKey]?.nextBeforeLine ?? beforeLine,
        loadingOlder: true,
        fullyLoaded: prev[cacheKey]?.fullyLoaded ?? false,
      },
    }));
    try {
      const incoming = await readInstanceLogs({
        instanceId: selectedId,
        source: logSourceFilter,
        maxLines: logMaxLines,
        beforeLine,
      });
      if (reqId !== logLoadRequestSeqRef.current) return;
      let merged: ReadInstanceLogsResult = incoming;
      setRawLogLinesBySource((prev) => {
        const existing = prev[cacheKey] ?? null;
        merged = mergeReadInstanceLogPayload({
          existing,
          incoming,
          mode: "prepend_older",
        });
        return {
          ...prev,
          [cacheKey]: merged,
        };
      });
      const nextBeforeLine = normalizeLogLineNo(merged.next_before_line);
      setLogWindowBySource((prev) => ({
        ...prev,
        [cacheKey]: {
          nextBeforeLine,
          loadingOlder: false,
          fullyLoaded: nextBeforeLine == null,
        },
      }));
      setLogLoadErr(null);
    } catch (err: any) {
      if (reqId !== logLoadRequestSeqRef.current) return;
      setLogLoadErr(err?.toString?.() ?? String(err));
      setLogWindowBySource((prev) => ({
        ...prev,
        [cacheKey]: {
          nextBeforeLine: prev[cacheKey]?.nextBeforeLine ?? beforeLine,
          loadingOlder: false,
          fullyLoaded: prev[cacheKey]?.fullyLoaded ?? false,
        },
      }));
    }
  };

  useEffect(() => {
    if (!libraryContextMenu) return;
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (libraryContextMenuRef.current?.contains(target)) return;
      setLibraryContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLibraryContextMenu(null);
    };
    const closeMenu = () => setLibraryContextMenu(null);

    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [libraryContextMenu]);

  useEffect(() => {
    setAccountAvatarSourceIdx(0);
  }, [accountDiagnostics?.minecraft_uuid, accountDiagnostics?.skin_url]);

  useEffect(() => {
    let cancelled = false;
    setAccountAvatarFromSkin(null);
    const skinUrl = accountDiagnostics?.skin_url ?? null;
    if (!skinUrl) return;
    renderMinecraftHeadFromSkin(skinUrl, 128)
      .then((url) => {
        if (!cancelled && url) setAccountAvatarFromSkin(url);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [accountDiagnostics?.skin_url]);

  useEffect(() => {
    let cancelled = false;
    const pending = accountSkinOptions.filter((skin) => {
      const existing = accountSkinThumbs[skin.id];
      return !existing || !existing.front || !existing.back || existing.mode !== "3d";
    });
    if (route !== "skins" || pending.length === 0) return;
    const idleApi = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout?: number }
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let handle: number | null = null;
    let cursor = 0;
    const schedule = () => {
      if (cancelled) return;
      if (idleApi.requestIdleCallback) {
        handle = idleApi.requestIdleCallback(run, { timeout: 1200 });
      } else {
        handle = window.setTimeout(run, 60);
      }
    };
    const run = () => {
      (async () => {
        const nextThumbs: Record<string, AccountSkinThumbSet> = {};
        const chunk = pending.slice(cursor, cursor + 2);
        cursor += chunk.length;
        for (const skin of chunk) {
          const baseSrc = toLocalIconSrc(skin.skin_url);
          if (!baseSrc) continue;
          const sources = skinThumbSourceCandidates(baseSrc);
          let front3d: string | null = null;
          let back3d: string | null = null;
          for (const candidate of sources) {
            front3d = await renderMinecraftSkinThumb3d({
              skinUrl: candidate,
              view: "front",
              size: SKIN_THUMB_3D_SIZE,
            }).catch(() => null);
            back3d = await renderMinecraftSkinThumb3d({
              skinUrl: candidate,
              view: "back",
              size: SKIN_THUMB_3D_SIZE,
            }).catch(() => null);
            if (front3d && back3d) break;
          }
          const prev = accountSkinThumbs[skin.id];
          if (front3d && back3d) {
            const changed =
              prev?.mode !== "3d" || prev.front !== front3d || prev.back !== back3d;
            if (changed) {
              nextThumbs[skin.id] = { front: front3d, back: back3d, mode: "3d" };
            }
          } else {
            const fallbackFront =
              front3d ??
              toLocalIconSrc(skin.preview_url) ??
              (await renderMinecraftHeadFromSkin(baseSrc, 192).catch(() => null)) ??
              "";
            const fallbackBack = back3d ?? fallbackFront;
            if (fallbackFront) {
              const changed =
                prev?.mode !== "fallback" ||
                prev.front !== fallbackFront ||
                prev.back !== fallbackBack;
              if (changed) {
                nextThumbs[skin.id] = {
                  front: fallbackFront,
                  back: fallbackBack,
                  mode: "fallback",
                };
              }
            }
          }
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
        if (!cancelled && Object.keys(nextThumbs).length > 0) {
          setAccountSkinThumbs((prev) => ({ ...prev, ...nextThumbs }));
        }
        if (!cancelled && cursor < pending.length) {
          schedule();
        }
      })().catch(() => null);
    };
    schedule();
    return () => {
      cancelled = true;
      if (handle == null) return;
      if (idleApi.requestIdleCallback && idleApi.cancelIdleCallback) {
        idleApi.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, [route, accountSkinOptions, accountSkinThumbs]);

  useEffect(() => {
    if (!showSkinViewer) {
      setSkinViewerPreparing(false);
      setSkinViewerBusy(false);
      skinViewerNameTagTextRef.current = null;
      return;
    }
    const stage = accountSkinViewerStageRef.current;
    const canvas = accountSkinViewerCanvasRef.current;
    if (!stage || !canvas || accountSkinViewerRef.current) return;

    let disposed = false;
    let idleHandle: number | null = null;
    const idleApi = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout?: number }
      ) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    setSkinViewerPreparing(true);

    const startViewer = () => {
      if (disposed || accountSkinViewerRef.current) return;
      const rect = stage.getBoundingClientRect();
      let viewer: SkinViewer;
      try {
        viewer = new SkinViewer({
          canvas,
          width: Math.max(220, Math.round(rect.width)),
          height: Math.max(280, Math.round(rect.height)),
          zoom: 0.64,
          fov: 40,
        });
        setSkinViewerErr(null);
      } catch (error) {
        setSkinViewerErr(
          error instanceof Error
            ? `3D preview unavailable: ${error.message}`
            : "3D preview unavailable on this device."
        );
        setSkinViewerPreparing(false);
        setSkinViewerBusy(false);
        return;
      }
      viewer.background = null;
      const renderer = (viewer as unknown as { renderer?: { setPixelRatio?: (ratio: number) => void } }).renderer;
      renderer?.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 1.5));
      viewer.globalLight.intensity = 1.15;
      viewer.cameraLight.intensity = 1.05;
      viewer.playerWrapper.position.y = 1.14;
      viewer.controls.enablePan = false;
      viewer.controls.enableZoom = true;
      viewer.controls.enableDamping = true;
      viewer.controls.dampingFactor = 0.09;
      viewer.controls.rotateSpeed = 0.68;
      viewer.controls.zoomSpeed = 0.88;
      viewer.controls.minDistance = 22;
      viewer.controls.maxDistance = 80;
      viewer.controls.minPolarAngle = 0.24;
      viewer.controls.maxPolarAngle = Math.PI - 0.24;
      viewer.controls.target.set(0, 11.2, 0);
      viewer.controls.update();
      viewer.autoRotate = false;

      const recoilState = {
        startedAt: 0,
        durationMs: 320,
        amount: 0.118,
      };
      const attackState = {
        startedAt: 0,
        durationMs: 300,
        amount: 1,
        arm: "right" as "right" | "left",
      };
      const emoteNames = [
        "wave",
        "nod",
        "celebrate",
        "lookAround",
        "salute",
        "shrug",
        "stretch",
        "bouncy",
        "twist",
        "bow",
        "headPop",
      ] as const;
      const emoteState = {
        name: null as (typeof emoteNames)[number] | null,
        startedAt: 0,
        durationMs: 0,
        nextAt: performance.now() + 7000 + Math.random() * 5000,
        lastInteractionAt: performance.now(),
      };
      const queueNextEmote = (now: number, minDelayMs = 5600) => {
        emoteState.nextAt = now + minDelayMs + Math.random() * 6800;
      };
      const markInteraction = (minDelayMs = 4200) => {
        const now = performance.now();
        emoteState.lastInteractionAt = now;
        if (!emoteState.name) queueNextEmote(now, minDelayMs);
      };
      const startRandomEmote = () => {
        const next = emoteNames[Math.floor(Math.random() * emoteNames.length)] ?? "wave";
        emoteState.name = next;
        emoteState.startedAt = performance.now();
        emoteState.durationMs =
          next === "wave"
            ? 2200
            : next === "celebrate"
              ? 1800
              : next === "lookAround"
                ? 2400
                : next === "salute"
                  ? 1500
                  : next === "shrug"
                    ? 1700
                    : next === "stretch"
                      ? 1900
                      : next === "bouncy"
                        ? 2100
                        : next === "twist"
                          ? 1900
                          : next === "headPop"
                            ? 2400
                          : 1400;
      };
      const tapState = {
        pointerId: -1,
        x: 0,
        y: 0,
        at: 0,
      };
      const triggerAttack = () => {
        markInteraction(5200);
        recoilState.startedAt = performance.now();
        recoilState.amount = 0.118;
        attackState.startedAt = performance.now();
        attackState.amount = 1;
        attackState.arm = "right";
        emoteState.name = null;
      };
      const onPointerDown = (event: PointerEvent) => {
        markInteraction(4200);
        tapState.pointerId = event.pointerId;
        tapState.x = event.clientX;
        tapState.y = event.clientY;
        tapState.at = performance.now();
      };
      const onPointerUp = (event: PointerEvent) => {
        markInteraction(4200);
        if (tapState.pointerId !== event.pointerId) return;
        const dx = event.clientX - tapState.x;
        const dy = event.clientY - tapState.y;
        const distance = Math.hypot(dx, dy);
        const elapsed = performance.now() - tapState.at;
        if (distance <= 9 && elapsed <= 300) {
          triggerAttack();
        }
        tapState.pointerId = -1;
      };
      const onPointerCancel = () => {
        markInteraction(4200);
        tapState.pointerId = -1;
      };
      const onWheel = () => {
        markInteraction(3600);
      };
      const controls = viewer.controls as unknown as {
        addEventListener?: (event: string, cb: () => void) => void;
        removeEventListener?: (event: string, cb: () => void) => void;
      };
      const onControlStart = () => markInteraction(4200);
      const onControlChange = () => markInteraction(2600);
      controls.addEventListener?.("start", onControlStart);
      controls.addEventListener?.("change", onControlChange);
      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("wheel", onWheel, { passive: true });
      skinViewerInputCleanupRef.current = () => {
        controls.removeEventListener?.("start", onControlStart);
        controls.removeEventListener?.("change", onControlChange);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("wheel", onWheel);
      };

      const idle = new IdleAnimation();
      idle.speed = 0.78;
      idle.addAnimation((player, progress) => {
        const now = performance.now();
        const breathing = Math.sin(progress * 2.4) * 0.055;
        const sway = Math.sin(progress * 0.92) * 0.085;
        const elapsed = now - recoilState.startedAt;
        const t = recoilState.startedAt > 0 ? Math.min(1, Math.max(0, elapsed / recoilState.durationMs)) : 1;
        let recoil = 0;
        if (t < 1) {
          if (t <= 0.19) {
            recoil = recoilState.amount * (t / 0.19);
          } else {
            const release = (t - 0.19) / 0.81;
            recoil = recoilState.amount * Math.pow(1 - release, 2.25);
          }
        }
        const attackElapsed = now - attackState.startedAt;
        const attackT =
          attackState.startedAt > 0
            ? Math.min(1, Math.max(0, attackElapsed / attackState.durationMs))
            : 1;

        if (
          !emoteState.name &&
          attackT >= 1 &&
          now >= emoteState.nextAt &&
          now - emoteState.lastInteractionAt > 5000
        ) {
          startRandomEmote();
        }

        let emoteProgress = -1;
        if (emoteState.name) {
          emoteProgress = Math.min(1, Math.max(0, (now - emoteState.startedAt) / emoteState.durationMs));
          if (emoteProgress >= 1) {
            emoteState.name = null;
            emoteProgress = -1;
            queueNextEmote(now, 5200);
          }
        }
        const emotePeak = emoteProgress >= 0 ? Math.sin(Math.PI * emoteProgress) : 0;
        const emotePulse = emoteProgress >= 0 ? Math.sin(emoteProgress * Math.PI * 2.6) : 0;
        let emoteRightX = 0;
        let emoteRightY = 0;
        let emoteRightZ = 0;
        let emoteLeftX = 0;
        let emoteLeftY = 0;
        let emoteLeftZ = 0;
        let emoteHeadX = 0;
        let emoteHeadY = 0;
        let emoteHeadLift = 0;
        let emoteHeadForward = 0;
        let emoteBodyYaw = 0;
        let emoteBodyPitch = 0;
        let emoteBodyRoll = 0;
        let emoteLift = 0;
        let emoteLegRightX = 0;
        let emoteLegLeftX = 0;
        let emoteRootYaw = 0;
        if (emoteState.name === "wave") {
          emoteRightX = -1.08 * emotePeak;
          emoteRightZ = -0.18 * emotePeak + emotePulse * 0.42 * emotePeak;
          emoteBodyYaw = -0.09 * emotePeak;
        } else if (emoteState.name === "nod") {
          emoteHeadX = Math.sin(emoteProgress * Math.PI * 3.6) * 0.3 * (0.4 + emotePeak * 0.6);
          emoteBodyPitch = -0.05 * emotePeak;
        } else if (emoteState.name === "celebrate") {
          emoteRightX = -1.68 * emotePeak;
          emoteLeftX = -1.56 * emotePeak;
          emoteRightZ = -0.16 * emotePeak;
          emoteLeftZ = 0.16 * emotePeak;
          emoteLift = Math.sin(Math.PI * emoteProgress) * 0.08;
        } else if (emoteState.name === "lookAround") {
          emoteHeadY = Math.sin(emoteProgress * Math.PI * 1.8) * 0.55 * emotePeak;
          emoteHeadX = -0.07 * emotePeak;
          emoteBodyYaw = Math.sin(emoteProgress * Math.PI * 1.8) * 0.13 * emotePeak;
        } else if (emoteState.name === "salute") {
          emoteRightX = -1.3 * emotePeak;
          emoteRightY = -0.36 * emotePeak;
          emoteRightZ = -0.08 * emotePeak;
          emoteHeadX = -0.1 * emotePeak;
          emoteBodyYaw = -0.08 * emotePeak;
        } else if (emoteState.name === "shrug") {
          emoteRightX = -0.48 * emotePeak;
          emoteLeftX = -0.48 * emotePeak;
          emoteRightZ = -0.34 * emotePeak;
          emoteLeftZ = 0.34 * emotePeak;
          emoteHeadY = Math.sin(emoteProgress * Math.PI * 2.1) * 0.2 * emotePeak;
          emoteBodyRoll = Math.sin(emoteProgress * Math.PI * 2.1) * 0.06 * emotePeak;
        } else if (emoteState.name === "stretch") {
          emoteRightX = -1.76 * emotePeak;
          emoteLeftX = -1.76 * emotePeak;
          emoteRightZ = -0.12 * emotePeak;
          emoteLeftZ = 0.12 * emotePeak;
          emoteBodyPitch = -0.13 * emotePeak;
          emoteLift = 0.04 * emotePeak;
        } else if (emoteState.name === "bouncy") {
          const hop = Math.abs(Math.sin(emoteProgress * Math.PI * 3.3));
          emoteLift = hop * 0.095;
          emoteRightX = -0.46 * hop + emotePulse * 0.22 * emotePeak;
          emoteLeftX = -0.46 * hop - emotePulse * 0.22 * emotePeak;
          emoteLegRightX = -0.12 * hop + emotePulse * 0.14 * emotePeak;
          emoteLegLeftX = -0.12 * hop - emotePulse * 0.14 * emotePeak;
        } else if (emoteState.name === "twist") {
          const twist = Math.sin(emoteProgress * Math.PI * 2.4) * 0.24 * emotePeak;
          emoteBodyYaw = twist;
          emoteHeadY = -twist * 0.75;
          emoteRightX = -0.24 * emotePeak;
          emoteLeftX = -0.24 * emotePeak;
          emoteRootYaw = twist * 0.3;
        } else if (emoteState.name === "bow") {
          emoteBodyPitch = 0.22 * emotePeak;
          emoteHeadX = 0.28 * emotePeak;
          emoteRightX = -0.22 * emotePeak;
          emoteLeftX = -0.22 * emotePeak;
        } else if (emoteState.name === "headPop") {
          const t = Math.max(0, Math.min(1, emoteProgress));
          const easeOut = (v: number) => 1 - Math.pow(1 - v, 2.2);
          const easeIn = (v: number) => Math.pow(v, 2.1);
          let pop = 0;
          let hold = 0;
          let catchPhase = 0;
          let settle = 0;
          if (t < 0.22) {
            pop = easeOut(t / 0.22);
          } else if (t < 0.54) {
            pop = 1;
            hold = (t - 0.22) / 0.32;
          } else if (t < 0.84) {
            catchPhase = (t - 0.54) / 0.3;
            pop = 1 - easeIn(catchPhase);
          } else {
            settle = (t - 0.84) / 0.16;
          }
          const hoverBob = Math.sin(hold * Math.PI * 2.4) * 0.06;
          const settleBounce = Math.sin(Math.PI * settle) * Math.exp(-4.2 * settle);
          emoteHeadLift = pop * 1.72 + hoverBob + settleBounce * 0.12;
          emoteHeadForward = pop * 0.18 + Math.sin(hold * Math.PI * 2.1) * 0.035;
          emoteHeadY = Math.sin(t * Math.PI * 5.8) * 0.2 * pop;
          emoteHeadX = -0.04 * pop + settleBounce * 0.07;
          const reach = Math.max(pop * 0.9, Math.sin(catchPhase * Math.PI) * 1.08);
          emoteRightX = -1.16 * reach;
          emoteLeftX = -1.16 * reach;
          emoteRightZ = -0.14 * reach;
          emoteLeftZ = 0.14 * reach;
          emoteBodyPitch = -0.09 * pop + 0.1 * Math.sin(catchPhase * Math.PI) * (catchPhase > 0 ? 1 : 0);
          emoteLift = 0.04 * pop;
        }

        let punchWindup = 0;
        let punch = 0;
        if (attackT < 1) {
          if (attackT <= 0.2) {
            punchWindup = attackState.amount * (attackT / 0.2);
          } else if (attackT <= 0.42) {
            punch = attackState.amount * ((attackT - 0.2) / 0.22);
          } else {
            const recover = (attackT - 0.42) / 0.58;
            punch = attackState.amount * Math.pow(1 - recover, 1.65);
          }
        }
        const punchRight = attackState.arm === "right";
        const skin = (player as any).skin;
        const rightArm = skin?.rightArm;
        const leftArm = skin?.leftArm;
        const rightLeg = skin?.rightLeg;
        const leftLeg = skin?.leftLeg;
        const idleArmSwing = Math.sin(progress * 1.9) * 0.045;
        if (rightArm?.rotation) {
          rightArm.rotation.x = idleArmSwing + emoteRightX;
          rightArm.rotation.y = emoteRightY;
          rightArm.rotation.z = emoteRightZ;
        }
        if (leftArm?.rotation) {
          leftArm.rotation.x = -idleArmSwing * 0.68 + emoteLeftX;
          leftArm.rotation.y = emoteLeftY;
          leftArm.rotation.z = emoteLeftZ;
        }
        if (rightLeg?.rotation) {
          rightLeg.rotation.x = emoteLegRightX;
          rightLeg.rotation.y = 0;
          rightLeg.rotation.z = 0;
        }
        if (leftLeg?.rotation) {
          leftLeg.rotation.x = emoteLegLeftX;
          leftLeg.rotation.y = 0;
          leftLeg.rotation.z = 0;
        }
        if (punch > 0) {
          const attackingArm = punchRight ? rightArm : leftArm;
          const supportArm = punchRight ? leftArm : rightArm;
          if (attackingArm?.rotation) {
            attackingArm.rotation.x += 0.26 * punchWindup - 1.92 * punch;
            attackingArm.rotation.y = (punchRight ? -0.12 : 0.12) * punch;
            attackingArm.rotation.z += (punchRight ? -0.28 : 0.28) * punch;
          }
          if (supportArm?.rotation) {
            supportArm.rotation.x += 0.14 * punch + 0.08 * punchWindup;
            supportArm.rotation.z += (punchRight ? 0.08 : -0.08) * punch;
          }
        }
        const combatYaw = (punchRight ? -0.24 : 0.24) * punch + (punchRight ? 0.08 : -0.08) * punchWindup;
        if (skin?.body?.rotation) {
          skin.body.rotation.y = emoteBodyYaw + combatYaw;
          skin.body.rotation.x = -recoil * 0.29 + emoteBodyPitch;
          skin.body.rotation.z = Math.sin(progress * 1.2) * 0.015 + emoteBodyRoll;
        }
        if (skin?.head?.rotation) {
          skin.head.rotation.x = Math.sin(progress * 2.2) * 0.05 - recoil * 0.24 + emoteHeadX - punch * 0.05;
          skin.head.rotation.y = emoteHeadY + (punchRight ? 0.04 : -0.04) * punch;
        }
        if (skin?.head?.position) {
          skin.head.position.y = emoteHeadLift;
          skin.head.position.z = emoteHeadForward;
        }
        player.position.y = 0.06 + breathing + emoteLift;
        player.position.z = -recoil - punch * 0.055;
        player.rotation.x = -recoil * 0.34 - punch * 0.06;
        player.rotation.y = sway + (punchRight ? -0.18 : 0.18) * punch + emoteBodyYaw * 0.26 + emoteRootYaw;
      });
      viewer.animation = idle;

      accountSkinViewerRef.current = viewer;
      skinViewerNameTagTextRef.current = null;
      lastLoadedSkinSrcRef.current = null;
      lastLoadedCapeSrcRef.current = null;
      const resizeObserver = new ResizeObserver(() => {
        const { width, height } = stage.getBoundingClientRect();
        viewer.setSize(Math.max(220, Math.round(width)), Math.max(260, Math.round(height)));
      });
      resizeObserver.observe(stage);
      accountSkinViewerResizeRef.current = resizeObserver;
      setSkinViewerPreparing(false);
      setSkinViewerEpoch((v) => v + 1);

      if (disposed) {
        skinViewerInputCleanupRef.current?.();
        skinViewerInputCleanupRef.current = null;
        resizeObserver.disconnect();
        viewer.dispose();
      }
    };

    if (idleApi.requestIdleCallback) {
      idleHandle = idleApi.requestIdleCallback(startViewer, { timeout: 260 });
    } else {
      idleHandle = window.setTimeout(startViewer, 110);
    }

    return () => {
      disposed = true;
      setSkinViewerPreparing(false);
      setSkinViewerBusy(false);
      if (idleHandle != null) {
        if (idleApi.cancelIdleCallback && idleApi.requestIdleCallback) {
          idleApi.cancelIdleCallback(idleHandle);
        } else {
          window.clearTimeout(idleHandle);
        }
      }
      skinViewerInputCleanupRef.current?.();
      skinViewerInputCleanupRef.current = null;
      accountSkinViewerResizeRef.current?.disconnect();
      accountSkinViewerResizeRef.current = null;
      accountSkinViewerRef.current?.dispose();
      accountSkinViewerRef.current = null;
      skinViewerNameTagTextRef.current = null;
    };
  }, [showSkinViewer, route]);

  useEffect(() => {
    if (!showSkinViewer) return;
    const viewer = accountSkinViewerRef.current;
    if (!viewer) return;
    const text = String(skinViewerNameTag ?? "").trim() || "Player";
    if (skinViewerNameTagTextRef.current === text && viewer.nameTag) return;
    viewer.nameTag = new NameTagObject(text, {
      font: "64px Minecraft, system-ui, sans-serif",
      margin: [8, 16, 8, 16],
      textStyle: "rgba(246, 248, 255, 0.98)",
      backgroundStyle: "rgba(18, 24, 36, 0.55)",
      height: 2.8,
      repaintAfterLoaded: true,
    });
    if (viewer.nameTag) {
      viewer.nameTag.position.y = 20.3;
    }
    skinViewerNameTagTextRef.current = text;
  }, [showSkinViewer, skinViewerEpoch, skinViewerNameTag]);

  useEffect(() => {
    if (!showSkinViewer) return;
    const viewer = accountSkinViewerRef.current;
    if (!viewer) return;
    const t = normalizedPreviewTimeOfDay / 24;
    const azimuth = t * Math.PI * 2;
    const elevation = clampNumber(Math.sin((t - 0.25) * Math.PI * 2), 0.12, 0.98);
    const daylight = clampNumber((elevation - 0.12) / 0.86, 0, 1);
    // Keep the model readable at all times, then layer time-of-day variation on top.
    const readableBias = 1 - daylight;
    viewer.globalLight.intensity = 1.2 + daylight * 0.52 + readableBias * 0.22;
    viewer.cameraLight.intensity = 1.08 + daylight * 0.48 + readableBias * 0.3;
    const cameraDistance = viewer.camera.position.length();
    const frontBias = cameraDistance * (0.74 + 0.08 * daylight);
    const sideBias = cameraDistance * (0.12 + 0.16 * daylight);
    viewer.cameraLight.position.set(
      Math.cos(azimuth) * Math.cos(elevation) * sideBias,
      cameraDistance * 0.5 + Math.sin(elevation) * cameraDistance * 0.4,
      frontBias + Math.sin(azimuth) * Math.cos(elevation) * sideBias * 0.45
    );
  }, [showSkinViewer, skinViewerEpoch, normalizedPreviewTimeOfDay]);

  useEffect(() => {
    if (!showSkinViewer) return;
    const viewer = accountSkinViewerRef.current;
    if (!viewer) return;
    const loadWithTimeout = async (task: Promise<void> | void) => {
      await Promise.race([
        Promise.resolve(task),
        new Promise<void>((resolve) => window.setTimeout(resolve, SKIN_VIEWER_LOAD_TIMEOUT_MS)),
      ]);
    };
    let cancelled = false;
    const skinSrc = toLocalIconSrc(selectedAccountSkin?.skin_url) ?? null;
    const capeSrc = toLocalIconSrc(selectedAccountCape?.url) ?? null;
    const skinChanged = skinSrc !== lastLoadedSkinSrcRef.current;
    const capeChanged = capeSrc !== lastLoadedCapeSrcRef.current;
    if (!skinChanged && !capeChanged) {
      setSkinViewerBusy(false);
      return;
    }
    setSkinViewerBusy(true);
    (async () => {
      if (skinChanged) {
        const skinLoadStarted = performance.now();
        try {
          if (skinSrc) {
            const resolvedSkinSrc = await resolveViewerTexture(skinSrc, skinTextureCacheRef);
            if (cancelled) return;
            await loadWithTimeout(viewer.loadSkin(resolvedSkinSrc ?? skinSrc, { model: "auto-detect" }));
          } else {
            viewer.loadSkin(null);
          }
          lastLoadedSkinSrcRef.current = skinSrc;
        } catch {
          // keep the current texture if remote loading fails
        } finally {
          const skinLoadMs = Math.round(performance.now() - skinLoadStarted);
          if (skinLoadMs > 900) {
            console.info(`[perf] skin texture load took ${skinLoadMs}ms (${skinSrc ?? "none"})`);
          }
        }
      }
      if (cancelled) return;
      if (capeChanged) {
        const capeLoadStarted = performance.now();
        try {
          if (capeSrc) {
            const resolvedCapeSrc = await resolveViewerTexture(capeSrc, capeTextureCacheRef);
            if (cancelled) return;
            await loadWithTimeout(viewer.loadCape(resolvedCapeSrc ?? capeSrc, { backEquipment: "cape" }));
          } else {
            viewer.loadCape(null);
          }
          lastLoadedCapeSrcRef.current = capeSrc;
        } catch {
          viewer.loadCape(null);
          lastLoadedCapeSrcRef.current = null;
        } finally {
          const capeLoadMs = Math.round(performance.now() - capeLoadStarted);
          if (capeLoadMs > 900) {
            console.info(`[perf] cape texture load took ${capeLoadMs}ms (${capeSrc ?? "none"})`);
          }
        }
      }
      if (!cancelled) setSkinViewerBusy(false);
    })().catch(() => {
      if (!cancelled) setSkinViewerBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    showSkinViewer,
    skinViewerEpoch,
    selectedAccountSkin?.skin_url,
    selectedAccountCape?.url,
  ]);

  function renderContent() {
    if (route === "settings") {
      return (
        <div style={{ maxWidth: 980 }}>
          <div className="h1">Settings</div>
          <div className="p">Theme, accent, and interaction feel.</div>

          <div className="card" style={{ padding: 16, marginTop: 14, borderRadius: 22 }}>
            <div style={{ fontWeight: 980, fontSize: 14 }}>Appearance</div>
            <div className="p" style={{ marginTop: 8 }}>Tune the app look without changing layout behavior.</div>

            <div className="settingStack">
              <div>
                <div className="settingTitle">Theme</div>
                <div className="settingSub">Switch between dark and light.</div>
                <div className="row">
                  <button
                    className={`btn ${theme === "dark" ? "primary" : ""}`}
                    onClick={() => setTheme("dark")}
                  >
                    Dark
                  </button>
                  <button
                    className={`btn ${theme === "light" ? "primary" : ""}`}
                    onClick={() => setTheme("light")}
                  >
                    Light
                  </button>
                </div>
              </div>

              <div>
                <div className="settingTitle">Accent</div>
                <div className="settingSub">Pick your accent vibe. Neutral blends in, colors add personality.</div>
                <div className="row accentPicker">
                  {ACCENT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`btn accentChoice ${accentPreset === opt.value ? "primary" : ""}`}
                      onClick={() => setAccentPreset(opt.value)}
                    >
                      <span className={`accentSwatch accent-${opt.value}`} />
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="settingTitle">Accent strength</div>
                <div className="settingSub">Adjust accent opacity and intensity from subtle to max.</div>
                <div className="row">
                  <SegmentedControl
                    value={accentStrength}
                    options={ACCENT_STRENGTH_OPTIONS}
                    onChange={(v) => setAccentStrength((v ?? "normal") as AccentStrength)}
                    variant="scroll"
                  />
                </div>
              </div>

              <div>
                <div className="settingTitle">Motion profile</div>
                <div className="settingSub">Choose how animated the interface should feel.</div>
                <div className="row">
                  <SegmentedControl
                    value={motionPreset}
                    options={MOTION_OPTIONS}
                    onChange={(v) => setMotionPreset((v ?? "standard") as MotionPreset)}
                  />
                </div>
              </div>

              <div>
                <div className="settingTitle">UI density</div>
                <div className="settingSub">Comfortable keeps more space, compact fits more on screen.</div>
                <div className="row">
                  <SegmentedControl
                    value={densityPreset}
                    options={DENSITY_OPTIONS}
                    onChange={(v) => setDensityPreset((v ?? "comfortable") as DensityPreset)}
                  />
                </div>
              </div>

              <div>
                <div className="settingTitle">Reset UI settings</div>
                <div className="settingSub">
                  Restore theme, accent, accent strength, motion profile, and density to defaults.
                </div>
                <div className="row">
                  <button className="btn" onClick={onResetUiSettings}>
                    Reset appearance
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 16, marginTop: 14, borderRadius: 22 }}>
            <div style={{ fontWeight: 980, fontSize: 14 }}>Launcher</div>
            <div className="p" style={{ marginTop: 8 }}>
              Sign into Minecraft with one click, then tune launcher behavior.
            </div>

            <div className="settingStack">
              <div>
                <div className="settingTitle">Microsoft account</div>
                <div className="settingSub">
                  Connect the Microsoft account that owns Minecraft. You normally do not need to configure any client ID.
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button className="btn primary" onClick={onBeginMicrosoftLogin} disabled={launcherBusy}>
                    {msLoginSessionId ? "Waiting for login…" : "Connect Microsoft"}
                  </button>
                  {msLoginSessionId && msCodePrompt ? (
                    <button className="btn" onClick={() => setMsCodePromptVisible(true)}>
                      Show code
                    </button>
                  ) : null}
                  <button className="btn" onClick={() => setRoute("account")}>
                    Open account page
                  </button>
                  {msLoginState?.message ? <div className="muted">{msLoginState.message}</div> : null}
                </div>
                <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                  {launcherAccounts.length === 0 ? (
                    <div className="muted">No connected account yet.</div>
                  ) : (
                    launcherAccounts.map((acct) => {
                      const selectedAccount = launcherSettings?.selected_account_id === acct.id;
                      return (
                        <div key={acct.id} className="card" style={{ padding: 10, borderRadius: 14 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                            <div>
                              <div style={{ fontWeight: 900 }}>{acct.username}</div>
                              <div className="muted">{acct.id}</div>
                            </div>
                            <div className="row" style={{ gap: 8 }}>
                              <button
                                className={`btn ${selectedAccount ? "primary" : ""}`}
                                onClick={() => onSelectAccount(acct.id)}
                                disabled={launcherBusy}
                              >
                                {selectedAccount ? "Selected" : "Use"}
                              </button>
                              <button
                                className="btn danger"
                                onClick={() => onLogoutAccount(acct.id)}
                                disabled={launcherBusy}
                              >
                                Disconnect
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              <div>
                <div className="settingTitle">Default launch method</div>
                <div className="settingSub">Use native launcher or Prism launcher by default.</div>
                <div className="row">
                  <SegmentedControl
                    value={launchMethodPick}
                    onChange={(v) => setLaunchMethodPick((v ?? "native") as LaunchMethod)}
                    options={[
                      { label: "Native", value: "native" },
                      { label: "Prism", value: "prism" },
                    ]}
                  />
                </div>
              </div>

              <div>
                <div className="settingTitle">3D skin preview</div>
                <div className="settingSub">
                  Disable this for faster Account and Skins page loads on lower-end hardware.
                </div>
                <div className="row">
                  <button
                    className={`btn ${skinPreviewEnabled ? "primary" : ""}`}
                    onClick={() => setSkinPreviewEnabled((prev) => !prev)}
                  >
                    {skinPreviewEnabled ? "Enabled" : "Disabled"}
                  </button>
                </div>
              </div>

              <div>
                <div className="settingTitle">Java executable</div>
                <div className="settingSub">
                  Absolute path to Java, or leave blank to use `java` from PATH. Minecraft 1.20.5+ needs Java 21+.
                </div>
                <input
                  className="input"
                  value={javaPathDraft}
                  onChange={(e) => setJavaPathDraft(e.target.value)}
                  placeholder="/usr/bin/java or C:\\Program Files\\Java\\bin\\java.exe"
                />
                <div className="row">
                  <button className="btn" onClick={onPickLauncherJavaPath} disabled={launcherBusy}>
                    <span className="btnIcon">
                      <Icon name="upload" size={17} />
                    </span>
                    Browse…
                  </button>
                  <button className="btn" onClick={() => void refreshJavaRuntimeCandidates()} disabled={javaRuntimeBusy}>
                    {javaRuntimeBusy ? "Detecting…" : "Detect installed Java"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => void openExternalLink("https://adoptium.net/temurin/releases/?version=21")}
                  >
                    Get Java 21
                  </button>
                </div>
                {javaRuntimeCandidates.length > 0 ? (
                  <div className="settingListMini">
                    {javaRuntimeCandidates.map((runtime) => (
                      <div key={runtime.path} className="settingListMiniRow">
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 900 }}>Java {runtime.major}</div>
                          <div className="muted" style={{ wordBreak: "break-all" }}>{runtime.path}</div>
                        </div>
                        <button
                          className={`btn ${javaPathDraft.trim() === runtime.path.trim() ? "primary" : ""}`}
                          onClick={() => setJavaPathDraft(runtime.path)}
                          disabled={launcherBusy}
                        >
                          {javaPathDraft.trim() === runtime.path.trim() ? "Selected" : "Use"}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div>
                <div className="settingTitle">CurseForge API (Setup)</div>
                <div className="settingSub">
                  CurseForge search/install requires an official API key. This app reads `MPM_CURSEFORGE_API_KEY` (or `CURSEFORGE_API_KEY`) from your environment.
                </div>
                <div className="row">
                  <button className="btn" onClick={() => void refreshCurseforgeApiStatus()} disabled={curseforgeApiBusy}>
                    {curseforgeApiBusy ? "Checking…" : "Check key status"}
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      void openExternalLink("https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key")
                    }
                  >
                    Get API key
                  </button>
                  <button
                    className="btn"
                    onClick={() => void openExternalLink("https://docs.curseforge.com/rest-api/")}
                  >
                    API docs
                  </button>
                </div>
                {curseforgeApiStatus ? (
                  <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                    <div className="chip">
                      {curseforgeApiStatus.validated
                        ? "Connected"
                        : curseforgeApiStatus.configured
                          ? "Configured but not validated"
                          : "Not configured"}
                    </div>
                    <div className={curseforgeApiStatus.validated ? "noticeBox" : "errorBox"}>
                      {curseforgeApiStatus.message}
                    </div>
                    {curseforgeApiStatus.configured ? (
                      <div className="muted">
                        Source: {curseforgeApiStatus.env_var ?? "Unknown"} · Key: {curseforgeApiStatus.key_hint ?? "hidden"}
                      </div>
                    ) : (
                      <div className="muted">
                        macOS/zsh example: `export MPM_CURSEFORGE_API_KEY=\"your_key_here\"` then restart `tauri:dev`.
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              <div>
                <button className="btn" onClick={() => setShowAdvancedClientId((v) => !v)}>
                  {showAdvancedClientId ? "Hide advanced OAuth settings" : "Show advanced OAuth settings"}
                </button>
                {showAdvancedClientId ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="settingSub">
                      Client ID is a public identifier, not a secret API key. Leave blank to use the bundled default.
                    </div>
                    <input
                      className="input"
                      value={oauthClientIdDraft}
                      onChange={(e) => setOauthClientIdDraft(e.target.value)}
                      placeholder="Optional override client ID"
                      style={{ marginTop: 8 }}
                    />
                  </div>
                ) : null}
              </div>

              <div className="row">
                <button className="btn primary" onClick={onSaveLauncherPrefs} disabled={launcherBusy}>
                  {launcherBusy ? "Saving…" : "Save launcher settings"}
                </button>
              </div>

              {launcherErr ? <div className="errorBox">{launcherErr}</div> : null}
            </div>
          </div>
        </div>
      );
    }

    if (route === "updates") {
      return (
        <div className="page">
          <div style={{ maxWidth: 1100 }}>
            <div className="h1">Updates available</div>
            <div className="p">
              Scheduled checks for installed Modrinth content with optional auto-apply rules.
            </div>

            <div className="card updatesScreenSummaryCard">
              <div className="updatesScreenSummaryHeader">
                <div>
                  <div className="settingTitle">Schedule: {updateCadenceLabel(updateCheckCadence)}</div>
                  <div className="settingSub">
                    Last run: {scheduledUpdateLastRunAt ? formatDate(scheduledUpdateLastRunAt) : "Never"} · Next run: {updateCheckCadence === "off" ? "Disabled" : nextScheduledUpdateRunAt ? formatDate(nextScheduledUpdateRunAt) : "Pending first check"}
                  </div>
                  <div className="settingSub" style={{ marginTop: 6 }}>
                    Mode: {updateAutoApplyModeLabel(updateAutoApplyMode)} ({updateApplyScopeLabel(updateApplyScope)})
                  </div>
                </div>
                <div className="updatesScreenSummaryActions">
                  <button className="btn primary" onClick={() => void runScheduledUpdateChecks("manual")} disabled={scheduledUpdateBusy}>
                    {scheduledUpdateBusy ? "Checking…" : "Check now"}
                  </button>
                </div>
              </div>
              <div className="row" style={{ marginTop: 10, gap: 10, flexWrap: "wrap" }}>
                <MenuSelect
                  value={updateCheckCadence}
                  labelPrefix="Check cadence"
                  onChange={(v) => {
                    const next = normalizeUpdateCheckCadence(v);
                    setUpdateCheckCadence(next);
                    void persistUpdateSchedulerPrefs({ cadence: next });
                  }}
                  options={UPDATE_CADENCE_OPTIONS}
                />
                <MenuSelect
                  value={updateAutoApplyMode}
                  labelPrefix="Auto-apply"
                  onChange={(v) => {
                    const next = normalizeUpdateAutoApplyMode(v);
                    setUpdateAutoApplyMode(next);
                    void persistUpdateSchedulerPrefs({ autoApplyMode: next });
                  }}
                  options={UPDATE_AUTO_APPLY_MODE_OPTIONS}
                />
                <MenuSelect
                  value={updateApplyScope}
                  labelPrefix="Apply on"
                  onChange={(v) => {
                    const next = normalizeUpdateApplyScope(v);
                    setUpdateApplyScope(next);
                    void persistUpdateSchedulerPrefs({ applyScope: next });
                  }}
                  options={UPDATE_APPLY_SCOPE_OPTIONS}
                />
                {updatePrefsBusy ? <span className="chip">Saving…</span> : <span className="chip subtle">Saved</span>}
              </div>
              <div className="updatesScreenStatsRow">
                <span className="chip subtle">{scheduledInstancesWithUpdatesCount} instance{scheduledInstancesWithUpdatesCount === 1 ? "" : "s"} with updates</span>
                <span className="chip">{scheduledUpdatesAvailableTotal} total update{scheduledUpdatesAvailableTotal === 1 ? "" : "s"}</span>
                <span className="chip subtle">{scheduledUpdateEntries.length} checked instance{scheduledUpdateEntries.length === 1 ? "" : "s"}</span>
              </div>
              {scheduledUpdateErr ? <div className="errorBox" style={{ marginTop: 10 }}>{scheduledUpdateErr}</div> : null}
            </div>

            {scheduledUpdateEntries.length === 0 ? (
              <div className="emptyState" style={{ marginTop: 12 }}>
                <div className="emptyTitle">No scheduled update checks yet</div>
                <div className="emptySub">
                  {updateCheckCadence === "off"
                    ? "Scheduled checks are disabled. Use the cadence controls above to enable them."
                    : `Run a check now or wait for the ${updateCadenceLabel(updateCheckCadence).toLowerCase()} schedule.`}
                </div>
              </div>
            ) : (
              <div className="updatesScreenList">
                {scheduledUpdateEntries.map((row) => (
                  <div key={row.instance_id} className="card updatesScreenItemCard">
                    <div className="updatesScreenItemHead">
                      <div>
                        <div className="updatesScreenItemTitle">{row.instance_name}</div>
                        <div className="muted">
                          Checked {new Date(row.checked_at).toLocaleString()}
                        </div>
                      </div>
                      <div className="updatesScreenItemActions">
                        <button className="btn" onClick={() => openInstance(row.instance_id)}>
                          Open instance
                        </button>
                        <button
                          className="btn"
                          onClick={() => {
                            const inst = instances.find((item) => item.id === row.instance_id);
                            if (inst) void onCheckUpdates(inst);
                          }}
                          disabled={updateBusy || scheduledUpdateBusy}
                        >
                          Recheck
                        </button>
                      </div>
                    </div>
                    {row.error ? (
                      <div className="errorBox" style={{ marginTop: 8 }}>{row.error}</div>
                    ) : row.update_count === 0 ? (
                      <div className="noticeBox" style={{ marginTop: 8 }}>
                        Up to date ({row.checked_mods} mod{row.checked_mods === 1 ? "" : "s"} checked).
                      </div>
                    ) : (
                      <div className="updatesList" style={{ marginTop: 8 }}>
                        <div className="updatesCardTitle">
                          {row.update_count} update{row.update_count === 1 ? "" : "s"} available
                        </div>
                        {row.updates.slice(0, 8).map((u) => (
                          <div key={`${row.instance_id}:${u.project_id}`} className="updatesListRow">
                            <div className="updatesListName">{u.name}</div>
                            <div className="updatesListMeta">
                              {u.current_version_number} → {u.latest_version_number}
                            </div>
                          </div>
                        ))}
                        {row.updates.length > 8 ? (
                          <div className="muted">+{row.updates.length - 8} more</div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    if (route === "account") {
      const diag = accountDiagnostics;
      const account = diag?.account ?? selectedLauncherAccount;
      const uuid = diag?.minecraft_uuid ?? account?.id ?? null;
      const username = diag?.minecraft_username ?? account?.username ?? "No account connected";
      const skinTexture = toLocalIconSrc(diag?.skin_url) ?? "";
      const avatarSources = minecraftAvatarSources(uuid);
      const avatarSrc =
        toLocalIconSrc(
          avatarSources[Math.min(accountAvatarSourceIdx, Math.max(avatarSources.length - 1, 0))] ?? ""
        ) ?? "";

      return (
        <div className="accountPage">
          <div className="h1">Account</div>
          <div className="p">Minecraft account details, launcher diagnostics, and skin studio controls.</div>

          <div className="accountHero card">
            <div className="accountAvatarWrap">
              {accountAvatarFromSkin ? (
                <img src={accountAvatarFromSkin} alt="Minecraft avatar" />
              ) : skinTexture ? (
                <span className="minecraftHeadPreview" role="img" aria-label="Minecraft avatar">
                  <img src={skinTexture} alt="" className="minecraftHeadLayer base" />
                  <img src={skinTexture} alt="" className="minecraftHeadLayer hat" />
                </span>
              ) : avatarSrc ? (
                <img
                  src={avatarSrc}
                  alt="Minecraft avatar"
                  onError={() => setAccountAvatarSourceIdx((i) => i + 1)}
                />
              ) : (
                <span>{username?.slice(0, 1)?.toUpperCase() ?? "?"}</span>
              )}
            </div>
            <div className="accountHeroMain">
              <div className="accountHeroName">{username}</div>
              <div className="accountHeroMeta">
                <span className="chip">{diag?.status ?? "not connected"}</span>
                {diag?.entitlements_ok ? <span className="chip">Owns Minecraft</span> : null}
                {diag?.token_exchange_status ? <span className="chip subtle">{humanizeToken(diag.token_exchange_status)}</span> : null}
              </div>
              <div className="accountHeroSub">
                UUID: {uuid ?? "Not available"}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary" onClick={onBeginMicrosoftLogin} disabled={launcherBusy}>
                  {msLoginSessionId ? "Waiting for login…" : "Connect / Reconnect"}
                </button>
                {msLoginSessionId && msCodePrompt ? (
                  <button className="btn" onClick={() => setMsCodePromptVisible(true)}>
                    Show code
                  </button>
                ) : null}
                <button className="btn" onClick={() => refreshAccountDiagnostics().catch(() => null)} disabled={accountDiagnosticsBusy}>
                  {accountDiagnosticsBusy ? "Refreshing…" : "Refresh diagnostics"}
                </button>
              </div>
            </div>
          </div>

          <div className="accountGrid">
            <div className="card accountCard">
              <div className="settingTitle">Launcher profile</div>
              <div className="settingSub">Useful account and launcher defaults for quick checks.</div>
              <div className="accountDiagList">
                <div className="accountDiagRow">
                  <span>Default launch mode</span>
                  <strong>{humanizeToken(launcherSettings?.default_launch_method ?? "native")}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Update checks</span>
                  <strong>{updateCadenceLabel(updateCheckCadence)}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Auto-apply</span>
                  <strong>{updateAutoApplyModeLabel(updateAutoApplyMode)}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Connected accounts</span>
                  <strong>{launcherAccounts.length}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Current skin</span>
                  <strong>{selectedAccountSkin?.label ?? "None"}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Current cape</span>
                  <strong>{selectedAccountCape?.label ?? "No cape"}</strong>
                </div>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn" onClick={() => setRoute("skins")}>
                  Open skin studio
                </button>
              </div>
              <label className="toggleRow" style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={skinPreviewEnabled}
                  onChange={(event) => setSkinPreviewEnabled(event.target.checked)}
                />
                <span className="togglePill" />
                <span>Enable 3D preview in Skin Studio</span>
              </label>
            </div>

            <div className="card accountCard">
              <div className="settingTitle">Skin library summary</div>
              <div className="settingSub">Saved and default skin availability for this profile.</div>
              <div className="accountDiagList">
                <div className="accountDiagRow">
                  <span>Saved skins</span>
                  <strong>{savedSkinOptions.length}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Default skins</span>
                  <strong>{defaultSkinOptions.length}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Cape options</span>
                  <strong>{capeOptions.length}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Last diagnostics refresh</span>
                  <strong>{diag?.last_refreshed_at ? new Date(diag.last_refreshed_at).toLocaleString() : "Never"}</strong>
                </div>
              </div>
            </div>

            <div className="card accountCard">
              <div className="settingTitle">Diagnostics</div>
              <div className="settingSub">Token chain and entitlement health for native launcher.</div>
              <div className="accountDiagList">
                <div className="accountDiagRow">
                  <span>Connection</span>
                  <strong>{humanizeToken(diag?.status ?? "not_connected")}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Entitlements</span>
                  <strong>{diag?.entitlements_ok ? "OK" : "Not verified"}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Token status</span>
                  <strong>{humanizeToken(diag?.token_exchange_status ?? "idle")}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Client ID source</span>
                  <strong>{humanizeToken(diag?.client_id_source ?? "unknown")}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Last refresh</span>
                  <strong>{diag?.last_refreshed_at ?? "Never"}</strong>
                </div>
                {diag?.last_error ? (
                  <div className="errorBox" style={{ marginTop: 8 }}>{diag.last_error}</div>
                ) : null}
                {accountDiagnosticsErr ? (
                  <div className="errorBox" style={{ marginTop: 8 }}>{accountDiagnosticsErr}</div>
                ) : null}
              </div>
            </div>

            <div className="card accountCard">
              <div className="settingTitle">Accounts</div>
              <div className="settingSub">Switch active account for native launch.</div>
              <div className="accountAccountsList">
                {launcherAccounts.length === 0 ? (
                  <div className="muted">No connected accounts.</div>
                ) : (
                  launcherAccounts.map((acct) => {
                    const selectedAccount = selectedLauncherAccountId === acct.id;
                    return (
                      <div key={acct.id} className="accountAccountRow">
                        <div className="accountAccountInfo">
                          <div className="accountAccountName">{acct.username}</div>
                          <div className="accountAccountId">{acct.id}</div>
                        </div>
                        <div className="row" style={{ marginTop: 0 }}>
                          <button
                            className={`btn ${selectedAccount ? "primary" : ""}`}
                            onClick={() => onSelectAccount(acct.id)}
                            disabled={launcherBusy}
                          >
                            {selectedAccount ? "Selected" : "Use"}
                          </button>
                          <button
                            className="btn danger"
                            onClick={() => onLogoutAccount(acct.id)}
                            disabled={launcherBusy}
                          >
                            Disconnect
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="card accountCard">
              <div className="settingTitle">Profile assets</div>
              <div className="settingSub">Skins and capes returned by Minecraft profile API.</div>
              <div className="accountDiagList">
                <div className="accountDiagRow">
                  <span>Skins</span>
                  <strong>{diag?.skins?.length ?? 0}</strong>
                </div>
                <div className="accountDiagRow">
                  <span>Capes</span>
                  <strong>{diag?.cape_count ?? 0}</strong>
                </div>
                <div className="accountAssetList">
                  {(diag?.skins ?? []).slice(0, 6).map((skin) => (
                    <div key={`${skin.id}:${skin.url}`} className="accountAssetRow">
                      <span>{skin.variant ?? "Skin"}</span>
                      <a href={skin.url} target="_blank" rel="noreferrer">Open</a>
                    </div>
                  ))}
                  {(diag?.capes ?? []).slice(0, 6).map((cape) => (
                    <div key={`${cape.id}:${cape.url}`} className="accountAssetRow">
                      <span>{cape.alias ?? "Cape"}</span>
                      <a href={cape.url} target="_blank" rel="noreferrer">Open</a>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (route === "modpacks") {
      const selectedInst = instances.find((i) => i.id === selectedId) ?? null;
      const creator = creatorDraft;
      const creatorEntries = creator?.entries ?? [];
      const creatorEnabledCount = creatorEntries.filter((e) => e.enabled !== false).length;
      const creatorDisabledCount = creatorEntries.length - creatorEnabledCount;
      const creatorDatapackCount = creatorEntries.filter(
        (e) => normalizeCreatorEntryType(e.content_type as string) === "datapacks"
      ).length;
      const creatorMissingProjectCount = creatorEntries.filter(
        (e) => !String(e.project_id ?? "").trim()
      ).length;
      const creatorMissingWorldTargetCount = creatorEntries.filter(
        (e) =>
          normalizeCreatorEntryType(e.content_type as string) === "datapacks" &&
          (e.target_worlds?.length ?? 0) === 0 &&
          creator?.settings?.datapack_target_policy !== "all_worlds"
      ).length;
      const creatorGroups = ["mods", "resourcepacks", "shaderpacks", "datapacks", "modpacks"]
        .map((type) => ({
          type,
          label: creatorEntryTypeLabel(type),
          entries: creatorEntries
            .map((entry, idx) => ({ entry, idx }))
            .filter(({ entry }) => normalizeCreatorEntryType(entry.content_type as string) === type),
        }))
        .filter((g) => g.entries.length > 0);
      const creatorIssues = creatorEntries.flatMap((entry, idx) => {
        const issues: { id: string; text: string; severity: "warning" | "error" }[] = [];
        if (!String(entry.project_id ?? "").trim()) {
          issues.push({
            id: `missing-project:${idx}`,
            text: `Entry #${idx + 1} is missing a project ID.`,
            severity: "error",
          });
        }
        if (
          normalizeCreatorEntryType(entry.content_type as string) === "datapacks" &&
          (entry.target_worlds?.length ?? 0) === 0 &&
          creator?.settings?.datapack_target_policy !== "all_worlds"
        ) {
          issues.push({
            id: `missing-world-target:${idx}`,
            text: `Datapack "${entry.title || `#${idx + 1}`}" has no world target.`,
            severity: "warning",
          });
        }
        return issues;
      });
      const creatorCanApplyDraft = Boolean(
        selectedInst && creatorEntries.length > 0 && creatorIssues.length === 0
      );
      const templatePage = Math.floor(templateOffset / limit) + 1;
      const templatePages = Math.max(1, Math.ceil(templateTotalHits / limit));
      return (
        <div style={{ maxWidth: 1240 }}>
          <div className="h1">Creator Studio</div>
          <div className="p">Creator studio for mods, shaderpacks, resourcepacks, datapacks, and imported modpack templates.</div>

          <div className="topRow" style={{ marginTop: 12 }}>
            <SegmentedControl
              value={modpacksStudioTab}
              onChange={(v) => setModpacksStudioTab((v as any) ?? "creator")}
              options={[
                { value: "creator", label: "Creator" },
                { value: "templates", label: "Discover Templates" },
                { value: "saved", label: "Saved Presets" },
                { value: "config", label: "Config Editor" },
              ]}
              variant="scroll"
            />
          </div>

          {modpacksStudioTab === "creator" ? (
            <div className="creatorStudioMain creatorStudioSingle">
              <div className="card creatorTopBarCard">
                <div className="creatorSectionTitleRow">
                  <div className="creatorSectionTitle">Quick Start</div>
                  <span className="chip subtle">{selectedInst ? `Instance: ${selectedInst.name}` : "No instance selected"}</span>
                </div>
                <div className="muted creatorGuideText">
                  Add content from Discover Templates or Discover, then configure and validate before applying.
                </div>
                <div className="creatorActionRow">
                  <button className="btn primary" onClick={() => setModpacksStudioTab("templates")}>
                    Add from templates
                  </button>
                  <button className="btn" onClick={() => setRoute("discover")}>
                    Open discover
                  </button>
                  <button
                    className="btn"
                    onClick={() => selectedInst && onCreatePresetFromInstance(selectedInst)}
                    disabled={presetBusy || !selectedInst}
                    title={selectedInst ? "Capture selected instance into draft" : "Select an instance first"}
                  >
                    Capture selected instance
                  </button>
                </div>
                <div className="creatorStatsRow">
                  <span className="chip subtle">Entries: {creatorEntries.length}</span>
                  <span className="chip subtle">Enabled: {creatorEnabledCount}</span>
                  <span className="chip subtle">Disabled: {creatorDisabledCount}</span>
                  <span className="chip subtle">Datapacks: {creatorDatapackCount}</span>
                  <span className="chip subtle">Worlds found: {instanceWorlds.length}</span>
                </div>
              </div>

              <div className="card creatorSectionCard">
                <div className="creatorSectionTitleRow">
                  <div className="creatorSectionTitle">Step 1 · Preset Setup</div>
                  <span className="chip subtle">{creator?.name?.trim() ? "Named" : "Needs name"}</span>
                </div>
                <div className="creatorMetaGrid">
                  <label className="creatorField">
                    <span className="creatorFieldLabel">Preset name</span>
                    <input
                      className="input creatorNameInput"
                      value={creator?.name ?? ""}
                      onChange={(e) =>
                        updateCreatorDraft((current) => ({ ...current, name: e.target.value }))
                      }
                      placeholder="Preset name"
                    />
                  </label>
                  <div className="creatorField">
                    <span className="creatorFieldLabel">Selected instance</span>
                    <div className="creatorInlineValue">
                      {selectedInst ? selectedInst.name : "No instance selected"}
                    </div>
                    <div className="muted creatorTinyText">
                      Datapack world targets come from this instance.
                    </div>
                  </div>
                </div>

                <div className="creatorActionRow">
                  <button className="btn" onClick={() => onAddCreatorBlankEntry(selectedInst)}>
                    Add blank entry
                  </button>
                  <button className="btn" onClick={() => setModpacksStudioTab("templates")}>
                    Browse templates
                  </button>
                  <button className="btn" onClick={() => setRoute("discover")}>
                    Browse discover
                  </button>
                </div>

                <div className="creatorSettingsGrid">
                  <div className="creatorField">
                    <span className="creatorFieldLabel">Dependencies</span>
                    <MenuSelect
                      value={(creator?.settings?.dependency_policy as string) || "required"}
                      labelPrefix="Deps"
                      options={[
                        { value: "required", label: "Required only" },
                        { value: "none", label: "Disable deps" },
                      ]}
                      onChange={(v) =>
                        updateCreatorDraft((current) => ({
                          ...current,
                          settings: { ...defaultPresetSettings(), ...(current.settings ?? {}), dependency_policy: v },
                        }))
                      }
                    />
                  </div>
                  <div className="creatorField">
                    <span className="creatorFieldLabel">Conflict behavior</span>
                    <MenuSelect
                      value={(creator?.settings?.conflict_strategy as string) || "replace"}
                      labelPrefix="Conflicts"
                      options={[
                        { value: "replace", label: "Replace existing" },
                        { value: "keep", label: "Keep existing" },
                      ]}
                      onChange={(v) =>
                        updateCreatorDraft((current) => ({
                          ...current,
                          settings: { ...defaultPresetSettings(), ...(current.settings ?? {}), conflict_strategy: v },
                        }))
                      }
                    />
                  </div>
                  <div className="creatorField">
                    <span className="creatorFieldLabel">Datapack targeting</span>
                    <MenuSelect
                      value={(creator?.settings?.datapack_target_policy as string) || "choose_worlds"}
                      labelPrefix="Datapacks"
                      options={[
                        { value: "choose_worlds", label: "Choose worlds" },
                        { value: "all_worlds", label: "All worlds" },
                      ]}
                      onChange={(v) =>
                        updateCreatorDraft((current) => ({
                          ...current,
                          settings: { ...defaultPresetSettings(), ...(current.settings ?? {}), datapack_target_policy: v },
                        }))
                      }
                    />
                  </div>
                  <div className="creatorField">
                    <span className="creatorFieldLabel">Safety</span>
                    <button
                      className={`btn ${(creator?.settings?.snapshot_before_apply ?? true) ? "primary" : ""}`}
                      onClick={() =>
                        updateCreatorDraft((current) => ({
                          ...current,
                          settings: {
                            ...defaultPresetSettings(),
                            ...(current.settings ?? {}),
                            snapshot_before_apply: !(current.settings?.snapshot_before_apply ?? true),
                          },
                        }))
                      }
                    >
                      Snapshot before apply: {(creator?.settings?.snapshot_before_apply ?? true) ? "On" : "Off"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="card creatorSectionCard">
                <div className="creatorSectionTitleRow">
                  <div className="creatorSectionTitle">Step 2 · Draft Entries</div>
                  <span className="chip subtle">Apply order follows this list</span>
                </div>
                {!creator || creator.entries.length === 0 ? (
                  <div className="creatorEmptyState">
                    <div className="muted">No entries yet. Add items from Discover or Discover Templates.</div>
                    <div className="creatorEmptyActions">
                      <button className="btn" onClick={() => setModpacksStudioTab("templates")}>Open templates</button>
                      <button className="btn" onClick={() => setRoute("discover")}>Open discover</button>
                    </div>
                  </div>
                ) : (
                  <div className="creatorGroupsWrap">
                    {creatorGroups.map((group) => (
                      <div key={group.type} className="creatorTypeGroup">
                        <div className="creatorTypeGroupHeader">
                          <div className="creatorTypeGroupTitle">{group.label}</div>
                          <span className="chip subtle">{group.entries.length}</span>
                        </div>
                        <div className="creatorTypeGroupList">
                          {group.entries.map(({ entry, idx }) => {
                            const isDatapack = normalizeCreatorEntryType(entry.content_type as string) === "datapacks";
                            const selectedWorlds = entry.target_worlds ?? [];
                            const selectedWorldCount = selectedWorlds.length;
                            const hasIssue =
                              !String(entry.project_id ?? "").trim() ||
                              (isDatapack &&
                                selectedWorldCount === 0 &&
                                creator?.settings?.datapack_target_policy !== "all_worlds");
                            return (
                              <div key={`${entry.source}:${entry.project_id}:${idx}`} className="card creatorEntryCard">
                                <div className="creatorEntryHead">
                                  <div className="creatorEntryHeadLeft">
                                    <div className="creatorEntryIndex">#{idx + 1}</div>
                                    <div className="creatorEntryName">{entry.title || "Untitled entry"}</div>
                                    <span className={`chip ${entry.enabled === false ? "subtle" : ""}`}>
                                      {entry.enabled === false ? "Disabled" : "Enabled"}
                                    </span>
                                    <span className="chip subtle">{entry.source}</span>
                                    {hasIssue ? <span className="chip">Needs attention</span> : null}
                                  </div>
                                  <div className="creatorEntryActions">
                                    <button className="btn" disabled={idx === 0} onClick={() => moveCreatorEntry(idx, -1)}>
                                      Up
                                    </button>
                                    <button
                                      className="btn"
                                      disabled={idx >= creatorEntries.length - 1}
                                      onClick={() => moveCreatorEntry(idx, 1)}
                                    >
                                      Down
                                    </button>
                                    <button
                                      className={`btn ${entry.enabled === false ? "" : "primary"}`}
                                      onClick={() =>
                                        updateCreatorDraft((current) => ({
                                          ...current,
                                          entries: current.entries.map((x, i) =>
                                            i === idx ? { ...x, enabled: !(x.enabled !== false) } : x
                                          ),
                                        }))
                                      }
                                    >
                                      {entry.enabled === false ? "Enable" : "Disable"}
                                    </button>
                                    <button
                                      className="btn danger"
                                      onClick={() =>
                                        updateCreatorDraft((current) => ({
                                          ...current,
                                          entries: current.entries.filter((_, i) => i !== idx),
                                        }))
                                      }
                                    >
                                      Remove
                                    </button>
                                  </div>
                                </div>

                                <div className="creatorEntryGrid">
                                  <div className="creatorEntryRow">
                                    <label className="creatorField creatorFieldGrow">
                                      <span className="creatorFieldLabel">Title</span>
                                      <input
                                        className="input creatorInputGrow"
                                        value={entry.title}
                                        onChange={(e) =>
                                          updateCreatorDraft((current) => ({
                                            ...current,
                                            entries: current.entries.map((x, i) =>
                                              i === idx ? { ...x, title: e.target.value } : x
                                            ),
                                          }))
                                        }
                                        placeholder="Display title"
                                      />
                                    </label>
                                    <label className="creatorField creatorFieldGrow">
                                      <span className="creatorFieldLabel">Project ID</span>
                                      <input
                                        className="input creatorInputGrow"
                                        value={entry.project_id}
                                        onChange={(e) =>
                                          updateCreatorDraft((current) => ({
                                            ...current,
                                            entries: current.entries.map((x, i) =>
                                              i === idx ? { ...x, project_id: e.target.value } : x
                                            ),
                                          }))
                                        }
                                        placeholder="modrinth slug/project or curseforge project ID"
                                      />
                                    </label>
                                  </div>

                                  <div className="creatorEntryRow">
                                    <div className="creatorField">
                                      <span className="creatorFieldLabel">Source</span>
                                      <MenuSelect
                                        value={entry.source}
                                        labelPrefix="Source"
                                        options={[
                                          { value: "modrinth", label: "Modrinth" },
                                          { value: "curseforge", label: "CurseForge" },
                                        ]}
                                        onChange={(v) =>
                                          updateCreatorDraft((current) => ({
                                            ...current,
                                            entries: current.entries.map((x, i) =>
                                              i === idx ? { ...x, source: v } : x
                                            ),
                                          }))
                                        }
                                      />
                                    </div>
                                    <div className="creatorField">
                                      <span className="creatorFieldLabel">Content type</span>
                                      <MenuSelect
                                        value={(entry.content_type as string) ?? "mods"}
                                        labelPrefix="Type"
                                        options={[
                                          { value: "mods", label: "Mods" },
                                          { value: "resourcepacks", label: "Resourcepacks" },
                                          { value: "shaderpacks", label: "Shaderpacks" },
                                          { value: "datapacks", label: "Datapacks" },
                                          { value: "modpacks", label: "Modpacks (template)" },
                                        ]}
                                        onChange={(v) =>
                                          updateCreatorDraft((current) => ({
                                            ...current,
                                            entries: current.entries.map((x, i) =>
                                              i === idx
                                                ? {
                                                    ...x,
                                                    content_type: v,
                                                    target_scope: v === "datapacks" ? "world" : "instance",
                                                    target_worlds: v === "datapacks" ? x.target_worlds ?? [] : [],
                                                  }
                                                : x
                                            ),
                                          }))
                                        }
                                      />
                                    </div>
                                    <label className="creatorField creatorFieldGrow">
                                      <span className="creatorFieldLabel">Pinned version (optional)</span>
                                      <input
                                        className="input creatorInputGrow"
                                        value={entry.pinned_version ?? ""}
                                        onChange={(e) =>
                                          updateCreatorDraft((current) => ({
                                            ...current,
                                            entries: current.entries.map((x, i) =>
                                              i === idx ? { ...x, pinned_version: e.target.value.trim() || null } : x
                                            ),
                                          }))
                                        }
                                        placeholder="Leave blank for latest compatible"
                                      />
                                    </label>
                                  </div>

                                  {isDatapack ? (
                                    <div className="creatorDatapackSection">
                                      <div className="creatorWorldTools">
                                        <div
                                          className={`creatorWorldHelp ${
                                            selectedWorldCount === 0 &&
                                            creator?.settings?.datapack_target_policy !== "all_worlds"
                                              ? "warn"
                                              : ""
                                          }`}
                                        >
                                          Datapacks install into `saves/&lt;world&gt;/datapacks`.
                                        </div>
                                        <div className="creatorWorldActions">
                                          <button
                                            className="btn"
                                            disabled={instanceWorlds.length === 0}
                                            onClick={() =>
                                              updateCreatorDraft((current) => ({
                                                ...current,
                                                entries: current.entries.map((x, i) =>
                                                  i === idx
                                                    ? {
                                                        ...x,
                                                        target_scope: "world",
                                                        target_worlds: instanceWorlds.map((w) => w.id),
                                                      }
                                                    : x
                                                ),
                                              }))
                                            }
                                          >
                                            All worlds
                                          </button>
                                          <button
                                            className="btn"
                                            disabled={selectedWorldCount === 0}
                                            onClick={() =>
                                              updateCreatorDraft((current) => ({
                                                ...current,
                                                entries: current.entries.map((x, i) =>
                                                  i === idx ? { ...x, target_scope: "world", target_worlds: [] } : x
                                                ),
                                              }))
                                            }
                                          >
                                            Clear
                                          </button>
                                          <span className="muted">{selectedWorldCount} selected</span>
                                        </div>
                                      </div>
                                      {instanceWorlds.length === 0 ? (
                                        <div className="muted">No worlds found in selected instance yet.</div>
                                      ) : (
                                        <div className="creatorWorldChips">
                                          {instanceWorlds.map((world) => {
                                            const active = selectedWorlds.includes(world.id);
                                            return (
                                              <button
                                                key={`${entry.project_id}:${world.id}`}
                                                className={`creatorWorldChip ${active ? "on" : ""}`}
                                                onClick={() =>
                                                  updateCreatorDraft((current) => ({
                                                    ...current,
                                                    entries: current.entries.map((x, i) => {
                                                      if (i !== idx) return x;
                                                      const currentWorlds = x.target_worlds ?? [];
                                                      const has = currentWorlds.includes(world.id);
                                                      return {
                                                        ...x,
                                                        target_scope: "world",
                                                        target_worlds: has
                                                          ? currentWorlds.filter((w) => w !== world.id)
                                                          : [...currentWorlds, world.id],
                                                      };
                                                    }),
                                                  }))
                                                }
                                              >
                                                {world.name}
                                              </button>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="card creatorSectionCard creatorValidationCard">
                <div className="creatorSectionTitle">Step 3 · Validate and Save</div>
                <div className="creatorChecklist creatorChecklistGrid">
                  <div className={`creatorChecklistItem ${creatorEntries.length > 0 ? "ok" : ""}`}>
                    Entries added: {creatorEntries.length}
                  </div>
                  <div className={`creatorChecklistItem ${creatorMissingProjectCount === 0 ? "ok" : "bad"}`}>
                    Missing project IDs: {creatorMissingProjectCount}
                  </div>
                  <div className={`creatorChecklistItem ${creatorMissingWorldTargetCount === 0 ? "ok" : "bad"}`}>
                    Datapacks missing world targets: {creatorMissingWorldTargetCount}
                  </div>
                </div>
                {creatorIssues.length > 0 ? (
                  <div className="creatorIssuesList">
                    {creatorIssues.slice(0, 8).map((issue) => (
                      <div
                        key={issue.id}
                        className={`creatorIssueRow ${issue.severity === "error" ? "error" : "warn"}`}
                      >
                        {issue.text}
                      </div>
                    ))}
                    {creatorIssues.length > 8 ? (
                      <div className="muted">+{creatorIssues.length - 8} more issue(s)</div>
                    ) : null}
                  </div>
                ) : (
                  <div className="creatorHealthyText">No blocking issues found in this draft.</div>
                )}

                {presetPreview ? (
                  <div className="creatorPreviewBox">
                    <div className="creatorPreviewTitle">Latest preview</div>
                    <div className="creatorPreviewRow">Installable: {presetPreview.installable_entries}</div>
                    <div className="creatorPreviewRow">Disabled skipped: {presetPreview.skipped_disabled_entries}</div>
                    <div className="creatorPreviewRow">Duplicates: {presetPreview.duplicate_entries}</div>
                  </div>
                ) : (
                  <div className="muted creatorTinyText">Run preview to validate provider compatibility and target mapping before apply.</div>
                )}

                <div className="creatorFooterActions creatorFooterActionsRow">
                  <button className="btn primary" onClick={onSaveCreatorToPresets}>
                    Save draft
                  </button>
                  <button
                    className="btn"
                    disabled={!selectedInst || !creator}
                    onClick={() => creator && selectedInst && onPreviewPresetApply(creator, selectedInst)}
                  >
                    Preview on selected instance
                  </button>
                  <button
                    className="btn primary"
                    disabled={!creatorCanApplyDraft}
                    onClick={() => creator && selectedInst && onApplyPresetToInstance(creator, selectedInst)}
                  >
                    Apply draft now
                  </button>
                </div>

                <div className="creatorInlineTips">
                  <div className="creatorSideTipsTitle">Quick tips</div>
                  <div className="creatorSideTip">Use Discover Templates for modpack/datapack starters, then edit here.</div>
                  <div className="creatorSideTip">Use Up and Down on entries to tune apply order.</div>
                  <div className="creatorSideTip">Pinned version keeps a specific release while the rest can float to latest compatible.</div>
                </div>
              </div>
            </div>
          ) : null}

          {modpacksStudioTab === "templates" ? (
            <>
              <div className="card" style={{ padding: 16, marginTop: 14, borderRadius: 22 }}>
                <div className="row" style={{ marginBottom: 10 }}>
                  <SegmentedControl
                    value={templateType}
                    onChange={(v) => {
                      setTemplateType((v as any) ?? "modpacks");
                      setTemplateOffset(0);
                    }}
                    options={[
                      { value: "modpacks", label: "Modpacks" },
                      { value: "datapacks", label: "Datapacks" },
                    ]}
                  />
                  <MenuSelect
                    value={templateSource}
                    labelPrefix="Source"
                    options={DISCOVER_SOURCE_OPTIONS}
                    onChange={(v) => setTemplateSource((v as DiscoverSource) ?? "all")}
                  />
                </div>
                <div className="row">
                  <input
                    className="input"
                    value={templateQuery}
                    onChange={(e) => setTemplateQuery(e.target.value)}
                    placeholder={templateType === "modpacks" ? "Search modpack templates…" : "Search datapacks…"}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") runTemplateSearch(0, templateQuery);
                    }}
                  />
                  <button className="btn primary" onClick={() => runTemplateSearch(0, templateQuery)} disabled={templateBusy}>
                    {templateBusy ? "Searching…" : "Search"}
                  </button>
                </div>
                {templateErr ? <div className="errorBox" style={{ marginTop: 10 }}>{templateErr}</div> : null}
              </div>

              <div className="resultsGrid" style={{ marginTop: 14 }}>
                {templateHits.map((h) => (
                  <div key={`${h.source}:${h.project_id}`} className="resultCard">
                    <div className="resultIcon">{h.icon_url ? <img src={h.icon_url} alt="" /> : <div>⬚</div>}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="resultTitle">{h.title}</div>
                      <div className="resultDesc">{h.description}</div>
                      <div className="resultMetaRow">
                        <span className="chip subtle">{h.source}</span>
                        <span className="chip">{h.content_type}</span>
                      </div>
                    </div>
                    <div className="resultActions">
                      <button className="btn" onClick={() => addHitToCreator(h, selectedInst)}>
                        Add to creator
                      </button>
                      <button className="btn primary" onClick={() => importTemplateFromHit(h, selectedInst)} disabled={presetBusy}>
                        {h.content_type === "modpacks" ? "Import template" : "Quick add"}
                      </button>
                    </div>
                  </div>
                ))}
                {!templateBusy && templateHits.length === 0 ? (
                  <div className="card" style={{ padding: 16, borderRadius: 22, color: "var(--muted)" }}>
                    No results.
                  </div>
                ) : null}
              </div>

              <div className="pager">
                <button
                  className="btn"
                  onClick={() => runTemplateSearch(Math.max(0, templateOffset - limit), templateQuery)}
                  disabled={templateBusy || templateOffset === 0}
                >
                  ← Prev
                </button>
                <div style={{ color: "var(--muted)", fontWeight: 950 }}>
                  Page {templatePage} / {templatePages}
                </div>
                <button
                  className="btn"
                  onClick={() => runTemplateSearch(Math.min((templatePages - 1) * limit, templateOffset + limit), templateQuery)}
                  disabled={templateBusy || templateOffset + limit >= templateTotalHits}
                >
                  Next →
                </button>
              </div>
            </>
          ) : null}

          {modpacksStudioTab === "saved" ? (
            <>
              <div className="card" style={{ padding: 16, marginTop: 14, borderRadius: 22 }}>
                <div style={{ fontWeight: 980 }}>Preset JSON</div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn" onClick={onImportPresets} disabled={presetIoBusy}>
                    {presetIoBusy ? "Working…" : "Import presets JSON"}
                  </button>
                  <button className="btn" onClick={onExportPresets} disabled={presetIoBusy || presets.length === 0}>
                    {presetIoBusy ? "Working…" : "Export presets JSON"}
                  </button>
                </div>
                <div className="muted" style={{ marginTop: 8 }}>
                  Shareable format: `mpm-presets/v2` JSON.
                </div>
              </div>

              <div className="card" style={{ padding: 16, marginTop: 14, borderRadius: 22 }}>
                <div style={{ fontWeight: 980 }}>Saved presets</div>
                {presets.length === 0 ? (
                  <div className="muted" style={{ marginTop: 10 }}>No presets yet.</div>
                ) : (
                  <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                    {presets.map((preset) => (
                      <div key={preset.id} className="card" style={{ padding: 12, borderRadius: 14 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                          <div>
                            <div style={{ fontWeight: 900 }}>{preset.name}</div>
                            <div className="muted">
                              {preset.entries.length} entries · from {preset.source_instance_name}
                            </div>
                          </div>
                          <div className="row">
                            <button
                              className="btn"
                              onClick={() => selectedInst && onPreviewPresetApply(preset, selectedInst)}
                              disabled={presetPreviewBusy || !selectedInst}
                              title={selectedInst ? "Preview apply" : "Select an instance first"}
                            >
                              Preview
                            </button>
                            <button
                              className="btn primary"
                              onClick={() => selectedInst && onApplyPresetToInstance(preset, selectedInst)}
                              disabled={presetBusy || !selectedInst}
                              title={selectedInst ? `Apply to ${selectedInst.name}` : "Select an instance first"}
                            >
                              Apply
                            </button>
                            <button
                              className="btn"
                              onClick={() => {
                                setCreatorDraft({
                                  ...preset,
                                  id: `preset_${Date.now()}`,
                                  name: `${preset.name} copy`,
                                });
                                setModpacksStudioTab("creator");
                              }}
                            >
                              Edit copy
                            </button>
                            <button
                              className="btn danger"
                              onClick={() => setPresets((prev) => prev.filter((p) => p.id !== preset.id))}
                              disabled={presetBusy}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {presetPreview ? (
                  <div className="card" style={{ marginTop: 12, padding: 12, borderRadius: 12 }}>
                    <div style={{ fontWeight: 900 }}>Last preview</div>
                    <div className="muted" style={{ marginTop: 6 }}>
                      installable: {presetPreview.installable_entries} · disabled: {presetPreview.skipped_disabled_entries} · duplicates: {presetPreview.duplicate_entries}
                    </div>
                    {presetPreview.provider_warnings.length ? (
                      <div className="errorBox" style={{ marginTop: 8 }}>{presetPreview.provider_warnings.join(" | ")}</div>
                    ) : null}
                    {presetPreview.missing_world_targets.length ? (
                      <div className="errorBox" style={{ marginTop: 8 }}>
                        Missing datapack targets: {presetPreview.missing_world_targets.join(", ")}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {modpacksStudioTab === "config" ? (
            <div style={{ marginTop: 14 }}>
              <ModpacksConfigEditor
                instances={instances}
                selectedInstanceId={selectedId}
                onSelectInstance={setSelectedId}
                onManageInstances={() => setRoute("library")}
                runningInstanceIds={runningInstances.map((run) => run.instance_id)}
              />
            </div>
          ) : null}
        </div>
      );
    }

    if (route === "discover") {
      const selectedInst = instances.find((i) => i.id === selectedId) ?? null;
      const discoverPlaceholder =
        discoverContentType === "shaderpacks"
          ? "Search shaderpacks…"
          : discoverContentType === "resourcepacks"
            ? "Search resourcepacks…"
            : discoverContentType === "datapacks"
              ? "Search datapacks and modpacks…"
              : "Search mods…";

      return (
        <div style={{ maxWidth: 1400 }}>
          <div className="h1">Discover content</div>
          <div className="p">Search Modrinth + CurseForge and install directly into instances.</div>

          <div className="topRow" style={{ marginBottom: 10 }}>
            <SegmentedControl
              value={discoverContentType}
              onChange={(v) => {
                setDiscoverContentType((v as DiscoverContentType) ?? "mods");
                setFilterLoaders([]);
                setOffset(0);
              }}
              options={DISCOVER_CONTENT_OPTIONS}
              variant="scroll"
            />
          </div>

          <div className="topRow discoverSearchRow">
            <div className="searchGrow">
              <input
                className="input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={discoverPlaceholder}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch(0);
                }}
              />
            </div>

            <MenuSelect
              value={index}
              labelPrefix="Sort"
              options={DISCOVER_SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => {
                setIndex(v as any);
                setOffset(0);
              }}
            />

            <MenuSelect
              value={String(limit)}
              labelPrefix="View"
              options={DISCOVER_VIEW_OPTIONS}
              align="end"
              onChange={(v) => {
                setLimit(parseInt(v, 10));
                setOffset(0);
              }}
            />

            <MenuSelect
              value={discoverSource}
              labelPrefix="Source"
              options={DISCOVER_SOURCE_OPTIONS}
              align="end"
              onChange={(v) => {
                setDiscoverSource((v as DiscoverSource) ?? "all");
                setOffset(0);
              }}
            />

            <button className="btn primary" onClick={() => runSearch(0)} disabled={discoverBusy}>
              {discoverBusy ? "Searching…" : "Search"}
            </button>
          </div>

          <div className="topRow discoverFilterRow">
            <div className="discoverFiltersRight">
              <div className="filterCtrl filterCtrlVersion">
                <Dropdown
                  value={filterVersion}
                  placeholder="Game version: Any"
                  groups={groupedDiscoverVersions}
                  includeAny
                  onPick={(v) => {
                    setFilterVersion(v);
                    setOffset(0);
                  }}
                />
              </div>

              <div className="filterCtrl filterCtrlLoader">
                <MultiSelectDropdown
                  values={filterLoaders}
                  placeholder="Loaders: Any"
                  groups={DISCOVER_LOADER_GROUPS}
                  onChange={(v) => {
                    if (discoverContentType !== "mods") return;
                    setFilterLoaders(v);
                    setOffset(0);
                  }}
                />
              </div>

              <div className="filterCtrl filterCtrlCategory">
                <MultiSelectDropdown
                  values={filterCategories}
                  placeholder="Categories: Any"
                  groups={MOD_CATEGORY_GROUPS}
                  onChange={(v) => {
                    setFilterCategories(v);
                    setOffset(0);
                  }}
                />
              </div>

              <label className="checkboxRow discoverCheckboxRow">
                <span
                  className={`checkbox ${discoverAllVersions ? "checked" : ""}`}
                  onClick={() => setDiscoverAllVersions(!discoverAllVersions)}
                  role="checkbox"
                  aria-checked={discoverAllVersions}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDiscoverAllVersions(!discoverAllVersions);
                    }
                  }}
                >
                  {discoverAllVersions ? "✓" : ""}
                </span>
                Show all versions
              </label>

              <button
                className="btn discoverClearBtn"
                onClick={() => {
                  setFilterVersion(null);
                  setFilterLoaders([]);
                  setFilterCategories([]);
                  setOffset(0);
                }}
                disabled={!filterVersion && filterLoaders.length === 0 && filterCategories.length === 0}
              >
                Clear filters
              </button>
            </div>
          </div>

          {discoverErr ? <div className="errorBox">{discoverErr}</div> : null}

          <div className="resultsGrid">
            {hits.map((h) => (
              <div
                className="resultCard"
                key={`${h.source}:${h.project_id}`}
                onClick={() => {
                    if (h.source === "modrinth") {
                      openProject(h.project_id, (h.content_type as DiscoverContentType) ?? discoverContentType);
                      return;
                    }
                    openCurseforgeProject(h.project_id, (h.content_type as DiscoverContentType) ?? discoverContentType);
                }}
              >
                <div className="resultIcon">
                  {h.icon_url ? <img src={h.icon_url} alt="" /> : <div>⬚</div>}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="resultTitle">{h.title}</div>
                  <div className="resultDesc">{h.description}</div>
                  <div className="resultMetaRow">
                    <span className="chip subtle">{h.source}</span>
                    <span>by {h.author}</span>
                    <span>↓ {formatCompact(h.downloads)}</span>
                    <span>♥ {formatCompact(h.follows)}</span>
                    {h.categories?.slice(0, 3)?.map((c) => (
                      <span key={c} className="chip">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>

                <div
                  className="resultActions"
                  style={{ alignSelf: "center" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="btn ghost"
                    onClick={() => {
                      if (h.source === "modrinth") {
                        openProject(h.project_id, (h.content_type as DiscoverContentType) ?? discoverContentType);
                        return;
                      }
                      openCurseforgeProject(h.project_id, (h.content_type as DiscoverContentType) ?? discoverContentType);
                    }}
                  >
                    View
                  </button>
                  <button
                    className="btn"
                    onClick={() => addHitToCreator(h, selectedInst)}
                    title="Add this item to Modpacks & Presets creator"
                  >
                    Add to creator
                  </button>
                  <button
                    className="btn primary installAction"
                    onClick={() =>
                      openInstall({
                        source: h.source === "curseforge" ? "curseforge" : "modrinth",
                        projectId: h.project_id,
                        title: h.title,
                        contentType:
                          (h.content_type as DiscoverContentType) === "modpacks"
                            ? "modpacks"
                            : ((h.content_type as DiscoverContentType) ?? discoverContentType),
                        iconUrl: h.icon_url,
                        description: h.description,
                      })
                    }
                    title={h.content_type === "modpacks" ? "Modpacks are imported as templates" : "Install to instance"}
                    disabled={h.content_type === "modpacks"}
                  >
                    <Icon name="download" /> {h.content_type === "modpacks" ? "Template only" : "Install"}
                  </button>
                </div>
              </div>
            ))}

            {hits.length === 0 && !discoverBusy ? (
              <div className="card" style={{ padding: 16, borderRadius: 22, color: "var(--muted)" }}>
                No results.
              </div>
            ) : null}
          </div>

          <div className="pager">
            <button
              className="btn"
              onClick={() => runSearch(Math.max(0, offset - limit))}
              disabled={discoverBusy || offset === 0}
            >
              ← Prev
            </button>
            <div style={{ color: "var(--muted)", fontWeight: 950 }}>
              Page {page} / {pages}
            </div>
            <button
              className="btn"
              onClick={() => runSearch(Math.min((pages - 1) * limit, offset + limit))}
              disabled={discoverBusy || offset + limit >= totalHits}
            >
              Next →
            </button>
          </div>
        </div>
      );
    }


    if (route === "instance") {
      const inst = instances.find((i) => i.id === selectedId);

      if (!inst) {
        return (
          <div className="page">
            <div className="card" style={{ padding: 14 }}>
              <div className="h2">Instance not found</div>
              <div className="muted" style={{ marginTop: 6 }}>
                This instance may have been deleted or not loaded yet.
              </div>
              <div style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => setRoute("library")}>
                  Back to Library
                </button>
              </div>
            </div>
          </div>
        );
      }

      const loaderLabel =
        inst.loader === "neoforge"
          ? "NeoForge"
          : inst.loader === "fabric"
            ? "Fabric"
            : inst.loader === "forge"
              ? "Forge"
              : inst.loader === "quilt"
                ? "Quilt"
                : "Vanilla";
      const instSettings = normalizeInstanceSettings(inst.settings);
      const requiredJavaMajor = requiredJavaMajorForMcVersion(inst.mc_version);
      const launchHooksDraft = instanceLaunchHooksById[inst.id] ?? defaultLaunchHooksDraft();
      const setLaunchHooksDraft = (patch: Partial<InstanceLaunchHooksDraft>) => {
        setInstanceLaunchHooksById((prev) => ({
          ...prev,
          [inst.id]: {
            ...(prev[inst.id] ?? defaultLaunchHooksDraft()),
            ...patch,
          },
        }));
      };
      const modEntries = installedContentSummary.modEntries;
      const resourcepackEntries = installedContentSummary.resourcepackEntries;
      const shaderpackEntries = installedContentSummary.shaderpackEntries;
      const datapackEntries = installedContentSummary.datapackEntries;
      const visibleInstalledMods = installedContentSummary.visibleInstalledMods;
      const runningForInstance = runningByInstanceId.get(inst.id) ?? [];
      const hasRunningForInstance = runningForInstance.length > 0;
      const canStartConcurrentNative = hasRunningForInstance && launchMethodPick === "native";
      const hasNativeRunningForInstance = runningForInstance.some(
        (r) => String(r.method ?? "").toLowerCase() === "native"
      );
      const launchFailure = launchFailureByInstance[inst.id] ?? null;
      const hasLaunchFailure = Boolean(launchFailure);
      const launchHealth = launchHealthByInstance[inst.id] ?? null;
      const showLaunchHealthBanner = Boolean(launchHealth) && !launchHealthDismissedByInstance[inst.id];
      const showOpenLaunchLogAction =
        hasNativeRunningForInstance || String(launchFailure?.method ?? "").toLowerCase() === "native";
      const launchStage = launchStageByInstance[inst.id] ?? null;
      const launchStageLabel = launchStage?.label?.trim() || launchStageBadgeLabel(
        launchStage?.status,
        launchStage?.message
      );
      const selectableVisibleMods = installedContentSummary.selectableVisibleMods;
      const selectedVisibleModCount = installedContentSummary.selectedVisibleModCount;
      const allVisibleModsSelected =
        selectableVisibleMods.length > 0 &&
        selectedVisibleModCount === selectableVisibleMods.length;
      const selectedInstalledModCount = installedContentSummary.selectedInstalledModCount;
      const instanceActivity = instanceActivityById[inst.id] ?? [];

      const activeLogCacheKey = `${inst.id}:${logSourceFilter}`;
      const activeLogPayload = rawLogLinesBySource[activeLogCacheKey] ?? null;
      const activeLogWindow = logWindowBySource[activeLogCacheKey] ?? {
        nextBeforeLine: normalizeLogLineNo(activeLogPayload?.next_before_line),
        loadingOlder: false,
        fullyLoaded: normalizeLogLineNo(activeLogPayload?.next_before_line) == null,
      };
      const normalizedUpdatedAt = Number(activeLogPayload?.updated_at ?? Date.now());
      const parsedSourceLines =
        activeLogPayload?.available && Array.isArray(activeLogPayload.lines)
          ? activeLogPayload.lines.map((line, idx) =>
              toInstanceLogLine({
                raw: line.raw,
                source: logSourceFilter,
                index: idx,
                updatedAt: normalizedUpdatedAt,
                severity: line.severity,
                timestamp: line.timestamp,
                lineNo: line.line_no,
              })
            )
          : [];
      const analysisSourceLines = parsedSourceLines;
      const allLogLines =
        parsedSourceLines.length > 0
          ? parsedSourceLines
          : fallbackInstanceLogLines({
              source: logSourceFilter,
              instanceId: inst.id,
              hasRunning: hasRunningForInstance,
              message:
                logLoadErr ||
                activeLogPayload?.message ||
                (activeLogPayload?.available ? "Log file is currently empty." : null),
            });
      const logSourcePath = String(activeLogPayload?.path ?? "").trim();
      const sourceTotalLines = Number(activeLogPayload?.total_lines ?? allLogLines.length);
      const sourceLoadedLines = parsedSourceLines.length;
      const sourceTruncated = activeLogWindow.nextBeforeLine != null;
      const activeQuickFilters = QUICK_LOG_FILTER_OPTIONS.filter((item) => logQuickFilters[item.id]).map(
        (item) => item.id
      );
      const normalizedLogQuery = logFilterQuery.trim().toLowerCase();
      const quickFilterMatch = (line: InstanceLogLine) => {
        if (activeQuickFilters.length === 0) return true;
        const text = line.message.toLowerCase();
        const matches: Record<QuickLogFilter, boolean> = {
          errors: line.severity === "error" || /exception|failed|fatal/.test(text),
          warnings: line.severity === "warn" || /\bwarn(?:ing)?\b/.test(text),
          suspects:
            /mod|mixin|plugin|jar|inject|caused by|suspect/.test(text) ||
            /\.(jar|dll)\b/.test(text),
          crashes:
            /crash|fatal|exception|exit code -1|segmentation|stacktrace|crash report/.test(text),
        };
        return activeQuickFilters.some((id) => matches[id]);
      };
      const visibleLogLines = allLogLines.filter((line) => {
        if (logSeverityFilter !== "all" && line.severity !== logSeverityFilter) return false;
        if (!quickFilterMatch(line)) return false;
        if (!normalizedLogQuery) return true;
        const searchable = `${line.message} ${severityLabel(line.severity)} ${line.source}`.toLowerCase();
        return searchable.includes(normalizedLogQuery);
      });
      const hiddenByFilters = Math.max(0, sourceLoadedLines - visibleLogLines.length);
      const crashSuspects = detectCrashSuspectsFromMessages(
        visibleLogLines.map((line) => ({
          message: line.message,
          severity: line.severity,
        }))
      );
      const copiedLogText = visibleLogLines
        .map(
          (line) =>
            `[${formatLogTimestamp(line.timestamp)}] ${severityLabel(line.severity).toUpperCase()} ${line.message}`
        )
        .join("\n");

      return (
        <div className="page">
          <div className="instanceLayout">
            <section className="instanceMainPane">
              <div className="breadcrumbRow">
                <button className="crumbLink" onClick={() => setRoute("library")} aria-label="Back to Library">
                  Library
                </button>
                <span className="crumbSep">›</span>
                <span className="crumbCurrent" title={inst.name}>{inst.name || "Instance"}</span>
                <span className="crumbSep">›</span>
                <span className="crumbCurrent">{instanceTab === "content" ? "Content" : instanceTab === "worlds" ? "Worlds" : "Logs"}</span>
              </div>

              {!selectedLauncherAccount ? (
                <div className="card instanceWarningBanner">
                  <div className="instanceWarningTitle">Cannot reach authentication servers</div>
                  <div className="instanceWarningText">
                    Connect a Minecraft account to launch with the native runtime.
                  </div>
                </div>
              ) : null}

              {showLaunchHealthBanner ? (
                <div className="card instanceNoticeCard" style={{ borderColor: "rgba(52, 211, 153, 0.3)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 950 }}>Launch health check passed</div>
                      <div className="muted">
                        First native launch succeeded for this instance.
                      </div>
                    </div>
                    <button
                      className="btn"
                      onClick={() =>
                        setLaunchHealthDismissedByInstance((prev) => ({
                          ...prev,
                          [inst.id]: true,
                        }))
                      }
                    >
                      Dismiss
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    <span className="chip">Auth ✓</span>
                    <span className="chip">Assets ✓</span>
                    <span className="chip">Libraries ✓</span>
                    <span className="chip">Starting Java ✓</span>
                  </div>
                </div>
              ) : null}

              {hasLaunchFailure ? (
                <div className="card instanceNoticeCard" style={{ borderColor: "rgba(248, 113, 113, 0.32)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 950 }}>Last launch did not complete</div>
                      <div className="muted">{launchFailure?.message || "Check native launch log for details."}</div>
                    </div>
                    <button className="btn" onClick={() => void onOpenLaunchLog(inst)}>
                      <span className="btnIcon">
                        <Icon name="folder" size={16} />
                      </span>
                      Open launch log
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="instPageTop">
                <div className="instHero">
                  <div className="instHeroIcon">
                    <Icon name="box" size={22} />
                  </div>
                  <div className="instHeroText">
                    <div className="instTitle">{inst.name || "Untitled instance"}</div>
                    <div className="instMetaRow">
                      <span className="chip">{loaderLabel} {inst.mc_version}</span>
                      <span className="chip subtle">{hasRunningForInstance ? "Running" : "Never played"}</span>
                      {hasLaunchFailure ? <span className="chip">Last launch failed</span> : null}
                      {launchStageLabel ? (
                        <span className="chip">{launchStage?.status === "starting" ? `Launching: ${launchStageLabel}` : launchStageLabel}</span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="instHeroActions">
                  <MenuSelect
                    value={launchMethodPick}
                    labelPrefix="Launch"
                    options={[
                      { value: "native", label: "Native" },
                      { value: "prism", label: "Prism" },
                    ]}
                    onChange={(v) => setLaunchMethodPick((v as LaunchMethod) ?? "native")}
                  />
                  <button
                    className={`btn ${launchBusyInstanceId === inst.id ? "danger" : "primary"}`}
                    onClick={() => onPlayInstance(inst, launchMethodPick)}
                    disabled={
                      (Boolean(launchBusyInstanceId) && launchBusyInstanceId !== inst.id) ||
                      launchCancelBusyInstanceId === inst.id
                    }
                    title={
                      launchBusyInstanceId === inst.id
                        ? "Cancel current launch"
                        : canStartConcurrentNative
                          ? "Launch an isolated concurrent native session"
                          : `Launch with ${launchMethodPick === "native" ? "native launcher" : "Prism Launcher"}`
                    }
                  >
                    <span className="btnIcon">
                      <Icon name={launchBusyInstanceId === inst.id ? "x" : "play"} size={18} />
                    </span>
                    {launchBusyInstanceId === inst.id
                      ? (launchCancelBusyInstanceId === inst.id ? "Cancelling…" : "Cancel launch")
                      : canStartConcurrentNative
                        ? "Play (isolated)"
                        : "Play"}
                  </button>
                  {showOpenLaunchLogAction ? (
                    <button className="btn" onClick={() => void onOpenLaunchLog(inst)}>
                      <span className="btnIcon">
                        <Icon name="folder" size={16} />
                      </span>
                      Open launch log
                    </button>
                  ) : null}
                  <button
                    className="btn settingsSpin"
                    onClick={() => {
                      setInstanceSettingsSection("general");
                      setInstanceSettingsOpen(true);
                    }}
                  >
                    <span className="btnIcon">
                      <Icon name="gear" size={18} className="navIcon navAnimGear" />
                    </span>
                  </button>
                  {hasRunningForInstance ? (
                    <button
                      className="btn danger"
                      onClick={() => onStopRunning(runningForInstance[0].launch_id)}
                    >
                      Stop
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="instTabsRow">
                <SegmentedControl
                  className="instPrimaryTabs"
                  value={instanceTab}
                  onChange={(v) => setInstanceTab(v as any)}
                  options={[
                    { label: "Content", value: "content" },
                    { label: "Worlds", value: "worlds" },
                    { label: "Logs", value: "logs" },
                  ]}
                />
                <div className="instTabsActions">
                  {instanceTab === "content" ? (
                    <>
                      <button className="btn primary installAction" onClick={() => setRoute("discover")}>
                        <span className="btnIcon">
                          <Icon name="plus" size={18} />
                        </span>
                        Install content
                      </button>
                      <button
                        className="btn"
                        onClick={() => onAddModFromFile(inst)}
                        disabled={importingInstanceId === inst.id}
                      >
                        <span className="btnIcon">
                          <Icon name="upload" size={18} />
                        </span>
                        {importingInstanceId === inst.id ? "Adding…" : "Add from file"}
                      </button>
                    </>
                  ) : instanceTab === "worlds" ? (
                    <>
                      <button
                        className="btn"
                        onClick={async () => {
                          const worlds = await listInstanceWorlds({ instanceId: inst.id }).catch(() => [] as InstanceWorld[]);
                          setInstanceWorlds(worlds);
                          setInstallNotice("World list refreshed.");
                        }}
                      >
                        Refresh
                      </button>
                      <button className="btn" onClick={() => onOpenInstancePath(inst, "instance")}>
                        <span className="btnIcon">
                          <Icon name="folder" size={16} />
                        </span>
                        Open instance folder
                      </button>
                    </>
                  ) : (
                    <></>
                  )}
                </div>
              </div>

              {instanceTab === "content" ? (
                <div className="instToolbar instToolbarSolo">
                  <div className="instToolbarLeft">
                    <Icon name="search" size={18} />
                    <input
                      className="input"
                      value={instanceQuery}
                      onChange={(e) => setInstanceQuery(e.target.value)}
                      placeholder="Search installed content…"
                    />
                    {instanceQuery && (
                      <button className="iconBtn" onClick={() => setInstanceQuery("")} aria-label="Clear">
                        <Icon name="x" size={18} />
                      </button>
                    )}
                  </div>
                </div>
              ) : null}

              <div className="card instPanel">
                {instanceTab === "content" ? (
                  <div className="instanceContentWrap">
                    <div className="instanceContentTopRow">
                      <SegmentedControl
                        value={instanceContentType}
                        onChange={(v) => setInstanceContentType((v as any) ?? "mods")}
                        options={[
                          { label: "Installed mods", value: "mods" },
                          { label: "Resource packs", value: "resourcepacks" },
                          { label: "Datapacks", value: "datapacks" },
                          { label: "Shaders", value: "shaders" },
                        ]}
                        variant="scroll"
                        className="instanceContentTabs"
                      />
                    </div>

                    <div className="instanceContentControlGrid">
                      <div className="instanceContentControlCard">
                        <div className="instanceContentControlHead">
                          <div className="instanceContentControlTitle">Selection</div>
                          <div className="muted instanceContentControlMeta">
                            {installedMods.length} item{installedMods.length === 1 ? "" : "s"} in lockfile
                          </div>
                        </div>
                        <div className="instanceContentStatRow">
                          <span className="chip subtle">Visible: {visibleInstalledMods.length}</span>
                          <span className="chip subtle">Selected: {selectedInstalledModCount}</span>
                        </div>
                        {instanceContentType === "mods" ? (
                          <div className="instanceModsBulkRow">
                            <button
                              className="btn"
                              onClick={() => onToggleAllVisibleModSelection(visibleInstalledMods, !allVisibleModsSelected)}
                              disabled={selectableVisibleMods.length === 0 || toggleBusyVersion === "__bulk__"}
                            >
                              {allVisibleModsSelected ? "Unselect visible" : "Select visible"}
                            </button>
                            <button
                              className="btn"
                              onClick={() => setSelectedModVersionIds([])}
                              disabled={selectedInstalledModCount === 0 || toggleBusyVersion === "__bulk__"}
                            >
                              Clear selection
                            </button>
                          </div>
                        ) : (
                          <div className="muted instanceContentControlHint">
                            Switch to Installed mods to use bulk selection.
                          </div>
                        )}
                      </div>

                      <div className="instanceContentControlCard">
                        <div className="instanceContentControlHead">
                          <div className="instanceContentControlTitle">Maintenance</div>
                          <div className="muted instanceContentControlMeta">
                            {snapshotsBusy
                              ? "Loading snapshots…"
                              : snapshots.length > 0
                                ? `${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"}`
                                : "No snapshots yet"}
                          </div>
                        </div>
                        <div className="instanceContentUpdateRow">
                          <button
                            className="btn"
                            onClick={() => onCheckUpdates(inst)}
                            disabled={updateBusy || updateAllBusy || instanceContentType !== "mods"}
                          >
                            {updateBusy ? "Checking…" : "Refresh"}
                          </button>
                          <button
                            className="btn primary"
                            onClick={() => onUpdateAll(inst)}
                            disabled={updateAllBusy || updateBusy || instanceContentType !== "mods" || (updateCheck?.update_count ?? 0) === 0}
                          >
                            {updateAllBusy ? "Updating…" : `Update all${updateCheck?.update_count ? ` (${updateCheck.update_count})` : ""}`}
                          </button>
                        </div>
                        <div className="instanceSnapshotRow">
                          {snapshots.length > 0 ? (
                            <MenuSelect
                              value={rollbackSnapshotId ?? snapshots[0].id}
                              labelPrefix="Snapshot"
                              options={snapshots.slice(0, 30).map((s) => ({
                                value: s.id,
                                label: `${s.id} • ${s.reason}`,
                              }))}
                              align="start"
                              onChange={(v) => setRollbackSnapshotId(v)}
                            />
                          ) : null}
                          <button
                            className="btn instanceSnapshotRollbackBtn"
                            onClick={() => onRollbackToSnapshot(inst, rollbackSnapshotId)}
                            disabled={rollbackBusy || snapshots.length === 0}
                            title={
                              snapshots.length === 0
                                ? "No snapshot available yet"
                                : `Rollback to ${rollbackSnapshotId ?? snapshots[0]?.id ?? "latest snapshot"}`
                            }
                          >
                            {rollbackBusy ? "Rolling back…" : `Rollback${snapshots.length ? ` (${snapshots.length})` : ""}`}
                          </button>
                        </div>
                        {snapshots.length > 0 ? (
                          <div className="muted instanceContentControlHint">
                            Selected snapshot: {rollbackSnapshotId ?? snapshots[0].id}
                          </div>
                        ) : (
                          <div className="muted instanceContentControlHint">
                            Installing or updating content creates a snapshot automatically.
                          </div>
                        )}
                      </div>
                    </div>

                    {updateErr ? <div className="errorBox" style={{ marginTop: 4 }}>{updateErr}</div> : null}

                    {instanceContentType === "mods" && updateCheck ? (
                      <div className="card updatesCard">
                        <div className="updatesCardTitle">
                          {updateCheck.update_count === 0
                            ? `Checked ${updateCheck.checked_mods} mod${updateCheck.checked_mods === 1 ? "" : "s"} - all up to date`
                            : `${updateCheck.update_count} update${updateCheck.update_count === 1 ? "" : "s"} available`}
                        </div>
                        {updateCheck.update_count > 0 ? (
                          <div className="updatesList">
                            {updateCheck.updates.slice(0, 8).map((u) => (
                              <div key={u.project_id} className="updatesListRow">
                                <div className="updatesListName">{u.name}</div>
                                <div className="updatesListMeta">
                                  {u.current_version_number} → {u.latest_version_number}
                                </div>
                              </div>
                            ))}
                            {updateCheck.updates.length > 8 ? (
                              <div className="muted">+{updateCheck.updates.length - 8} more</div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {modsBusy ? (
                      <div className="emptyState">
                        <div className="emptyTitle">Loading installed content…</div>
                      </div>
                    ) : modsErr ? (
                      <div className="errorBox" style={{ marginTop: 8 }}>{modsErr}</div>
                    ) : visibleInstalledMods.length === 0 ? (
                      <div className="emptyState">
                        <div className="emptyTitle">No {instanceContentType} installed</div>
                        <div className="emptySub">Install from Discover or apply a preset.</div>
                      </div>
                    ) : (
                      <div className="instanceModsTable">
                        <div className="instanceModsHeaderRow">
                          <div className="instanceModsHeaderSelect">
                            {instanceContentType === "mods" ? (
                              <input
                                type="checkbox"
                                className="instanceModsSelectCheck"
                                checked={allVisibleModsSelected}
                                onChange={(e) =>
                                  onToggleAllVisibleModSelection(visibleInstalledMods, e.target.checked)
                                }
                                disabled={selectableVisibleMods.length === 0 || toggleBusyVersion === "__bulk__"}
                                aria-label={
                                  allVisibleModsSelected ? "Unselect all visible mods" : "Select all visible mods"
                                }
                              />
                            ) : null}
                          </div>
                          <div className="instanceModsHeaderName">Name</div>
                          <div className="instanceModsHeaderUpdated">Updated</div>
                          <div className="instanceModsHeaderAction">Action</div>
                        </div>
                        {visibleInstalledMods.map((m) => (
                          <div key={m.version_id} className={`instanceModsRow ${m.enabled ? "" : "disabled"}`}>
                            <div className="instanceModsSelectCell">
                              {(m.content_type ?? "mods") === "mods" ? (
                                <input
                                  type="checkbox"
                                  className="instanceModsSelectCheck"
                                  checked={selectedModVersionIdSet.has(m.version_id)}
                                  onChange={(e) => onToggleModSelection(m.version_id, e.target.checked)}
                                  disabled={!m.file_exists || toggleBusyVersion === "__bulk__"}
                                  aria-label={`Select ${m.name}`}
                                />
                              ) : null}
                            </div>
                            <div className="instanceModsNameCell">
                              <div className="instanceModIcon">
                                <Icon name="layers" size={16} />
                              </div>
                              <div className="instanceModsNameText">
                                <div className="instanceModsNameTitle">
                                  {m.name}
                                  {!m.file_exists ? (
                                    <span className="chip" style={{ color: "rgba(248,113,113,0.95)", borderColor: "rgba(248,113,113,0.28)" }}>
                                      Missing file
                                    </span>
                                  ) : null}
                                </div>
                                <div className="instanceModsNameMeta">
                                  Source: {m.source}
                                  {m.content_type ? ` · ${m.content_type}` : ""}
                                  {m.target_worlds?.length ? ` · worlds: ${m.target_worlds.join(", ")}` : ""}
                                </div>
                              </div>
                            </div>

                            <div className="instanceModsUpdatedCell">
                              <div className="instanceModsVersion">{m.version_number}</div>
                              <div className="instanceModsFilename">{m.filename}</div>
                            </div>

                            <div className="instanceModsActionCell">
                              {(m.content_type ?? "mods") === "mods" ? (
                                <button
                                  className={`btn ${m.enabled ? "danger" : "primary"} instanceEnableBtn`}
                                  onClick={() => onToggleInstalledMod(inst, m, !m.enabled)}
                                  disabled={toggleBusyVersion === m.version_id || toggleBusyVersion === "__bulk__" || !m.file_exists}
                                  aria-label={m.enabled ? "Disable mod" : "Enable mod"}
                                >
                                  {toggleBusyVersion === m.version_id
                                    ? "Applying…"
                                    : m.enabled
                                      ? "Disable"
                                      : "Enable"}
                                </button>
                              ) : (
                                <span className="chip subtle">Managed</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {instanceContentType === "mods" && selectedInstalledModCount > 0 ? (
                      <div className="instanceModsStickyBar">
                        <div className="instanceModsStickyTitle">
                          {selectedInstalledModCount} selected
                        </div>
                        <div className="instanceModsStickyActions">
                          <button
                            className="btn primary"
                            onClick={() => void onBulkToggleSelectedMods(inst, true)}
                            disabled={selectedInstalledModCount === 0 || toggleBusyVersion === "__bulk__"}
                          >
                            {toggleBusyVersion === "__bulk__" ? "Applying…" : "Enable"}
                          </button>
                          <button
                            className="btn danger"
                            onClick={() => void onBulkToggleSelectedMods(inst, false)}
                            disabled={selectedInstalledModCount === 0 || toggleBusyVersion === "__bulk__"}
                          >
                            {toggleBusyVersion === "__bulk__" ? "Applying…" : "Disable"}
                          </button>
                          <button
                            className="btn"
                            onClick={() => setSelectedModVersionIds([])}
                            disabled={selectedInstalledModCount === 0 || toggleBusyVersion === "__bulk__"}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : instanceTab === "worlds" ? (
                  <div className="instanceSectionShell">
                    <div className="instanceSectionHeader">
                      <div>
                        <div className="instanceSectionTitle">Worlds</div>
                        <div className="instanceSectionMeta">World saves discovered in this instance folder.</div>
                      </div>
                      <div className="instanceSectionActions">
                        <span className="chip subtle">
                          Auto backup every {instSettings.world_backup_interval_minutes} min
                        </span>
                        <button
                          className="btn"
                          onClick={async () => {
                            const worlds = await listInstanceWorlds({ instanceId: inst.id }).catch(() => [] as InstanceWorld[]);
                            setInstanceWorlds(worlds);
                            setInstallNotice("World list refreshed.");
                          }}
                        >
                          Refresh
                        </button>
                      </div>
                    </div>
                    {instanceWorlds.length === 0 ? (
                      <div className="instanceWorldsEmpty">
                        <div className="instanceWorldsIconWrap">
                          <Icon name="sparkles" size={30} />
                        </div>
                        <div className="emptyTitle">You don't have any worlds yet.</div>
                        <div className="emptySub">Create a world in Minecraft, then refresh this list.</div>
                        <div className="instanceWorldsActions">
                          <button className="btn" onClick={() => onOpenInstancePath(inst, "saves")}>
                            <span className="btnIcon">
                              <Icon name="folder" size={16} />
                            </span>
                            Open saves folder
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="instanceWorldGrid">
                        {(() => {
                          const instanceRunning = (runningByInstanceId.get(inst.id)?.length ?? 0) > 0;
                          return instanceWorlds.map((world) => {
                            const hasBackup = Boolean(world.latest_backup_at) && (world.backup_count ?? 0) > 0;
                            const rollbackBusyForWorld = Boolean(worldRollbackBusyById[world.id]);
                            const rollbackDisabled = !hasBackup || rollbackBusyForWorld;
                            return (
                              <div key={world.id} className="card instanceWorldCard">
                                <div className="instanceWorldCardTop">
                                  <div className="instanceWorldName">{world.name}</div>
                                  <span className="chip subtle">
                                    {hasBackup
                                      ? `${world.backup_count ?? 0} backup${(world.backup_count ?? 0) === 1 ? "" : "s"}`
                                      : "No backup yet"}
                                  </span>
                                </div>
                                <div className="muted">{world.path}</div>
                                <div className="instanceWorldBackupMeta">
                                  {hasBackup
                                    ? `Latest backup: ${formatDateTime(world.latest_backup_at)}`
                                    : `Auto backup runs every ${instSettings.world_backup_interval_minutes} minutes while Minecraft is running.`}
                                </div>
                                <div className="instanceWorldActions">
                                  <button className="btn" onClick={() => onOpenInstancePath(inst, "saves")}>
                                    <span className="btnIcon">
                                      <Icon name="folder" size={15} />
                                    </span>
                                    Open saves
                                  </button>
                                  <button
                                    className="btn primary"
                                    onClick={() => void onRollbackWorldBackup(inst, world)}
                                    disabled={rollbackDisabled}
                                    title={
                                      instanceRunning
                                        ? "Stop Minecraft first, then rollback."
                                        : hasBackup
                                          ? "Restore this world from the latest auto-backup."
                                          : "No auto-backup available yet."
                                    }
                                  >
                                    {rollbackBusyForWorld ? "Rolling back…" : "Rollback latest backup"}
                                  </button>
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="instanceSectionShell">
                    <div className="instanceSectionHeader">
                      <div>
                        <div className="instanceSectionTitle">Logs</div>
                        <div className="instanceSectionMeta">Clean log view with quick filters and suspects.</div>
                      </div>
                    </div>
                    <div className="instanceLogsModeRow">
                      <SegmentedControl
                        value={logViewMode}
                        onChange={(v) => setLogViewMode((v as LogViewMode) ?? "live")}
                        options={[
                          { value: "live", label: "Live" },
                          { value: "analyze", label: "Analyze" },
                        ]}
                      />
                      <span className="chip subtle">
                        {logViewMode === "live"
                          ? `${visibleLogLines.length} visible · ${sourceLoadedLines.toLocaleString()} / ${sourceTotalLines.toLocaleString()} loaded`
                          : "Paste logs or analyze current source"}
                      </span>
                    </div>
                    {logViewMode === "live" ? (
                      <div className="instanceLogsShell">
                        <div className="instanceLogsMain">
                          <div className="instanceLogsToolbar">
                            <div className="instToolbarLeft instanceLogSearch">
                              <Icon name="search" size={18} />
                              <input
                                className="input"
                                value={logFilterQuery}
                                onChange={(e) => setLogFilterQuery(e.target.value)}
                                placeholder="Search log lines…"
                              />
                              {logFilterQuery ? (
                                <button
                                  className="iconBtn"
                                  onClick={() => setLogFilterQuery("")}
                                  aria-label="Clear search"
                                >
                                  <Icon name="x" size={18} />
                                </button>
                              ) : null}
                            </div>
                            <MenuSelect
                              value={logSeverityFilter}
                              labelPrefix="Level"
                              options={LOG_SEVERITY_OPTIONS}
                              onChange={(v) =>
                                setLogSeverityFilter(
                                  (v as "all" | InstanceLogSeverity | null) ?? "all"
                                )
                              }
                            />
                            <MenuSelect
                              value={logSourceFilter}
                              labelPrefix="Source"
                              options={LOG_SOURCE_OPTIONS}
                              onChange={(v) =>
                                setLogSourceFilter((v as InstanceLogSource | null) ?? "live")
                              }
                            />
                            <MenuSelect
                              value={String(logMaxLines)}
                              labelPrefix="Lines"
                              options={LOG_MAX_LINES_OPTIONS}
                              onChange={(v) => {
                                const parsed = Number.parseInt(v, 10);
                                if (!Number.isFinite(parsed)) return;
                                setLogMaxLines(Math.max(200, Math.min(12000, parsed)));
                              }}
                            />
                            <button
                              className="btn"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(
                                    copiedLogText || "No visible log lines to copy."
                                  );
                                  setInstallNotice("Copied visible log lines.");
                                } catch {
                                  setInstallNotice("Could not copy visible log lines.");
                                }
                              }}
                            >
                              Copy
                            </button>
                            <button
                              className="btn"
                              onClick={() => {
                                setLogFilterQuery("");
                                setLogSeverityFilter("all");
                                setLogQuickFilters({
                                  errors: false,
                                  warnings: false,
                                  suspects: false,
                                  crashes: false,
                                });
                                setSelectedCrashSuspect(null);
                                setInstallNotice("Log filters cleared.");
                              }}
                            >
                              Clear
                            </button>
                            <button
                              className="btn"
                              onClick={() => {
                                if (logSourceFilter === "latest_crash") {
                                  void onOpenInstancePath(inst, "crash-log");
                                } else {
                                  void onOpenInstancePath(inst, "launch-log");
                                }
                              }}
                            >
                              Open file
                            </button>
                          </div>

                          <div className="instanceLogsQuickFilters">
                            <span className="instanceLogsQuickLabel">Quick filters</span>
                            {QUICK_LOG_FILTER_OPTIONS.map((opt) => (
                              <button
                                key={opt.id}
                                className={`instanceLogQuickChip ${logQuickFilters[opt.id] ? "on" : ""}`}
                                onClick={() =>
                                  setLogQuickFilters((prev) => ({
                                    ...prev,
                                    [opt.id]: !prev[opt.id],
                                  }))
                                }
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>

                          <div className="instanceLogsMetaStrip">
                            <span className="instanceLogsMetaStatus">{logLoadBusy ? "Refreshing…" : "Ready"}</span>
                            {logSourcePath ? (
                              <span className="instanceLogsMetaPath" title={logSourcePath}>
                                {logSourcePath}
                              </span>
                            ) : null}
                            <span className="chip subtle">
                              Loaded {sourceLoadedLines.toLocaleString()} / {sourceTotalLines.toLocaleString()}
                            </span>
                            <span className="chip subtle">Visible {visibleLogLines.length.toLocaleString()}</span>
                            <span className="chip subtle">Hidden by filters {hiddenByFilters.toLocaleString()}</span>
                            {sourceTruncated ? <span className="chip subtle">Older lines hidden</span> : null}
                            {logSourceFilter !== "live" && activeLogWindow.nextBeforeLine != null ? (
                              <button
                                className="btn"
                                onClick={() => void onLoadOlderLogLines()}
                                disabled={activeLogWindow.loadingOlder}
                              >
                                {activeLogWindow.loadingOlder ? "Loading older…" : "Load older lines"}
                              </button>
                            ) : null}
                          </div>
                          {logLoadErr ? <div className="instanceLogsInlineErr">{logLoadErr}</div> : null}

                          <div className="instanceLogsViewer">
                            {visibleLogLines.length === 0 ? (
                              <div className="instanceLogsEmpty">
                                No log lines match your current filters.
                              </div>
                            ) : (
                              <div className="instanceLogRows">
                                {visibleLogLines.map((line) => {
                                  const suspectMatch = selectedCrashSuspect
                                    ? line.message.toLowerCase().includes(selectedCrashSuspect)
                                    : false;
                                  return (
                                    <div
                                      key={line.id}
                                      className={`instanceLogRow sev-${line.severity} ${suspectMatch ? "suspectHit" : ""}`}
                                    >
                                      <span className={`instanceLogSeverityPill sev-${line.severity}`}>
                                        {severityShort(line.severity)}
                                      </span>
                                      <div className="instanceLogRowMain">
                                        <span className="instanceLogTimestamp">
                                          {formatLogTimestamp(line.timestamp)}
                                        </span>
                                        <span className="instanceLogMessage">{line.message}</span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>

                        <aside className="instanceLogSuspects">
                          <div className="instanceLogSuspectsHead">
                            <div className="instanceLogSuspectsTitle">Crash suspects</div>
                            <span className="chip subtle">Ranked</span>
                          </div>
                          <div className="instanceLogSuspectsSub">
                            Ranked from visible lines with weighted crash heuristics.
                          </div>
                          <div className="instanceLogSuspectList">
                            {crashSuspects.length === 0 ? (
                              <div className="instanceLogSuspectsEmpty">
                                No strong suspects detected.
                              </div>
                            ) : (
                              crashSuspects.map((suspect) => (
                                <button
                                  key={suspect.id}
                                  className={`instanceLogSuspectItem ${selectedCrashSuspect === suspect.id ? "on" : ""}`}
                                  onClick={() =>
                                    setSelectedCrashSuspect((prev) =>
                                      prev === suspect.id ? null : suspect.id
                                    )
                                  }
                                >
                                  <span>{suspect.label}</span>
                                  <span className="chip subtle">
                                    {suspect.matches} · {Math.round(suspect.confidence * 100)}%
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        </aside>
                      </div>
                    ) : (
                      <div className="instanceAnalyzeWrap">
                        <div className="instanceAnalyzeInput">
                          <div className="instanceAnalyzeTitle">Analyze logs</div>
                          <div className="instanceAnalyzeSub">
                            Paste log text below or drop a file here to run offline analysis.
                          </div>
                          <textarea
                            className="textarea instanceAnalyzeTextarea"
                            value={logAnalyzeInput}
                            onChange={(e) => {
                              setLogAnalyzeInput(e.target.value);
                              setLogAnalyzeResult(null);
                              setLogAnalyzeSourcesUsed([]);
                              setLogAnalyzeMissingCrash(false);
                            }}
                            placeholder="Paste logs here…"
                          />
                          <div className="row" style={{ marginTop: 6 }}>
                            <button
                              className="btn primary"
                              onClick={() => {
                                const result = analyzeLogText(logAnalyzeInput);
                                setLogAnalyzeResult(result);
                                setLogAnalyzeSourcesUsed([]);
                                setLogAnalyzeMissingCrash(false);
                                setInstallNotice(`Analyzed ${result.totalLines} log line${result.totalLines === 1 ? "" : "s"}.`);
                              }}
                              disabled={!logAnalyzeInput.trim() || logAnalyzeBusy}
                            >
                              {logAnalyzeBusy ? "Analyzing…" : "Analyze"}
                            </button>
                            <button
                              className="btn"
                              onClick={() => {
                                void (async () => {
                                  if (analysisSourceLines.length === 0 || logAnalyzeBusy) return;
                                  setLogAnalyzeBusy(true);
                                  try {
                                    const sourceOrder: InstanceLogSource[] = [logSourceFilter];
                                    if (!sourceOrder.includes("latest_launch")) {
                                      sourceOrder.push("latest_launch");
                                    }
                                    if (!sourceOrder.includes("latest_crash")) {
                                      sourceOrder.push("latest_crash");
                                    }

                                    const sourceRows = new Map<InstanceLogSource, InstanceLogLine[]>();
                                    sourceRows.set(logSourceFilter, analysisSourceLines);
                                    let missingCrash = false;

                                    for (const source of sourceOrder) {
                                      if (source === logSourceFilter) continue;
                                      const cacheKey = `${inst.id}:${source}`;
                                      let payload = rawLogLinesBySource[cacheKey] ?? null;
                                      if (!payload || !payload.available) {
                                        try {
                                          payload = await readInstanceLogs({
                                            instanceId: inst.id,
                                            source,
                                            maxLines: logMaxLines,
                                          });
                                        } catch {
                                          payload = null;
                                        }
                                      }
                                      const rows =
                                        payload?.available && Array.isArray(payload.lines)
                                          ? payload.lines.map((line, idx) =>
                                              toInstanceLogLine({
                                                raw: line.raw,
                                                source,
                                                index: idx,
                                                updatedAt: Number(payload?.updated_at ?? Date.now()),
                                                severity: line.severity,
                                                timestamp: line.timestamp,
                                                lineNo: line.line_no,
                                              })
                                            )
                                          : [];
                                      if (rows.length > 0) {
                                        sourceRows.set(source, rows);
                                      } else if (source === "latest_crash") {
                                        missingCrash = true;
                                      }
                                    }

                                    const dedupe = new Set<string>();
                                    const combined: InstanceLogLine[] = [];
                                    for (const source of sourceOrder) {
                                      const rows = sourceRows.get(source) ?? [];
                                      for (const row of rows) {
                                        const dedupeKey = `${source}:${row.lineNo ?? "x"}:${row.message}`;
                                        if (dedupe.has(dedupeKey)) continue;
                                        dedupe.add(dedupeKey);
                                        combined.push(row);
                                      }
                                    }
                                    const cappedCombined =
                                      combined.length > 18000 ? combined.slice(combined.length - 18000) : combined;
                                    const result = analyzeLogLines(
                                      cappedCombined.map((line) => ({
                                        message: line.message,
                                        severity: line.severity,
                                        source: line.source,
                                        lineNo: line.lineNo,
                                        timestamp: line.timestamp,
                                      }))
                                    );
                                    const sourcesUsed = sourceOrder.filter(
                                      (source) => (sourceRows.get(source) ?? []).length > 0
                                    );
                                    setLogAnalyzeResult(result);
                                    setLogAnalyzeSourcesUsed(sourcesUsed);
                                    setLogAnalyzeMissingCrash(missingCrash);
                                    setInstallNotice(
                                      `Analyzed ${result.totalLines} line${result.totalLines === 1 ? "" : "s"} from ${sourcesUsed.length} source${sourcesUsed.length === 1 ? "" : "s"}.`
                                    );
                                  } finally {
                                    setLogAnalyzeBusy(false);
                                  }
                                })();
                              }}
                              disabled={analysisSourceLines.length === 0 || logAnalyzeBusy}
                            >
                              {logAnalyzeBusy ? "Analyzing…" : "Analyze current source"}
                            </button>
                          </div>
                          {logAnalyzeSourcesUsed.length > 0 ? (
                            <div className="instanceAnalyzeSourceRow">
                              <span className="instanceAnalyzeSourcesLabel">Sources used</span>
                              {logAnalyzeSourcesUsed.map((source) => (
                                <span key={source} className="chip subtle">
                                  {sourceLabel(source)}
                                </span>
                              ))}
                              {logAnalyzeMissingCrash ? (
                                <span className="chip subtle">No crash report found</span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <div className="instanceAnalyzeResults">
                          <div className="instanceAnalyzeCard">
                            <div className="instanceAnalyzeCardTitle">Summary</div>
                            {logAnalyzeResult ? (
                              <div className="muted">
                                {logAnalyzeResult.totalLines} lines · {logAnalyzeResult.errorCount} errors · {logAnalyzeResult.warnCount} warnings · {logAnalyzeResult.infoCount} info
                              </div>
                            ) : (
                              <div className="muted">Run Analyze to generate a summary.</div>
                            )}
                          </div>
                          <div className="instanceAnalyzeCard">
                            <div className="instanceAnalyzeCardTitle">Likely causes</div>
                            {logAnalyzeResult && logAnalyzeResult.likelyCauses.length > 0 ? (
                              <div style={{ display: "grid", gap: 6 }}>
                                {logAnalyzeResult.likelyCauses.slice(0, 4).map((cause) => (
                                  <div key={cause.id}>
                                    <div className="rowBetween">
                                      <span>{cause.title}</span>
                                      <span className="chip subtle">{Math.round(cause.confidence * 100)}%</span>
                                    </div>
                                    <div className="muted">{cause.reason}</div>
                                    {logAnalyzeResult.evidenceByCause?.[cause.id]?.[0] ? (
                                      <div className="muted">
                                        Evidence: {logAnalyzeResult.evidenceByCause[cause.id][0]}
                                      </div>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="muted">No high-confidence root cause detected yet.</div>
                            )}
                          </div>
                          <div className="instanceAnalyzeCard">
                            <div className="instanceAnalyzeCardTitle">Failed mods</div>
                            {logAnalyzeResult && logAnalyzeResult.failedMods.length > 0 ? (
                              <div style={{ display: "grid", gap: 6 }}>
                                {logAnalyzeResult.failedMods.slice(0, 6).map((mod) => (
                                  <div key={mod.id}>
                                    <div className="rowBetween">
                                      <span>{mod.label}</span>
                                      <span className="chip subtle">{Math.round(mod.confidence * 100)}%</span>
                                    </div>
                                    <div className="muted">{mod.reason}</div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="muted">No explicit failed mod lines detected.</div>
                            )}
                          </div>
                          <div className="instanceAnalyzeCard">
                            <div className="instanceAnalyzeCardTitle">Suspects</div>
                            {logAnalyzeResult && logAnalyzeResult.suspects.length > 0 ? (
                              <div style={{ display: "grid", gap: 6 }}>
                                {logAnalyzeResult.suspects.slice(0, 6).map((suspect) => (
                                  <div key={suspect.id} className="rowBetween">
                                    <span>{suspect.label}</span>
                                    <span className="chip subtle">
                                      {suspect.matches} · {Math.round(suspect.confidence * 100)}%
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="muted">No strong suspects detected yet.</div>
                            )}
                          </div>
                          <div className="instanceAnalyzeCard">
                            <div className="instanceAnalyzeCardTitle">Key errors</div>
                            {logAnalyzeResult && logAnalyzeResult.keyErrors.length > 0 ? (
                              <div style={{ display: "grid", gap: 6 }}>
                                {logAnalyzeResult.keyErrors.map((line, idx) => (
                                  <div key={`${idx}:${line.slice(0, 24)}`} className="muted">{line}</div>
                                ))}
                              </div>
                            ) : (
                              <div className="muted">No error lines detected.</div>
                            )}
                          </div>
                          <div className="instanceAnalyzeCard">
                            <div className="instanceAnalyzeCardTitle">Confidence notes</div>
                            {logAnalyzeResult && (logAnalyzeResult.confidenceNotes?.length ?? 0) > 0 ? (
                              <div style={{ display: "grid", gap: 6 }}>
                                {(logAnalyzeResult.confidenceNotes ?? []).map((note, idx) => (
                                  <div key={`${idx}:${note.slice(0, 18)}`} className="muted">{note}</div>
                                ))}
                              </div>
                            ) : (
                              <div className="muted">Run Analyze to generate confidence notes.</div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>

            <aside className="instanceSidePane">
              <div className="card instanceSideCard instanceActivityCard">
                <div className="instanceActivityHead">
                  <div className="librarySideTitle">Activity</div>
                  <div className="instanceActivityActions">
                    {instanceActivity.length > 0 ? (
                      <button
                        className="btn"
                        onClick={() =>
                          setInstanceActivityById((prev) => ({
                            ...prev,
                            [inst.id]: [],
                          }))
                        }
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                </div>
                {instanceActivity.length === 0 ? (
                  <div className="muted">Launch, install, and maintenance updates appear here.</div>
                ) : (
                  <div className="instanceActivityList">
                    {instanceActivity.slice(0, 10).map((entry) => (
                      <div key={entry.id} className={`instanceActivityItem ${entry.tone}`}>
                        <span className="instanceActivityDot" />
                        <div className="instanceActivityContent">
                          <div className="instanceActivityMessage">{entry.message}</div>
                          <div className="instanceActivityTime">
                            {new Date(entry.at).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="card instanceSideCard">
                <div className="librarySideTitle">No instances running</div>
                <div className="muted">
                  {hasRunningForInstance
                    ? `${runningForInstance.length} running instance${runningForInstance.length === 1 ? "" : "s"}`
                    : "This instance is currently stopped."}
                </div>
              </div>
              <div className="card instanceSideCard">
                <div className="librarySideTitle">Playing as</div>
                {selectedLauncherAccount ? (
                  <>
                    <div className="libraryAccountName">{selectedLauncherAccount.username}</div>
                    <div className="muted">{selectedLauncherAccount.id}</div>
                  </>
                ) : (
                  <div className="muted">Select account in Settings or Account page.</div>
                )}
              </div>
              <div className="card instanceSideCard">
                <div className="librarySideTitle">Instance tools</div>
                <div className="libraryQuickActions">
                  <button className="btn" onClick={() => onOpenInstancePath(inst, "instance")}>
                    <Icon name="folder" size={16} />
                    Open instance folder
                  </button>
                  <button className="btn" onClick={() => onOpenInstancePath(inst, "mods")}>
                    <Icon name="folder" size={16} />
                    Open mods folder
                  </button>
                  <button className="btn" onClick={() => onExportModsZip(inst)}>
                    <Icon name="download" size={16} />
                    Export mods zip
                  </button>
                </div>
              </div>
            </aside>
          </div>

          {instanceSettingsOpen && (
            <Modal
              title={`${inst.name || "Instance"} settings`}
              className="instanceSettingsModal"
              titleNode={
                <div className="instSettingsCrumb">
                  <span className="instSettingsCrumbIcon" aria-hidden="true">
                    <Icon name="box" size={15} />
                  </span>
                  <span className="instSettingsCrumbName">{inst.name || "Instance"}</span>
                  <span className="instSettingsCrumbSep">›</span>
                  <span className="instSettingsCrumbLabel">Settings</span>
                </div>
              }
              onClose={() => setInstanceSettingsOpen(false)}
              size="wide"
            >
              <div className="modalBody instSettingsModalBody">
                <div className="instSettings">
                  <div className="instSettingsNav">
                    {[
                      { id: "general", label: "General", icon: "sliders" },
                      { id: "installation", label: "Installation", icon: "box" },
                      { id: "graphics", label: "Window", icon: "sparkles" },
                      { id: "java", label: "Java and memory", icon: "cpu" },
                      { id: "content", label: "Launch hooks", icon: "layers" },
                    ].map((s) => (
                    <button
                      key={s.id}
                      className={"instSettingsNavItem" + (instanceSettingsSection === s.id ? " active" : "")}
                      onClick={() => setInstanceSettingsSection(s.id as "general" | "installation" | "java" | "graphics" | "content")}
                    >
                      <span className="navIco">
                        <Icon name={s.icon as any} size={18} />
                      </span>
                      {s.label}
                    </button>
                  ))}

                  <div className="instSettingsNavFooter">
                    <button
                      className="btn danger"
                      onClick={() => {
                        requestDelete(inst);
                      }}
                    >
                      <span className="btnIcon">
                        <Icon name="trash" size={18} />
                      </span>
                      Delete instance
                    </button>
                  </div>
                </div>

                  <div className="instSettingsBody">
                  <div className="instSettingsStatusRow">
                    <span className="chip subtle">Auto-save on toggle/change</span>
                    {instanceSettingsBusy ? <span className="chip">Saving…</span> : <span className="chip">Saved</span>}
                  </div>
                  {instanceSettingsSection === "general" && (
                    <>
                      <div className="h2 sectionHead">
                        General
                      </div>

                      <div className="settingGrid">
                        <div className="settingCard">
                          <div className="settingTitle">Name</div>
                          <div className="settingSub">Displayed in Library and sidebar.</div>
                          <input
                            className="input"
                            value={instanceNameDraft}
                            onChange={(e) => setInstanceNameDraft(e.target.value)}
                            onBlur={() => void onCommitInstanceName(inst)}
                            placeholder="Instance name"
                            disabled={instanceSettingsBusy}
                          />
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Icon</div>
                          <div className="settingSub">Used for quick access in the sidebar.</div>
                          <div className="instanceIconPreviewRow">
                            <div className="instCardIcon">
                              {inst.icon_path ? (
                                <LocalImage path={inst.icon_path} alt="" fallback={<Icon name="box" size={19} />} />
                              ) : (
                                <Icon name="box" size={19} />
                              )}
                            </div>
                            <div className="muted">
                              {inst.icon_path ? "Custom icon selected" : "Using default icon"}
                            </div>
                          </div>
                          <div className="row">
                            <button className="btn" onClick={() => void onSelectInstanceIcon(inst)} disabled={busy === "instance-icon" || instanceSettingsBusy}>
                              <span className="btnIcon">
                                <Icon name="upload" size={18} />
                              </span>
                              Select icon
                            </button>
                            <button className="btn" onClick={() => void onRemoveInstanceIcon(inst)} disabled={busy === "instance-icon" || instanceSettingsBusy || !inst.icon_path}>
                              <span className="btnIcon">
                                <Icon name="x" size={18} />
                              </span>
                              Remove icon
                            </button>
                          </div>
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Notes</div>
                          <div className="settingSub">Personal reminder for this instance.</div>
                          <textarea
                            className="textarea"
                            value={instanceNotesDraft}
                            onChange={(e) => setInstanceNotesDraft(e.target.value)}
                            onBlur={() => void onCommitInstanceNotes(inst)}
                            placeholder="Write a quick note…"
                            disabled={instanceSettingsBusy}
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {instanceSettingsSection === "installation" && (
                    <>
                      <div className="h2 sectionHead">
                        Installation
                      </div>

                      <div className="settingGrid">
                        <div className="settingCard">
                          <div className="settingTitle">Loader</div>
                          <div className="settingSub">Switch between supported loaders for this instance.</div>
                          <SegmentedControl
                            value={inst.loader}
                            onChange={(v) => {
                              const nextLoader = (v ?? inst.loader) as Loader;
                              if (nextLoader === inst.loader) return;
                              void persistInstanceChanges(inst, { loader: nextLoader }, `Loader set to ${nextLoader}.`);
                            }}
                            options={[
                              { label: "Vanilla", value: "vanilla" },
                              { label: "Fabric", value: "fabric" },
                              { label: "Forge", value: "forge" },
                              { label: "NeoForge", value: "neoforge" },
                              { label: "Quilt", value: "quilt" },
                            ]}
                            variant="scroll"
                          />
                        </div>

                        <div className="settingCard settingCardVersion">
                          <MenuSelect
                            value={inst.mc_version}
                            labelPrefix="Version"
                            onChange={(v) => {
                              if (v === inst.mc_version) return;
                              void persistInstanceChanges(inst, { mcVersion: v }, `Minecraft version set to ${v}.`);
                            }}
                            options={instanceVersionOptions}
                            placement="top"
                          />
                          <div className="settingTitle settingTitleAfterControl">Game version</div>
                          <div className="settingSub">Shown in Discover filters and install prompts.</div>
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Instance location</div>
                          <div className="settingSub">Where files are stored on disk.</div>
                          <div className="pathRow">
                            <input
                              className="input"
                              value={`Instance ID: ${inst.id}`}
                              readOnly
                            />
                            <button className="btn" onClick={() => void onOpenInstancePath(inst, "instance")}>
                              <span className="btnIcon">
                                <Icon name="folder" size={18} />
                              </span>
                              Open
                            </button>
                          </div>
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Updates</div>
                          <div className="settingSub">Control install and update behavior for this instance.</div>
                          <label className="toggleRow">
                            <input
                              type="checkbox"
                              checked={instSettings.auto_update_installed_content}
                              onChange={(e) =>
                                void persistInstanceChanges(
                                  inst,
                                  { settings: { auto_update_installed_content: e.target.checked } },
                                  "Update preference saved."
                                )
                              }
                              disabled={instanceSettingsBusy}
                            />
                            <span className="togglePill" />
                            <span>Auto-update installed content</span>
                          </label>
                          <label className="toggleRow">
                            <input
                              type="checkbox"
                              checked={instSettings.prefer_release_builds}
                              onChange={(e) =>
                                void persistInstanceChanges(
                                  inst,
                                  { settings: { prefer_release_builds: e.target.checked } },
                                  "Update preference saved."
                                )
                              }
                              disabled={instanceSettingsBusy}
                            />
                            <span className="togglePill" />
                            <span>Prefer release builds</span>
                          </label>
                        </div>
                      </div>
                    </>
                  )}

                  {instanceSettingsSection === "java" && (
                    <>
                      <div className="h2 sectionHead">
                        Java and memory
                      </div>

                      <div className="settingGrid">
                        <div className="settingCard">
                          <div className="settingTitle">Java runtime</div>
                          <div className="settingSub">
                            Use a per-instance override, or leave blank to use launcher default.
                          </div>
                          <input
                            className="input"
                            value={instanceJavaPathDraft}
                            onChange={(e) => setInstanceJavaPathDraft(e.target.value)}
                            onBlur={() => void onCommitInstanceJavaPath(inst)}
                            placeholder="Blank = use launcher Java path"
                            disabled={instanceSettingsBusy}
                          />
                          <div className="row">
                            <button className="btn" onClick={() => void onPickInstanceJavaPath(inst)} disabled={instanceSettingsBusy}>
                              <span className="btnIcon">
                                <Icon name="upload" size={17} />
                              </span>
                              Browse…
                            </button>
                            <button className="btn" onClick={() => void refreshJavaRuntimeCandidates()} disabled={javaRuntimeBusy}>
                              {javaRuntimeBusy ? "Detecting…" : "Detect runtimes"}
                            </button>
                            <button
                              className="btn"
                              onClick={() => void openExternalLink("https://adoptium.net/temurin/releases/?version=21")}
                            >
                              Get Java 21
                            </button>
                          </div>
                          <div className="muted" style={{ marginTop: 8 }}>
                            Minecraft {inst.mc_version} requires Java {requiredJavaMajor}+.
                          </div>
                          {javaRuntimeCandidates.length > 0 ? (
                            <div className="settingListMini">
                              {javaRuntimeCandidates.slice(0, 5).map((runtime) => (
                                <div key={runtime.path} className="settingListMiniRow">
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 900 }}>Java {runtime.major}</div>
                                    <div className="muted" style={{ wordBreak: "break-all" }}>{runtime.path}</div>
                                  </div>
                                  <button
                                    className={`btn ${instanceJavaPathDraft.trim() === runtime.path.trim() ? "primary" : ""}`}
                                    onClick={() => {
                                      setInstanceJavaPathDraft(runtime.path);
                                      void persistInstanceChanges(
                                        inst,
                                        { settings: { java_path: runtime.path } },
                                        "Instance Java path updated."
                                      );
                                    }}
                                    disabled={instanceSettingsBusy}
                                  >
                                    {instanceJavaPathDraft.trim() === runtime.path.trim() ? "Selected" : "Use"}
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Memory</div>
                          <div className="settingSub">Set Java heap size in MB for this instance.</div>
                          <div className="row">
                            <input
                              className="input"
                              type="number"
                              min={512}
                              max={65536}
                              step={256}
                              value={instanceMemoryDraft}
                              onChange={(e) => setInstanceMemoryDraft(e.target.value)}
                              onBlur={() => void onCommitInstanceMemory(inst)}
                              disabled={instanceSettingsBusy}
                            />
                            <button
                              className="btn"
                              onClick={() => {
                                setInstanceMemoryDraft("4096");
                                void persistInstanceChanges(inst, { settings: { memory_mb: 4096 } }, "Memory reset to 4096 MB.");
                              }}
                              disabled={instanceSettingsBusy}
                            >
                              Reset
                            </button>
                          </div>
                          <div className="row">
                            {[2048, 4096, 6144, 8192].map((presetMb) => (
                              <button
                                key={presetMb}
                                className={`btn ${Number(instanceMemoryDraft) === presetMb ? "primary" : ""}`}
                                onClick={() => {
                                  setInstanceMemoryDraft(String(presetMb));
                                  void persistInstanceChanges(
                                    inst,
                                    { settings: { memory_mb: presetMb } },
                                    `Memory set to ${presetMb} MB.`
                                  );
                                }}
                                disabled={instanceSettingsBusy}
                              >
                                {Math.round(presetMb / 1024)} GB
                              </button>
                            ))}
                          </div>
                          <div className="muted" style={{ marginTop: 8 }}>
                            Recommended: 4096 MB for medium packs, 6144-8192 MB for heavier packs.
                          </div>
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">JVM arguments</div>
                          <div className="settingSub">Advanced users only. Saved per instance.</div>
                          <textarea
                            className="textarea"
                            placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=80"
                            value={instanceJvmArgsDraft}
                            onChange={(e) => setInstanceJvmArgsDraft(e.target.value)}
                            onBlur={() => void onCommitInstanceJvmArgs(inst)}
                            disabled={instanceSettingsBusy}
                          />
                        </div>
                      </div>
                    </>
                  )}

                  {instanceSettingsSection === "graphics" && (
                    <>
                      <div className="h2 sectionHead">
                        Window
                      </div>

                      <div className="settingGrid">
                        <div className="settingCard">
                          <div className="settingTitle">Window behavior</div>
                          <div className="settingSub">Saved per instance. Off now minimizes the launcher instead of hiding it, so logs stay accessible.</div>
                          <label className="toggleRow">
                            <input
                              type="checkbox"
                              checked={instSettings.keep_launcher_open_while_playing}
                              onChange={(e) =>
                                void persistInstanceChanges(
                                  inst,
                                  { settings: { keep_launcher_open_while_playing: e.target.checked } },
                                  "Window behavior saved."
                                )
                              }
                              disabled={instanceSettingsBusy}
                            />
                            <span className="togglePill" />
                            <span>Keep launcher open while playing</span>
                          </label>
                          <label className="toggleRow">
                            <input
                              type="checkbox"
                              checked={instSettings.close_launcher_on_game_exit}
                              onChange={(e) =>
                                void persistInstanceChanges(
                                  inst,
                                  { settings: { close_launcher_on_game_exit: e.target.checked } },
                                  "Window behavior saved."
                                )
                              }
                              disabled={instanceSettingsBusy}
                            />
                            <span className="togglePill" />
                            <span>Close launcher on game exit</span>
                          </label>
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Visual preset</div>
                          <div className="settingSub">Controls optional graphics defaults for this instance.</div>
                          <MenuSelect
                            value={instSettings.graphics_preset}
                            labelPrefix="Preset"
                            onChange={(v) =>
                              void persistInstanceChanges(
                                inst,
                                {
                                  settings: {
                                    graphics_preset: v,
                                  },
                                },
                                `Graphics preset set to ${v}.`
                              )
                            }
                            options={[
                              { value: "Performance", label: "Performance" },
                              { value: "Balanced", label: "Balanced" },
                              { value: "Quality", label: "Quality" },
                            ]}
                          />
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Optional display features</div>
                          <div className="settingSub">Toggles that can improve image quality at runtime.</div>
                          <label className="toggleRow">
                            <input
                              type="checkbox"
                              checked={instSettings.enable_shaders}
                              onChange={(e) =>
                                void persistInstanceChanges(
                                  inst,
                                  { settings: { enable_shaders: e.target.checked } },
                                  "Graphics preference saved."
                                )
                              }
                              disabled={instanceSettingsBusy}
                            />
                            <span className="togglePill" />
                            <span>Enable shaders</span>
                          </label>
                          <label className="toggleRow">
                            <input
                              type="checkbox"
                              checked={instSettings.force_vsync}
                              onChange={(e) =>
                                void persistInstanceChanges(
                                  inst,
                                  { settings: { force_vsync: e.target.checked } },
                                  "Graphics preference saved."
                                )
                              }
                              disabled={instanceSettingsBusy}
                            />
                            <span className="togglePill" />
                            <span>Force vsync</span>
                          </label>
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">World safety backups</div>
                          <div className="settingSub">
                            Auto-back up worlds while Minecraft is running for this instance. Changes apply on next launch.
                          </div>
                          <MenuSelect
                            value={String(instSettings.world_backup_interval_minutes)}
                            labelPrefix="Interval"
                            onChange={(v) =>
                              void persistInstanceChanges(
                                inst,
                                { settings: { world_backup_interval_minutes: Number(v) } },
                                "World backup interval saved."
                              )
                            }
                            options={WORLD_BACKUP_INTERVAL_OPTIONS}
                          />
                          <div style={{ height: 8 }} />
                          <MenuSelect
                            value={String(instSettings.world_backup_retention_count)}
                            labelPrefix="Retention"
                            onChange={(v) =>
                              void persistInstanceChanges(
                                inst,
                                { settings: { world_backup_retention_count: Number(v) } },
                                "World backup retention saved."
                              )
                            }
                            options={WORLD_BACKUP_RETENTION_OPTIONS}
                          />
                          <div className="muted" style={{ marginTop: 8 }}>
                            Backups run every {instSettings.world_backup_interval_minutes} min and keep{" "}
                            {instSettings.world_backup_retention_count} per world.
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {instanceSettingsSection === "content" && (
                    <>
                      <div className="h2 sectionHead">
                        Launch hooks
                      </div>

                      <div className="settingGrid">
                        <div className="settingCard">
                          <div className="settingTitle">Game launch hooks</div>
                          <div className="settingSub">
                            Hooks run system commands before and after launching Minecraft for this instance.
                          </div>
                          <label className="toggleRow">
                            <input
                              type="checkbox"
                              checked={launchHooksDraft.enabled}
                              onChange={(e) => setLaunchHooksDraft({ enabled: e.target.checked })}
                            />
                            <span className="togglePill" />
                            <span>Custom launch hooks</span>
                          </label>
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Pre-launch</div>
                          <div className="settingSub">Runs before the instance is launched.</div>
                          <input
                            className="input"
                            value={launchHooksDraft.pre_launch}
                            onChange={(e) => setLaunchHooksDraft({ pre_launch: e.target.value })}
                            placeholder="Enter pre-launch command..."
                            disabled={!launchHooksDraft.enabled}
                          />
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Wrapper</div>
                          <div className="settingSub">Wrapper command used for launching Minecraft.</div>
                          <input
                            className="input"
                            value={launchHooksDraft.wrapper}
                            onChange={(e) => setLaunchHooksDraft({ wrapper: e.target.value })}
                            placeholder="Enter wrapper command..."
                            disabled={!launchHooksDraft.enabled}
                          />
                        </div>

                        <div className="settingCard">
                          <div className="settingTitle">Post-exit</div>
                          <div className="settingSub">Runs after the game closes.</div>
                          <input
                            className="input"
                            value={launchHooksDraft.post_exit}
                            onChange={(e) => setLaunchHooksDraft({ post_exit: e.target.value })}
                            placeholder="Enter post-exit command..."
                            disabled={!launchHooksDraft.enabled}
                          />
                        </div>
                      </div>
                    </>
                  )}
                  </div>
                </div>
              </div>
            </Modal>
          )}
        </div>
      );
    }

    if (route === "skins") {
      return (
        <div className="page">
          <div style={{ maxWidth: 1360 }}>
            <div className="h1">Skins</div>
            <div className="p">Manage skins and capes with live 3D preview.</div>

            <div className="accountSkinsStudio accountSkinsStudioLibrary skinsRouteLayoutRef card">
              <div className="accountSkinViewerPane">
                <div className="accountSkinTitleRow">
                  <div className="accountSkinHeading">Skins</div>
                  <span className="accountSkinBeta">Beta</span>
                </div>
                <div className="accountSkinSub">Interactive 3D preview. Drag to rotate your player.</div>
                <div
                  ref={accountSkinViewerStageRef}
                  className="accountSkinViewerStage"
                  style={skinViewerShadowStyle}
                >
                  <canvas ref={accountSkinViewerCanvasRef} className="accountSkinViewerCanvas" />
                  <div className="accountSkinViewerShadow" />
                </div>
                {skinViewerErr ? <div className="errorBox">{skinViewerErr}</div> : null}
                <div className="accountSkinViewerHint">{skinViewerHintText}</div>
                {!skinPreviewEnabled ? (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn" onClick={() => setSkinPreviewEnabled(true)}>
                      Enable 3D preview
                    </button>
                  </div>
                ) : null}
                <div className="accountSkinViewerActions">
                  <button className="btn" onClick={onCycleAccountCape} disabled={capeOptions.length <= 1}>
                    Change cape
                  </button>
                  {selectedAccountSkin?.origin === "custom" ? (
                    <button className="btn danger" onClick={onRemoveSelectedCustomSkin}>
                      Remove skin
                    </button>
                  ) : null}
                </div>
                <div className="accountSkinLightingControl">
                  <div className="accountSkinLightingMeta">
                    <span>{previewTimeLabel}</span>
                    <span>{previewTimeText}</span>
                  </div>
                  <input
                    className="accountSkinLightingSlider"
                    type="range"
                    min={0}
                    max={24}
                    step={0.1}
                    value={normalizedPreviewTimeOfDay}
                    onChange={(event) => setPreviewTimeOfDay(Number(event.target.value))}
                  />
                </div>
                <div className="accountSkinViewerHint">
                  Cape: {selectedAccountCape?.label ?? "No cape"}
                </div>
              </div>

              <div className="accountSkinLibraryPane skinsLibraryPane skinsLibraryRef">
                <div className="skinsRefHeadRow">
                  <div className="skinsRefSectionTitle">Saved skins</div>
                  <div className="skinsLibraryStats">
                    <span className="chip subtle">{savedSkinOptions.length} saved</span>
                    <span className="chip subtle">{defaultSkinOptions.length} default</span>
                  </div>
                </div>

                <div className="skinsLibrarySelection skinsLibrarySelectionRef">
                  <span className="chip">Selected</span>
                  <strong>{selectedAccountSkin?.label ?? "None"}</strong>
                  <span className="skinsLibrarySelectionMeta">
                    {selectedAccountSkin?.origin === "custom"
                      ? "Custom"
                      : selectedAccountSkin?.origin === "profile"
                        ? "Profile"
                        : "Default"}
                  </span>
                </div>

                <div className="accountSkinCardGrid accountSkinCardGridSaved skinsRefSavedGrid">
                  <button className="accountSkinAddCard accountSkinAddCardRef" onClick={onAddCustomSkin}>
                    <span className="accountSkinAddPlus">+</span>
                    <span>Add a skin</span>
                  </button>
                  {savedSkinOptions.map((skin) => {
                    const active = selectedAccountSkin?.id === skin.id;
                    const thumbSet = accountSkinThumbs[skin.id];
                    const frontThumb =
                      thumbSet?.front ??
                      toLocalIconSrc(skin.preview_url) ??
                      toLocalIconSrc(skin.skin_url) ??
                      "";
                    const backThumb = thumbSet?.back ?? frontThumb;
                    return (
                      <button
                        key={skin.id}
                        className={`accountSkinChoiceCard skinChoiceSaved skinChoiceSavedRef ${active ? "active" : ""}`}
                        onClick={() => setSelectedAccountSkinId(skin.id)}
                      >
                        <div className="accountSkinChoiceThumb">
                          <div className="accountSkinChoiceThumbInner">
                            <div className="accountSkinChoiceFace accountSkinChoiceFaceFront">
                              {frontThumb ? (
                                <img src={frontThumb} alt={`${skin.label} front preview`} />
                              ) : (
                                <span>{skin.label.slice(0, 1).toUpperCase()}</span>
                              )}
                            </div>
                            <div className="accountSkinChoiceFace accountSkinChoiceFaceBack">
                              {backThumb ? (
                                <img src={backThumb} alt={`${skin.label} back preview`} />
                              ) : (
                                <span>{skin.label.slice(0, 1).toUpperCase()}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="accountSkinChoiceLabel">{skin.label}</div>
                        <div className="accountSkinChoiceMeta">
                          {skin.origin === "custom" ? "Custom" : "Profile"}
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="skinsRefSectionTitle skinsRefDefaultTitle">Default skins</div>
                <div className="accountSkinCardGrid accountSkinCardGridDefault skinsRefDefaultGrid">
                  {defaultSkinOptions.map((skin) => {
                    const active = selectedAccountSkin?.id === skin.id;
                    const thumbSet = accountSkinThumbs[skin.id];
                    const frontThumb =
                      thumbSet?.front ??
                      toLocalIconSrc(skin.preview_url) ??
                      toLocalIconSrc(skin.skin_url) ??
                      "";
                    const backThumb = thumbSet?.back ?? frontThumb;
                    return (
                      <button
                        key={skin.id}
                        className={`accountSkinChoiceCard skinChoiceCompact skinChoiceCompactRef ${active ? "active" : ""}`}
                        onClick={() => setSelectedAccountSkinId(skin.id)}
                      >
                        <div className="accountSkinChoiceThumb">
                          <div className="accountSkinChoiceThumbInner">
                            <div className="accountSkinChoiceFace accountSkinChoiceFaceFront">
                              {frontThumb ? (
                                <img src={frontThumb} alt={`${skin.label} front preview`} />
                              ) : (
                                <span>{skin.label.slice(0, 1).toUpperCase()}</span>
                              )}
                            </div>
                            <div className="accountSkinChoiceFace accountSkinChoiceFaceBack">
                              {backThumb ? (
                                <img src={backThumb} alt={`${skin.label} back preview`} />
                              ) : (
                                <span>{skin.label.slice(0, 1).toUpperCase()}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="accountSkinChoiceLabel">{skin.label}</div>
                        <div className="accountSkinChoiceMeta">Default</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Library (dashboard layout + custom context menu)
    const loaderLabelFor = (inst: Instance) =>
      inst.loader === "neoforge"
        ? "NeoForge"
        : inst.loader === "fabric"
          ? "Fabric"
          : inst.loader === "forge"
            ? "Forge"
            : inst.loader === "quilt"
              ? "Quilt"
              : "Vanilla";

    const visibleInstances =
      libraryScope === "downloaded"
        ? []
        : instances.filter((x) => x.name.toLowerCase().includes(libraryQuery.toLowerCase()));

    const filtered = [...visibleInstances].sort((a, b) => {
      if (librarySort === "name") {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
      }
      const bTs = parseDateLike(b.created_at)?.getTime() ?? 0;
      const aTs = parseDateLike(a.created_at)?.getTime() ?? 0;
      return bTs - aTs;
    });

    const grouped = (() => {
      if (libraryGroupBy === "none") {
        return [{ key: "all", label: "All instances", items: filtered }];
      }
      const map = new Map<string, Instance[]>();
      for (const inst of filtered) {
        const key = libraryGroupBy === "loader" ? loaderLabelFor(inst) : inst.mc_version;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(inst);
      }
      return Array.from(map.entries()).map(([key, items]) => ({
        key,
        label: key,
        items,
      }));
    })();

    const runningIds = new Set(runningInstances.map((run) => run.instance_id));

    return (
      <div className="page">
        <div className="libraryLayout">
          <section className="libraryMainPane">
            <div className="libraryHeader">
              <div>
                <div className="h1">Library</div>
                <div className="muted">All your instances - open one to manage content and settings.</div>
              </div>

              <button className="btn primary" onClick={() => setShowCreate(true)}>
                <span className="btnIcon">
                  <Icon name="plus" size={18} className="navIcon plusIcon navAnimPlus" />
                </span>
                Create new instance
              </button>
            </div>

            <>
                {!selectedLauncherAccount ? (
                  <div className="libraryStatusBanner card">
                    <div className="libraryStatusTitle">Sign in to Microsoft</div>
                    <div className="libraryStatusText">
                      Connect your Minecraft account to launch with the native launcher.
                    </div>
                    <button className="btn" onClick={onBeginMicrosoftLogin} disabled={launcherBusy}>
                      {msLoginSessionId ? "Waiting for login..." : "Connect account"}
                    </button>
                  </div>
                ) : null}

                <div className="libraryTopRow">
                  <div className="libraryPrimaryControls">
                    <SegmentedControl
                      value={libraryScope}
                      onChange={(v) => setLibraryScope(v as any)}
                      options={[
                        { label: "All instances", value: "all" },
                        { label: "Downloaded", value: "downloaded" },
                        { label: "Custom", value: "custom" },
                      ]}
                    />

                    <div className="librarySearch">
                      <Icon name="search" size={18} />
                      <input
                        className="input"
                        placeholder="Search instances..."
                        value={libraryQuery}
                        onChange={(e) => setLibraryQuery(e.target.value)}
                      />
                      {libraryQuery && (
                        <button className="iconBtn" onClick={() => setLibraryQuery("")} aria-label="Clear">
                          <Icon name="x" size={18} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="libraryRight">
                    <MenuSelect
                      value={librarySort}
                      labelPrefix="Sort"
                      onChange={(v) => setLibrarySort(v as "recent" | "name")}
                      options={[
                        { value: "recent", label: "Recently created" },
                        { value: "name", label: "Name" },
                      ]}
                      align="start"
                    />
                    <MenuSelect
                      value={libraryGroupBy}
                      labelPrefix="Group"
                      onChange={(v) => setLibraryGroupBy(v as LibraryGroupBy)}
                      options={[
                        { value: "none", label: "None" },
                        { value: "loader", label: "Loader" },
                        { value: "version", label: "Game version" },
                      ]}
                      align="start"
                    />
                  </div>
                </div>

                {libraryScope === "downloaded" ? (
              <div className="card" style={{ marginTop: 12 }}>
                <div className="emptyState">
                  <div className="emptyTitle">No downloaded instances yet</div>
                  <div className="emptySub">
                    Later, installed Modrinth modpacks will appear here. For now, create a custom
                    instance.
                  </div>
                </div>
              </div>
                ) : filtered.length === 0 ? (
              <div className="card" style={{ marginTop: 12 }}>
                <div className="emptyState">
                  <div className="emptyTitle">No instances found</div>
                  <div className="emptySub">
                    Create an instance to start managing mods and versions.
                  </div>
                  <div style={{ marginTop: 12 }}>
                    <button className="btn primary" onClick={() => setShowCreate(true)}>
                      <span className="btnIcon">
                        <Icon name="plus" size={18} className="navIcon plusIcon navAnimPlus" />
                      </span>
                      Create new instance
                    </button>
                  </div>
                </div>
              </div>
                ) : (
              <div className="libraryGroupList">
                {grouped.map((group) => (
                  <section key={group.key} className="libraryGroupSection">
                    {libraryGroupBy !== "none" ? (
                      <div className="libraryGroupHeader">
                        <div>{group.label}</div>
                        <div className="chip subtle">{group.items.length}</div>
                      </div>
                    ) : null}
                    <div className="libraryGrid">
                      {group.items.map((inst) => {
                        const active = inst.id === selectedId;
                        const loaderLabel = loaderLabelFor(inst);
                        const isRunning = runningIds.has(inst.id);
                        const runningLaunch = runningInstances.find((run) => run.instance_id === inst.id) ?? null;
                        const launchStage = launchStageByInstance[inst.id] ?? null;
                        const launchStageLabel = launchStage?.label?.trim() || launchStageBadgeLabel(
                          launchStage?.status,
                          launchStage?.message
                        );
                        return (
                          <article
                            key={inst.id}
                            className={`instCard ${active ? "active" : ""} ${isRunning ? "running" : ""}`}
                            onClick={() => openInstance(inst.id)}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setLibraryContextMenu({
                                instanceId: inst.id,
                                x: event.clientX,
                                y: event.clientY,
                              });
                            }}
                          >
                            <div className="instCardHead">
                              <div className="instCardIcon">
                                {inst.icon_path ? (
                                  <LocalImage path={inst.icon_path} alt="" fallback={<Icon name="box" size={19} />} />
                                ) : (
                                  <Icon name="box" size={19} />
                                )}
                              </div>
                              <div className="instCardHeadText">
                                <div className="instCardTitle">{inst.name}</div>
                                <div className="instCardSub">
                                  {loaderLabel} · Minecraft {inst.mc_version}
                                </div>
                              </div>
                              {isRunning ? <span className="chip">Running</span> : null}
                              {!isRunning && launchStageLabel ? (
                                <span className="chip">{launchStage?.status === "starting" ? `Launching: ${launchStageLabel}` : launchStageLabel}</span>
                              ) : null}
                            </div>

                            <div className="instCardMeta">
                              <span className="chip">{loaderLabel}</span>
                              <span className="chip">{inst.mc_version}</span>
                              <span className="chip subtle">Custom</span>
                            </div>

                            <div className="instCardActions" onClick={(event) => event.stopPropagation()}>
                              {runningLaunch ? (
                                <button className="btn" onClick={() => onStopRunning(runningLaunch.launch_id)}>
                                  Stop
                                </button>
                              ) : (
                                <button
                                  className={`btn ${launchBusyInstanceId === inst.id ? "danger" : "primary"}`}
                                  onClick={() => onPlayInstance(inst)}
                                  disabled={
                                    (Boolean(launchBusyInstanceId) && launchBusyInstanceId !== inst.id) ||
                                    launchCancelBusyInstanceId === inst.id
                                  }
                                >
                                  <Icon name={launchBusyInstanceId === inst.id ? "x" : "play"} size={16} />
                                  {launchBusyInstanceId === inst.id
                                    ? (launchCancelBusyInstanceId === inst.id ? "Cancelling…" : "Cancel launch")
                                    : "Play"}
                                </button>
                              )}
                              <button className="btn" onClick={() => openInstance(inst.id)}>
                                View instance
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
                )}
              </>
          </section>

          <aside className="librarySidePane">
            <div className="card librarySideCard">
              <div className="librarySideTitle">Instances running</div>
              <div className="libraryRunCount">{runningInstances.length}</div>
              {runningInstances.length === 0 ? (
                <div className="muted">No instances running right now.</div>
              ) : (
                <div className="libraryRunList">
                  {runningInstances.slice(0, 5).map((run) => (
                    <div key={run.launch_id} className="libraryRunRow">
                      <span>{run.instance_name}</span>
                      <span className="chip subtle">{run.method}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card librarySideCard">
              <div className="librarySideTitle">Playing as</div>
              {selectedLauncherAccount ? (
                <>
                  <div className="libraryAccountName">{selectedLauncherAccount.username}</div>
                  <div className="muted">{selectedLauncherAccount.id}</div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn" onClick={() => setRoute("account")}>
                      Account page
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="muted">No Minecraft account connected.</div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn" onClick={onBeginMicrosoftLogin} disabled={launcherBusy}>
                      {msLoginSessionId ? "Waiting..." : "Sign in"}
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="card librarySideCard">
              <div className="librarySideTitle">Quick actions</div>
              <div className="libraryQuickActions">
                <button className="btn" onClick={() => setRoute("discover")}>Discover mods</button>
                <button className="btn" onClick={() => setShowCreate(true)}>Create instance</button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="appWrap">
      <aside className="navRail">
        <NavButton active={route === "discover"} label="Discover content" onClick={() => setRoute("discover")}>
          <Icon name="compass" className="navIcon compassIcon navAnimCompass" />
        </NavButton>

        <NavButton className="boxPulse" active={route === "modpacks"} label="Creator Studio" onClick={() => setRoute("modpacks")}>
          <Icon name="box" className="navIcon navAnimBox" />
        </NavButton>

        <NavButton
          className="booksTilt"
          active={route === "library"}
          label="Library"
          onClick={() => setRoute("library")}
        >
          <Icon name="books" className="navIcon navAnimBooks" />
        </NavButton>

        <NavButton
          active={route === "updates"}
          label="Updates available"
          onClick={() => setRoute("updates")}
          badge={scheduledUpdatesAvailableTotal}
        >
          <Icon name="bell" className="navIcon" />
        </NavButton>

        <NavButton
          active={route === "skins"}
          label="Skins"
          onClick={() => setRoute("skins")}
        >
          <Icon name="skin" className="navIcon" />
        </NavButton>

        <div className="navDivider" />

	        {instances.length > 0 && (
	          <div className="navInstances">
	            {instances.slice(0, 6).map((inst) => (
	              <NavButton
	                key={inst.id}
	                variant="accent"
	                active={route === "instance" && selectedId === inst.id}
	                label={inst.name}
	                onClick={() => openInstance(inst.id)}
	              >
		                <div className="instAvatar" aria-hidden="true">
		                  {inst.icon_path ? (
                        <LocalImage
                          path={inst.icon_path}
                          alt=""
                          fallback={inst.name.trim() ? inst.name.trim().slice(0, 1).toUpperCase() : "?"}
                        />
                      ) : (
		                    inst.name.trim() ? inst.name.trim().slice(0, 1).toUpperCase() : "?"
                      )}
		                </div>
	              </NavButton>
	            ))}
	          </div>
	        )}

	        {instances.length > 0 && <div className="navDivider" />}

        <NavButton
          className="plusJump"
          active={false}
          label="Create new instance"
          onClick={() => setShowCreate(true)}
        >
          <Icon name="plus" className="navIcon plusIcon navAnimPlus" />
        </NavButton>

        <div className="navBottom">
          <NavButton className="profileBounce" active={route === "account"} label="Account" onClick={() => setRoute("account")}>
            <Icon name="user" className="navIcon navAnimUser" />
          </NavButton>
          <NavButton className="settingsSpin" active={route === "settings"} label="Settings" onClick={() => setRoute("settings")}>
            <Icon name="gear" className="navIcon navAnimGear" />
          </NavButton>
        </div>
      </aside>

      <main className="content">
        {error ? <div className="errorBox" style={{ marginTop: 0, marginBottom: 12 }}>{error}</div> : null}
        {renderContent()}
      </main>

      {libraryContextMenu && libraryContextMenuStyle && libraryContextTarget
        ? createPortal(
            <div
              ref={libraryContextMenuRef}
              className="libraryContextMenu"
              style={libraryContextMenuStyle}
            >
              <button
                className="libraryContextItem"
                disabled={
                  (Boolean(launchBusyInstanceId) && launchBusyInstanceId !== libraryContextTarget.id) ||
                  launchCancelBusyInstanceId === libraryContextTarget.id
                }
                onClick={() => {
                  setLibraryContextMenu(null);
                  void onPlayInstance(libraryContextTarget);
                }}
              >
                <Icon name={launchBusyInstanceId === libraryContextTarget.id ? "x" : "play"} size={16} />
                {launchBusyInstanceId === libraryContextTarget.id ? "Cancel launch" : "Play"}
              </button>
              <button
                className="libraryContextItem"
                onClick={() => {
                  setLibraryContextMenu(null);
                  setRoute("discover");
                  setInstallNotice(
                    `Open a mod and choose "${libraryContextTarget.name}" in Install to instance.`
                  );
                }}
              >
                <Icon name="download" size={16} />
                Add content
              </button>
              <div className="libraryContextDivider" />
              <button
                className="libraryContextItem"
                onClick={() => {
                  setLibraryContextMenu(null);
                  openInstance(libraryContextTarget.id);
                }}
              >
                <Icon name="books" size={16} />
                View instance
              </button>
              <button
                className="libraryContextItem"
                onClick={() => {
                  setLibraryContextMenu(null);
                  void onOpenInstancePath(libraryContextTarget, "instance");
                }}
              >
                <Icon name="folder" size={16} />
                Open folder
              </button>
              <button
                className="libraryContextItem"
                onClick={() => {
                  setLibraryContextMenu(null);
                  void onOpenInstancePath(libraryContextTarget, "mods");
                }}
              >
                <Icon name="folder" size={16} />
                Open mods folder
              </button>
              <button
                className="libraryContextItem"
                onClick={() => {
                  setLibraryContextMenu(null);
                  void onExportModsZip(libraryContextTarget);
                }}
              >
                <Icon name="upload" size={16} />
                Export mods zip
              </button>
              <div className="libraryContextDivider" />
              <button
                className="libraryContextItem danger"
                onClick={() => {
                  setLibraryContextMenu(null);
                  requestDelete(libraryContextTarget);
                }}
              >
                <Icon name="trash" size={16} />
                Delete
              </button>
            </div>,
            document.body
          )
        : null}

      {showCreate ? (
        <Modal
          title="Creating an instance"
          className="createInstanceModal"
          onClose={() => (busy ? null : setShowCreate(false))}
        >
          <div className="modalBody createInstanceModalBody">
            <SegTabs
              tabs={[
                { id: "custom", label: "Custom" },
                { id: "file", label: "From File" },
                { id: "launcher", label: "Import From Launcher" },
              ]}
              active={createMode}
              onChange={(id) => setCreateMode(id as any)}
            />

            <div style={{ height: 18 }} />

            <div className="split">
              <div className="iconBox" title={createIconPath ?? "No icon selected"}>
                {createIconPath ? (
                  <LocalImage
                    path={createIconPath}
                    alt="Instance icon preview"
                    fallback={<div style={{ fontSize: 54, fontWeight: 900, opacity: 0.6 }}>⬚</div>}
                  />
                ) : (
                  <div style={{ fontSize: 54, fontWeight: 900, opacity: 0.6 }}>⬚</div>
                )}
              </div>

              <div>
                <div className="toolbarRow">
                  <button className="btn" onClick={() => void onPickCreateIcon()} disabled={busy !== null}>
                    <span className="btnIcon">
                      <Icon name="upload" size={17} />
                    </span>
                    Select icon
                  </button>
                  <button className="btn" onClick={() => setCreateIconPath(null)} disabled={busy !== null || !createIconPath}>
                    <span className="btnIcon">
                      <Icon name="x" size={17} />
                    </span>
                    Remove icon
                  </button>
                </div>

                {createMode === "custom" ? (
                  <>
                    <div className="sectionLabel sectionLabelTight">
                      Name
                    </div>
                    <input
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Horror Pack"
                    />

                    <div className="sectionLabel">Loader</div>
                    <div className="pillRow">
                      {(["vanilla", "fabric", "forge", "neoforge", "quilt"] as Loader[]).map((value) => (
                        <div
                          key={value}
                          className={`pill ${loader === value ? "active" : ""}`}
                          onClick={() => setLoader(value)}
                        >
                          {loader === value ? "✓ " : ""}
                          {value === "vanilla"
                            ? "Vanilla"
                            : value === "neoforge"
                              ? "NeoForge"
                              : value[0].toUpperCase() + value.slice(1)}
                        </div>
                      ))}
                    </div>

                    <div className="sectionLabel">Game version</div>
                    <div className="rowBetween createVersionRow">
                      <div style={{ flex: 1 }}>
                        <Dropdown
                          value={mcVersion}
                          placeholder="Select game version"
                          groups={groupedCreateVersions}
                          onPick={setMcVersion}
                          placement="top"
                        />
                        {manifestError ? (
                          <div style={{ marginTop: 8, color: "var(--muted2)", fontWeight: 900, fontSize: 12 }}>
                            Couldn’t fetch official list (using fallback).
                          </div>
                        ) : null}
                      </div>

                      <div
                        className="checkboxRow"
                        onClick={() => setCreateAllVersions((v) => !v)}
                        title="Includes snapshots / pre-releases / RCs"
                      >
                        <div className={`checkbox ${createAllVersions ? "checked" : ""}`}>
                          <div />
                        </div>
                        <div>Show all versions</div>
                      </div>
                    </div>
                  </>
                ) : null}

                {createMode === "file" ? (
                  <>
                    <div className="sectionLabel sectionLabelTight">Modpack archive</div>
                    <div className="toolbarRow">
                      <button className="btn" onClick={() => void onPickCreateModpackFile()} disabled={busy !== null}>
                        <span className="btnIcon">
                          <Icon name="upload" size={17} />
                        </span>
                        Select .mrpack/.zip
                      </button>
                      <button className="btn" onClick={() => setCreatePackFilePath(null)} disabled={busy !== null || !createPackFilePath}>
                        <span className="btnIcon">
                          <Icon name="x" size={17} />
                        </span>
                        Clear
                      </button>
                    </div>
                    <input
                      className="input"
                      value={createPackFilePath ?? ""}
                      onChange={(e) => setCreatePackFilePath(e.target.value)}
                      placeholder="/path/to/modpack.mrpack"
                    />
                    <div className="sectionLabel">Instance name (optional)</div>
                    <input
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Defaults to pack name"
                    />
                  </>
                ) : null}

                {createMode === "launcher" ? (
                  <>
                    <div className="sectionLabel sectionLabelTight">Launcher source</div>
                    <div className="toolbarRow">
                      <button className="btn" onClick={() => void refreshLauncherImportSources()} disabled={launcherImportBusy || busy !== null}>
                        {launcherImportBusy ? "Refreshing…" : "Refresh sources"}
                      </button>
                    </div>
                    <MenuSelect
                      value={selectedLauncherImportSourceId ?? ""}
                      labelPrefix="Source"
                      onChange={(v) => setSelectedLauncherImportSourceId(v)}
                      options={launcherImportSources.map((item) => ({
                        value: item.id,
                        label: `${item.label} · ${item.loader} · ${item.mc_version}`,
                      }))}
                      placement="top"
                    />
                    <div className="sectionLabel">Instance name (optional)</div>
                    <input
                      className="input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Defaults to source name"
                    />
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="footerBar">
            <button className="btn" onClick={() => setShowCreate(false)} disabled={busy !== null}>
              ✕ Cancel
            </button>
            <button
              className="btn primary"
              onClick={onCreate}
              disabled={
                busy !== null ||
                (createMode === "custom" && (!name.trim() || !mcVersion)) ||
                (createMode === "file" && !createPackFilePath) ||
                (createMode === "launcher" && !selectedLauncherImportSourceId)
              }
            >
              + {busy === "create" ? "Creating…" : "Create"}
            </button>
          </div>
        </Modal>
      ) : null}

      {installTarget ? (
        <Modal title="Install to instance" size="wide" onClose={() => setInstallTarget(null)}>
          <div className="modalBody">
            <div className="installModHeader">
              <div className="resultIcon" style={{ width: 56, height: 56, borderRadius: 16 }}>
                {installTarget.iconUrl ? <img src={installTarget.iconUrl} alt="" /> : <div>⬚</div>}
              </div>
              <div>
                <div className="h3" style={{ margin: 0 }}>{installTarget.title}</div>
                <div className="p" style={{ marginTop: 4 }}>
                  Source: {installTarget.source}. Type: {installTarget.contentType}.
                  {installTarget.contentType === "mods"
                    ? " The app will pick the latest compatible version (loader + game version). Modrinth installs include required dependency resolution."
                    : installTarget.contentType === "datapacks"
                      ? " Datapacks install into world datapacks folders. Direct install targets all detected worlds on that instance."
                      : " The app will install the latest compatible file and track it in lockfile."}
                </div>
              </div>
            </div>

            {installProgress && installProgress.project_id === installTarget.projectId ? (
              <div className="card installProgressCard">
                <div className="installProgressTitle">
                  {installProgress.message ?? "Working…"}
                </div>
                <div className="installProgressBar">
                  <div
                    className={`installProgressFill ${installProgress.stage}`}
                    style={{ width: `${installProgress.percent ?? 0}%` }}
                  />
                </div>
                <div className="installProgressMeta">
                  <span>{formatPercent(installProgress.percent)}</span>
                  <span>{installProgress.stage}</span>
                </div>
              </div>
            ) : null}

            <div style={{ marginTop: 12 }}>
              <div className="searchPill" style={{ width: "100%" }}>
                <Icon name="search" />
                <input
                  className="input"
                  placeholder="Search instances…"
                  value={installInstanceQuery}
                  onChange={(e) => setInstallInstanceQuery(e.target.value)}
                />
              </div>
            </div>

            <div className="installList">
              {instances
                .filter((i) => {
                  const q = installInstanceQuery.trim().toLowerCase();
                  if (!q) return true;
                  return i.name.toLowerCase().includes(q);
                })
                .map((inst) => {
                  const preview = installPlanPreview[inst.id];
                  const previewBusy = installPlanPreviewBusy[inst.id];
                  const previewErr = installPlanPreviewErr[inst.id];
                  return (
                    <div key={inst.id} className="installRow">
                      <div className="installRowLeft">
                        <div className="installInstanceIcon">
                          <Icon name="box" />
                        </div>
                        <div>
                          <div className="installRowName">{inst.name}</div>
                          <div className="installRowMeta">
                            <span className="chip">{inst.loader}</span>
                            <span className="chip">{inst.mc_version}</span>
                          </div>
                          <div className={`installRowPreview ${previewErr ? "error" : ""}`}>
                            {installTarget.contentType !== "mods"
                              ? installTarget.contentType === "datapacks"
                                ? "Datapack will be copied to all detected worlds for this instance."
                                : `Will install 1 ${installTarget.contentType === "shaderpacks" ? "shaderpack" : installTarget.contentType === "resourcepacks" ? "resourcepack" : "item"}.`
                              : previewBusy
                              ? "Checking required dependencies…"
                              : previewErr
                                ? "Dependency preview unavailable."
                                : preview
                                  ? `Will install: ${preview.will_install_mods} mod${preview.will_install_mods === 1 ? "" : "s"}${preview.dependency_mods > 0 ? ` (${preview.dependency_mods} required dependenc${preview.dependency_mods === 1 ? "y" : "ies"})` : ""}`
                                  : "Checking required dependencies…"}
                          </div>
                        </div>
                      </div>

                      <button
                        className="btn primary installAction"
                        onClick={() => onInstallToInstance(inst)}
                        disabled={installingKey !== null && installingKey !== `${inst.id}:${installTarget.source}:${installTarget.contentType}:${installTarget.projectId}`}
                      >
                        <Icon name="download" />
                        {installingKey === `${inst.id}:${installTarget.source}:${installTarget.contentType}:${installTarget.projectId}`
                          ? `Installing ${formatPercent(installProgress?.percent) || ""}`.trim()
                          : "Install"}
                      </button>
                    </div>
                  );
                })}

              {instances.length === 0 ? (
                <div className="emptyState" style={{ marginTop: 8 }}>
                  No instances yet — create one first.
                </div>
              ) : null}
            </div>
          </div>

          <div className="footerBar">
            <button className="btn" onClick={() => setInstallTarget(null)}>
              Close
            </button>
            <button
              className="btn"
              onClick={() => {
                setInstallTarget(null);
                setShowCreate(true);
              }}
            >
              + Create new instance
            </button>
          </div>
        </Modal>
      ) : null}

      {projectOpen || projectBusy || projectErr ? (
        <Modal title={projectOpen?.title ?? (projectBusy ? "Loading…" : "Mod details")} onClose={closeProjectOverlays}>
          <div className="modalBody">
            {projectErr ? <div className="errorBox">{projectErr}</div> : null}
            {projectBusy && !projectOpen ? (
              <div className="card" style={{ padding: 16, borderRadius: 22 }}>
                Loading…
              </div>
            ) : null}

            {projectOpen ? (
              <div className="projectDetailWrap">
                <div className="card projectHeroCard">
                  <div className="projectHeroAura" />

                  <div className="projectHero">
                    <div className="resultIcon projectIcon projectIconLarge">
                      {projectOpen.icon_url ? <img src={projectOpen.icon_url} alt="" /> : <div>⬚</div>}
                    </div>

                    <div className="projectHeroMain">
                      <div className="projectEyebrow">
                        Modrinth • {projectOpen.slug || projectOpen.id}
                      </div>
                      <div className="projectHeroTitleRow">
                        <div className="projectHeroTitle">{projectOpen.title}</div>
                        <div className="chip">Updated {formatDate(latestProjectVersion?.date_published)}</div>
                      </div>
                      <div className="p projectHeroDesc">{projectOpen.description}</div>

                      <div className="projectChipRow">
                        <span className="chip">Client: {humanizeToken(projectOpen.client_side)}</span>
                        <span className="chip">Server: {humanizeToken(projectOpen.server_side)}</span>
                        {projectOpen.categories?.slice(0, 8).map((c) => (
                          <span key={c} className="chip">
                            {humanizeToken(c)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="projectStatsGrid">
                    <div className="projectStatCard">
                      <div className="projectStatLabel">Downloads</div>
                      <div className="projectStatValue">{formatCompact(projectOpen.downloads)}</div>
                    </div>
                    <div className="projectStatCard">
                      <div className="projectStatLabel">Likes</div>
                      <div className="projectStatValue">{formatCompact(projectOpen.followers)}</div>
                    </div>
                    <div className="projectStatCard">
                      <div className="projectStatLabel">Versions</div>
                      <div className="projectStatValue">{sortedProjectVersions.length || projectOpen.versions.length}</div>
                    </div>
                    <div className="projectStatCard">
                      <div className="projectStatLabel">Team members</div>
                      <div className="projectStatValue">{projectMembers.length || "—"}</div>
                    </div>
                  </div>

                  <div className="projectActionRow">
                    {projectPageUrl ? (
                      <a className="btn projectActionBtn" href={projectPageUrl} target="_blank" rel="noreferrer">
                        Open on Modrinth
                      </a>
                    ) : null}
                    {projectPageUrl ? (
                      <button className="btn projectActionBtn" onClick={() => copyProjectText("Link", projectPageUrl)}>
                        Copy link
                      </button>
                    ) : null}
                    <button className="btn projectActionBtn" onClick={() => copyProjectText("Project ID", projectOpen.id)}>
                      Copy project ID
                    </button>
                    {latestPrimaryFile ? (
                      <button
                        className="btn projectActionBtn"
                        onClick={() => copyProjectText("Primary file", latestPrimaryFile.filename)}
                      >
                        Copy primary file
                      </button>
                    ) : null}
                  </div>

                  {projectCopyNotice ? <div className="projectCopyNotice">{projectCopyNotice}</div> : null}
                </div>

                <div className="projectTabSticky">
                  <SegmentedControl
                    value={projectDetailTab}
                    options={PROJECT_DETAIL_TABS}
                    onChange={(v) => setProjectDetailTab((v ?? "overview") as ProjectDetailTab)}
                    variant="scroll"
                    className="projectTabBar"
                  />
                </div>

                {projectDetailTab === "overview" ? (
                  <>
                    <div className="projectOverviewCols">
                      <div className="projectOverviewCol">
                        <div className="card projectSectionCard projectSectionLatest">
                          <div className="projectSectionTitle">Latest release</div>
                          {latestProjectVersion ? (
                            <div className="projectLatestCard">
                              <div className="projectVersionTitle">{latestProjectVersion.version_number}</div>
                              <div className="projectVersionMeta">
                                <span>{formatDate(latestProjectVersion.date_published)}</span>
                                <span>↓ {formatCompact(latestProjectVersion.downloads ?? 0)}</span>
                                <span>{latestProjectVersion.files.length} files</span>
                              </div>
                              {latestPrimaryFile ? (
                                <div className="projectLatestFile">
                                  {latestPrimaryFile.filename} • {formatFileSize(latestPrimaryFile.size)}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="muted">No release data available.</div>
                          )}
                        </div>

                        <div className="card projectSectionCard projectSectionDesc">
                          <div className="projectSectionTitle">Description</div>
                          <pre className="projectBodyText">
                            {toReadableBody(projectOpen.body) || projectOpen.description}
                          </pre>
                        </div>

                        <div className="card projectSectionCard projectSectionLinks">
                          <div className="projectSectionTitle">Links</div>
                          <div className="projectLinks">
                            {[
                              { label: "Website", href: projectOpen.link_urls?.homepage },
                              { label: "Source", href: projectOpen.source_url },
                              { label: "Issues", href: projectOpen.issues_url },
                              { label: "Wiki", href: projectOpen.wiki_url ?? undefined },
                              { label: "Discord", href: projectOpen.discord_url ?? undefined },
                            ]
                              .filter((x) => !!x.href)
                              .map((x) => (
                                <a
                                  key={x.label}
                                  className="projectLinkBtn"
                                  href={x.href}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {x.label}
                                </a>
                              ))}
                            {!projectOpen.link_urls?.homepage &&
                            !projectOpen.source_url &&
                            !projectOpen.issues_url &&
                            !projectOpen.wiki_url &&
                            !projectOpen.discord_url ? (
                              <div className="muted">No external links provided.</div>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <div className="projectOverviewCol">
                        <div className="card projectSectionCard projectSectionCompat">
                          <div className="projectSectionTitle">Compatibility</div>
                          <div className="projectFacetGroup">
                            <div className="projectFacetLabel">Loaders</div>
                            <div className="projectFacetWrap">
                              {projectLoaderFacets.length ? (
                                projectLoaderFacets.map((loaderName) => (
                                  <span key={loaderName} className="chip">
                                    {humanizeToken(loaderName)}
                                  </span>
                                ))
                              ) : (
                                <span className="muted">No loader data.</span>
                              )}
                            </div>
                          </div>
                          <div className="projectFacetGroup">
                            <div className="projectFacetLabel">Game versions</div>
                            <div className="projectFacetWrap">
                              {projectGameVersionFacets.length ? (
                                projectGameVersionFacets.map((gameVersion) => (
                                  <span key={gameVersion} className="chip">
                                    {gameVersion}
                                  </span>
                                ))
                              ) : (
                                <span className="muted">No game version data.</span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="card projectSectionCard projectSectionTeam">
                          <div className="projectSectionTitle">Team</div>
                          {projectMembers.length === 0 ? (
                            <div className="muted">No member data returned.</div>
                          ) : (
                            <div className="projectMemberList">
                              {projectMembers.slice(0, 10).map((m) => {
                                const displayName = m.user.name || m.user.username;
                                return (
                                  <div key={`${m.role}:${m.user.username}`} className="projectMemberRow">
                                    <div className="projectMemberIdentity">
                                      <div className="projectMemberAvatar">
                                        {m.user.avatar_url ? (
                                          <img src={m.user.avatar_url} alt={displayName} />
                                        ) : (
                                          displayName.slice(0, 1).toUpperCase()
                                        )}
                                      </div>
                                      <div>
                                        <div className="projectMemberName">{displayName}</div>
                                        <div className="projectMemberRole">@{m.user.username}</div>
                                      </div>
                                    </div>
                                    <div className="chip">{humanizeToken(m.role)}</div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                ) : null}

                {projectDetailTab === "versions" ? (
                  <div className="card projectSectionCard">
                    <div className="projectSectionTitle">Versions</div>
                    {sortedProjectVersions.length === 0 ? (
                      <div className="muted">No version list available.</div>
                    ) : (
                      <div className="projectVersionList">
                        {sortedProjectVersions.slice(0, 30).map((v) => {
                          const primaryFile =
                            v.files.find((f) => f.primary) ?? v.files[0] ?? null;
                          return (
                            <div key={v.id} className="projectVersionRow">
                              <div className="projectVersionMain">
                                <div className="projectVersionTitle">{v.version_number}</div>
                                <div className="projectVersionMeta">
                                  <span>{formatDate(v.date_published)}</span>
                                  <span>{v.loaders.join(", ") || "Loader n/a"}</span>
                                  <span>{v.game_versions.slice(0, 5).join(", ") || "Version n/a"}</span>
                                </div>
                                {primaryFile ? (
                                  <div className="projectVersionFile">
                                    {primaryFile.filename} • {formatFileSize(primaryFile.size)}
                                  </div>
                                ) : null}
                              </div>

                              <div className="projectVersionAside">
                                <div className="chip">↓ {formatCompact(v.downloads ?? 0)}</div>
                                <div className="chip">{v.files.length} file{v.files.length === 1 ? "" : "s"}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : null}

                {projectDetailTab === "changelog" ? (
                  <div className="card projectSectionCard">
                    <div className="projectSectionTitle">Recent changelogs</div>
                    {changelogVersions.length === 0 ? (
                      <div className="muted">No changelogs were returned by Modrinth for recent versions.</div>
                    ) : (
                      <div className="projectChangelogList">
                        {changelogVersions.map((v) => (
                          <div key={`changelog:${v.id}`} className="projectChangeItem">
                            <div className="projectChangeHeader">
                              <div className="projectVersionTitle">{v.version_number}</div>
                              <div className="chip">{formatDate(v.date_published)}</div>
                            </div>
                            <pre className="projectBodyText projectChangelogText">
                              {toReadableBody(v.changelog)}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}

                <div className="p projectInstallHint">
                  Install downloads the latest compatible jar and required dependencies for your selected instance, then writes everything to lockfile.
                </div>
              </div>
            ) : null}
          </div>

          <div className="footerBar">
            <button className="btn" onClick={closeProjectOverlays}>
              Close
            </button>
            <button
              className="btn primary installAction"
              disabled={!projectOpen || projectOpenContentType === "modpacks"}
              title={projectOpen ? (projectOpenContentType === "modpacks" ? "Use Import template in Modpacks & Presets" : "Install to an instance") : "Loading..."}
              onClick={() => {
                if (!projectOpen) return;
                openInstall({
                  source: "modrinth",
                  projectId: projectOpen.id,
                  title: projectOpen.title,
                  contentType: projectOpenContentType,
                  iconUrl: projectOpen.icon_url,
                  description: projectOpen.description,
                });
              }}
            >
              <Icon name="download" /> {projectOpenContentType === "modpacks" ? "Template only" : "Install to instance"}
            </button>
          </div>
        </Modal>
      ) : null}

      {curseforgeOpen || curseforgeBusy || curseforgeErr ? (
        <Modal
          title={curseforgeOpen?.title ?? (curseforgeBusy ? "Loading…" : "CurseForge details")}
          onClose={closeProjectOverlays}
        >
          <div className="modalBody">
            {curseforgeErr ? <div className="errorBox">{curseforgeErr}</div> : null}
            {curseforgeBusy && !curseforgeOpen ? (
              <div className="card" style={{ padding: 16, borderRadius: 22 }}>
                Loading…
              </div>
            ) : null}

            {curseforgeOpen ? (
              <div className="projectDetailWrap">
                <div className="card projectHeroCard">
                  <div className="projectHeroAura" />

                  <div className="projectHero">
                    <div className="resultIcon projectIcon projectIconLarge">
                      {curseforgeOpen.icon_url ? <img src={curseforgeOpen.icon_url} alt="" /> : <div>⬚</div>}
                    </div>

                    <div className="projectHeroMain">
                      <div className="projectEyebrow">
                        CurseForge • {curseforgeOpen.slug || curseforgeOpen.project_id}
                      </div>
                      <div className="projectHeroTitleRow">
                        <div className="projectHeroTitle">{curseforgeOpen.title}</div>
                        <div className="chip">Updated {formatDate(curseforgeOpen.date_modified)}</div>
                      </div>
                      <div className="p projectHeroDesc">{curseforgeOpen.summary}</div>
                      <div className="projectChipRow">
                        {curseforgeOpen.categories.slice(0, 8).map((c) => (
                          <span key={c} className="chip">
                            {humanizeToken(c)}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="projectStatsGrid">
                    <div className="projectStatCard">
                      <div className="projectStatLabel">Downloads</div>
                      <div className="projectStatValue">{formatCompact(curseforgeOpen.downloads)}</div>
                    </div>
                    <div className="projectStatCard">
                      <div className="projectStatLabel">Files</div>
                      <div className="projectStatValue">{curseforgeOpen.files.length}</div>
                    </div>
                    <div className="projectStatCard">
                      <div className="projectStatLabel">Authors</div>
                      <div className="projectStatValue">
                        {curseforgeOpen.author_names.length ? curseforgeOpen.author_names.length : "—"}
                      </div>
                    </div>
                    <div className="projectStatCard">
                      <div className="projectStatLabel">Provider</div>
                      <div className="projectStatValue">CurseForge</div>
                    </div>
                  </div>

                  <div className="projectActionRow">
                    {curseforgeOpen.external_url ? (
                      <a className="btn projectActionBtn" href={curseforgeOpen.external_url} target="_blank" rel="noreferrer">
                        Open on CurseForge
                      </a>
                    ) : null}
                    {curseforgeOpen.external_url ? (
                      <button
                        className="btn projectActionBtn"
                        onClick={() => copyProjectText("Link", curseforgeOpen.external_url!)}
                      >
                        Copy link
                      </button>
                    ) : null}
                    <button
                      className="btn projectActionBtn"
                      onClick={() => copyProjectText("Project ID", curseforgeOpen.project_id)}
                    >
                      Copy project ID
                    </button>
                  </div>

                  {projectCopyNotice ? <div className="projectCopyNotice">{projectCopyNotice}</div> : null}
                </div>

                <div className="projectTabSticky">
                  <SegmentedControl
                    value={curseforgeDetailTab}
                    options={CURSEFORGE_DETAIL_TABS}
                    onChange={(v) => setCurseforgeDetailTab((v ?? "overview") as CurseforgeDetailTab)}
                    variant="scroll"
                    className="projectTabBar"
                  />
                </div>

                {curseforgeDetailTab === "overview" ? (
                  <div className="projectOverviewCols">
                    <div className="projectOverviewCol">
                      <div className="card projectSectionCard projectSectionDesc">
                        <div className="projectSectionTitle">Description</div>
                        <pre className="projectBodyText">
                          {toReadableHtml(curseforgeOpen.description) || curseforgeOpen.summary}
                        </pre>
                      </div>
                    </div>
                    <div className="projectOverviewCol">
                      <div className="card projectSectionCard projectSectionTeam">
                        <div className="projectSectionTitle">Authors</div>
                        {curseforgeOpen.author_names.length === 0 ? (
                          <div className="muted">No author data returned.</div>
                        ) : (
                          <div className="projectMemberList">
                            {curseforgeOpen.author_names.map((name) => (
                              <div key={name} className="projectMemberRow">
                                <div className="projectMemberIdentity">
                                  <div className="projectMemberAvatar">{name.slice(0, 1).toUpperCase()}</div>
                                  <div>
                                    <div className="projectMemberName">{name}</div>
                                    <div className="projectMemberRole">CurseForge author</div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}

                {curseforgeDetailTab === "files" ? (
                  <div className="card projectSectionCard">
                    <div className="projectSectionTitle">Files</div>
                    {curseforgeOpen.files.length === 0 ? (
                      <div className="muted">No file list available.</div>
                    ) : (
                      <div className="projectVersionList">
                        {curseforgeOpen.files.slice(0, 40).map((f) => (
                          <div key={f.file_id} className="projectVersionRow">
                            <div className="projectVersionMain">
                              <div className="projectVersionTitle">
                                {f.display_name || f.file_name || `File ${f.file_id}`}
                              </div>
                              <div className="projectVersionMeta">
                                <span>{formatDate(f.file_date)}</span>
                                <span>{f.file_name}</span>
                              </div>
                              {f.game_versions.length > 0 ? (
                                <div className="projectVersionFile">
                                  {f.game_versions.slice(0, 10).join(", ")}
                                </div>
                              ) : null}
                            </div>
                            <div className="projectVersionAside">
                              <div className="chip">#{f.file_id}</div>
                              {f.download_url ? (
                                <a className="chip" href={f.download_url} target="_blank" rel="noreferrer">
                                  Direct URL
                                </a>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}

                {curseforgeDetailTab === "changelog" ? (
                  <div className="card projectSectionCard">
                    <div className="projectSectionTitle">Changelog</div>
                    <div className="muted">
                      CurseForge project-level changelogs are not consistently available via the current API. Use the files tab and the CurseForge page for detailed release notes.
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="footerBar">
            <button className="btn" onClick={closeProjectOverlays}>
              Close
            </button>
            <button
              className="btn primary installAction"
              disabled={!curseforgeOpen || curseforgeOpenContentType === "modpacks"}
              title={curseforgeOpen ? (curseforgeOpenContentType === "modpacks" ? "Use Import template in Modpacks & Presets" : "Install to an instance") : "Loading..."}
              onClick={() => {
                if (!curseforgeOpen) return;
                openInstall({
                  source: "curseforge",
                  projectId: curseforgeOpen.project_id,
                  title: curseforgeOpen.title,
                  contentType: curseforgeOpenContentType,
                  iconUrl: curseforgeOpen.icon_url,
                  description: curseforgeOpen.summary,
                });
              }}
            >
              <Icon name="download" /> {curseforgeOpenContentType === "modpacks" ? "Template only" : "Install to instance"}
            </button>
          </div>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <div className="modalOverlay dangerVignette noBlur" onMouseDown={() => (busy === "delete" ? null : setDeleteTarget(null))}>
          <div className="deleteConfirmDialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="deleteConfirmHeader">
              <div className="deleteConfirmTitle">Are you sure you want to delete this instance?</div>
              <button
                className="iconBtn"
                onClick={() => setDeleteTarget(null)}
                disabled={busy === "delete"}
                aria-label="Close delete dialog"
              >
                <Icon name="x" size={20} />
              </button>
            </div>

            <div className="deleteConfirmBody">
              If you proceed, all data for your instance will be removed. You will not be able to recover it.
            </div>

            <div className="deleteConfirmActions">
              <button className="btn dangerSolid" onClick={onDelete} disabled={busy === "delete"}>
                <Icon name="trash" size={17} /> {busy === "delete" ? "Deleting…" : "Delete"}
              </button>
              <button className="btn" onClick={() => setDeleteTarget(null)} disabled={busy === "delete"}>
                <Icon name="x" size={17} /> Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {msLoginSessionId && msCodePromptVisible && msCodePrompt ? (
        <div className="modalOverlay msCodeOverlay noBlur" onMouseDown={() => setMsCodePromptVisible(false)}>
          <div className="msCodeDialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="msCodeTitle">Enter this code to continue sign-in</div>
            <div className="msCodeSub">Open Microsoft device login and paste this code.</div>
            <div className="msCodeValue" aria-live="polite">{msCodePrompt.code}</div>
            <div className="msCodeActions">
              <button className="btn primary" onClick={copyMicrosoftCode}>
                {msCodeCopied ? "Copied" : "Copy code"}
              </button>
              <button
                className="btn"
                onClick={() => void openExternalLink(msCodePrompt.verificationUrl)}
              >
                Open login page
              </button>
              <button className="btn" onClick={() => setMsCodePromptVisible(false)}>
                Hide
              </button>
            </div>
            <div className="muted">
              Waiting for Microsoft confirmation…
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
