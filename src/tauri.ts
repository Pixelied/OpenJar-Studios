import { invoke } from "@tauri-apps/api/tauri";
import type {
  AccountDiagnostics,
  BeginMicrosoftLoginResult,
  CreateInstanceFromModpackFileResult,
  CreatorPreset,
  CurseforgeApiStatus,
  CurseforgeProjectDetail,
  DiscoverContentType,
  DiscoverSearchResult,
  DiscoverSource,
  ExportModsResult,
  ImportInstanceFromLauncherResult,
  InstanceSettings,
  InstanceWorld,
  InstallPlanPreview,
  Instance,
  JavaRuntimeCandidate,
  LauncherImportSource,
  InstalledMod,
  LauncherAccount,
  LauncherSettings,
  LaunchResult,
  LaunchMethod,
  Loader,
  MicrosoftLoginState,
  ModUpdateCheckResult,
  OpenInstancePathResult,
  RevealConfigEditorFileResult,
  PresetApplyPreview,
  PresetApplyResult,
  PresetsJsonIoResult,
  RollbackResult,
  ReadInstanceLogsResult,
  RunningInstance,
  SnapshotMeta,
  UpdateAllResult,
  WorldConfigFileEntry,
  ReadWorldConfigFileResult,
  WriteWorldConfigFileResult,
  WorldRollbackResult,
} from "./types";

export function listInstances(): Promise<Instance[]> {
  return invoke("list_instances");
}

export function createInstance(input: {
  name: string;
  mcVersion: string;
  loader: Loader;
  iconPath?: string | null;
}): Promise<Instance> {
  return invoke("create_instance", { args: input });
}

export function createInstanceFromModpackFile(input: {
  filePath: string;
  name?: string;
  iconPath?: string | null;
}): Promise<CreateInstanceFromModpackFileResult> {
  return invoke("create_instance_from_modpack_file", { args: input });
}

export function listLauncherImportSources(): Promise<LauncherImportSource[]> {
  return invoke("list_launcher_import_sources");
}

export function importInstanceFromLauncher(input: {
  sourceId: string;
  name?: string;
  iconPath?: string | null;
}): Promise<ImportInstanceFromLauncherResult> {
  return invoke("import_instance_from_launcher", { args: input });
}

export function updateInstance(input: {
  instanceId: string;
  name?: string;
  mcVersion?: string;
  loader?: Loader;
  settings?: InstanceSettings;
}): Promise<Instance> {
  return invoke("update_instance", { args: input });
}

export function setInstanceIcon(input: {
  instanceId: string;
  iconPath?: string | null;
}): Promise<Instance> {
  return invoke("set_instance_icon", { args: input });
}

export function readLocalImageDataUrl(input: {
  path: string;
}): Promise<string> {
  return invoke("read_local_image_data_url", { args: input });
}

export function detectJavaRuntimes(): Promise<JavaRuntimeCandidate[]> {
  return invoke("detect_java_runtimes");
}

export function deleteInstance(id: string): Promise<void> {
  return invoke("delete_instance", { args: { id } });
}

export function installModrinthMod(input: {
  instanceId: string;
  projectId: string;
  projectTitle?: string;
}): Promise<InstalledMod> {
  return invoke("install_modrinth_mod", { args: input });
}

export function installCurseforgeMod(input: {
  instanceId: string;
  projectId: string;
  projectTitle?: string;
}): Promise<InstalledMod> {
  return invoke("install_curseforge_mod", { args: input });
}

export function listInstalledMods(instanceId: string): Promise<InstalledMod[]> {
  return invoke("list_installed_mods", { args: { instanceId } });
}

export function setInstalledModEnabled(input: {
  instanceId: string;
  versionId: string;
  enabled: boolean;
}): Promise<InstalledMod> {
  return invoke("set_installed_mod_enabled", { args: input });
}

export function importLocalModFile(input: {
  instanceId: string;
  filePath: string;
}): Promise<InstalledMod> {
  return invoke("import_local_mod_file", { args: input });
}

export function previewModrinthInstall(input: {
  instanceId: string;
  projectId: string;
  projectTitle?: string;
}): Promise<InstallPlanPreview> {
  return invoke("preview_modrinth_install", { args: input });
}

export function checkModrinthUpdates(input: {
  instanceId: string;
}): Promise<ModUpdateCheckResult> {
  return invoke("check_modrinth_updates", { args: input });
}

export function updateAllModrinthMods(input: {
  instanceId: string;
}): Promise<UpdateAllResult> {
  return invoke("update_all_modrinth_mods", { args: input });
}

export function searchDiscoverContent(input: {
  query: string;
  loaders?: string[];
  gameVersion?: string | null;
  categories?: string[];
  index: string;
  limit: number;
  offset: number;
  source: DiscoverSource;
  contentType: DiscoverContentType;
}): Promise<DiscoverSearchResult> {
  return invoke("search_discover_content", { args: input });
}

export function getCurseforgeProjectDetail(input: {
  projectId: string;
}): Promise<CurseforgeProjectDetail> {
  return invoke("get_curseforge_project_detail", { args: input });
}

export function launchInstance(input: {
  instanceId: string;
  method?: LaunchMethod;
}): Promise<LaunchResult> {
  return invoke("launch_instance", { args: input });
}

export function getLauncherSettings(): Promise<LauncherSettings> {
  return invoke("get_launcher_settings");
}

export function getCurseforgeApiStatus(): Promise<CurseforgeApiStatus> {
  return invoke("get_curseforge_api_status");
}

