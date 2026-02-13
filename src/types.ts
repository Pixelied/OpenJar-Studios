export type Loader = "fabric" | "forge" | "quilt" | "neoforge" | "vanilla";

export type Instance = {
  id: string;
  name: string;
  mc_version: string;
  loader: Loader;
  created_at: string;
  icon_path?: string | null;
  settings?: InstanceSettings;
};

export type InstanceSettings = {
  keep_launcher_open_while_playing: boolean;
  close_launcher_on_game_exit: boolean;
  notes: string;
  auto_update_installed_content: boolean;
  prefer_release_builds: boolean;
  java_path: string;
  memory_mb: number;
  jvm_args: string;
  graphics_preset: "Performance" | "Balanced" | "Quality" | string;
  enable_shaders: boolean;
  force_vsync: boolean;
  world_backup_interval_minutes: number;
  world_backup_retention_count: number;
};

export type InstalledMod = {
  source: "modrinth" | string;
  project_id: string;
  version_id: string;
  name: string;
  version_number: string;
  filename: string;
  content_type?: "mods" | "shaderpacks" | "resourcepacks" | "datapacks" | "modpacks" | string;
  target_scope?: "instance" | "world" | string;
  target_worlds?: string[];
  pinned_version?: string | null;
  enabled: boolean;
  file_exists: boolean;
  hashes?: Record<string, string>;
};

export type InstallProgressEvent = {
  instance_id: string;
  project_id: string;
  stage: "resolving" | "downloading" | "completed" | "error";
  downloaded: number;
  total?: number | null;
  percent?: number | null;
  message?: string | null;
};

export type InstallPlanPreview = {
  total_mods: number;
  dependency_mods: number;
  will_install_mods: number;
};

export type ModUpdateInfo = {
  project_id: string;
  name: string;
  current_version_id: string;
  current_version_number: string;
  latest_version_id: string;
  latest_version_number: string;
};

export type ModUpdateCheckResult = {
  checked_mods: number;
  update_count: number;
  updates: ModUpdateInfo[];
};

export type UpdateAllResult = {
  checked_mods: number;
  updated_mods: number;
};

export type LaunchResult = {
  method: "prism" | "native" | string;
  launch_id?: string | null;
  pid?: number | null;
  prism_instance_id?: string | null;
  prism_root?: string | null;
  message: string;
};

export type LaunchMethod = "prism" | "native";

export type UpdateCheckCadence =
  | "off"
  | "hourly"
  | "every_3_hours"
  | "every_6_hours"
  | "every_12_hours"
  | "daily"
  | "weekly"
  | string;

export type UpdateAutoApplyMode = "never" | "opt_in_instances" | "all_instances" | string;

export type UpdateApplyScope = "scheduled_only" | "scheduled_and_manual" | string;

export type LauncherSettings = {
  default_launch_method: LaunchMethod;
  java_path: string;
  oauth_client_id: string;
  update_check_cadence: UpdateCheckCadence;
  update_auto_apply_mode?: UpdateAutoApplyMode;
  update_apply_scope?: UpdateApplyScope;
  selected_account_id?: string | null;
};

export type LauncherAccount = {
  id: string;
  username: string;
  added_at: string;
};

export type AccountCosmeticSummary = {
  id: string;
  state: string;
  url: string;
  alias?: string | null;
  variant?: string | null;
};

export type AccountDiagnostics = {
  status: "connected" | "not_connected" | "error" | string;
  last_refreshed_at: string;
  selected_account_id?: string | null;
  account?: LauncherAccount | null;
  minecraft_uuid?: string | null;
  minecraft_username?: string | null;
  entitlements_ok: boolean;
  token_exchange_status: string;
  skin_url?: string | null;
  cape_count: number;
  skins: AccountCosmeticSummary[];
  capes: AccountCosmeticSummary[];
  last_error?: string | null;
  client_id_source: string;
};

export type BeginMicrosoftLoginResult = {
  session_id: string;
  auth_url: string;
  user_code?: string | null;
  verification_uri?: string | null;
};

export type JavaRuntimeCandidate = {
  path: string;
  major: number;
  version_line: string;
};

export type CurseforgeApiStatus = {
  configured: boolean;
  env_var?: string | null;
  key_hint?: string | null;
  validated: boolean;
  message: string;
};

export type MicrosoftLoginState = {
  status: "pending" | "success" | "error" | string;
  message?: string | null;
  account?: LauncherAccount | null;
};

export type RunningInstance = {
  launch_id: string;
  instance_id: string;
  instance_name: string;
  method: LaunchMethod | string;
  pid: number;
  started_at: string;
  log_path?: string | null;
};

export type InstanceLogSourceApi = "live" | "latest_launch" | "latest_crash";

export type ReadInstanceLogsLine = {
  raw: string;
  line_no?: number;
  timestamp?: string | null;
  severity?: "error" | "warn" | "info" | "debug" | "trace" | string | null;
  source: InstanceLogSourceApi | string;
};