export function setLauncherSettings(input: {
  defaultLaunchMethod?: LaunchMethod;
  javaPath?: string;
  oauthClientId?: string;
  updateCheckCadence?: "off" | "hourly" | "every_3_hours" | "every_6_hours" | "every_12_hours" | "daily" | "weekly";
  updateAutoApplyMode?: "never" | "opt_in_instances" | "all_instances";
  updateApplyScope?: "scheduled_only" | "scheduled_and_manual";
}): Promise<LauncherSettings> {
  return invoke("set_launcher_settings", { args: input });
}

export function listLauncherAccounts(): Promise<LauncherAccount[]> {
  return invoke("list_launcher_accounts");
}

export function beginMicrosoftLogin(): Promise<BeginMicrosoftLoginResult> {
  return invoke("begin_microsoft_login");
}

export function pollMicrosoftLogin(input: {
  sessionId: string;
}): Promise<MicrosoftLoginState> {
  return invoke("poll_microsoft_login", { args: input });
}

export function selectLauncherAccount(input: {
  accountId: string;
}): Promise<LauncherSettings> {
  return invoke("select_launcher_account", { args: input });
}

export function logoutMicrosoftAccount(input: {
  accountId: string;
}): Promise<LauncherAccount[]> {
  return invoke("logout_microsoft_account", { args: input });
}

export function listRunningInstances(): Promise<RunningInstance[]> {
  return invoke("list_running_instances");
}

export function stopRunningInstance(input: {
  launchId: string;
}): Promise<void> {
  return invoke("stop_running_instance", { args: input });
}

export function cancelInstanceLaunch(input: {
  instanceId: string;
}): Promise<string> {
  return invoke("cancel_instance_launch", { args: input });
}

export function exportInstanceModsZip(input: {
  instanceId: string;
  outputPath?: string;
}): Promise<ExportModsResult> {
  return invoke("export_instance_mods_zip", { args: input });
}

export function getSelectedAccountDiagnostics(): Promise<AccountDiagnostics> {
  return invoke("get_selected_account_diagnostics");
}

export function openInstancePath(input: {
  instanceId: string;
  target:
    | "instance"
    | "mods"
    | "resourcepacks"
    | "shaderpacks"
    | "saves"
    | "launch-log"
    | "crash-log";
}): Promise<OpenInstancePathResult> {
  return invoke("open_instance_path", { args: input });
}

export function revealConfigEditorFile(input: {
  instanceId: string;
  scope: "instance" | "world";
  worldId?: string;
  path?: string;
}): Promise<RevealConfigEditorFileResult> {
  return invoke("reveal_config_editor_file", { args: input });
}

export function readInstanceLogs(input: {
  instanceId: string;
  source: "live" | "latest_launch" | "latest_crash";
  maxLines?: number;
  beforeLine?: number;
}): Promise<ReadInstanceLogsResult> {
  return invoke("read_instance_logs", { args: input });
}

export function listInstanceSnapshots(input: {
  instanceId: string;
}): Promise<SnapshotMeta[]> {
  return invoke("list_instance_snapshots", { args: input });
}

export function rollbackInstance(input: {
  instanceId: string;
  snapshotId?: string;
}): Promise<RollbackResult> {
  return invoke("rollback_instance", { args: input });
}

export function rollbackInstanceWorldBackup(input: {
  instanceId: string;
  worldId: string;
  backupId?: string;
}): Promise<WorldRollbackResult> {
  return invoke("rollback_instance_world_backup", { args: input });
}

export function listInstanceWorlds(input: {
  instanceId: string;
}): Promise<InstanceWorld[]> {
  return invoke("list_instance_worlds", { args: input });
}

export function listWorldConfigFiles(input: {
  instanceId: string;
  worldId: string;
}): Promise<WorldConfigFileEntry[]> {
  return invoke("list_world_config_files", { args: input });
}

export function readWorldConfigFile(input: {
  instanceId: string;
  worldId: string;
  path: string;
}): Promise<ReadWorldConfigFileResult> {
  return invoke("read_world_config_file", { args: input });
}

export function writeWorldConfigFile(input: {
  instanceId: string;
  worldId: string;
  path: string;
  content: string;
  expectedModifiedAt?: number;
}): Promise<WriteWorldConfigFileResult> {
  return invoke("write_world_config_file", { args: input });
}

export function installDiscoverContent(input: {
  instanceId: string;
  source: DiscoverSource | "modrinth" | "curseforge";
  projectId: string;
  projectTitle?: string;
  contentType: DiscoverContentType;
  targetWorlds?: string[];
}): Promise<InstalledMod> {
  return invoke("install_discover_content", { args: input });
}

export function previewPresetApply(input: {
  instanceId: string;
  preset: CreatorPreset;
}): Promise<PresetApplyPreview> {
  return invoke("preview_preset_apply", { args: input });
}

export function applyPresetToInstance(input: {
  instanceId: string;
  preset: CreatorPreset;
}): Promise<PresetApplyResult> {
  return invoke("apply_preset_to_instance", { args: input });
}

export function importProviderModpackTemplate(input: {
  source: "modrinth" | "curseforge";
  projectId: string;
  projectTitle?: string;
}): Promise<CreatorPreset> {
  return invoke("import_provider_modpack_template", { args: input });
}

export function exportPresetsJson(input: {
  outputPath: string;
  payload: unknown;
}): Promise<PresetsJsonIoResult> {
  return invoke("export_presets_json", { args: input });
}

export function importPresetsJson(input: {
  inputPath: string;
}): Promise<unknown> {
  return invoke("import_presets_json", { args: input });
}