export type ReadInstanceLogsResult = {
  source: InstanceLogSourceApi | string;
  path: string;
  available: boolean;
  total_lines: number;
  returned_lines: number;
  truncated: boolean;
  start_line_no?: number | null;
  end_line_no?: number | null;
  next_before_line?: number | null;
  lines: ReadInstanceLogsLine[];
  updated_at: number;
  message?: string | null;
};

export type ExportModsResult = {
  output_path: string;
  files_count: number;
};

export type OpenInstancePathResult = {
  target:
    | "instance"
    | "mods"
    | "resourcepacks"
    | "shaderpacks"
    | "saves"
    | "launch-log"
    | "crash-log"
    | string;
  path: string;
};

export type RevealConfigEditorFileResult = {
  opened_path: string;
  revealed_file: boolean;
  virtual_file: boolean;
  message: string;
};

export type CreateInstanceFromModpackFileResult = {
  instance: Instance;
  imported_files: number;
  warnings: string[];
};

export type LauncherImportSource = {
  id: string;
  source_kind: "vanilla" | "prism" | string;
  label: string;
  mc_version: string;
  loader: Loader;
  source_path: string;
};

export type ImportInstanceFromLauncherResult = {
  instance: Instance;
  imported_files: number;
};

export type InstanceWorld = {
  id: string;
  name: string;
  path: string;
  latest_backup_id?: string | null;
  latest_backup_at?: string | null;
  backup_count?: number;
};

export type WorldConfigFileEntry = {
  path: string;
  size_bytes: number;
  modified_at: number;
  editable: boolean;
  kind: string;
  readonly_reason?: string | null;
};

export type ReadWorldConfigFileResult = {
  path: string;
  editable: boolean;
  kind: string;
  size_bytes: number;
  modified_at: number;
  readonly_reason?: string | null;
  content?: string | null;
  preview?: string | null;
};

export type WriteWorldConfigFileResult = {
  path: string;
  size_bytes: number;
  modified_at: number;
  message: string;
};

export type SnapshotMeta = {
  id: string;
  created_at: string;
  reason: string;
};

export type RollbackResult = {
  snapshot_id: string;
  created_at: string;
  restored_files: number;
  message: string;
};

export type WorldRollbackResult = {
  world_id: string;
  backup_id: string;
  created_at: string;
  restored_files: number;
  message: string;
};

export type DiscoverSource = "modrinth" | "curseforge" | "all";
export type DiscoverContentType = "mods" | "shaderpacks" | "resourcepacks" | "datapacks" | "modpacks";

export type DiscoverSearchHit = {
  source: "modrinth" | "curseforge" | string;
  project_id: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  follows: number;
  icon_url?: string | null;
  categories: string[];
  versions: string[];
  date_modified: string;
  content_type: "mods" | "shaderpacks" | "resourcepacks" | "datapacks" | "modpacks" | string;
  slug?: string | null;
  external_url?: string | null;
};

export type DiscoverSearchResult = {
  hits: DiscoverSearchHit[];
  offset: number;
  limit: number;
  total_hits: number;
};

export type CurseforgeProjectFileDetail = {
  file_id: string;
  display_name: string;
  file_name: string;
  file_date: string;
  game_versions: string[];
  download_url?: string | null;
};

export type CurseforgeProjectDetail = {
  source: "curseforge" | string;
  project_id: string;
  title: string;
  slug?: string | null;
  summary: string;
  description: string;
  author_names: string[];
  downloads: number;
  categories: string[];
  icon_url?: string | null;
  date_modified: string;
  external_url?: string | null;
  files: CurseforgeProjectFileDetail[];
};

export type PresetsJsonIoResult = {
  path: string;
  items: number;
};

export type CreatorPresetEntry = {
  source: "modrinth" | "curseforge" | string;
  project_id: string;
  title: string;
  content_type: "mods" | "shaderpacks" | "resourcepacks" | "datapacks" | "modpacks" | string;
  pinned_version?: string | null;
  target_scope?: "instance" | "world" | string;
  target_worlds?: string[];
  enabled?: boolean;
};

export type CreatorPresetSettings = {
  dependency_policy?: string;
  conflict_strategy?: string;
  provider_priority?: string[];
  snapshot_before_apply?: boolean;
  apply_order?: string[];
  datapack_target_policy?: string;
};

export type CreatorPreset = {
  id: string;
  name: string;
  created_at: string;
  source_instance_id: string;
  source_instance_name: string;
  entries: CreatorPresetEntry[];
  settings?: CreatorPresetSettings;
};

export type PresetApplyPreview = {
  valid: boolean;
  installable_entries: number;
  skipped_disabled_entries: number;
  missing_world_targets: string[];
  provider_warnings: string[];
  duplicate_entries: number;
};

export type PresetApplyResult = {
  message: string;
  installed_entries: number;
  skipped_entries: number;
  failed_entries: number;
  snapshot_id?: string | null;
  by_content_type: Record<string, number>;
};
