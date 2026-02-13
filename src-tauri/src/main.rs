#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{DateTime, Local};
use base64::Engine as _;
use keyring::{Entry as KeyringEntry, Error as KeyringError};
use open_launcher::{auth as ol_auth, version as ol_version, Launcher as OpenLauncher};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;
use tauri::Manager;
use zip::write::FileOptions;
use zip::ZipArchive;

const USER_AGENT: &str = "ModpackManager/0.0.1 (Tauri)";
const KEYRING_SERVICE: &str = "ModpackManager";
const LEGACY_KEYRING_SERVICES: [&str; 2] = ["com.adrien.modpackmanager", "modpack-manager"];
const LAUNCHER_TOKEN_FALLBACK_FILE: &str = "tokens_fallback.json";
const MS_TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const MS_DEVICE_CODE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const XBL_AUTH_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_AUTH_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_AUTH_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_LAUNCHER_AUTH_URL: &str = "https://api.minecraftservices.com/launcher/login";
const MC_ENTITLEMENTS_URL: &str = "https://api.minecraftservices.com/entitlements/mcstore";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";
const DEFAULT_MS_PUBLIC_CLIENT_ID: &str = "c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb";
const CURSEFORGE_API_BASE: &str = "https://api.curseforge.com/v1";
const CURSEFORGE_GAME_ID_MINECRAFT: i64 = 432;
const MAX_LOCAL_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_WORLD_BACKUP_INTERVAL_MINUTES: u32 = 10;
const DEFAULT_WORLD_BACKUP_RETENTION_COUNT: u32 = 1;

fn modrinth_api_base() -> String {
    std::env::var("MPM_MODRINTH_API_BASE")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://api.modrinth.com/v2".to_string())
}

fn curseforge_api_key() -> Option<String> {
    curseforge_api_key_with_source().map(|(key, _)| key)
}

fn curseforge_api_key_with_source() -> Option<(String, String)> {
    for key in ["MPM_CURSEFORGE_API_KEY", "CURSEFORGE_API_KEY"] {
        if let Ok(v) = std::env::var(key) {
            let trimmed = v.trim().to_string();
            if !trimmed.is_empty() {
                return Some((trimmed, key.to_string()));
            }
        }
    }
    None
}

fn mask_secret(secret: &str) -> String {
    if secret.len() <= 8 {
        return "********".to_string();
    }
    let head = &secret[..4];
    let tail = &secret[secret.len().saturating_sub(4)..];
    format!("{head}…{tail}")
}

fn parse_curseforge_project_id(raw: &str) -> Result<i64, String> {
    let normalized = raw
        .trim()
        .trim_start_matches("cf:")
        .trim_start_matches("curseforge:")
        .trim();
    normalized
        .parse::<i64>()
        .map_err(|_| format!("Invalid CurseForge project ID: {}", raw))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Instance {
    id: String,
    name: String,
    mc_version: String,
    loader: String, // "fabric" | "forge"
    created_at: String,
    #[serde(default)]
    icon_path: Option<String>,
    #[serde(default)]
    settings: InstanceSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstanceSettings {
    #[serde(default = "default_true")]
    keep_launcher_open_while_playing: bool,
    #[serde(default)]
    close_launcher_on_game_exit: bool,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    auto_update_installed_content: bool,
    #[serde(default = "default_true")]
    prefer_release_builds: bool,
    #[serde(default)]
    java_path: String,
    #[serde(default = "default_memory_mb")]
    memory_mb: u32,
    #[serde(default)]
    jvm_args: String,
    #[serde(default = "default_graphics_preset")]
    graphics_preset: String,
    #[serde(default)]
    enable_shaders: bool,
    #[serde(default)]
    force_vsync: bool,
    #[serde(default = "default_world_backup_interval_minutes")]
    world_backup_interval_minutes: u32,
    #[serde(default = "default_world_backup_retention_count")]
    world_backup_retention_count: u32,
}

impl Default for InstanceSettings {
    fn default() -> Self {
        Self {
            keep_launcher_open_while_playing: true,
            close_launcher_on_game_exit: false,
            notes: String::new(),
            auto_update_installed_content: false,
            prefer_release_builds: true,
            java_path: String::new(),
            memory_mb: default_memory_mb(),
            jvm_args: String::new(),
            graphics_preset: default_graphics_preset(),
            enable_shaders: false,
            force_vsync: false,
            world_backup_interval_minutes: default_world_backup_interval_minutes(),
            world_backup_retention_count: default_world_backup_retention_count(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct InstanceIndex {
    instances: Vec<Instance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LockEntry {
    source: String,
    project_id: String,
    version_id: String,
    name: String,
    version_number: String,
    filename: String,
    #[serde(default = "default_content_type_mods")]
    content_type: String,
    #[serde(default = "default_target_scope_instance")]
    target_scope: String,
    #[serde(default)]
    target_worlds: Vec<String>,
    #[serde(default)]
    pinned_version: Option<String>,
    enabled: bool,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Lockfile {
    version: u32,
    entries: Vec<LockEntry>,
}

impl Default for Lockfile {
    fn default() -> Self {
        Self {
            version: 2,
            entries: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstalledMod {
    source: String,
    project_id: String,
    version_id: String,
    name: String,
    version_number: String,
    filename: String,
    content_type: String,
    target_scope: String,
    #[serde(default)]
    target_worlds: Vec<String>,
    #[serde(default)]
    pinned_version: Option<String>,
    enabled: bool,
    file_exists: bool,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
struct InstallProgressEvent {
    instance_id: String,
    project_id: String,
    stage: String, // resolving | downloading | completed | error
    downloaded: u64,
    total: Option<u64>,
    percent: Option<f64>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateInstanceArgs {
    name: String,
    #[serde(alias = "mcVersion", alias = "mc_version")]
    mc_version: String,
    loader: String,
    #[serde(alias = "iconPath", alias = "icon_path", default)]
    icon_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeleteInstanceArgs {
    id: String,
}

#[derive(Debug, Deserialize)]
struct SetInstanceIconArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "iconPath", alias = "icon_path", default)]
    icon_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReadLocalImageDataUrlArgs {
    path: String,
}

#[derive(Debug, Deserialize)]
struct UpdateInstanceArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(alias = "mcVersion", alias = "mc_version", default)]
    mc_version: Option<String>,
    #[serde(default)]
    loader: Option<String>,
    #[serde(default)]
    settings: Option<InstanceSettings>,
}

#[derive(Debug, Clone, Serialize)]
struct JavaRuntimeCandidate {
    path: String,
    major: u32,
    version_line: String,
}

#[derive(Debug, Clone, Serialize)]
struct CurseforgeApiStatus {
    configured: bool,
    env_var: Option<String>,
    key_hint: Option<String>,
    validated: bool,
    message: String,
}

#[derive(Debug, Deserialize)]
struct InstallModrinthModArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "projectTitle", default)]
    project_title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListInstalledModsArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
}

#[derive(Debug, Deserialize)]
struct SetInstalledModEnabledArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "versionId")]
    version_id: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
struct ImportLocalModFileArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "filePath")]
    file_path: String,
}

#[derive(Debug, Deserialize)]
struct CheckUpdatesArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
}

#[derive(Debug, Deserialize)]
struct LaunchInstanceArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(default)]
    method: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExportInstanceModsZipArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "outputPath", default)]
    output_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PollMicrosoftLoginArgs {
    #[serde(alias = "sessionId")]
    session_id: String,
}

#[derive(Debug, Deserialize)]
struct SelectLauncherAccountArgs {
    #[serde(alias = "accountId")]
    account_id: String,
}

#[derive(Debug, Deserialize)]
struct LogoutMicrosoftAccountArgs {
    #[serde(alias = "accountId")]
    account_id: String,
}

#[derive(Debug, Deserialize)]
struct SetLauncherSettingsArgs {
    #[serde(alias = "defaultLaunchMethod", default)]
    default_launch_method: Option<String>,
    #[serde(alias = "javaPath", default)]
    java_path: Option<String>,
    #[serde(alias = "oauthClientId", default)]
    oauth_client_id: Option<String>,
    #[serde(alias = "updateCheckCadence", default)]
    update_check_cadence: Option<String>,
    #[serde(alias = "updateAutoApplyMode", default)]
    update_auto_apply_mode: Option<String>,
    #[serde(alias = "updateApplyScope", default)]
    update_apply_scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StopRunningInstanceArgs {
    #[serde(alias = "launchId")]
    launch_id: String,
}

#[derive(Debug, Deserialize)]
struct CancelInstanceLaunchArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
}

#[derive(Debug, Deserialize)]
struct OpenInstancePathArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    target: String, // instance | mods
}

#[derive(Debug, Deserialize)]
struct ReadInstanceLogsArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    source: String, // live | latest_launch | latest_crash
    #[serde(alias = "maxLines", default)]
    max_lines: Option<usize>,
    #[serde(alias = "beforeLine", default)]
    before_line: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RevealConfigEditorFileArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    scope: String, // instance | world
    #[serde(alias = "worldId", default)]
    world_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateInstanceFromModpackFileArgs {
    #[serde(alias = "filePath")]
    file_path: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(alias = "iconPath", alias = "icon_path", default)]
    icon_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CreateInstanceFromModpackFileResult {
    instance: Instance,
    imported_files: usize,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct LauncherImportSource {
    id: String,
    source_kind: String, // vanilla | prism
    label: String,
    mc_version: String,
    loader: String,
    source_path: String,
}

#[derive(Debug, Deserialize)]
struct ImportInstanceFromLauncherArgs {
    #[serde(alias = "sourceId")]
    source_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(alias = "iconPath", alias = "icon_path", default)]
    icon_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ImportInstanceFromLauncherResult {
    instance: Instance,
    imported_files: usize,
}

#[derive(Debug, Deserialize)]
struct RollbackInstanceArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "snapshotId", default)]
    snapshot_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListInstanceSnapshotsArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
}

#[derive(Debug, Deserialize)]
struct ListInstanceWorldsArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
}

#[derive(Debug, Deserialize)]
struct ListWorldConfigFilesArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "worldId")]
    world_id: String,
}

#[derive(Debug, Deserialize)]
struct ReadWorldConfigFileArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "worldId")]
    world_id: String,
    path: String,
}

#[derive(Debug, Deserialize)]
struct WriteWorldConfigFileArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "worldId")]
    world_id: String,
    path: String,
    content: String,
    #[serde(alias = "expectedModifiedAt", default)]
    expected_modified_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RollbackInstanceWorldBackupArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "worldId")]
    world_id: String,
    #[serde(alias = "backupId", default)]
    backup_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstallDiscoverContentArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    source: String,
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "projectTitle", default)]
    project_title: Option<String>,
    #[serde(alias = "contentType")]
    content_type: String,
    #[serde(alias = "targetWorlds", default)]
    target_worlds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CreatorPresetSettings {
    #[serde(default)]
    dependency_policy: String,
    #[serde(default)]
    conflict_strategy: String,
    #[serde(default)]
    provider_priority: Vec<String>,
    #[serde(default = "default_true")]
    snapshot_before_apply: bool,
    #[serde(default)]
    apply_order: Vec<String>,
    #[serde(default)]
    datapack_target_policy: String,
}

impl Default for CreatorPresetSettings {
    fn default() -> Self {
        default_preset_settings()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CreatorPresetEntry {
    source: String,
    project_id: String,
    title: String,
    content_type: String,
    #[serde(default)]
    pinned_version: Option<String>,
    #[serde(default = "default_target_scope_instance")]
    target_scope: String,
    #[serde(default)]
    target_worlds: Vec<String>,
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CreatorPreset {
    id: String,
    name: String,
    created_at: String,
    source_instance_id: String,
    source_instance_name: String,
    entries: Vec<CreatorPresetEntry>,
    #[serde(default)]
    settings: CreatorPresetSettings,
}

#[derive(Debug, Deserialize)]
struct ApplyPresetToInstanceArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    preset: CreatorPreset,
}

#[derive(Debug, Deserialize)]
struct PreviewPresetApplyArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    preset: CreatorPreset,
}

#[derive(Debug, Deserialize)]
struct ImportProviderModpackArgs {
    source: String,
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "projectTitle", default)]
    project_title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GetCurseforgeProjectArgs {
    #[serde(alias = "projectId")]
    project_id: String,
}

#[derive(Debug, Deserialize)]
struct ExportPresetsJsonArgs {
    #[serde(alias = "outputPath")]
    output_path: String,
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ImportPresetsJsonArgs {
    #[serde(alias = "inputPath")]
    input_path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SearchDiscoverContentArgs {
    query: String,
    #[serde(default)]
    loaders: Vec<String>,
    #[serde(alias = "gameVersion", default)]
    game_version: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    index: String, // relevance | downloads | follows | updated | newest
    limit: usize,
    offset: usize,
    source: String,      // modrinth | curseforge | all
    #[serde(alias = "contentType")]
    content_type: String, // mods | modpacks | resourcepacks | datapacks | shaders
}

#[derive(Debug, Deserialize)]
struct InstallCurseforgeModArgs {
    #[serde(alias = "instanceId")]
    instance_id: String,
    #[serde(alias = "projectId")]
    project_id: String,
    #[serde(alias = "projectTitle", default)]
    project_title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModrinthProjectResponse {
    title: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthVersionFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: Option<bool>,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthDependency {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    version_id: Option<String>,
    #[serde(default)]
    dependency_type: String, // required | optional | incompatible | embedded
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthVersion {
    #[serde(default)]
    project_id: String,
    id: String,
    version_number: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
    date_published: String,
    #[serde(default)]
    dependencies: Vec<ModrinthDependency>,
    #[serde(default)]
    files: Vec<ModrinthVersionFile>,
}

#[derive(Debug, Clone)]
struct ResolvedInstallMod {
    project_id: String,
    version: ModrinthVersion,
    file: ModrinthVersionFile,
}

#[derive(Debug, Deserialize)]
struct CurseforgePagination {
    #[serde(default)]
    #[serde(rename = "totalCount")]
    total_count: usize,
}

#[derive(Debug, Deserialize)]
struct CurseforgeSearchResponse {
    data: Vec<CurseforgeMod>,
    #[serde(default)]
    pagination: Option<CurseforgePagination>,
}

#[derive(Debug, Deserialize)]
struct CurseforgeModResponse {
    data: CurseforgeMod,
}

#[derive(Debug, Deserialize)]
struct CurseforgeFilesResponse {
    data: Vec<CurseforgeFile>,
}

#[derive(Debug, Deserialize)]
struct CurseforgeDownloadUrlResponse {
    data: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseforgeAuthor {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseforgeLogo {
    url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseforgeCategory {
    #[serde(default)]
    name: String,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseforgeFileHash {
    #[serde(default)]
    value: String,
    #[serde(default)]
    algo: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseforgeMod {
    id: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    #[serde(rename = "downloadCount")]
    download_count: f64,
    #[serde(default)]
    #[serde(rename = "dateModified")]
    date_modified: String,
    #[serde(default)]
    authors: Vec<CurseforgeAuthor>,
    #[serde(default)]
    categories: Vec<CurseforgeCategory>,
    #[serde(default)]
    logo: Option<CurseforgeLogo>,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseforgeFile {
    id: i64,
    #[serde(default)]
    #[serde(rename = "displayName")]
    display_name: String,
    #[serde(default)]
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(default)]
    #[serde(rename = "fileDate")]
    file_date: String,
    #[serde(default)]
    #[serde(rename = "downloadUrl")]
    download_url: Option<String>,
    #[serde(default)]
    #[serde(rename = "gameVersions")]
    game_versions: Vec<String>,
    #[serde(default)]
    hashes: Vec<CurseforgeFileHash>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthModpackIndex {
    #[serde(default)]
    files: Vec<ModrinthModpackIndexFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct ModrinthModpackIndexFile {
    #[serde(default)]
    path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseforgeModpackManifest {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    files: Vec<CurseforgeModpackManifestFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct CurseforgeModpackManifestFile {
    #[serde(rename = "projectID")]
    project_id: i64,
    #[serde(rename = "fileID")]
    file_id: i64,
}

#[derive(Debug, Clone, Serialize)]
struct InstallPlanPreview {
    total_mods: usize,
    dependency_mods: usize,
    will_install_mods: usize,
}

#[derive(Debug, Clone, Serialize)]
struct ModUpdateInfo {
    project_id: String,
    name: String,
    current_version_id: String,
    current_version_number: String,
    latest_version_id: String,
    latest_version_number: String,
}

#[derive(Debug, Clone, Serialize)]
struct ModUpdateCheckResult {
    checked_mods: usize,
    update_count: usize,
    updates: Vec<ModUpdateInfo>,
}

#[derive(Debug, Clone, Serialize)]
struct UpdateAllResult {
    checked_mods: usize,
    updated_mods: usize,
}

#[derive(Debug, Clone, Serialize)]
struct LaunchResult {
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    launch_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prism_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prism_root: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum LaunchMethod {
    Prism,
    Native,
}

impl Default for LaunchMethod {
    fn default() -> Self {
        LaunchMethod::Native
    }
}

impl LaunchMethod {
    fn as_str(&self) -> &'static str {
        match self {
            LaunchMethod::Prism => "prism",
            LaunchMethod::Native => "native",
        }
    }

    fn parse(v: &str) -> Option<Self> {
        let x = v.trim().to_lowercase();
        match x.as_str() {
            "prism" => Some(LaunchMethod::Prism),
            "native" => Some(LaunchMethod::Native),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct LauncherSettings {
    default_launch_method: LaunchMethod,
    java_path: String,
    oauth_client_id: String,
    #[serde(default = "default_update_check_cadence")]
    update_check_cadence: String,
    #[serde(default = "default_update_auto_apply_mode")]
    update_auto_apply_mode: String,
    #[serde(default = "default_update_apply_scope")]
    update_apply_scope: String,
    selected_account_id: Option<String>,
}

impl Default for LauncherSettings {
    fn default() -> Self {
        Self {
            default_launch_method: LaunchMethod::Native,
            java_path: String::new(),
            oauth_client_id: String::new(),
            update_check_cadence: default_update_check_cadence(),
            update_auto_apply_mode: default_update_auto_apply_mode(),
            update_apply_scope: default_update_apply_scope(),
            selected_account_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherAccount {
    id: String,
    username: String,
    added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct LauncherTokenFallbackStore {
    refresh_tokens: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
struct BeginMicrosoftLoginResult {
    session_id: String,
    auth_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verification_uri: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct MicrosoftLoginState {
    status: String, // pending | success | error
    message: Option<String>,
    account: Option<LauncherAccount>,
}

#[derive(Debug, Clone, Serialize)]
struct RunningInstance {
    launch_id: String,
    instance_id: String,
    instance_name: String,
    method: String,
    pid: u32,
    started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ExportModsResult {
    output_path: String,
    files_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct RollbackResult {
    snapshot_id: String,
    created_at: String,
    restored_files: usize,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct PresetsJsonIoResult {
    path: String,
    items: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotMeta {
    id: String,
    created_at: String,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
struct DiscoverSearchHit {
    source: String, // modrinth | curseforge
    project_id: String,
    title: String,
    description: String,
    author: String,
    downloads: u64,
    follows: u64,
    icon_url: Option<String>,
    categories: Vec<String>,
    versions: Vec<String>,
    date_modified: String,
    content_type: String, // mods | shaderpacks | resourcepacks | datapacks | modpacks
    slug: Option<String>,
    external_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct DiscoverSearchResult {
    hits: Vec<DiscoverSearchHit>,
    offset: usize,
    limit: usize,
    total_hits: usize,
}

#[derive(Debug, Clone, Serialize)]
struct CurseforgeProjectFileDetail {
    file_id: String,
    display_name: String,
    file_name: String,
    file_date: String,
    game_versions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct CurseforgeProjectDetail {
    source: String, // curseforge
    project_id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    slug: Option<String>,
    summary: String,
    description: String,
    author_names: Vec<String>,
    downloads: u64,
    categories: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
    date_modified: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    external_url: Option<String>,
    files: Vec<CurseforgeProjectFileDetail>,
}

#[derive(Debug, Clone, Serialize)]
struct OpenInstancePathResult {
    target: String,
    path: String,
}

#[derive(Debug, Clone, Serialize)]
struct RevealConfigEditorFileResult {
    opened_path: String,
    revealed_file: bool,
    virtual_file: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct LogLineDto {
    raw: String,
    line_no: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    severity: Option<String>,
    source: String,
}

#[derive(Debug, Clone, Serialize)]
struct ReadInstanceLogsResult {
    source: String,
    path: String,
    available: bool,
    total_lines: usize,
    returned_lines: usize,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_line_no: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_line_no: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_before_line: Option<u64>,
    lines: Vec<LogLineDto>,
    updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct InstanceWorld {
    id: String,
    name: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_backup_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_backup_at: Option<String>,
    #[serde(default)]
    backup_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct WorldConfigFileEntry {
    path: String,
    size_bytes: u64,
    modified_at: i64,
    editable: bool,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    readonly_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ReadWorldConfigFileResult {
    path: String,
    editable: bool,
    kind: String,
    size_bytes: u64,
    modified_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    readonly_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct WriteWorldConfigFileResult {
    path: String,
    size_bytes: u64,
    modified_at: i64,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct WorldRollbackResult {
    world_id: String,
    backup_id: String,
    created_at: String,
    restored_files: usize,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorldBackupMeta {
    id: String,
    world_id: String,
    created_at: String,
    reason: String,
    files_count: usize,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
struct PresetApplyPreview {
    valid: bool,
    installable_entries: usize,
    skipped_disabled_entries: usize,
    missing_world_targets: Vec<String>,
    provider_warnings: Vec<String>,
    duplicate_entries: usize,
}

#[derive(Debug, Clone, Serialize)]
struct PresetApplyResult {
    message: String,
    installed_entries: usize,
    skipped_entries: usize,
    failed_entries: usize,
    snapshot_id: Option<String>,
    by_content_type: HashMap<String, usize>,
}

#[derive(Debug, Clone, Serialize)]
struct AccountCosmeticSummary {
    id: String,
    state: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct AccountDiagnostics {
    status: String, // connected | not_connected | error
    last_refreshed_at: String,
    selected_account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<LauncherAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    minecraft_uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    minecraft_username: Option<String>,
    entitlements_ok: bool,
    token_exchange_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    skin_url: Option<String>,
    cape_count: usize,
    skins: Vec<AccountCosmeticSummary>,
    capes: Vec<AccountCosmeticSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    client_id_source: String,
}

struct RunningProcess {
    meta: RunningInstance,
    child: Arc<Mutex<Child>>,
    log_path: Option<PathBuf>,
}

#[derive(Clone, Default)]
struct AppState {
    login_sessions: Arc<Mutex<HashMap<String, MicrosoftLoginState>>>,
    running: Arc<Mutex<HashMap<String, RunningProcess>>>,
    launch_cancelled: Arc<Mutex<HashSet<String>>>,
}

fn app_instances_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path_resolver()
        .app_data_dir()
        .ok_or("Failed to resolve app data dir")?;
    Ok(base.join("instances"))
}

fn index_path(instances_dir: &Path) -> PathBuf {
    instances_dir.join("instances.json")
}

fn lock_path(instances_dir: &Path, instance_id: &str) -> PathBuf {
    instances_dir.join(instance_id).join("lock.json")
}

fn launcher_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path_resolver()
        .app_data_dir()
        .ok_or("Failed to resolve app data dir")?;
    Ok(base.join("launcher"))
}

fn launcher_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(launcher_dir(app)?.join("settings.json"))
}

fn launcher_accounts_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(launcher_dir(app)?.join("accounts.json"))
}

fn launcher_token_fallback_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(launcher_dir(app)?.join(LAUNCHER_TOKEN_FALLBACK_FILE))
}

fn launcher_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(launcher_dir(app)?.join("cache"))
}

fn keyring_username_for_account(account_id: &str) -> String {
    format!("msa_refresh_{account_id}")
}

fn read_launcher_settings(app: &tauri::AppHandle) -> Result<LauncherSettings, String> {
    let p = launcher_settings_path(app)?;
    if !p.exists() {
        return Ok(LauncherSettings::default());
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("read launcher settings failed: {e}"))?;
    let mut settings: LauncherSettings =
        serde_json::from_str(&raw).map_err(|e| format!("parse launcher settings failed: {e}"))?;
    settings.update_check_cadence = normalize_update_check_cadence(&settings.update_check_cadence);
    settings.update_auto_apply_mode = normalize_update_auto_apply_mode(&settings.update_auto_apply_mode);
    settings.update_apply_scope = normalize_update_apply_scope(&settings.update_apply_scope);
    Ok(settings)
}

fn write_launcher_settings(app: &tauri::AppHandle, settings: &LauncherSettings) -> Result<(), String> {
    let p = launcher_settings_path(app)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir launcher dir failed: {e}"))?;
    }
    let s = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("serialize launcher settings failed: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write launcher settings failed: {e}"))
}

fn read_launcher_accounts(app: &tauri::AppHandle) -> Result<Vec<LauncherAccount>, String> {
    let p = launcher_accounts_path(app)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("read launcher accounts failed: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse launcher accounts failed: {e}"))
}

fn write_launcher_accounts(app: &tauri::AppHandle, accounts: &[LauncherAccount]) -> Result<(), String> {
    let p = launcher_accounts_path(app)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir launcher dir failed: {e}"))?;
    }
    let s = serde_json::to_string_pretty(accounts)
        .map_err(|e| format!("serialize launcher accounts failed: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write launcher accounts failed: {e}"))
}

fn read_token_fallback_store(app: &tauri::AppHandle) -> Result<LauncherTokenFallbackStore, String> {
    let p = launcher_token_fallback_path(app)?;
    if !p.exists() {
        return Ok(LauncherTokenFallbackStore::default());
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("read launcher token fallback failed: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse launcher token fallback failed: {e}"))
}

fn write_token_fallback_store(
    app: &tauri::AppHandle,
    store: &LauncherTokenFallbackStore,
) -> Result<(), String> {
    let p = launcher_token_fallback_path(app)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir launcher dir failed: {e}"))?;
    }
    let s = serde_json::to_string_pretty(store)
        .map_err(|e| format!("serialize launcher token fallback failed: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write launcher token fallback failed: {e}"))
}

fn token_fallback_set_refresh_token(
    app: &tauri::AppHandle,
    account_id: &str,
    refresh_token: &str,
) -> Result<(), String> {
    let mut store = read_token_fallback_store(app)?;
    store
        .refresh_tokens
        .insert(account_id.to_string(), refresh_token.to_string());
    write_token_fallback_store(app, &store)
}

fn token_fallback_delete_refresh_token(app: &tauri::AppHandle, account_id: &str) -> Result<(), String> {
    let mut store = read_token_fallback_store(app)?;
    store.refresh_tokens.remove(account_id);
    write_token_fallback_store(app, &store)
}

fn token_fallback_get_refresh_token(
    app: &tauri::AppHandle,
    account: &LauncherAccount,
    accounts: &[LauncherAccount],
) -> Result<Option<String>, String> {
    let store = read_token_fallback_store(app)?;
    let usernames = keyring_username_candidates(account, accounts);
    if let Some(token) = usernames
        .iter()
        .find_map(|key| store.refresh_tokens.get(key))
        .cloned()
    {
        return Ok(Some(token));
    }
    Ok(None)
}

fn read_index(instances_dir: &Path) -> Result<InstanceIndex, String> {
    let p = index_path(instances_dir);
    if !p.exists() {
        return Ok(InstanceIndex::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("read index failed: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("parse index failed: {e}"))
}

fn default_true() -> bool {
    true
}

fn default_memory_mb() -> u32 {
    4096
}

fn default_graphics_preset() -> String {
    "Balanced".to_string()
}

fn default_world_backup_interval_minutes() -> u32 {
    DEFAULT_WORLD_BACKUP_INTERVAL_MINUTES
}

fn default_world_backup_retention_count() -> u32 {
    DEFAULT_WORLD_BACKUP_RETENTION_COUNT
}

fn default_update_check_cadence() -> String {
    "daily".to_string()
}

fn normalize_update_check_cadence(input: &str) -> String {
    match input.trim().to_lowercase().as_str() {
        "off" => "off".to_string(),
        "hourly" => "hourly".to_string(),
        "every_3_hours" | "3h" => "every_3_hours".to_string(),
        "every_6_hours" | "6h" => "every_6_hours".to_string(),
        "every_12_hours" | "12h" => "every_12_hours".to_string(),
        "weekly" => "weekly".to_string(),
        _ => "daily".to_string(),
    }
}

fn default_update_auto_apply_mode() -> String {
    "never".to_string()
}

fn normalize_update_auto_apply_mode(input: &str) -> String {
    match input.trim().to_lowercase().as_str() {
        "opt_in_instances" | "opt-in" | "instance_opt_in" => "opt_in_instances".to_string(),
        "all_instances" | "all" => "all_instances".to_string(),
        _ => "never".to_string(),
    }
}

fn default_update_apply_scope() -> String {
    "scheduled_only".to_string()
}

fn normalize_update_apply_scope(input: &str) -> String {
    match input.trim().to_lowercase().as_str() {
        "scheduled_and_manual" | "scheduled+manual" | "scheduled_and_check_now" => {
            "scheduled_and_manual".to_string()
        }
        _ => "scheduled_only".to_string(),
    }
}

fn default_content_type_mods() -> String {
    "mods".to_string()
}

fn default_target_scope_instance() -> String {
    "instance".to_string()
}

fn normalize_lock_content_type(input: &str) -> String {
    match input.trim().to_lowercase().as_str() {
        "mods" | "mod" => "mods".to_string(),
        "resourcepacks" | "resourcepack" => "resourcepacks".to_string(),
        "shaderpacks" | "shaderpack" | "shaders" | "shader" => "shaderpacks".to_string(),
        "datapacks" | "datapack" => "datapacks".to_string(),
        "modpacks" | "modpack" => "modpacks".to_string(),
        _ => "mods".to_string(),
    }
}

fn normalize_target_scope(input: &str) -> String {
    match input.trim().to_lowercase().as_str() {
        "world" => "world".to_string(),
        _ => "instance".to_string(),
    }
}

fn write_index(instances_dir: &Path, idx: &InstanceIndex) -> Result<(), String> {
    fs::create_dir_all(instances_dir).map_err(|e| format!("mkdir instances dir failed: {e}"))?;
    let p = index_path(instances_dir);
    let s =
        serde_json::to_string_pretty(idx).map_err(|e| format!("serialize index failed: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write index failed: {e}"))
}

fn read_lockfile(instances_dir: &Path, instance_id: &str) -> Result<Lockfile, String> {
    let p = lock_path(instances_dir, instance_id);
    if !p.exists() {
        return Ok(Lockfile::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| format!("read lockfile failed: {e}"))?;
    let mut lock: Lockfile = serde_json::from_str(&s).map_err(|e| format!("parse lockfile failed: {e}"))?;
    if lock.version < 2 {
        lock.version = 2;
    }
    for entry in &mut lock.entries {
        entry.content_type = normalize_lock_content_type(&entry.content_type);
        entry.target_scope = normalize_target_scope(&entry.target_scope);
        if entry.content_type != "datapacks" {
            entry.target_worlds.clear();
            if entry.target_scope == "world" {
                entry.target_scope = "instance".to_string();
            }
        } else if entry.target_scope != "world" {
            entry.target_scope = "world".to_string();
        }
    }
    Ok(lock)
}

fn write_lockfile(instances_dir: &Path, instance_id: &str, lock: &Lockfile) -> Result<(), String> {
    let p = lock_path(instances_dir, instance_id);
    let parent = p.parent().ok_or("invalid lockfile path")?.to_path_buf();
    fs::create_dir_all(parent).map_err(|e| format!("mkdir instance dir failed: {e}"))?;
    let mut normalized = lock.clone();
    normalized.version = 2;
    for entry in &mut normalized.entries {
        entry.content_type = normalize_lock_content_type(&entry.content_type);
        entry.target_scope = normalize_target_scope(&entry.target_scope);
        if entry.content_type != "datapacks" {
            entry.target_worlds.clear();
            if entry.target_scope == "world" {
                entry.target_scope = "instance".to_string();
            }
        }
    }
    let s = serde_json::to_string_pretty(&normalized)
        .map_err(|e| format!("serialize lockfile failed: {e}"))?;
    fs::write(&p, s).map_err(|e| format!("write lockfile failed: {e}"))
}

fn snapshots_dir(instance_dir: &Path) -> PathBuf {
    instance_dir.join("snapshots")
}

fn snapshot_content_zip_path(snapshot_dir: &Path) -> PathBuf {
    snapshot_dir.join("content.zip")
}

fn snapshot_lock_path(snapshot_dir: &Path) -> PathBuf {
    snapshot_dir.join("lock.json")
}

fn snapshot_meta_path(snapshot_dir: &Path) -> PathBuf {
    snapshot_dir.join("meta.json")
}

fn snapshot_allowed_root(name: &str) -> bool {
    matches!(name, "mods" | "resourcepacks" | "shaderpacks" | "saves")
}

fn add_dir_recursive_to_zip(
    zip: &mut zip::ZipWriter<File>,
    root: &Path,
    current: &Path,
    opts: FileOptions,
    count: &mut usize,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(current).map_err(|e| format!("read dir '{}' failed: {e}", current.display()))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read dir entry failed: {e}"))?;
        let path = ent.path();
        let meta = ent
            .metadata()
            .map_err(|e| format!("read metadata '{}' failed: {e}", path.display()))?;
        if meta.is_dir() {
            add_dir_recursive_to_zip(zip, root, &path, opts, count)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "failed to compute relative snapshot path".to_string())?;
        let rel_text = rel
            .to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        if rel_text.is_empty() {
            continue;
        }
        zip.start_file(rel_text, opts)
            .map_err(|e| format!("zip start file failed: {e}"))?;
        let data = fs::read(&path).map_err(|e| format!("read snapshot source file failed: {e}"))?;
        zip.write_all(&data)
            .map_err(|e| format!("zip write failed: {e}"))?;
        *count += 1;
    }
    Ok(())
}

fn create_instance_content_zip(instance_dir: &Path, zip_path: &Path) -> Result<usize, String> {
    let parent = zip_path
        .parent()
        .ok_or_else(|| "invalid snapshot zip path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir snapshot dir failed: {e}"))?;
    let file = File::create(zip_path).map_err(|e| format!("create snapshot zip failed: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut count = 0usize;

    for dir_name in ["mods", "resourcepacks", "shaderpacks"] {
        let dir = instance_dir.join(dir_name);
        add_dir_recursive_to_zip(&mut zip, instance_dir, &dir, opts, &mut count)?;
    }
    let saves = instance_dir.join("saves");
    if saves.exists() {
        let worlds = fs::read_dir(&saves).map_err(|e| format!("read saves dir failed: {e}"))?;
        for world in worlds {
            let world = world.map_err(|e| format!("read saves entry failed: {e}"))?;
            let world_path = world.path();
            if !world_path.is_dir() {
                continue;
            }
            let dp_dir = world_path.join("datapacks");
            add_dir_recursive_to_zip(&mut zip, instance_dir, &dp_dir, opts, &mut count)?;
        }
    }

    zip.finish()
        .map_err(|e| format!("finalize snapshot zip failed: {e}"))?;
    Ok(count)
}

fn restore_instance_content_zip(zip_path: &Path, instance_dir: &Path) -> Result<usize, String> {
    for dir_name in ["mods", "resourcepacks", "shaderpacks"] {
        let dir = instance_dir.join(dir_name);
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("clear '{}' failed: {e}", dir.display()))?;
        }
        fs::create_dir_all(&dir).map_err(|e| format!("mkdir '{}' failed: {e}", dir.display()))?;
    }
    let saves = instance_dir.join("saves");
    if saves.exists() {
        let worlds = fs::read_dir(&saves).map_err(|e| format!("read saves dir failed: {e}"))?;
        for world in worlds {
            let world = world.map_err(|e| format!("read saves entry failed: {e}"))?;
            let world_path = world.path();
            if !world_path.is_dir() {
                continue;
            }
            let dp_dir = world_path.join("datapacks");
            if dp_dir.exists() {
                fs::remove_dir_all(&dp_dir).map_err(|e| format!("clear datapacks failed: {e}"))?;
            }
            fs::create_dir_all(&dp_dir).map_err(|e| format!("mkdir datapacks failed: {e}"))?;
        }
    }
    if !zip_path.exists() {
        return Ok(0);
    }

    let file = File::open(zip_path).map_err(|e| format!("open snapshot zip failed: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("read snapshot zip failed: {e}"))?;
    let mut count = 0usize;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read snapshot zip entry failed: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let rel = name.to_string_lossy().replace('\\', "/");
        let parts: Vec<&str> = rel.split('/').filter(|p| !p.trim().is_empty()).collect();
        if parts.is_empty() || !snapshot_allowed_root(parts[0]) {
            continue;
        }
        if parts[0] == "saves" && (parts.len() < 4 || parts[2] != "datapacks") {
            continue;
        }
        let out_path = instance_dir.join(parts.join("/"));
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir restore parent failed: {e}"))?;
        }
        let mut out = File::create(&out_path).map_err(|e| format!("restore mods file failed: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("restore copy failed: {e}"))?;
        count += 1;
    }

    Ok(count)
}

fn read_snapshot_meta(snapshot_dir: &Path) -> Result<SnapshotMeta, String> {
    let raw = fs::read_to_string(snapshot_meta_path(snapshot_dir))
        .map_err(|e| format!("read snapshot metadata failed: {e}"))?;
    serde_json::from_str::<SnapshotMeta>(&raw)
        .map_err(|e| format!("parse snapshot metadata failed: {e}"))
}

fn write_snapshot_meta(snapshot_dir: &Path, meta: &SnapshotMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("serialize snapshot metadata failed: {e}"))?;
    fs::write(snapshot_meta_path(snapshot_dir), raw)
        .map_err(|e| format!("write snapshot metadata failed: {e}"))
}

fn list_snapshots(instance_dir: &Path) -> Result<Vec<SnapshotMeta>, String> {
    let root = snapshots_dir(instance_dir);
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| format!("read snapshots dir failed: {e}"))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read snapshot dir entry failed: {e}"))?;
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok(meta) = read_snapshot_meta(&path) {
            out.push(meta);
        }
    }
    out.sort_by(|a, b| created_at_sort_key(&b.created_at).cmp(&created_at_sort_key(&a.created_at)));
    Ok(out)
}

fn prune_old_snapshots(instance_dir: &Path, keep: usize) -> Result<(), String> {
    if keep == 0 {
        return Ok(());
    }
    let metas = list_snapshots(instance_dir)?;
    if metas.len() <= keep {
        return Ok(());
    }
    let root = snapshots_dir(instance_dir);
    for meta in metas.iter().skip(keep) {
        let dir = root.join(&meta.id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("remove old snapshot failed: {e}"))?;
        }
    }
    Ok(())
}

fn create_instance_snapshot(
    instances_dir: &Path,
    instance_id: &str,
    reason: &str,
) -> Result<SnapshotMeta, String> {
    let instance_dir = instances_dir.join(instance_id);
    let lock = read_lockfile(instances_dir, instance_id)?;
    let snapshot_id = format!("snap_{}", now_millis());
    let snapshot_dir = snapshots_dir(&instance_dir).join(&snapshot_id);
    fs::create_dir_all(&snapshot_dir).map_err(|e| format!("mkdir snapshot failed: {e}"))?;

    let lock_raw =
        serde_json::to_string_pretty(&lock).map_err(|e| format!("serialize snapshot lock failed: {e}"))?;
    fs::write(snapshot_lock_path(&snapshot_dir), lock_raw)
        .map_err(|e| format!("write snapshot lock failed: {e}"))?;

    let _ = create_instance_content_zip(&instance_dir, &snapshot_content_zip_path(&snapshot_dir))?;
    let meta = SnapshotMeta {
        id: snapshot_id,
        created_at: now_iso(),
        reason: reason.to_string(),
    };
    write_snapshot_meta(&snapshot_dir, &meta)?;
    prune_old_snapshots(&instance_dir, 20)?;
    Ok(meta)
}

fn world_backups_dir(instance_dir: &Path) -> PathBuf {
    instance_dir.join("world_backups")
}

fn world_backup_meta_path(backup_dir: &Path) -> PathBuf {
    backup_dir.join("meta.json")
}

fn world_backup_zip_path(backup_dir: &Path) -> PathBuf {
    backup_dir.join("world.zip")
}

fn read_world_backup_meta(backup_dir: &Path) -> Result<WorldBackupMeta, String> {
    let raw = fs::read_to_string(world_backup_meta_path(backup_dir))
        .map_err(|e| format!("read world backup metadata failed: {e}"))?;
    serde_json::from_str::<WorldBackupMeta>(&raw)
        .map_err(|e| format!("parse world backup metadata failed: {e}"))
}

fn write_world_backup_meta(backup_dir: &Path, meta: &WorldBackupMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("serialize world backup metadata failed: {e}"))?;
    fs::write(world_backup_meta_path(backup_dir), raw)
        .map_err(|e| format!("write world backup metadata failed: {e}"))
}

fn list_world_backups(instance_dir: &Path) -> Result<Vec<WorldBackupMeta>, String> {
    let root = world_backups_dir(instance_dir);
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| format!("read world backups dir failed: {e}"))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read world backup dir entry failed: {e}"))?;
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok(meta) = read_world_backup_meta(&path) {
            out.push(meta);
        }
    }
    out.sort_by(|a, b| created_at_sort_key(&b.created_at).cmp(&created_at_sort_key(&a.created_at)));
    Ok(out)
}

fn prune_old_world_backups(instance_dir: &Path, world_id: &str, keep: usize) -> Result<(), String> {
    if keep == 0 {
        return Ok(());
    }
    let metas = list_world_backups(instance_dir)?;
    let root = world_backups_dir(instance_dir);
    let mut seen = 0usize;
    for meta in metas {
        if meta.world_id != world_id {
            continue;
        }
        seen += 1;
        if seen <= keep {
            continue;
        }
        let dir = root.join(&meta.id);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("remove old world backup failed: {e}"))?;
        }
    }
    Ok(())
}

fn add_world_dir_recursive_to_zip(
    zip: &mut zip::ZipWriter<File>,
    root: &Path,
    current: &Path,
    opts: FileOptions,
    file_count: &mut usize,
    total_bytes: &mut u64,
) -> Result<(), String> {
    if !current.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(current).map_err(|e| format!("read dir '{}' failed: {e}", current.display()))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read dir entry failed: {e}"))?;
        let path = ent.path();
        let meta = match ent.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.is_dir() {
            add_world_dir_recursive_to_zip(zip, root, &path, opts, file_count, total_bytes)?;
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("session.lock"))
            .unwrap_or(false)
        {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "failed to compute relative world backup path".to_string())?;
        let rel_text = rel
            .to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        if rel_text.is_empty() {
            continue;
        }
        let data = match fs::read(&path) {
            Ok(data) => data,
            Err(_) => continue,
        };
        zip.start_file(rel_text, opts)
            .map_err(|e| format!("world backup zip start file failed: {e}"))?;
        zip.write_all(&data)
            .map_err(|e| format!("world backup zip write failed: {e}"))?;
        *file_count += 1;
        *total_bytes += data.len() as u64;
    }
    Ok(())
}

fn create_world_backup_zip(world_dir: &Path, zip_path: &Path) -> Result<(usize, u64), String> {
    let parent = zip_path
        .parent()
        .ok_or_else(|| "invalid world backup zip path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir world backup dir failed: {e}"))?;
    let file = File::create(zip_path).map_err(|e| format!("create world backup zip failed: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    add_world_dir_recursive_to_zip(&mut zip, world_dir, world_dir, opts, &mut file_count, &mut total_bytes)?;
    zip.finish()
        .map_err(|e| format!("finalize world backup zip failed: {e}"))?;
    Ok((file_count, total_bytes))
}

fn restore_world_backup_zip(zip_path: &Path, world_dir: &Path) -> Result<usize, String> {
    if !zip_path.exists() {
        return Err("World backup archive is missing".to_string());
    }
    if world_dir.exists() {
        fs::remove_dir_all(world_dir).map_err(|e| format!("clear world dir failed: {e}"))?;
    }
    fs::create_dir_all(world_dir).map_err(|e| format!("mkdir world dir failed: {e}"))?;

    let file = File::open(zip_path).map_err(|e| format!("open world backup zip failed: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("read world backup zip failed: {e}"))?;
    let mut count = 0usize;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read world backup zip entry failed: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else {
            continue;
        };
        let rel = name.to_string_lossy().replace('\\', "/");
        let parts: Vec<&str> = rel.split('/').filter(|p| !p.trim().is_empty()).collect();
        if parts.is_empty() {
            continue;
        }
        let out_path = world_dir.join(parts.join("/"));
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir world restore parent failed: {e}"))?;
        }
        let mut out = File::create(&out_path).map_err(|e| format!("restore world file failed: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("restore world copy failed: {e}"))?;
        count += 1;
    }

    Ok(count)
}

fn create_world_backup_for_world(
    instance_dir: &Path,
    world_id: &str,
    reason: &str,
    keep_per_world: usize,
) -> Result<WorldBackupMeta, String> {
    let world_name = world_id.trim();
    if world_name.is_empty() {
        return Err("World name is empty".to_string());
    }
    let world_dir = instance_dir.join("saves").join(world_name);
    if !world_dir.exists() || !world_dir.is_dir() {
        return Err(format!("World '{}' not found", world_name));
    }

    let slug_base = sanitize_name(world_name).replace(' ', "_");
    let slug = if slug_base.is_empty() {
        "world".to_string()
    } else {
        slug_base
    };
    let backup_id = format!("wb_{}_{}", slug, now_millis());
    let backup_dir = world_backups_dir(instance_dir).join(&backup_id);
    fs::create_dir_all(&backup_dir).map_err(|e| format!("mkdir world backup failed: {e}"))?;
    let (files_count, total_bytes) = create_world_backup_zip(&world_dir, &world_backup_zip_path(&backup_dir))?;
    let meta = WorldBackupMeta {
        id: backup_id,
        world_id: world_name.to_string(),
        created_at: now_iso(),
        reason: reason.to_string(),
        files_count,
        total_bytes,
    };
    write_world_backup_meta(&backup_dir, &meta)?;
    prune_old_world_backups(instance_dir, world_name, keep_per_world)?;
    Ok(meta)
}

fn create_world_backups_for_instance(
    instances_dir: &Path,
    instance_id: &str,
    reason: &str,
    keep_per_world: usize,
) -> Result<usize, String> {
    let instance_dir = instances_dir.join(instance_id);
    let worlds = list_instance_world_names(&instance_dir)?;
    if worlds.is_empty() {
        return Ok(0);
    }
    let mut created = 0usize;
    let mut last_error: Option<String> = None;
    for world in worlds {
        match create_world_backup_for_world(&instance_dir, &world, reason, keep_per_world) {
            Ok(_) => created += 1,
            Err(e) => last_error = Some(e),
        }
    }
    if created == 0 {
        if let Some(err) = last_error {
            return Err(err);
        }
    }
    Ok(created)
}

fn sanitize_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
            out.push(c);
        }
    }
    out.trim().to_string()
}

fn normalize_instance_settings(mut settings: InstanceSettings) -> InstanceSettings {
    settings.notes = settings.notes.trim().to_string();
    settings.java_path = settings.java_path.trim().to_string();
    settings.jvm_args = settings.jvm_args.trim().to_string();
    settings.graphics_preset = match settings.graphics_preset.trim() {
        "Performance" | "Balanced" | "Quality" => settings.graphics_preset.trim().to_string(),
        _ => default_graphics_preset(),
    };
    settings.memory_mb = settings.memory_mb.clamp(512, 65536);
    settings.world_backup_interval_minutes = settings.world_backup_interval_minutes.clamp(5, 15);
    settings.world_backup_retention_count = settings.world_backup_retention_count.clamp(1, 2);
    settings
}

fn parse_loader_for_instance(input: &str) -> Option<String> {
    match input.trim().to_lowercase().as_str() {
        "vanilla" => Some("vanilla".to_string()),
        "fabric" => Some("fabric".to_string()),
        "forge" => Some("forge".to_string()),
        "neoforge" => Some("neoforge".to_string()),
        "quilt" => Some("quilt".to_string()),
        _ => None,
    }
}

fn sanitize_filename(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c == '/' || c == '\\' || c.is_control() {
            out.push('_');
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

fn allowed_icon_extension(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif")
}

fn image_mime_for_extension(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn write_instance_meta(instance_dir: &Path, inst: &Instance) -> Result<(), String> {
    let meta_path = instance_dir.join("meta.json");
    let meta = serde_json::to_string_pretty(inst).map_err(|e| format!("serialize meta failed: {e}"))?;
    fs::write(meta_path, meta).map_err(|e| format!("write meta failed: {e}"))
}

fn clear_instance_icon_files(instance_dir: &Path) -> Result<(), String> {
    if !instance_dir.exists() {
        return Ok(());
    }
    let entries = fs::read_dir(instance_dir).map_err(|e| format!("read instance dir failed: {e}"))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read instance entry failed: {e}"))?;
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if !lower.starts_with("icon.") {
            continue;
        }
        fs::remove_file(&path).map_err(|e| format!("remove old icon failed: {e}"))?;
    }
    Ok(())
}

fn copy_instance_icon_to_dir(icon_source: &Path, instance_dir: &Path) -> Result<String, String> {
    if !icon_source.exists() || !icon_source.is_file() {
        return Err("selected icon file does not exist".to_string());
    }

    let ext = icon_source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.trim().to_ascii_lowercase())
        .ok_or_else(|| "icon file must have an extension".to_string())?;
    if !allowed_icon_extension(&ext) {
        return Err("icon must be png/jpg/jpeg/webp/bmp/gif".to_string());
    }

    clear_instance_icon_files(instance_dir)?;
    let target = instance_dir.join(format!("icon.{ext}"));
    fs::copy(icon_source, &target).map_err(|e| format!("copy icon failed: {e}"))?;
    Ok(target.display().to_string())
}

fn now_iso() -> String {
    Local::now().to_rfc3339()
}

fn created_at_sort_key(raw: &str) -> i64 {
    let text = raw.trim();
    if let Some(rest) = text.strip_prefix("unix:") {
        if let Ok(secs) = rest.trim().parse::<i64>() {
            return secs;
        }
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(text) {
        return dt.timestamp();
    }
    0
}

fn gen_id() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("inst_{n}")
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn modified_millis(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|stamp| stamp.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_relative_file_path(input: &str) -> Result<String, String> {
    let trimmed = input.trim().replace('\\', "/");
    let mut parts: Vec<String> = Vec::new();
    for part in trimmed.split('/') {
        let clean = part.trim();
        if clean.is_empty() || clean == "." {
            continue;
        }
        if clean == ".." {
            return Err("Path traversal is not allowed".to_string());
        }
        parts.push(clean.to_string());
    }
    if parts.is_empty() {
        return Err("File path is required".to_string());
    }
    Ok(parts.join("/"))
}

fn world_root_dir(instances_dir: &Path, instance_id: &str, world_id: &str) -> Result<PathBuf, String> {
    let _ = find_instance(instances_dir, instance_id)?;
    let world_name = world_id.trim();
    if world_name.is_empty() {
        return Err("World ID is required".to_string());
    }
    if world_name.contains('/') || world_name.contains('\\') || world_name == "." || world_name == ".." {
        return Err("Invalid world ID".to_string());
    }
    let saves_dir = instances_dir.join(instance_id).join("saves");
    let world_dir = saves_dir.join(world_name);
    if !world_dir.exists() || !world_dir.is_dir() {
        return Err(format!("World '{}' was not found in this instance.", world_name));
    }
    let world_meta = fs::symlink_metadata(&world_dir).map_err(|e| format!("read world path metadata failed: {e}"))?;
    if world_meta.file_type().is_symlink() {
        return Err("Symlinked world folders are not supported for live config editing.".to_string());
    }
    let resolved_world = fs::canonicalize(&world_dir).map_err(|e| format!("resolve world path failed: {e}"))?;
    let resolved_saves = fs::canonicalize(&saves_dir).map_err(|e| format!("resolve saves path failed: {e}"))?;
    let _ = resolved_world
        .strip_prefix(&resolved_saves)
        .map_err(|_| "World path escapes instance saves directory".to_string())?;
    Ok(resolved_world)
}

fn resolve_world_file_path(
    world_root: &Path,
    relative_path: &str,
    must_exist: bool,
) -> Result<(PathBuf, String), String> {
    let normalized = normalize_relative_file_path(relative_path)?;
    let candidate = world_root.join(&normalized);
    if must_exist {
        if !candidate.exists() || !candidate.is_file() {
            return Err("World file was not found".to_string());
        }
        let resolved = fs::canonicalize(&candidate).map_err(|e| format!("resolve world file failed: {e}"))?;
        if resolved
            .strip_prefix(world_root)
            .map_err(|_| "World file path escapes selected world".to_string())?
            .as_os_str()
            .is_empty()
        {
            return Err("Invalid world file path".to_string());
        }
        return Ok((resolved, normalized));
    }
    let parent = candidate
        .parent()
        .ok_or_else(|| "Invalid world file path".to_string())?;
    let resolved_parent = fs::canonicalize(parent).map_err(|e| format!("resolve world file parent failed: {e}"))?;
    let _ = resolved_parent
        .strip_prefix(world_root)
        .map_err(|_| "World file path escapes selected world".to_string())?;
    Ok((candidate, normalized))
}

fn infer_world_file_kind(path: &Path, text_like: bool) -> String {
    let lower = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match lower.as_str() {
        "json" => "json".to_string(),
        "toml" => "toml".to_string(),
        "properties" => "properties".to_string(),
        "txt" => "txt".to_string(),
        "cfg" | "conf" | "ini" | "yaml" | "yml" | "mcmeta" | "lang" | "log" => "text".to_string(),
        "dat" | "nbt" | "mca" | "png" | "jpg" | "jpeg" | "webp" | "gif" | "ogg" | "mp3" | "mp4" => {
            "binary".to_string()
        }
        _ => {
            if text_like {
                "text".to_string()
            } else {
                "binary".to_string()
            }
        }
    }
}

fn file_is_text_like(path: &Path, sample: &[u8]) -> bool {
    if sample.is_empty() {
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        return matches!(
            ext.as_str(),
            "json" | "toml" | "properties" | "txt" | "cfg" | "conf" | "ini" | "yaml" | "yml" | "mcmeta" | "lang" | "log"
        );
    }
    if sample.iter().any(|b| *b == 0) {
        return false;
    }
    std::str::from_utf8(sample).is_ok()
}

fn describe_non_editable_reason(kind: &str, text_like: bool) -> Option<String> {
    if kind == "binary" || !text_like {
        Some("Binary or unsupported file type.".to_string())
    } else {
        None
    }
}

fn format_binary_preview(sample: &[u8], total_bytes: u64, kind: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "Read-only {kind} file\nSize: {total_bytes} bytes\nShowing first {} byte(s)\n\n",
        sample.len()
    ));
    for (line_idx, chunk) in sample.chunks(16).enumerate() {
        let offset = line_idx * 16;
        let mut hex = String::new();
        let mut ascii = String::new();
        for byte in chunk {
            hex.push_str(&format!("{byte:02x} "));
            let ch = if (32..=126).contains(byte) {
                char::from(*byte)
            } else {
                '.'
            };
            ascii.push(ch);
        }
        out.push_str(&format!("{offset:08x}  {:<48} |{}|\n", hex.trim_end(), ascii));
    }
    if (sample.len() as u64) < total_bytes {
        out.push_str("\n... truncated ...");
    }
    out
}

fn infer_local_name(filename: &str) -> String {
    let base = filename.strip_suffix(".jar").unwrap_or(filename);
    let mut out = String::with_capacity(base.len());
    let mut prev_space = false;
    for c in base.chars() {
        let mapped = if c == '_' || c == '-' || c == '.' {
            ' '
        } else {
            c
        };
        if mapped.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(mapped);
            prev_space = false;
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "Local mod".to_string()
    } else {
        trimmed.to_string()
    }
}

fn mod_paths(instance_dir: &Path, filename: &str) -> (PathBuf, PathBuf) {
    let mods_dir = instance_dir.join("mods");
    let enabled = mods_dir.join(filename);
    let disabled = mods_dir.join(format!("{filename}.disabled"));
    (enabled, disabled)
}

fn content_dir_for_type(instance_dir: &Path, content_type: &str) -> PathBuf {
    match normalize_lock_content_type(content_type).as_str() {
        "resourcepacks" => instance_dir.join("resourcepacks"),
        "shaderpacks" => instance_dir.join("shaderpacks"),
        _ => instance_dir.join("mods"),
    }
}

fn entry_file_exists(instance_dir: &Path, entry: &LockEntry) -> bool {
    match normalize_lock_content_type(&entry.content_type).as_str() {
        "mods" => {
            let (enabled_path, disabled_path) = mod_paths(instance_dir, &entry.filename);
            if entry.enabled {
                enabled_path.exists() || disabled_path.exists()
            } else {
                disabled_path.exists() || enabled_path.exists()
            }
        }
        "resourcepacks" | "shaderpacks" => {
            let dir = content_dir_for_type(instance_dir, &entry.content_type);
            dir.join(&entry.filename).exists()
        }
        "datapacks" => {
            if entry.target_worlds.is_empty() {
                return false;
            }
            entry.target_worlds.iter().all(|world| {
                let path = instance_dir.join("saves").join(world).join("datapacks").join(&entry.filename);
                path.exists()
            })
        }
        _ => {
            let dir = content_dir_for_type(instance_dir, "mods");
            dir.join(&entry.filename).exists()
        }
    }
}

fn lock_entry_to_installed(instance_dir: &Path, entry: &LockEntry) -> InstalledMod {
    let file_exists = entry_file_exists(instance_dir, entry);

    InstalledMod {
        source: entry.source.clone(),
        project_id: entry.project_id.clone(),
        version_id: entry.version_id.clone(),
        name: entry.name.clone(),
        version_number: entry.version_number.clone(),
        filename: entry.filename.clone(),
        content_type: normalize_lock_content_type(&entry.content_type),
        target_scope: normalize_target_scope(&entry.target_scope),
        target_worlds: entry.target_worlds.clone(),
        pinned_version: entry.pinned_version.clone(),
        enabled: entry.enabled,
        file_exists,
        hashes: entry.hashes.clone(),
    }
}

fn find_instance(instances_dir: &Path, instance_id: &str) -> Result<Instance, String> {
    let idx = read_index(instances_dir)?;
    idx.instances
        .into_iter()
        .find(|i| i.id == instance_id)
        .ok_or_else(|| "instance not found".to_string())
}

fn emit_install_progress(app: &tauri::AppHandle, payload: InstallProgressEvent) {
    let _ = app.emit_all("mod_install_progress", payload);
}

fn emit_launch_state(
    app: &tauri::AppHandle,
    instance_id: &str,
    launch_id: Option<&str>,
    method: &str,
    status: &str,
    message: &str,
) {
    let payload = serde_json::json!({
        "instance_id": instance_id,
        "launch_id": launch_id,
        "method": method,
        "status": status,
        "message": message
    });
    let _ = app.emit_all("instance_launch_state", payload);
}

fn clear_launch_cancel_request(
    state: &tauri::State<'_, AppState>,
    instance_id: &str,
) -> Result<(), String> {
    let mut guard = state
        .launch_cancelled
        .lock()
        .map_err(|_| "lock launch cancellation state failed".to_string())?;
    guard.remove(instance_id);
    Ok(())
}

fn mark_launch_cancel_request(
    state: &tauri::State<'_, AppState>,
    instance_id: &str,
) -> Result<(), String> {
    let mut guard = state
        .launch_cancelled
        .lock()
        .map_err(|_| "lock launch cancellation state failed".to_string())?;
    guard.insert(instance_id.to_string());
    Ok(())
}

fn is_launch_cancel_requested(
    state: &tauri::State<'_, AppState>,
    instance_id: &str,
) -> Result<bool, String> {
    let guard = state
        .launch_cancelled
        .lock()
        .map_err(|_| "lock launch cancellation state failed".to_string())?;
    Ok(guard.contains(instance_id))
}

async fn await_launch_stage_with_cancel<T, F>(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    instance_id: &str,
    method: &str,
    stage_label: &str,
    timeout_secs: u64,
    future: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let mut fut = Box::pin(future);
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);

    loop {
        tokio::select! {
            result = &mut fut => return result,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                if is_launch_cancel_requested(state, instance_id)? {
                    emit_launch_state(
                        app,
                        instance_id,
                        None,
                        method,
                        "stopped",
                        "Launch cancelled by user.",
                    );
                    clear_launch_cancel_request(state, instance_id)?;
                    return Err("Launch cancelled by user.".to_string());
                }
                if Instant::now() >= deadline {
                    let timeout_msg = format!(
                        "{} timed out after {}s. Check network/firewall and try again.",
                        stage_label, timeout_secs
                    );
                    emit_launch_state(
                        app,
                        instance_id,
                        None,
                        method,
                        "stopped",
                        &timeout_msg,
                    );
                    return Err(timeout_msg);
                }
            }
        }
    }
}

fn resolve_oauth_client_id_with_source(app: &tauri::AppHandle) -> Result<(String, String), String> {
    let settings = read_launcher_settings(app)?;
    if !settings.oauth_client_id.trim().is_empty() {
        return Ok((settings.oauth_client_id.trim().to_string(), "settings".to_string()));
    }

    if let Some(v) = std::env::var("MPM_MS_CLIENT_ID_DEFAULT")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        return Ok((v, "app_default_env".to_string()));
    }

    if !DEFAULT_MS_PUBLIC_CLIENT_ID.trim().is_empty() {
        return Ok((
            DEFAULT_MS_PUBLIC_CLIENT_ID.trim().to_string(),
            "bundled_default".to_string(),
        ));
    }

    if let Some(v) = std::env::var("MPM_MS_CLIENT_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        return Ok((v, "legacy_env".to_string()));
    }

    Err(
        "Microsoft public client ID is missing. This is not a secret key. Configure it in Settings > Launcher > Advanced."
            .to_string(),
    )
}

fn resolve_oauth_client_id(app: &tauri::AppHandle) -> Result<String, String> {
    resolve_oauth_client_id_with_source(app).map(|v| v.0)
}

fn build_http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("build http client failed: {e}"))
}

fn is_transient_network_error(err: &reqwest::Error) -> bool {
    if err.is_timeout() || err.is_connect() || err.is_request() {
        return true;
    }
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("timed out")
        || msg.contains("dns")
        || msg.contains("connection reset")
        || msg.contains("connection refused")
        || msg.contains("connection closed")
        || msg.contains("network is unreachable")
}

fn network_block_hint(url: &str) -> Option<&'static str> {
    if url.contains("xboxlive.com") {
        return Some(
            "Your network may be blocking Xbox endpoints (user.auth.xboxlive.com / xsts.auth.xboxlive.com). Native Minecraft sign-in requires these. This is common on school/work networks.",
        );
    }
    if url.contains("minecraftservices.com") {
        return Some(
            "Your network may be blocking Minecraft services endpoints. Try another network or hotspot and retry sign-in.",
        );
    }
    None
}

fn endpoint_send_error(stage: &str, url: &str, err: &reqwest::Error) -> String {
    let mut out = format!(
        "{stage} failed while calling {url}: {}",
        reqwest_error_with_causes(err)
    );
    if is_transient_network_error(err) {
        if let Some(hint) = network_block_hint(url) {
            out.push(' ');
            out.push_str(hint);
            if url.contains("xboxlive.com") {
                out.push_str(" You can still use `Launch: Prism` for this instance while native auth is blocked.");
            }
        }
    }
    out
}

fn reqwest_error_with_causes(err: &reqwest::Error) -> String {
    let mut out = err.to_string();
    let mut cur = std::error::Error::source(err);
    while let Some(next) = cur {
        out.push_str(" | caused by: ");
        out.push_str(&next.to_string());
        cur = next.source();
    }
    out
}

fn trim_error_body(raw: &str) -> String {
    let one_line = raw.replace('\n', " ").replace('\r', " ").trim().to_string();
    if one_line.len() > 280 {
        format!("{}…", &one_line[..280])
    } else {
        one_line
    }
}

fn post_json_with_retry(
    client: &Client,
    url: &str,
    body: &serde_json::Value,
    stage: &str,
    headers: &[(&str, &str)],
) -> Result<Response, String> {
    let max_attempts = 3usize;
    let mut attempt = 0usize;
    loop {
        attempt += 1;
        let mut req = client
            .post(url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }

        match req.json(body).send() {
            Ok(resp) => return Ok(resp),
            Err(err) => {
                if attempt < max_attempts && is_transient_network_error(&err) {
                    thread::sleep(Duration::from_millis(260 * attempt as u64));
                    continue;
                }
                return Err(endpoint_send_error(stage, url, &err));
            }
        }
    }
}

fn parse_xerr_code(body: &str) -> Option<i64> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("XErr").cloned())
        .and_then(|v| v.as_i64())
}

fn explain_xerr_code(xerr: i64) -> Option<&'static str> {
    match xerr {
        2148916233 => Some("This Microsoft account does not have an Xbox profile or Minecraft entitlement."),
        2148916235 => Some("Xbox Live is unavailable in your current country/region."),
        2148916238 => Some("This Microsoft account is underaged and not linked to a family account."),
        2148916236 => Some("This Microsoft account requires proof of age before it can sign into Xbox."),
        2148916237 => Some("This Microsoft account has reached its allowed playtime limit."),
        2148916227 => Some("This Microsoft account is banned from Xbox services."),
        2148916229 => Some("Guardian/parental controls currently block online play for this account."),
        2148916234 => Some("This Microsoft account must accept Xbox terms first."),
        _ => None,
    }
}

fn normalize_microsoft_login_error(error_code: &str, error_desc: &str, client_id_source: &str) -> String {
    let code = error_code.to_ascii_lowercase();
    let desc = error_desc.to_ascii_lowercase();
    let client_hint = if client_id_source == "settings" {
        "This usually means your current OAuth client ID is not allowed for Minecraft auth."
    } else {
        "This can happen when the bundled client ID is restricted by Microsoft tenant policy."
    };

    if desc.contains("not permitted to consent")
        || desc.contains("first party application")
        || desc.contains("pre-authorization")
        || desc.contains("user does not have consent")
        || code.contains("invalid_request")
    {
        return format!(
            "Microsoft sign-in was blocked by consent policy. {client_hint} This commonly happens with school/work accounts. Use a personal Microsoft account, or set your own Azure Public Client ID in Settings > Launcher > Advanced > OAuth client ID."
        );
    }

    if desc.contains("application with identifier")
        || desc.contains("unauthorized_client")
        || desc.contains("aadsts700016")
    {
        return "Microsoft sign-in failed: OAuth client ID is invalid for this tenant. Set your own Azure Public Client ID in Settings > Launcher > Advanced.".to_string();
    }

    if code.contains("access_denied") || desc.contains("access denied") {
        return "Microsoft sign-in was denied. Please complete consent in browser, then try again.".to_string();
    }

    format!("Microsoft device token polling failed: {error_desc}")
}

fn summarize_cosmetics(items: &[McProfileCosmetic]) -> Vec<AccountCosmeticSummary> {
    items
        .iter()
        .filter(|x| !x.url.trim().is_empty())
        .map(|x| AccountCosmeticSummary {
            id: x.id.clone(),
            state: x.state.clone(),
            url: x.url.clone(),
            alias: x.alias.clone(),
            variant: x.variant.clone(),
        })
        .collect()
}

fn make_account_diagnostics_base(settings: &LauncherSettings) -> AccountDiagnostics {
    AccountDiagnostics {
        status: if settings.selected_account_id.is_some() {
            "connected".to_string()
        } else {
            "not_connected".to_string()
        },
        last_refreshed_at: now_iso(),
        selected_account_id: settings.selected_account_id.clone(),
        account: None,
        minecraft_uuid: None,
        minecraft_username: None,
        entitlements_ok: false,
        token_exchange_status: "idle".to_string(),
        skin_url: None,
        cape_count: 0,
        skins: vec![],
        capes: vec![],
        last_error: None,
        client_id_source: "none".to_string(),
    }
}

fn fail_account_diag(mut diag: AccountDiagnostics, stage: &str, msg: String) -> AccountDiagnostics {
    diag.status = "error".to_string();
    diag.token_exchange_status = stage.to_string();
    diag.last_error = Some(msg);
    diag
}

fn latest_crash_report_path(instance_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        instance_dir.join("runtime").join("crash-reports"),
        instance_dir.join("crash-reports"),
    ];
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for root in candidates {
        if !root.exists() || !root.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for ent in entries.flatten() {
            let path = ent.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !name.ends_with(".txt") {
                continue;
            }
            let Ok(meta) = ent.metadata() else {
                continue;
            };
            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            match &best {
                Some((prev, _)) if *prev >= modified => {}
                _ => {
                    best = Some((modified, path));
                }
            }
        }
    }
    best.map(|(_, path)| path)
}

fn launch_logs_dir(instance_dir: &Path) -> PathBuf {
    instance_dir.join("logs").join("launches")
}

fn latest_launch_log_path(instance_dir: &Path) -> Option<PathBuf> {
    let root = launch_logs_dir(instance_dir);
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(entries) = fs::read_dir(&root) {
        for ent in entries.flatten() {
            let path = ent.path();
            if !path.is_file() {
                continue;
            }
            let Ok(meta) = ent.metadata() else {
                continue;
            };
            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            match &best {
                Some((prev, _)) if *prev >= modified => {}
                _ => {
                    best = Some((modified, path));
                }
            }
        }
    }
    if let Some((_, path)) = best {
        return Some(path);
    }
    let legacy = instance_dir.join("runtime").join("native-launch.log");
    if legacy.exists() && legacy.is_file() {
        Some(legacy)
    } else {
        None
    }
}

fn classify_log_severity(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    if lower.contains(" fatal ")
        || lower.contains(" exception")
        || lower.contains(" crashed")
        || lower.contains(" crash ")
        || lower.contains(" error")
        || lower.starts_with("error")
        || lower.starts_with("[error")
    {
        return Some("error".to_string());
    }
    if lower.contains(" warning")
        || lower.contains(" warn ")
        || lower.starts_with("warn")
        || lower.starts_with("[warn")
    {
        return Some("warn".to_string());
    }
    if lower.contains(" debug ") || lower.starts_with("debug") || lower.starts_with("[debug") {
        return Some("debug".to_string());
    }
    if lower.contains(" trace ") || lower.starts_with("trace") || lower.starts_with("[trace") {
        return Some("trace".to_string());
    }
    if lower.contains(" info ") || lower.starts_with("info") || lower.starts_with("[info") {
        return Some("info".to_string());
    }
    None
}

fn extract_log_timestamp(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(end) = trimmed.find(']') {
        if trimmed.starts_with('[') && end > 1 {
            let ts = trimmed[1..end].trim();
            if !ts.is_empty() {
                return Some(ts.to_string());
            }
        }
    }
    if trimmed.len() >= 19 {
        let candidate = &trimmed[..19];
        let bytes = candidate.as_bytes();
        if bytes.get(4) == Some(&b'-')
            && bytes.get(7) == Some(&b'-')
            && (bytes.get(10) == Some(&b' ') || bytes.get(10) == Some(&b'T'))
        {
            return Some(candidate.to_string());
        }
    }
    None
}

fn read_windowed_log_lines(
    path: &Path,
    source: &str,
    max_lines: usize,
    before_line: Option<u64>,
) -> Result<
    (
        Vec<LogLineDto>,
        usize,
        bool,
        Option<u64>,
        Option<u64>,
        Option<u64>,
    ),
    String,
> {
    let bytes = fs::read(path).map_err(|e| format!("read log file failed: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let all_lines: Vec<&str> = text.lines().collect();
    let total_lines = all_lines.len();
    let end_exclusive = before_line
        .map(|line| line.saturating_sub(1) as usize)
        .unwrap_or(total_lines)
        .min(total_lines);
    let start = end_exclusive.saturating_sub(max_lines);
    let truncated = start > 0;
    let lines = all_lines[start..end_exclusive]
        .iter()
        .enumerate()
        .map(|(offset, line)| {
            let raw = line.trim_end().to_string();
            let line_no = (start + offset + 1) as u64;
            LogLineDto {
                raw: raw.clone(),
                line_no,
                timestamp: extract_log_timestamp(&raw),
                severity: classify_log_severity(&raw),
                source: source.to_string(),
            }
        })
        .collect::<Vec<_>>();
    let start_line_no = if end_exclusive > start {
        Some((start + 1) as u64)
    } else {
        None
    };
    let end_line_no = if end_exclusive > start {
        Some(end_exclusive as u64)
    } else {
        None
    };
    let next_before_line = if truncated { start_line_no } else { None };
    Ok((
        lines,
        total_lines,
        truncated,
        start_line_no,
        end_line_no,
        next_before_line,
    ))
}

fn resolve_target_instance_path(
    instance_dir: &Path,
    target: &str,
) -> Result<(String, PathBuf, bool), String> {
    match target.trim().to_lowercase().as_str() {
        "instance" => Ok(("instance".to_string(), instance_dir.to_path_buf(), true)),
        "mods" => Ok(("mods".to_string(), instance_dir.join("mods"), true)),
        "resourcepacks" => Ok(("resourcepacks".to_string(), instance_dir.join("resourcepacks"), true)),
        "shaderpacks" => Ok(("shaderpacks".to_string(), instance_dir.join("shaderpacks"), true)),
        "saves" => Ok(("saves".to_string(), instance_dir.join("saves"), true)),
        "launch-log" | "launch_log" | "log" => Ok((
            "launch-log".to_string(),
            latest_launch_log_path(instance_dir)
                .unwrap_or_else(|| instance_dir.join("runtime").join("native-launch.log")),
            false,
        )),
        "crash-log" | "crash_log" | "latest-crash" | "latest_crash" => {
            if let Some(path) = latest_crash_report_path(instance_dir) {
                Ok(("crash-log".to_string(), path, false))
            } else {
                Err("No crash report found yet for this instance.".to_string())
            }
        }
        _ => Err(
            "target must be 'instance', 'mods', 'resourcepacks', 'shaderpacks', 'saves', 'launch-log', or 'crash-log'"
                .to_string(),
        ),
    }
}

fn open_path_in_shell(path: &Path, create_if_missing: bool) -> Result<(), String> {
    if !path.exists() {
        if create_if_missing {
            fs::create_dir_all(path)
                .map_err(|e| format!("create path '{}' failed: {e}", path.display()))?;
        } else {
            return Err(format!(
                "Path '{}' does not exist yet. Launch once first to generate it.",
                path.display()
            ));
        }
    }

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(path)
            .status()
            .map_err(|e| format!("open path '{}' failed: {e}", path.display()))?;
        if !status.success() {
            return Err(format!(
                "open path '{}' failed: open exited with status {}",
                path.display(),
                status
            ));
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("explorer")
            .arg(path)
            .status()
            .map_err(|e| format!("open path '{}' failed: {e}", path.display()))?;
        if !status.success() {
            return Err(format!(
                "open path '{}' failed: explorer exited with status {}",
                path.display(),
                status
            ));
        }
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|e| format!("open path '{}' failed: {e}", path.display()))?;
        if !status.success() {
            return Err(format!(
                "open path '{}' failed: xdg-open exited with status {}",
                path.display(),
                status
            ));
        }
        return Ok(());
    }
}

fn reveal_path_in_shell(path: &Path, allow_parent_fallback: bool) -> Result<(PathBuf, bool), String> {
    let mut target = path.to_path_buf();
    if !target.exists() {
        if allow_parent_fallback {
            if let Some(parent) = target.parent() {
                target = parent.to_path_buf();
            }
        }
    }
    if !target.exists() {
        return Err(format!(
            "Path '{}' does not exist yet. Launch once first to generate it.",
            target.display()
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("open");
        let reveal_exact = target.is_file();
        if reveal_exact {
            cmd.arg("-R");
        }
        let status = cmd
            .arg(&target)
            .status()
            .map_err(|e| format!("reveal path '{}' failed: {e}", target.display()))?;
        if !status.success() {
            return Err(format!(
                "reveal path '{}' failed: open exited with status {}",
                target.display(),
                status
            ));
        }
        return Ok((target, reveal_exact));
    }

    #[cfg(target_os = "windows")]
    {
        if target.is_file() {
            let arg = format!("/select,{}", target.display());
            let status = Command::new("explorer")
                .arg(arg)
                .status()
                .map_err(|e| format!("reveal path '{}' failed: {e}", target.display()))?;
            if !status.success() {
                return Err(format!(
                    "reveal path '{}' failed: explorer exited with status {}",
                    target.display(),
                    status
                ));
            }
            return Ok((target, true));
        }
        let status = Command::new("explorer")
            .arg(&target)
            .status()
            .map_err(|e| format!("open path '{}' failed: {e}", target.display()))?;
        if !status.success() {
            return Err(format!(
                "open path '{}' failed: explorer exited with status {}",
                target.display(),
                status
            ));
        }
        return Ok((target, false));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let open_target = if target.is_file() {
            target.parent().unwrap_or(&target).to_path_buf()
        } else {
            target.clone()
        };
        let status = Command::new("xdg-open")
            .arg(&open_target)
            .status()
            .map_err(|e| format!("open path '{}' failed: {e}", open_target.display()))?;
        if !status.success() {
            return Err(format!(
                "open path '{}' failed: xdg-open exited with status {}",
                open_target.display(),
                status
            ));
        }
        return Ok((open_target, false));
    }
}

fn set_login_session_state(
    state: &Arc<Mutex<HashMap<String, MicrosoftLoginState>>>,
    session_id: &str,
    status: &str,
    message: Option<String>,
    account: Option<LauncherAccount>,
) {
    if let Ok(mut guard) = state.lock() {
        guard.insert(
            session_id.to_string(),
            MicrosoftLoginState {
                status: status.to_string(),
                message,
                account,
            },
        );
    }
}

fn keyring_set_refresh_token(account_id: &str, refresh_token: &str) -> Result<(), String> {
    let username = keyring_username_for_account(account_id);
    let entry =
        KeyringEntry::new(KEYRING_SERVICE, &username).map_err(|e| format!("keyring init failed: {e}"))?;
    entry
        .set_password(refresh_token)
        .map_err(|e| format!("keyring write failed: {e}"))
}

fn persist_refresh_token(
    app: &tauri::AppHandle,
    account_id: &str,
    refresh_token: &str,
) -> Result<(), String> {
    let keyring_result = keyring_set_refresh_token(account_id, refresh_token);
    let fallback_result = token_fallback_set_refresh_token(app, account_id, refresh_token);
    if keyring_result.is_ok() {
        return fallback_result;
    }
    if fallback_result.is_ok() {
        if let Err(e) = keyring_result {
            eprintln!(
                "keyring write failed for account {}; using fallback token store: {}",
                account_id, e
            );
        }
        return Ok(());
    }
    Err(format!(
        "{} | {}",
        keyring_result.unwrap_err(),
        fallback_result.unwrap_err()
    ))
}

fn keyring_username_candidates(account: &LauncherAccount, accounts: &[LauncherAccount]) -> Vec<String> {
    fn push_unique(out: &mut Vec<String>, value: String) {
        if value.trim().is_empty() {
            return;
        }
        if !out.iter().any(|x| x == &value) {
            out.push(value);
        }
    }

    fn add_aliases(out: &mut Vec<String>, key: &str) {
        let key = key.trim();
        if key.is_empty() {
            return;
        }
        push_unique(out, keyring_username_for_account(key));
        push_unique(out, format!("msa_refresh_token_{key}"));
        push_unique(out, key.to_string());
    }

    let mut out = Vec::new();
    add_aliases(&mut out, &account.id);
    add_aliases(&mut out, &account.username);
    add_aliases(&mut out, &account.id.to_lowercase());
    for candidate in accounts
        .iter()
        .filter(|x| x.username.eq_ignore_ascii_case(&account.username))
    {
        add_aliases(&mut out, &candidate.id);
    }
    out
}

fn keyring_try_read(service: &str, username: &str) -> Result<Option<String>, String> {
    let entry =
        KeyringEntry::new(service, username).map_err(|e| format!("keyring init failed: {e}"))?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

fn keyring_get_refresh_token_for_account(
    app: &tauri::AppHandle,
    account: &LauncherAccount,
    accounts: &[LauncherAccount],
) -> Result<String, String> {
    let canonical_username = keyring_username_for_account(&account.id);
    let usernames = keyring_username_candidates(account, accounts);

    let mut candidates = Vec::with_capacity(1 + LEGACY_KEYRING_SERVICES.len());
    candidates.push(KEYRING_SERVICE);
    for legacy in LEGACY_KEYRING_SERVICES {
        candidates.push(legacy);
    }

    for service in candidates {
        for username in &usernames {
            let Some(token) = keyring_try_read(service, username)? else {
                continue;
            };

            let is_canonical = service == KEYRING_SERVICE && username == &canonical_username;
            if !is_canonical {
                if let Err(e) = persist_refresh_token(app, &account.id, &token) {
                    eprintln!(
                        "refresh token migration to canonical key failed for account {}: {}",
                        account.id, e
                    );
                }
            }
            return Ok(token);
        }
    }

    if let Some(token) = token_fallback_get_refresh_token(app, account, accounts)? {
        if let Err(e) = keyring_set_refresh_token(&account.id, &token) {
            eprintln!(
                "could not migrate fallback token into keyring for account {}: {}",
                account.id, e
            );
        }
        return Ok(token);
    }

    Err("No refresh token found in secure storage for the selected account. Click Connect / Reconnect to repair account credentials.".to_string())
}

fn keyring_delete_refresh_token(account_id: &str) -> Result<(), String> {
    let username = keyring_username_for_account(account_id);
    let entry =
        KeyringEntry::new(KEYRING_SERVICE, &username).map_err(|e| format!("keyring init failed: {e}"))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("keyring delete failed: {e}")),
    }
}

fn delete_refresh_token_everywhere(app: &tauri::AppHandle, account_id: &str) {
    if let Err(e) = keyring_delete_refresh_token(account_id) {
        eprintln!("keyring delete failed for account {}: {}", account_id, e);
    }
    if let Err(e) = token_fallback_delete_refresh_token(app, account_id) {
        eprintln!("fallback token delete failed for account {}: {}", account_id, e);
    }
}

#[derive(Debug, Deserialize)]
struct MsoTokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MsoDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    expires_in: u64,
    #[serde(default)]
    interval: u64,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XboxAuthResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: XboxDisplayClaims,
}

#[derive(Debug, Deserialize)]
struct XboxDisplayClaims {
    xui: Vec<XboxUserClaim>,
}

#[derive(Debug, Deserialize)]
struct XboxUserClaim {
    uhs: String,
}

#[derive(Debug, Deserialize)]
struct McAuthResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct McEntitlementsResponse {
    #[serde(default)]
    items: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
struct McProfileCosmetic {
    #[serde(default)]
    id: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    variant: Option<String>,
}

#[derive(Debug, Deserialize)]
struct McProfileResponse {
    id: String,
    name: String,
    #[serde(default)]
    skins: Vec<McProfileCosmetic>,
    #[serde(default)]
    capes: Vec<McProfileCosmetic>,
}

fn microsoft_refresh_access_token(
    client: &Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<MsoTokenResponse, String> {
    let params = [
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("scope", "XboxLive.signin XboxLive.offline_access"),
    ];
    let res = client
        .post(MS_TOKEN_URL)
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .map_err(|e| format!("Microsoft refresh failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Microsoft refresh failed with status {}", res.status()));
    }
    res.json::<MsoTokenResponse>()
        .map_err(|e| format!("parse Microsoft refresh failed: {e}"))
}

fn microsoft_begin_device_code(client: &Client, client_id: &str) -> Result<MsoDeviceCodeResponse, String> {
    let params = [
        ("client_id", client_id),
        ("scope", "XboxLive.signin XboxLive.offline_access"),
    ];
    let res = client
        .post(MS_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&params)
        .send()
        .map_err(|e| format!("Microsoft device code start failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "Microsoft device code start failed with status {}",
            res.status()
        ));
    }
    res.json::<MsoDeviceCodeResponse>()
        .map_err(|e| format!("parse Microsoft device code response failed: {e}"))
}

fn microsoft_access_to_mc_token(client: &Client, msa_access_token: &str) -> Result<String, String> {
    let xbl_req_with_prefix = serde_json::json!({
        "Properties": {
            "AuthMethod": "RPS",
            "SiteName": "user.auth.xboxlive.com",
            "RpsTicket": format!("d={}", msa_access_token),
        },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });
    let mut xbl = post_json_with_retry(
        client,
        XBL_AUTH_URL,
        &xbl_req_with_prefix,
        "Xbox Live auth",
        &[("x-xbl-contract-version", "1")],
    )?;

    if !xbl.status().is_success() {
        // Some environments are picky about the ticket prefix. Retry once with raw token.
        if xbl.status().as_u16() == 400 || xbl.status().as_u16() == 401 {
            let xbl_req_plain = serde_json::json!({
                "Properties": {
                    "AuthMethod": "RPS",
                    "SiteName": "user.auth.xboxlive.com",
                    "RpsTicket": msa_access_token,
                },
                "RelyingParty": "http://auth.xboxlive.com",
                "TokenType": "JWT"
            });
            xbl = post_json_with_retry(
                client,
                XBL_AUTH_URL,
                &xbl_req_plain,
                "Xbox Live auth",
                &[("x-xbl-contract-version", "1")],
            )?;
        }
    }

    if !xbl.status().is_success() {
        let status = xbl.status();
        let body = xbl.text().unwrap_or_default();
        return Err(format!(
            "Xbox Live auth failed with status {}{}",
            status,
            if body.trim().is_empty() {
                "".to_string()
            } else {
                format!(" ({})", trim_error_body(&body))
            }
        ));
    }
    let xbl_data = xbl
        .json::<XboxAuthResponse>()
        .map_err(|e| format!("parse Xbox Live auth failed: {e}"))?;
    let uhs = xbl_data
        .display_claims
        .xui
        .first()
        .map(|x| x.uhs.clone())
        .ok_or_else(|| "Xbox auth response missing uhs".to_string())?;

    let xsts_req = serde_json::json!({
        "Properties": {
            "SandboxId": "RETAIL",
            "UserTokens": [xbl_data.token],
        },
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT"
    });
    let xsts = post_json_with_retry(
        client,
        XSTS_AUTH_URL,
        &xsts_req,
        "XSTS auth",
        &[("x-xbl-contract-version", "1")],
    )?;
    if !xsts.status().is_success() {
        let status = xsts.status();
        let body = xsts.text().unwrap_or_default();
        if let Some(xerr) = parse_xerr_code(&body) {
            if let Some(explained) = explain_xerr_code(xerr) {
                return Err(format!("XSTS auth failed ({xerr}): {explained}"));
            }
            return Err(format!("XSTS auth failed with XErr {xerr}."));
        }
        return Err(format!(
            "XSTS auth failed with status {}{}",
            status,
            if body.trim().is_empty() {
                "".to_string()
            } else {
                format!(" ({})", trim_error_body(&body))
            }
        ));
    }
    let xsts_data = xsts
        .json::<XboxAuthResponse>()
        .map_err(|e| format!("parse XSTS auth failed: {e}"))?;

    let identity_token = format!("XBL3.0 x={};{}", uhs, xsts_data.token);

    let launcher_req = serde_json::json!({
        "xtoken": identity_token,
        "platform": "PC_LAUNCHER",
    });
    let launcher_resp = post_json_with_retry(
        client,
        MC_LAUNCHER_AUTH_URL,
        &launcher_req,
        "Minecraft launcher login",
        &[],
    )?;
    if launcher_resp.status().is_success() {
        let mc_data = launcher_resp
            .json::<McAuthResponse>()
            .map_err(|e| format!("parse Minecraft launcher login failed: {e}"))?;
        return Ok(mc_data.access_token);
    }

    // Fallback for older response shapes.
    let mc_req = serde_json::json!({
        "identityToken": format!("XBL3.0 x={};{}", uhs, xsts_data.token),
    });
    let mc = post_json_with_retry(client, MC_AUTH_URL, &mc_req, "Minecraft login", &[])?;
    if !mc.status().is_success() {
        let status = mc.status();
        let body = mc.text().unwrap_or_default();
        return Err(format!(
            "Minecraft login failed with status {}{}",
            status,
            if body.trim().is_empty() {
                "".to_string()
            } else {
                format!(" ({})", trim_error_body(&body))
            }
        ));
    }
    mc.json::<McAuthResponse>()
        .map(|v| v.access_token)
        .map_err(|e| format!("parse Minecraft login failed: {e}"))
}

fn ensure_minecraft_entitlement(client: &Client, mc_access_token: &str) -> Result<(), String> {
    let resp = client
        .get(MC_ENTITLEMENTS_URL)
        .header("Accept", "application/json")
        .bearer_auth(mc_access_token)
        .send()
        .map_err(|e| format!("Minecraft entitlements check failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Minecraft entitlements check failed with status {}",
            resp.status()
        ));
    }
    let payload = resp
        .json::<McEntitlementsResponse>()
        .map_err(|e| format!("parse Minecraft entitlements failed: {e}"))?;
    if payload.items.is_empty() {
        return Err("No Minecraft entitlement found for this Microsoft account.".to_string());
    }
    Ok(())
}

fn fetch_minecraft_profile(client: &Client, mc_access_token: &str) -> Result<McProfileResponse, String> {
    let resp = client
        .get(MC_PROFILE_URL)
        .header("Accept", "application/json")
        .bearer_auth(mc_access_token)
        .send()
        .map_err(|e| format!("Minecraft profile fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Minecraft profile fetch failed with status {}",
            resp.status()
        ));
    }
    resp.json::<McProfileResponse>()
        .map_err(|e| format!("parse Minecraft profile failed: {e}"))
}

fn resolve_fabric_loader_version(client: &Client, mc_version: &str) -> Result<String, String> {
    let url = format!("https://meta.fabricmc.net/v2/versions/loader/{mc_version}");
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Fabric loader lookup failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Fabric loader lookup failed with status {}",
            resp.status()
        ));
    }
    let items = resp
        .json::<Vec<serde_json::Value>>()
        .map_err(|e| format!("parse Fabric loader lookup failed: {e}"))?;
    for it in &items {
        if let Some(v) = it
            .get("loader")
            .and_then(|x| x.get("version"))
            .and_then(|x| x.as_str())
        {
            return Ok(v.to_string());
        }
    }
    Err(format!(
        "No compatible Fabric loader version found for Minecraft {}",
        mc_version
    ))
}

fn resolve_forge_loader_version(client: &Client, mc_version: &str) -> Result<String, String> {
    let url = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Forge loader lookup failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Forge loader lookup failed with status {}",
            resp.status()
        ));
    }
    let payload = resp
        .json::<serde_json::Value>()
        .map_err(|e| format!("parse Forge loader lookup failed: {e}"))?;
    let promos = payload
        .get("promos")
        .and_then(|x| x.as_object())
        .ok_or_else(|| "Forge promotions payload missing promos".to_string())?;
    let rec_key = format!("{mc_version}-recommended");
    if let Some(v) = promos.get(&rec_key).and_then(|x| x.as_str()) {
        return Ok(v.to_string());
    }
    let latest_key = format!("{mc_version}-latest");
    if let Some(v) = promos.get(&latest_key).and_then(|x| x.as_str()) {
        return Ok(v.to_string());
    }
    let mut candidates: Vec<String> = promos
        .iter()
        .filter_map(|(k, v)| {
            if !k.starts_with(&format!("{mc_version}-")) {
                return None;
            }
            v.as_str().map(|s| s.to_string())
        })
        .collect();
    candidates.sort();
    candidates
        .pop()
        .ok_or_else(|| format!("No compatible Forge version found for Minecraft {}", mc_version))
}

fn safe_mod_filename(project_id: &str, version_id: &str, source_filename: &str) -> String {
    let cleaned = sanitize_filename(source_filename);
    if cleaned.is_empty() {
        format!("{project_id}-{version_id}.jar")
    } else {
        cleaned
    }
}

fn pick_compatible_version(
    versions: Vec<ModrinthVersion>,
    instance: &Instance,
) -> Option<ModrinthVersion> {
    let mut compatible: Vec<ModrinthVersion> = versions
        .into_iter()
        .filter(|v| {
            v.game_versions.iter().any(|gv| gv == &instance.mc_version)
                && v.loaders.iter().any(|l| l == &instance.loader)
        })
        .collect();
    compatible.sort_by(|a, b| b.date_published.cmp(&a.date_published));
    compatible.into_iter().next()
}

fn fetch_project_versions(client: &Client, project_id: &str) -> Result<Vec<ModrinthVersion>, String> {
    let versions_url = format!("{}/project/{project_id}/version", modrinth_api_base());
    let versions_resp = client
        .get(&versions_url)
        .send()
        .map_err(|e| format!("fetch versions failed for {project_id}: {e}"))?;
    if !versions_resp.status().is_success() {
        return Err(format!(
            "fetch versions failed for {project_id} with status {}",
            versions_resp.status()
        ));
    }

    let mut versions: Vec<ModrinthVersion> = versions_resp
        .json()
        .map_err(|e| format!("parse versions failed for {project_id}: {e}"))?;
    for v in &mut versions {
        if v.project_id.trim().is_empty() {
            v.project_id = project_id.to_string();
        }
    }
    Ok(versions)
}

fn fetch_version_by_id(client: &Client, version_id: &str) -> Result<ModrinthVersion, String> {
    let url = format!("{}/version/{version_id}", modrinth_api_base());
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("fetch dependency version {version_id} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "fetch dependency version {version_id} failed with status {}",
            resp.status()
        ));
    }
    resp.json::<ModrinthVersion>()
        .map_err(|e| format!("parse dependency version {version_id} failed: {e}"))
}

fn resolve_modrinth_install_plan(
    client: &Client,
    instance: &Instance,
    root_project_id: &str,
) -> Result<Vec<ResolvedInstallMod>, String> {
    let mut project_versions_cache: HashMap<String, Vec<ModrinthVersion>> = HashMap::new();
    let mut version_by_id_cache: HashMap<String, ModrinthVersion> = HashMap::new();
    let mut resolved: Vec<ResolvedInstallMod> = Vec::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    let mut visited: HashSet<String> = HashSet::new();

    queue.push_back(root_project_id.to_string());

    while let Some(project_id) = queue.pop_front() {
        if !visited.insert(project_id.clone()) {
            continue;
        }

        let versions = if let Some(cached) = project_versions_cache.get(&project_id) {
            cached.clone()
        } else {
            let fetched = fetch_project_versions(client, &project_id)?;
            project_versions_cache.insert(project_id.clone(), fetched.clone());
            fetched
        };

        let version = pick_compatible_version(versions, instance).ok_or_else(|| {
            format!(
                "No compatible Modrinth version found for project {} ({} + {})",
                project_id, instance.loader, instance.mc_version
            )
        })?;

        for dep in &version.dependencies {
            if !dep.dependency_type.eq_ignore_ascii_case("required") {
                continue;
            }

            let dep_project_id = if let Some(pid) = dep.project_id.as_ref() {
                Some(pid.clone())
            } else if let Some(version_id) = dep.version_id.as_ref() {
                let dep_version = if let Some(cached) = version_by_id_cache.get(version_id) {
                    cached.clone()
                } else {
                    let fetched = fetch_version_by_id(client, version_id)?;
                    version_by_id_cache.insert(version_id.clone(), fetched.clone());
                    fetched
                };
                if dep_version.project_id.trim().is_empty() {
                    None
                } else {
                    Some(dep_version.project_id)
                }
            } else {
                None
            };

            if let Some(dep_pid) = dep_project_id {
                if dep_pid != project_id && !visited.contains(&dep_pid) {
                    queue.push_back(dep_pid);
                }
            }
        }

        let file = version
            .files
            .iter()
            .find(|f| f.primary.unwrap_or(false))
            .or_else(|| version.files.first())
            .cloned()
            .ok_or_else(|| format!("Version {} has no downloadable files", version.id))?;

        resolved.push(ResolvedInstallMod {
            project_id,
            version,
            file,
        });
    }

    Ok(resolved)
}

fn is_plan_entry_up_to_date(instance_dir: &Path, lock: &Lockfile, item: &ResolvedInstallMod) -> bool {
    let safe_filename = safe_mod_filename(&item.project_id, &item.version.id, &item.file.filename);
    let Some(existing) = lock.entries.iter().find(|e| e.project_id == item.project_id) else {
        return false;
    };
    if existing.version_id != item.version.id || existing.filename != safe_filename || !existing.enabled {
        return false;
    }
    let (enabled_path, _) = mod_paths(instance_dir, &existing.filename);
    enabled_path.exists()
}

fn count_plan_install_actions(instance_dir: &Path, lock: &Lockfile, plan: &[ResolvedInstallMod]) -> usize {
    plan.iter()
        .filter(|item| !is_plan_entry_up_to_date(instance_dir, lock, item))
        .count()
}

fn remove_replaced_entries_for_project(
    lock: &mut Lockfile,
    instance_dir: &Path,
    project_id: &str,
    keep_enabled_filename: Option<&str>,
) -> Result<(), String> {
    let keep = keep_enabled_filename.unwrap_or("");
    let replaced: Vec<LockEntry> = lock
        .entries
        .iter()
        .filter(|e| e.project_id == project_id)
        .cloned()
        .collect();
    lock.entries.retain(|e| e.project_id != project_id);

    for old in replaced {
        let (old_enabled, old_disabled) = mod_paths(instance_dir, &old.filename);
        if old.filename != keep && old_enabled.exists() {
            fs::remove_file(&old_enabled)
                .map_err(|e| format!("remove old mod file '{}' failed: {e}", old.filename))?;
        }
        if old_disabled.exists() {
            fs::remove_file(&old_disabled)
                .map_err(|e| format!("remove old disabled mod file '{}' failed: {e}", old.filename))?;
        }
    }
    Ok(())
}

fn remove_replaced_entries_for_content(
    lock: &mut Lockfile,
    instance_dir: &Path,
    project_id: &str,
    content_type: &str,
) -> Result<(), String> {
    let normalized = normalize_lock_content_type(content_type);
    let replaced: Vec<LockEntry> = lock
        .entries
        .iter()
        .filter(|e| {
            e.project_id == project_id
                && normalize_lock_content_type(&e.content_type) == normalized
        })
        .cloned()
        .collect();
    lock.entries.retain(|e| {
        !(e.project_id == project_id
            && normalize_lock_content_type(&e.content_type) == normalized)
    });

    for old in replaced {
        match normalized.as_str() {
            "mods" => {
                let (old_enabled, old_disabled) = mod_paths(instance_dir, &old.filename);
                if old_enabled.exists() {
                    fs::remove_file(&old_enabled)
                        .map_err(|e| format!("remove old mod file '{}' failed: {e}", old.filename))?;
                }
                if old_disabled.exists() {
                    fs::remove_file(&old_disabled).map_err(|e| {
                        format!("remove old disabled mod file '{}' failed: {e}", old.filename)
                    })?;
                }
            }
            "resourcepacks" | "shaderpacks" => {
                let dir = content_dir_for_type(instance_dir, &normalized);
                let file = dir.join(&old.filename);
                if file.exists() {
                    fs::remove_file(&file)
                        .map_err(|e| format!("remove old file '{}' failed: {e}", file.display()))?;
                }
            }
            "datapacks" => {
                for world in old.target_worlds {
                    let file = instance_dir
                        .join("saves")
                        .join(world)
                        .join("datapacks")
                        .join(&old.filename);
                    if file.exists() {
                        fs::remove_file(&file).map_err(|e| {
                            format!("remove old datapack '{}' failed: {e}", file.display())
                        })?;
                    }
                }
            }
            _ => {}
        }
    }

    Ok(())
}

fn fetch_project_title(client: &Client, project_id: &str) -> Option<String> {
    let project_url = format!("{}/project/{project_id}", modrinth_api_base());
    match client.get(&project_url).send() {
        Ok(resp) if resp.status().is_success() => match resp.json::<ModrinthProjectResponse>() {
            Ok(project) => Some(project.title),
            Err(_) => None,
        },
        _ => None,
    }
}

fn distinct_modrinth_projects(lock: &Lockfile) -> Vec<LockEntry> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<LockEntry> = Vec::new();
    for entry in &lock.entries {
        if !entry.source.eq_ignore_ascii_case("modrinth") {
            continue;
        }
        if normalize_lock_content_type(&entry.content_type) != "mods" {
            continue;
        }
        if seen.insert(entry.project_id.clone()) {
            out.push(entry.clone());
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn check_modrinth_updates_inner(
    client: &Client,
    instance: &Instance,
    lock: &Lockfile,
) -> Result<ModUpdateCheckResult, String> {
    let projects = distinct_modrinth_projects(lock);
    let checked_mods = projects.len();
    let mut updates: Vec<ModUpdateInfo> = Vec::new();

    for entry in projects {
        let versions = fetch_project_versions(client, &entry.project_id)?;
        let Some(latest) = pick_compatible_version(versions, instance) else {
            continue;
        };
        if latest.id == entry.version_id {
            continue;
        }

        updates.push(ModUpdateInfo {
            project_id: entry.project_id,
            name: entry.name,
            current_version_id: entry.version_id,
            current_version_number: entry.version_number,
            latest_version_id: latest.id,
            latest_version_number: latest.version_number,
        });
    }

    updates.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(ModUpdateCheckResult {
        checked_mods,
        update_count: updates.len(),
        updates,
    })
}

fn normalize_discover_content_type(input: &str) -> String {
    match input.trim().to_lowercase().as_str() {
        "mods" | "mod" => "mods".to_string(),
        "resourcepacks" | "resourcepack" | "texturepacks" | "texturepack" => {
            "resourcepacks".to_string()
        }
        "shaders" | "shaderpacks" | "shaderpack" | "shader" => "shaderpacks".to_string(),
        "datapacks" | "datapack" => "datapacks".to_string(),
        "modpacks" | "modpack" => "modpacks".to_string(),
        _ => "mods".to_string(),
    }
}

fn modrinth_project_type_facets(content_type: &str) -> Vec<String> {
    match content_type {
        "resourcepacks" => vec!["project_type:resourcepack".to_string()],
        "shaderpacks" => vec!["project_type:shader".to_string()],
        "datapacks" => vec!["project_type:datapack".to_string()],
        "modpacks" => vec!["project_type:modpack".to_string()],
        _ => vec!["project_type:mod".to_string()],
    }
}

fn curseforge_class_ids_for_content_type(content_type: &str) -> Vec<i64> {
    match content_type {
        "resourcepacks" => vec![12],
        // CurseForge does not have a first-class "shaderpacks" class in all metadata variants.
        // We use texture packs + query hints as best effort.
        "shaderpacks" => vec![12],
        "datapacks" => vec![6945],
        "modpacks" => vec![4471],
        _ => vec![6],
    }
}

fn discover_index_sort_field(index: &str) -> i64 {
    match index.trim().to_lowercase().as_str() {
        "downloads" => 6,
        "updated" => 3,
        "newest" => 11,
        "follows" => 2,
        _ => 1,
    }
}

fn parse_cf_hashes(file: &CurseforgeFile) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for h in &file.hashes {
        let key = match h.algo {
            1 => "sha1",
            2 => "md5",
            _ => continue,
        };
        if !h.value.trim().is_empty() {
            out.insert(key.to_string(), h.value.clone());
        }
    }
    out
}

fn discover_content_type_from_modrinth_project_type(project_type: &str) -> String {
    match project_type.trim().to_lowercase().as_str() {
        "resourcepack" => "resourcepacks".to_string(),
        "shader" => "shaderpacks".to_string(),
        "datapack" => "datapacks".to_string(),
        "modpack" => "modpacks".to_string(),
        _ => "mods".to_string(),
    }
}

fn discover_content_type_from_curseforge_class_id(class_id: i64, requested_content_type: &str) -> String {
    match class_id {
        4471 => "modpacks".to_string(),
        6945 => "datapacks".to_string(),
        12 => {
            if normalize_discover_content_type(requested_content_type) == "shaderpacks" {
                "shaderpacks".to_string()
            } else {
                "resourcepacks".to_string()
            }
        }
        _ => "mods".to_string(),
    }
}

fn file_looks_compatible_with_instance(file: &CurseforgeFile, instance: &Instance) -> bool {
    let values: Vec<String> = file
        .game_versions
        .iter()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty())
        .collect();

    if values.is_empty() {
        return false;
    }
    if !values.iter().any(|v| v == &instance.mc_version.to_lowercase()) {
        return false;
    }

    let has_loader_tokens = values.iter().any(|v| {
        v == "fabric" || v == "forge" || v == "quilt" || v == "neoforge" || v == "vanilla"
    });
    if !has_loader_tokens {
        return true;
    }

    let loader = instance.loader.to_lowercase();
    values.iter().any(|v| {
        v == &loader
            || (loader == "neoforge" && (v == "neo forge" || v == "neo-forge"))
            || (loader == "vanilla" && v == "minecraft")
    })
}

fn pick_compatible_version_for_content(
    versions: Vec<ModrinthVersion>,
    instance: &Instance,
    content_type: &str,
) -> Option<ModrinthVersion> {
    let normalized = normalize_lock_content_type(content_type);
    let mut compatible: Vec<ModrinthVersion> = versions
        .into_iter()
        .filter(|v| v.game_versions.iter().any(|gv| gv == &instance.mc_version))
        .filter(|v| {
            if normalized == "mods" {
                return v.loaders.iter().any(|l| l == &instance.loader);
            }
            if v.loaders.is_empty() {
                return true;
            }
            v.loaders.iter().any(|l| {
                let lc = l.trim().to_lowercase();
                lc == instance.loader
                    || lc == "minecraft"
                    || lc == "datapack"
                    || lc == "resourcepack"
                    || lc == "shader"
            })
        })
        .collect();
    compatible.sort_by(|a, b| b.date_published.cmp(&a.date_published));
    compatible.into_iter().next()
}

fn list_instance_world_names(instance_dir: &Path) -> Result<Vec<String>, String> {
    let saves_dir = instance_dir.join("saves");
    if !saves_dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&saves_dir).map_err(|e| format!("read saves dir failed: {e}"))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read save entry failed: {e}"))?;
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        if !name.trim().is_empty() {
            out.push(name);
        }
    }
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(out)
}

fn normalize_target_worlds_for_datapack(
    instance_dir: &Path,
    target_worlds: &[String],
) -> Result<Vec<String>, String> {
    let world_set: HashSet<String> = list_instance_world_names(instance_dir)?.into_iter().collect();
    if world_set.is_empty() {
        return Err("This instance has no worlds yet. Create a world first to install datapacks.".to_string());
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for world in target_worlds {
        let clean = world.trim().to_string();
        if clean.is_empty() {
            continue;
        }
        if !world_set.contains(&clean) {
            return Err(format!("World '{}' was not found in this instance.", clean));
        }
        if seen.insert(clean.clone()) {
            out.push(clean);
        }
    }
    if out.is_empty() {
        return Err("Select at least one world for datapack installation.".to_string());
    }
    Ok(out)
}

fn write_download_to_content_targets(
    instance_dir: &Path,
    content_type: &str,
    filename: &str,
    target_worlds: &[String],
    bytes: &[u8],
) -> Result<(), String> {
    let normalized = normalize_lock_content_type(content_type);
    match normalized.as_str() {
        "mods" | "resourcepacks" | "shaderpacks" => {
            let dir = content_dir_for_type(instance_dir, &normalized);
            fs::create_dir_all(&dir).map_err(|e| format!("mkdir '{}' failed: {e}", dir.display()))?;
            let out_path = dir.join(filename);
            fs::write(&out_path, bytes)
                .map_err(|e| format!("write '{}' failed: {e}", out_path.display()))?;
        }
        "datapacks" => {
            for world in target_worlds {
                let dir = instance_dir.join("saves").join(world).join("datapacks");
                fs::create_dir_all(&dir)
                    .map_err(|e| format!("mkdir '{}' failed: {e}", dir.display()))?;
                let out_path = dir.join(filename);
                fs::write(&out_path, bytes)
                    .map_err(|e| format!("write '{}' failed: {e}", out_path.display()))?;
            }
        }
        _ => {
            return Err("Unsupported content type for direct install".to_string());
        }
    }
    Ok(())
}

fn install_modrinth_content_inner(
    instance: &Instance,
    instance_dir: &Path,
    lock: &mut Lockfile,
    client: &Client,
    project_id: &str,
    project_title: Option<&str>,
    content_type: &str,
    target_worlds: &[String],
) -> Result<LockEntry, String> {
    let normalized = normalize_lock_content_type(content_type);
    if normalized == "modpacks" {
        return Err("Modpack entries are template-only. Import as template in Modpacks & Presets.".to_string());
    }

    let versions = fetch_project_versions(client, project_id)?;
    let version = pick_compatible_version_for_content(versions, instance, &normalized).ok_or_else(|| {
        format!(
            "No compatible Modrinth version found for {} ({} + {})",
            project_id, instance.loader, instance.mc_version
        )
    })?;
    let file = version
        .files
        .iter()
        .find(|f| f.primary.unwrap_or(false))
        .or_else(|| version.files.first())
        .cloned()
        .ok_or_else(|| format!("Version {} has no downloadable files", version.id))?;

    let safe_filename = sanitize_filename(&file.filename);
    if safe_filename.is_empty() {
        return Err("Resolved filename is invalid".to_string());
    }

    let resolved_title = project_title
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| fetch_project_title(client, project_id))
        .unwrap_or_else(|| project_id.to_string());

    let mut response = client
        .get(&file.url)
        .send()
        .map_err(|e| format!("download failed for {}: {e}", project_id))?;
    if !response.status().is_success() {
        return Err(format!(
            "download failed for {} with status {}",
            project_id,
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    response
        .copy_to(&mut bytes)
        .map_err(|e| format!("download read failed for {}: {e}", project_id))?;

    let worlds = if normalized == "datapacks" {
        normalize_target_worlds_for_datapack(instance_dir, target_worlds)?
    } else {
        vec![]
    };
    write_download_to_content_targets(instance_dir, &normalized, &safe_filename, &worlds, &bytes)?;

    remove_replaced_entries_for_content(lock, instance_dir, project_id, &normalized)?;

    let new_entry = LockEntry {
        source: "modrinth".to_string(),
        project_id: project_id.to_string(),
        version_id: version.id.clone(),
        name: resolved_title,
        version_number: version.version_number.clone(),
        filename: safe_filename,
        content_type: normalized.clone(),
        target_scope: if normalized == "datapacks" {
            "world".to_string()
        } else {
            "instance".to_string()
        },
        target_worlds: worlds,
        pinned_version: None,
        enabled: true,
        hashes: file.hashes.clone(),
    };
    lock.entries.push(new_entry.clone());
    Ok(new_entry)
}

fn install_curseforge_content_inner(
    instance: &Instance,
    instance_dir: &Path,
    lock: &mut Lockfile,
    client: &Client,
    api_key: &str,
    project_id: &str,
    project_title: Option<&str>,
    content_type: &str,
    target_worlds: &[String],
) -> Result<LockEntry, String> {
    let normalized = normalize_lock_content_type(content_type);
    if normalized == "modpacks" {
        return Err("Modpack entries are template-only. Import as template in Modpacks & Presets.".to_string());
    }
    let mod_id = parse_curseforge_project_id(project_id)?;
    let project_key = format!("cf:{mod_id}");

    let mod_resp = client
        .get(format!("{}/mods/{}", CURSEFORGE_API_BASE, mod_id))
        .header("Accept", "application/json")
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge project lookup failed: {e}"))?;
    if !mod_resp.status().is_success() {
        return Err(format!(
            "CurseForge project lookup failed with status {}",
            mod_resp.status()
        ));
    }
    let project = mod_resp
        .json::<CurseforgeModResponse>()
        .map_err(|e| format!("parse CurseForge project failed: {e}"))?
        .data;

    let files_resp = client
        .get(format!(
            "{}/mods/{}/files?pageSize=80&index=0",
            CURSEFORGE_API_BASE, mod_id
        ))
        .header("Accept", "application/json")
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge files lookup failed: {e}"))?;
    if !files_resp.status().is_success() {
        return Err(format!(
            "CurseForge files lookup failed with status {}",
            files_resp.status()
        ));
    }
    let mut files = files_resp
        .json::<CurseforgeFilesResponse>()
        .map_err(|e| format!("parse CurseForge files failed: {e}"))?
        .data;
    files.retain(|f| !f.file_name.trim().is_empty() && file_looks_compatible_with_instance(f, instance));
    files.sort_by(|a, b| b.file_date.cmp(&a.file_date));
    let file = files.into_iter().next().ok_or_else(|| {
        format!(
            "No compatible CurseForge file found for {} + {}",
            instance.loader, instance.mc_version
        )
    })?;

    let safe_filename = sanitize_filename(&file.file_name);
    if safe_filename.is_empty() {
        return Err("Resolved CurseForge filename is invalid".to_string());
    }
    let download_url = resolve_curseforge_file_download_url(client, api_key, mod_id, &file)?;
    let mut response = client
        .get(&download_url)
        .send()
        .map_err(|e| format!("download CurseForge file failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "download CurseForge file failed with status {}",
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    response
        .copy_to(&mut bytes)
        .map_err(|e| format!("download read failed: {e}"))?;

    let worlds = if normalized == "datapacks" {
        normalize_target_worlds_for_datapack(instance_dir, target_worlds)?
    } else {
        vec![]
    };
    write_download_to_content_targets(instance_dir, &normalized, &safe_filename, &worlds, &bytes)?;

    remove_replaced_entries_for_content(lock, instance_dir, &project_key, &normalized)?;

    let new_entry = LockEntry {
        source: "curseforge".to_string(),
        project_id: project_key,
        version_id: format!("cf_file:{}", file.id),
        name: project_title
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| project.name.clone()),
        version_number: if file.display_name.trim().is_empty() {
            file.file_name.clone()
        } else {
            file.display_name.clone()
        },
        filename: safe_filename,
        content_type: normalized.clone(),
        target_scope: if normalized == "datapacks" {
            "world".to_string()
        } else {
            "instance".to_string()
        },
        target_worlds: worlds,
        pinned_version: None,
        enabled: true,
        hashes: parse_cf_hashes(&file),
    };
    lock.entries.push(new_entry.clone());
    Ok(new_entry)
}

fn default_preset_settings() -> CreatorPresetSettings {
    CreatorPresetSettings {
        dependency_policy: "required".to_string(),
        conflict_strategy: "replace".to_string(),
        provider_priority: vec!["modrinth".to_string(), "curseforge".to_string()],
        snapshot_before_apply: true,
        apply_order: vec![
            "mods".to_string(),
            "resourcepacks".to_string(),
            "shaderpacks".to_string(),
            "datapacks".to_string(),
        ],
        datapack_target_policy: "choose_worlds".to_string(),
    }
}

fn classify_pack_path_content_type(path: &str) -> Option<String> {
    let lower = path.trim().replace('\\', "/").to_lowercase();
    if lower.starts_with("mods/") {
        return Some("mods".to_string());
    }
    if lower.starts_with("resourcepacks/") {
        return Some("resourcepacks".to_string());
    }
    if lower.starts_with("shaderpacks/") {
        return Some("shaderpacks".to_string());
    }
    if lower.contains("/datapacks/") || lower.starts_with("datapacks/") {
        return Some("datapacks".to_string());
    }
    None
}

fn import_modrinth_modpack_template_inner(
    client: &Client,
    project_id: &str,
    project_title: Option<&str>,
) -> Result<CreatorPreset, String> {
    let project_name = project_title
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| fetch_project_title(client, project_id))
        .unwrap_or_else(|| format!("Imported Modrinth pack {}", project_id));

    let mut versions = fetch_project_versions(client, project_id)?;
    versions.sort_by(|a, b| b.date_published.cmp(&a.date_published));
    let version = versions
        .first()
        .cloned()
        .ok_or_else(|| "No versions found for this Modrinth project".to_string())?;
    let file = version
        .files
        .iter()
        .find(|f| f.primary.unwrap_or(false))
        .or_else(|| version.files.first())
        .cloned()
        .ok_or_else(|| "Selected Modrinth version has no downloadable files".to_string())?;

    let mut entries: Vec<CreatorPresetEntry> = Vec::new();
    for dep in &version.dependencies {
        if !dep.dependency_type.eq_ignore_ascii_case("required") {
            continue;
        }
        let Some(dep_project_id) = dep.project_id.as_ref() else {
            continue;
        };
        entries.push(CreatorPresetEntry {
            source: "modrinth".to_string(),
            project_id: dep_project_id.clone(),
            title: dep_project_id.clone(),
            content_type: "mods".to_string(),
            pinned_version: dep.version_id.clone(),
            target_scope: "instance".to_string(),
            target_worlds: vec![],
            enabled: true,
        });
    }

    let mut resp = client
        .get(&file.url)
        .send()
        .map_err(|e| format!("download modpack failed: {e}"))?;
    if resp.status().is_success() {
        let mut bytes = Vec::new();
        let _ = resp.copy_to(&mut bytes);
        if !bytes.is_empty() {
            if let Ok(mut archive) = ZipArchive::new(Cursor::new(bytes)) {
                if let Ok(mut idx_file) = archive.by_name("modrinth.index.json") {
                    let mut raw = String::new();
                    if idx_file.read_to_string(&mut raw).is_ok() {
                        if let Ok(index) = serde_json::from_str::<ModrinthModpackIndex>(&raw) {
                            if entries.is_empty() {
                                for file in index.files {
                                    let Some(content_type) = classify_pack_path_content_type(&file.path) else {
                                        continue;
                                    };
                                    entries.push(CreatorPresetEntry {
                                        source: "modrinth".to_string(),
                                        project_id: format!("packfile:{}", file.path),
                                        title: file.path,
                                        content_type,
                                        pinned_version: None,
                                        target_scope: "instance".to_string(),
                                        target_worlds: vec![],
                                        enabled: false,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if entries.is_empty() {
        return Err("Could not derive installable entries from this Modrinth modpack.".to_string());
    }
    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));

    Ok(CreatorPreset {
        id: format!("preset_{}", now_millis()),
        name: project_name,
        created_at: now_iso(),
        source_instance_id: "template".to_string(),
        source_instance_name: "Modrinth template".to_string(),
        entries,
        settings: default_preset_settings(),
    })
}

fn import_curseforge_modpack_template_inner(
    client: &Client,
    api_key: &str,
    project_id: &str,
    project_title: Option<&str>,
) -> Result<CreatorPreset, String> {
    let mod_id = parse_curseforge_project_id(project_id)?;
    let mod_resp = client
        .get(format!("{}/mods/{}", CURSEFORGE_API_BASE, mod_id))
        .header("Accept", "application/json")
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge project lookup failed: {e}"))?;
    if !mod_resp.status().is_success() {
        return Err(format!(
            "CurseForge project lookup failed with status {}",
            mod_resp.status()
        ));
    }
    let project = mod_resp
        .json::<CurseforgeModResponse>()
        .map_err(|e| format!("parse CurseForge project failed: {e}"))?
        .data;

    let files_resp = client
        .get(format!(
            "{}/mods/{}/files?pageSize=40&index=0",
            CURSEFORGE_API_BASE, mod_id
        ))
        .header("Accept", "application/json")
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge files lookup failed: {e}"))?;
    if !files_resp.status().is_success() {
        return Err(format!(
            "CurseForge files lookup failed with status {}",
            files_resp.status()
        ));
    }
    let mut files = files_resp
        .json::<CurseforgeFilesResponse>()
        .map_err(|e| format!("parse CurseForge files failed: {e}"))?
        .data;
    files.sort_by(|a, b| b.file_date.cmp(&a.file_date));
    let file = files
        .first()
        .cloned()
        .ok_or_else(|| "No files found for this CurseForge modpack".to_string())?;
    let download_url = resolve_curseforge_file_download_url(client, api_key, mod_id, &file)?;
    let mut resp = client
        .get(&download_url)
        .send()
        .map_err(|e| format!("download CurseForge modpack failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "download CurseForge modpack failed with status {}",
            resp.status()
        ));
    }
    let mut bytes = Vec::new();
    resp.copy_to(&mut bytes)
        .map_err(|e| format!("read CurseForge modpack failed: {e}"))?;

    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("read CurseForge modpack archive failed: {e}"))?;
    let mut manifest_file = archive
        .by_name("manifest.json")
        .map_err(|_| "manifest.json was not found in the CurseForge modpack archive".to_string())?;
    let mut manifest_raw = String::new();
    manifest_file
        .read_to_string(&mut manifest_raw)
        .map_err(|e| format!("read manifest.json failed: {e}"))?;
    let manifest = serde_json::from_str::<CurseforgeModpackManifest>(&manifest_raw)
        .map_err(|e| format!("parse manifest.json failed: {e}"))?;

    let mut entries = Vec::new();
    for file_ref in manifest.files {
        entries.push(CreatorPresetEntry {
            source: "curseforge".to_string(),
            project_id: format!("cf:{}", file_ref.project_id),
            title: format!("CurseForge {}", file_ref.project_id),
            content_type: "mods".to_string(),
            pinned_version: Some(format!("cf_file:{}", file_ref.file_id)),
            target_scope: "instance".to_string(),
            target_worlds: vec![],
            enabled: true,
        });
    }
    if entries.is_empty() {
        return Err("This CurseForge modpack manifest does not contain installable files.".to_string());
    }

    let preset_name = manifest
        .name
        .or_else(|| project_title.map(|v| v.to_string()))
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| project.name);

    Ok(CreatorPreset {
        id: format!("preset_{}", now_millis()),
        name: preset_name,
        created_at: now_iso(),
        source_instance_id: "template".to_string(),
        source_instance_name: "CurseForge template".to_string(),
        entries,
        settings: default_preset_settings(),
    })
}

fn search_modrinth_discover(
    client: &Client,
    args: &SearchDiscoverContentArgs,
) -> Result<DiscoverSearchResult, String> {
    let content_type = normalize_discover_content_type(&args.content_type);
    let project_type_facets = modrinth_project_type_facets(&content_type);

    let mut params = vec![
        ("query".to_string(), args.query.clone()),
        ("index".to_string(), args.index.clone()),
        ("limit".to_string(), args.limit.to_string()),
        ("offset".to_string(), args.offset.to_string()),
    ];

    let mut groups: Vec<Vec<String>> = vec![project_type_facets];
    if !args.loaders.is_empty() {
        groups.push(
            args.loaders
                .iter()
                .map(|l| format!("categories:{}", l.trim().to_lowercase()))
                .collect(),
        );
    }
    if let Some(game_version) = args.game_version.as_ref() {
        if !game_version.trim().is_empty() {
            groups.push(vec![format!("versions:{}", game_version.trim())]);
        }
    }
    if !args.categories.is_empty() {
        groups.push(
            args.categories
                .iter()
                .map(|c| format!("categories:{}", c.trim().to_lowercase()))
                .collect(),
        );
    }
    let facets = serde_json::to_string(&groups).map_err(|e| format!("serialize facets failed: {e}"))?;
    params.push(("facets".to_string(), facets));

    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", url::form_urlencoded::byte_serialize(k.as_bytes()).collect::<String>(), url::form_urlencoded::byte_serialize(v.as_bytes()).collect::<String>()))
        .collect::<Vec<_>>()
        .join("&");
    let url = format!("{}/search?{}", modrinth_api_base(), query);
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .map_err(|e| format!("Modrinth discover search failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Modrinth discover search failed with status {}", resp.status()));
    }
    let payload = resp
        .json::<serde_json::Value>()
        .map_err(|e| format!("parse Modrinth discover search failed: {e}"))?;
    let offset = payload
        .get("offset")
        .and_then(|v| v.as_u64())
        .unwrap_or(args.offset as u64) as usize;
    let limit = payload
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(args.limit as u64) as usize;
    let total_hits = payload
        .get("total_hits")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    let mut hits = Vec::new();
    if let Some(arr) = payload.get("hits").and_then(|v| v.as_array()) {
        for it in arr {
            let project_id = it
                .get("project_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if project_id.is_empty() {
                continue;
            }
            let title = it
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled")
                .to_string();
            let description = it
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let author = it
                .get("author")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string();
            let downloads = it
                .get("downloads")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let follows = it
                .get("follows")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let icon_url = it
                .get("icon_url")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let categories = it
                .get("categories")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| c.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let versions = it
                .get("versions")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|c| c.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let date_modified = it
                .get("date_modified")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let slug = it
                .get("slug")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let hit_content_type = discover_content_type_from_modrinth_project_type(
                it.get("project_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default(),
            );

            hits.push(DiscoverSearchHit {
                source: "modrinth".to_string(),
                project_id,
                title,
                description,
                author,
                downloads,
                follows,
                icon_url,
                categories,
                versions,
                date_modified,
                content_type: hit_content_type,
                slug: slug.clone(),
                external_url: slug.map(|s| format!("https://modrinth.com/project/{s}")),
            });
        }
    }

    Ok(DiscoverSearchResult {
        hits,
        offset,
        limit,
        total_hits,
    })
}

fn search_curseforge_discover(
    client: &Client,
    args: &SearchDiscoverContentArgs,
) -> Result<DiscoverSearchResult, String> {
    let api_key = curseforge_api_key()
        .ok_or_else(|| "CurseForge API key missing. Set MPM_CURSEFORGE_API_KEY.".to_string())?;
    let content_type = normalize_discover_content_type(&args.content_type);
    let class_ids = curseforge_class_ids_for_content_type(&content_type);
    let sort_field = discover_index_sort_field(&args.index);
    let mut all_hits: Vec<DiscoverSearchHit> = Vec::new();
    let mut aggregate_total = 0usize;

    for class_id in class_ids {
        let mut query_pairs: Vec<(String, String)> = vec![
            ("gameId".to_string(), CURSEFORGE_GAME_ID_MINECRAFT.to_string()),
            ("classId".to_string(), class_id.to_string()),
            ("sortField".to_string(), sort_field.to_string()),
            ("sortOrder".to_string(), "desc".to_string()),
            ("pageSize".to_string(), (args.limit + args.offset).max(20).to_string()),
            ("index".to_string(), "0".to_string()),
        ];

        let q_trim = args.query.trim();
        if !q_trim.is_empty() {
            query_pairs.push(("searchFilter".to_string(), q_trim.to_string()));
        } else if content_type == "shaderpacks" {
            query_pairs.push(("searchFilter".to_string(), "shader".to_string()));
        }

        if let Some(game_version) = args.game_version.as_ref() {
            let gv = game_version.trim();
            if !gv.is_empty() {
                query_pairs.push(("gameVersion".to_string(), gv.to_string()));
            }
        }

        let query = query_pairs
            .iter()
            .map(|(k, v)| format!("{}={}", url::form_urlencoded::byte_serialize(k.as_bytes()).collect::<String>(), url::form_urlencoded::byte_serialize(v.as_bytes()).collect::<String>()))
            .collect::<Vec<_>>()
            .join("&");
        let url = format!("{}/mods/search?{}", CURSEFORGE_API_BASE, query);
        let resp = client
            .get(&url)
            .header("Accept", "application/json")
            .header("x-api-key", api_key.clone())
            .send()
            .map_err(|e| format!("CurseForge search failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "CurseForge search failed with status {} (classId={})",
                resp.status(),
                class_id
            ));
        }
        let payload = resp
            .json::<CurseforgeSearchResponse>()
            .map_err(|e| format!("parse CurseForge search failed: {e}"))?;
        aggregate_total += payload
            .pagination
            .as_ref()
            .map(|p| p.total_count)
            .unwrap_or(payload.data.len());

        for item in payload.data {
            let project_id = item.id.to_string();
            let title = if item.name.trim().is_empty() {
                format!("CurseForge #{}", item.id)
            } else {
                item.name.clone()
            };
            let author = item
                .authors
                .first()
                .map(|a| a.name.clone())
                .unwrap_or_else(|| "Unknown".to_string());
            let categories = item
                .categories
                .iter()
                .filter_map(|c| c.slug.clone().or_else(|| Some(c.name.clone())))
                .filter(|s| !s.trim().is_empty())
                .collect::<Vec<_>>();
            let hit_content_type =
                discover_content_type_from_curseforge_class_id(class_id, &content_type);
            let follows = 0_u64;
            all_hits.push(DiscoverSearchHit {
                source: "curseforge".to_string(),
                project_id: project_id.clone(),
                title,
                description: item.summary.clone(),
                author,
                downloads: item.download_count.max(0.0) as u64,
                follows,
                icon_url: item.logo.as_ref().map(|l| l.url.clone()),
                categories,
                versions: Vec::new(),
                date_modified: item.date_modified.clone(),
                content_type: hit_content_type,
                slug: item.slug.clone(),
                external_url: Some(format!("https://www.curseforge.com/minecraft/mc-mods/{}", item.slug.unwrap_or_else(|| project_id.clone()))),
            });
        }
    }

    all_hits.sort_by(|a, b| b.date_modified.cmp(&a.date_modified));
    let sliced = all_hits
        .into_iter()
        .skip(args.offset)
        .take(args.limit)
        .collect::<Vec<_>>();

    Ok(DiscoverSearchResult {
        hits: sliced,
        offset: args.offset,
        limit: args.limit,
        total_hits: aggregate_total,
    })
}

fn resolve_curseforge_file_download_url(
    client: &Client,
    api_key: &str,
    mod_id: i64,
    file: &CurseforgeFile,
) -> Result<String, String> {
    if let Some(url) = file.download_url.as_ref() {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let fallback = format!(
        "{}/mods/{}/files/{}/download-url",
        CURSEFORGE_API_BASE, mod_id, file.id
    );
    let resp = client
        .get(&fallback)
        .header("Accept", "application/json")
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge download-url lookup failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "CurseForge download-url lookup failed with status {}",
            resp.status()
        ));
    }
    let payload = resp
        .json::<CurseforgeDownloadUrlResponse>()
        .map_err(|e| format!("parse CurseForge download-url response failed: {e}"))?;
    let url = payload.data.trim().to_string();
    if url.is_empty() {
        return Err("CurseForge file has no download url".to_string());
    }
    Ok(url)
}

fn sort_discover_hits(hits: &mut [DiscoverSearchHit], index: &str) {
    match index.trim().to_lowercase().as_str() {
        "downloads" => hits.sort_by(|a, b| b.downloads.cmp(&a.downloads)),
        "follows" => hits.sort_by(|a, b| b.follows.cmp(&a.follows)),
        "updated" | "newest" => hits.sort_by(|a, b| b.date_modified.cmp(&a.date_modified)),
        _ => hits.sort_by(|a, b| b.downloads.cmp(&a.downloads)),
    }
}

fn home_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn prism_root_dir() -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("MPM_PRISM_ROOT") {
        let p = PathBuf::from(custom.trim());
        if !p.as_os_str().is_empty() {
            return Ok(p);
        }
    }

    if cfg!(target_os = "macos") {
        if let Some(home) = home_dir() {
            return Ok(home.join("Library").join("Application Support").join("PrismLauncher"));
        }
    } else if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return Ok(PathBuf::from(appdata).join("PrismLauncher"));
        }
    } else if let Some(home) = home_dir() {
        return Ok(home.join(".local").join("share").join("PrismLauncher"));
    }

    Err("Failed to resolve Prism Launcher root. Set MPM_PRISM_ROOT.".into())
}

fn parse_instance_cfg_name(cfg_path: &Path) -> Option<String> {
    let content = fs::read_to_string(cfg_path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(v) = trimmed.strip_prefix("name=") {
            return Some(v.trim().to_string());
        }
    }
    None
}

fn find_prism_instance_id(prism_root: &Path, instance: &Instance) -> Result<String, String> {
    let instances_dir = prism_root.join("instances");
    if !instances_dir.exists() {
        return Err(format!(
            "Prism instances folder not found at '{}'",
            instances_dir.display()
        ));
    }

    if instances_dir.join(&instance.id).is_dir() {
        return Ok(instance.id.clone());
    }

    let mut by_name: Option<String> = None;
    let target_name = instance.name.trim().to_lowercase();
    if !target_name.is_empty() {
        let read = fs::read_dir(&instances_dir)
            .map_err(|e| format!("read Prism instances failed: {e}"))?;
        for ent in read {
            let ent = ent.map_err(|e| format!("read Prism instance entry failed: {e}"))?;
            if !ent.path().is_dir() {
                continue;
            }
            let cfg = ent.path().join("instance.cfg");
            let Some(name) = parse_instance_cfg_name(&cfg) else {
                continue;
            };
            if name.trim().to_lowercase() == target_name {
                by_name = Some(ent.file_name().to_string_lossy().to_string());
                break;
            }
        }
    }

    by_name.ok_or_else(|| {
        format!(
            "No Prism instance matched '{}'. Create one in Prism first (same visible name), or set folder ID to '{}'.",
            instance.name, instance.id
        )
    })
}

fn parse_instance_cfg_value(cfg_path: &Path, key: &str) -> Option<String> {
    let content = fs::read_to_string(cfg_path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(v) = trimmed.strip_prefix(&format!("{key}=")) {
            return Some(v.trim().to_string());
        }
    }
    None
}

fn parse_loader_from_hint(input: &str) -> String {
    let lower = input.trim().to_lowercase();
    if lower.contains("neoforge") {
        return "neoforge".to_string();
    }
    if lower.contains("fabric") {
        return "fabric".to_string();
    }
    if lower.contains("quilt") {
        return "quilt".to_string();
    }
    if lower.contains("forge") {
        return "forge".to_string();
    }
    "vanilla".to_string()
}

fn vanilla_minecraft_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return home_dir().map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("minecraft")
        });
    }
    if cfg!(target_os = "windows") {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return Some(PathBuf::from(appdata).join(".minecraft"));
        }
    }
    home_dir().map(|home| home.join(".minecraft"))
}

fn detect_latest_release_version_from_dir(mc_dir: &Path) -> Option<String> {
    let versions_dir = mc_dir.join("versions");
    if !versions_dir.exists() {
        return None;
    }
    let mut candidates: Vec<String> = Vec::new();
    let entries = fs::read_dir(&versions_dir).ok()?;
    for ent in entries.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let id = ent.file_name().to_string_lossy().to_string();
        if id
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == '-')
            && id.chars().any(|c| c == '.')
        {
            candidates.push(id);
        }
    }
    candidates.sort();
    candidates.pop()
}

fn detect_prism_instance_meta(prism_instance_dir: &Path) -> (String, String) {
    let mut mc_version = "1.20.1".to_string();
    let mut loader = "vanilla".to_string();
    let mmc_pack = prism_instance_dir.join("mmc-pack.json");
    if let Ok(raw) = fs::read_to_string(&mmc_pack) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(components) = value.get("components").and_then(|v| v.as_array()) {
                for comp in components {
                    let uid = comp
                        .get("uid")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_lowercase();
                    let version = comp
                        .get("version")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    if uid == "net.minecraft" && !version.trim().is_empty() {
                        mc_version = version;
                    }
                    if uid.contains("fabric-loader") {
                        loader = "fabric".to_string();
                    } else if uid.contains("neoforge") {
                        loader = "neoforge".to_string();
                    } else if uid.contains("quilt") {
                        loader = "quilt".to_string();
                    } else if uid.contains("forge") {
                        loader = "forge".to_string();
                    }
                }
            }
        }
    }
    (mc_version, loader)
}

fn list_launcher_import_sources_inner() -> Vec<LauncherImportSource> {
    let mut out: Vec<LauncherImportSource> = Vec::new();
    if let Some(mc_dir) = vanilla_minecraft_dir() {
        if mc_dir.exists() && mc_dir.is_dir() {
            out.push(LauncherImportSource {
                id: "vanilla:default".to_string(),
                source_kind: "vanilla".to_string(),
                label: "Vanilla Minecraft".to_string(),
                mc_version: detect_latest_release_version_from_dir(&mc_dir)
                    .unwrap_or_else(|| "1.20.1".to_string()),
                loader: "vanilla".to_string(),
                source_path: mc_dir.display().to_string(),
            });
        }
    }

    if let Ok(prism_root) = prism_root_dir() {
        let instances_dir = prism_root.join("instances");
        if instances_dir.exists() && instances_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&instances_dir) {
                for ent in entries.flatten() {
                    let path = ent.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let folder_id = ent.file_name().to_string_lossy().to_string();
                    let cfg_path = path.join("instance.cfg");
                    let mc_dir = path.join(".minecraft");
                    if !cfg_path.exists() || !mc_dir.exists() {
                        continue;
                    }
                    let label = parse_instance_cfg_value(&cfg_path, "name")
                        .filter(|v| !v.trim().is_empty())
                        .unwrap_or_else(|| folder_id.clone());
                    let (mc_version, loader) = detect_prism_instance_meta(&path);
                    out.push(LauncherImportSource {
                        id: format!("prism:{folder_id}"),
                        source_kind: "prism".to_string(),
                        label,
                        mc_version,
                        loader,
                        source_path: mc_dir.display().to_string(),
                    });
                }
            }
        }
    }

    out.sort_by(|a, b| {
        a.source_kind
            .cmp(&b.source_kind)
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
    });
    out
}

fn copy_dir_recursive_count(src: &Path, dst: &Path) -> Result<usize, String> {
    if !src.exists() {
        return Ok(0);
    }
    fs::create_dir_all(dst).map_err(|e| format!("mkdir '{}' failed: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("read '{}' failed: {e}", src.display()))?;
    let mut copied = 0usize;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read dir entry failed: {e}"))?;
        let src_path = ent.path();
        let dst_path = dst.join(ent.file_name());
        let meta = ent
            .metadata()
            .map_err(|e| format!("read metadata '{}' failed: {e}", src_path.display()))?;
        if meta.is_dir() {
            copied += copy_dir_recursive_count(&src_path, &dst_path)?;
        } else if meta.is_file() {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir '{}' failed: {e}", parent.display()))?;
            }
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "copy '{}' -> '{}' failed: {e}",
                    src_path.display(),
                    dst_path.display()
                )
            })?;
            copied += 1;
        }
    }
    Ok(copied)
}

fn copy_file_if_exists(src: &Path, dst: &Path) -> Result<usize, String> {
    if !src.exists() || !src.is_file() {
        return Ok(0);
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir '{}' failed: {e}", parent.display()))?;
    }
    fs::copy(src, dst).map_err(|e| format!("copy '{}' -> '{}' failed: {e}", src.display(), dst.display()))?;
    Ok(1)
}

fn copy_launcher_source_into_instance(source_mc_dir: &Path, instance_dir: &Path) -> Result<usize, String> {
    let mut copied = 0usize;
    copied += copy_dir_recursive_count(&source_mc_dir.join("mods"), &instance_dir.join("mods"))?;
    copied += copy_dir_recursive_count(&source_mc_dir.join("config"), &instance_dir.join("config"))?;
    copied += copy_dir_recursive_count(
        &source_mc_dir.join("resourcepacks"),
        &instance_dir.join("resourcepacks"),
    )?;
    copied += copy_dir_recursive_count(
        &source_mc_dir.join("shaderpacks"),
        &instance_dir.join("shaderpacks"),
    )?;
    copied += copy_dir_recursive_count(&source_mc_dir.join("saves"), &instance_dir.join("saves"))?;
    copied += copy_file_if_exists(&source_mc_dir.join("options.txt"), &instance_dir.join("options.txt"))?;
    copied += copy_file_if_exists(&source_mc_dir.join("servers.dat"), &instance_dir.join("servers.dat"))?;
    Ok(copied)
}

fn parse_modpack_file_info(
    file_path: &Path,
) -> Result<(String, String, String, Vec<String>, Vec<String>), String> {
    let file =
        File::open(file_path).map_err(|e| format!("open modpack archive failed: {e}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("read modpack archive failed: {e}"))?;

    if let Ok(mut idx_file) = archive.by_name("modrinth.index.json") {
        let mut raw = String::new();
        idx_file
            .read_to_string(&mut raw)
            .map_err(|e| format!("read modrinth.index.json failed: {e}"))?;
        let value = serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|e| format!("parse modrinth.index.json failed: {e}"))?;
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "Imported Modrinth Pack".to_string());
        let deps = value
            .get("dependencies")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        let mc_version = deps
            .get("minecraft")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "1.20.1".to_string());

        let mut loader = "vanilla".to_string();
        for key in deps.keys() {
            let parsed = parse_loader_from_hint(key);
            if parsed != "vanilla" {
                loader = parsed;
                break;
            }
        }

        return Ok((
            name,
            mc_version,
            loader,
            vec!["overrides".to_string(), "client-overrides".to_string()],
            vec![],
        ));
    }

    if let Ok(mut manifest_file) = archive.by_name("manifest.json") {
        let mut raw = String::new();
        manifest_file
            .read_to_string(&mut raw)
            .map_err(|e| format!("read manifest.json failed: {e}"))?;
        let value = serde_json::from_str::<serde_json::Value>(&raw)
            .map_err(|e| format!("parse manifest.json failed: {e}"))?;
        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "Imported CurseForge Pack".to_string());

        let mc_version = value
            .get("minecraft")
            .and_then(|v| v.get("version"))
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "1.20.1".to_string());

        let mut loader = "vanilla".to_string();
        if let Some(loaders) = value
            .get("minecraft")
            .and_then(|v| v.get("modLoaders"))
            .and_then(|v| v.as_array())
        {
            for row in loaders {
                let id = row.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                let parsed = parse_loader_from_hint(id);
                if parsed != "vanilla" {
                    loader = parsed;
                    break;
                }
            }
        }

        let override_dir = value
            .get("overrides")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "overrides".to_string());

        return Ok((name, mc_version, loader, vec![override_dir], vec![]));
    }

    Err("Unsupported modpack archive. Expected modrinth.index.json or manifest.json.".to_string())
}

fn extract_overrides_from_modpack(
    file_path: &Path,
    instance_dir: &Path,
    override_roots: &[String],
) -> Result<usize, String> {
    if override_roots.is_empty() {
        return Ok(0);
    }
    let file =
        File::open(file_path).map_err(|e| format!("open modpack archive failed: {e}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("read modpack archive failed: {e}"))?;

    let mut extracted = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read modpack archive entry failed: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let rel = enclosed.to_string_lossy().replace('\\', "/");
        let mut matched_rel: Option<String> = None;
        for root in override_roots {
            let root_norm = root.trim().trim_matches('/').to_string();
            if root_norm.is_empty() {
                continue;
            }
            let prefix = format!("{root_norm}/");
            if rel == root_norm {
                matched_rel = Some(String::new());
                break;
            }
            if let Some(rest) = rel.strip_prefix(&prefix) {
                matched_rel = Some(rest.to_string());
                break;
            }
        }
        let Some(out_rel) = matched_rel else {
            continue;
        };
        if out_rel.is_empty() {
            continue;
        }
        if out_rel.starts_with("snapshots/") || out_rel.starts_with("runtime/") {
            continue;
        }
        let out_path = instance_dir.join(&out_rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir override parent failed: {e}"))?;
        }
        let mut out =
            File::create(&out_path).map_err(|e| format!("write override file failed: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("extract override failed: {e}"))?;
        extracted += 1;
    }
    Ok(extracted)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst).map_err(|e| format!("mkdir '{}' failed: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("read '{}' failed: {e}", src.display()))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read dir entry failed: {e}"))?;
        let src_path = ent.path();
        let dst_path = dst.join(ent.file_name());
        let meta = ent
            .metadata()
            .map_err(|e| format!("read metadata '{}' failed: {e}", src_path.display()))?;
        if meta.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if meta.is_file() {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir '{}' failed: {e}", parent.display()))?;
            }
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "copy '{}' -> '{}' failed: {e}",
                    src_path.display(),
                    dst_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let md = fs::symlink_metadata(path)
        .map_err(|e| format!("read metadata '{}' failed: {e}", path.display()))?;
    if md.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("remove '{}' failed: {e}", path.display()))?;
    } else {
        fs::remove_file(path).map_err(|e| format!("remove '{}' failed: {e}", path.display()))?;
    }
    Ok(())
}

fn create_dir_symlink(src: &Path, dst: &Path) -> Result<(), String> {
    remove_path_if_exists(dst)?;
    #[cfg(target_os = "windows")]
    {
        std::os::windows::fs::symlink_dir(src, dst)
            .map_err(|e| format!("symlink '{}' -> '{}' failed: {e}", dst.display(), src.display()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::fs::symlink(src, dst)
            .map_err(|e| format!("symlink '{}' -> '{}' failed: {e}", dst.display(), src.display()))
    }
}

fn sync_dir_link_first(src: &Path, dst: &Path, label: &str) -> Result<(), String> {
    if !src.exists() {
        fs::create_dir_all(src)
            .map_err(|e| format!("mkdir source '{}' for {} failed: {e}", src.display(), label))?;
    }
    match create_dir_symlink(src, dst) {
        Ok(()) => Ok(()),
        Err(link_err) => copy_dir_recursive(src, dst).map_err(|copy_err| {
            format!(
                "sync {} failed. symlink error: {}; copy fallback error: {}",
                label, link_err, copy_err
            )
        }),
    }
}

fn sync_instance_runtime_content(app_instance_dir: &Path, runtime_dir: &Path) -> Result<(), String> {
    let source_mods = app_instance_dir.join("mods");
    let source_config = app_instance_dir.join("config");
    let source_resourcepacks = app_instance_dir.join("resourcepacks");
    let source_shaderpacks = app_instance_dir.join("shaderpacks");
    let source_saves = app_instance_dir.join("saves");
    let runtime_mods = runtime_dir.join("mods");
    let runtime_config = runtime_dir.join("config");
    let runtime_resourcepacks = runtime_dir.join("resourcepacks");
    let runtime_shaderpacks = runtime_dir.join("shaderpacks");
    let runtime_saves = runtime_dir.join("saves");
    sync_dir_link_first(&source_mods, &runtime_mods, "runtime mods")?;
    sync_dir_link_first(&source_config, &runtime_config, "runtime config")?;
    sync_dir_link_first(
        &source_resourcepacks,
        &runtime_resourcepacks,
        "runtime resourcepacks",
    )?;
    sync_dir_link_first(&source_shaderpacks, &runtime_shaderpacks, "runtime shaderpacks")?;
    sync_dir_link_first(&source_saves, &runtime_saves, "runtime saves")?;
    Ok(())
}

fn sync_instance_runtime_content_isolated(app_instance_dir: &Path, runtime_dir: &Path) -> Result<(), String> {
    let source_mods = app_instance_dir.join("mods");
    let source_config = app_instance_dir.join("config");
    let source_resourcepacks = app_instance_dir.join("resourcepacks");
    let source_shaderpacks = app_instance_dir.join("shaderpacks");
    let source_saves = app_instance_dir.join("saves");
    let runtime_mods = runtime_dir.join("mods");
    let runtime_config = runtime_dir.join("config");
    let runtime_resourcepacks = runtime_dir.join("resourcepacks");
    let runtime_shaderpacks = runtime_dir.join("shaderpacks");
    let runtime_saves = runtime_dir.join("saves");

    // Concurrent sessions must not mutate live instance worlds/config.
    sync_dir_link_first(&source_mods, &runtime_mods, "runtime mods (isolated)")?;
    sync_dir_link_first(
        &source_resourcepacks,
        &runtime_resourcepacks,
        "runtime resourcepacks (isolated)",
    )?;
    sync_dir_link_first(
        &source_shaderpacks,
        &runtime_shaderpacks,
        "runtime shaderpacks (isolated)",
    )?;

    remove_path_if_exists(&runtime_config)?;
    copy_dir_recursive(&source_config, &runtime_config)?;
    remove_path_if_exists(&runtime_saves)?;
    copy_dir_recursive(&source_saves, &runtime_saves)?;
    let _ = copy_file_if_exists(&app_instance_dir.join("options.txt"), &runtime_dir.join("options.txt"))?;
    let _ = copy_file_if_exists(&app_instance_dir.join("servers.dat"), &runtime_dir.join("servers.dat"))?;
    Ok(())
}

fn sync_prism_instance_content(app_instance_dir: &Path, prism_mc_dir: &Path) -> Result<(), String> {
    let source_mods = app_instance_dir.join("mods");
    let source_config = app_instance_dir.join("config");
    let source_resourcepacks = app_instance_dir.join("resourcepacks");
    let source_shaderpacks = app_instance_dir.join("shaderpacks");
    let source_saves = app_instance_dir.join("saves");
    let target_mods = prism_mc_dir.join("mods");
    let target_config = prism_mc_dir.join("config");
    let target_resourcepacks = prism_mc_dir.join("resourcepacks");
    let target_shaderpacks = prism_mc_dir.join("shaderpacks");
    let target_saves = prism_mc_dir.join("saves");

    sync_dir_link_first(&source_mods, &target_mods, "prism mods")?;
    sync_dir_link_first(&source_config, &target_config, "prism config")?;
    sync_dir_link_first(
        &source_resourcepacks,
        &target_resourcepacks,
        "prism resourcepacks",
    )?;
    sync_dir_link_first(&source_shaderpacks, &target_shaderpacks, "prism shaderpacks")?;
    sync_dir_link_first(&source_saves, &target_saves, "prism saves")?;
    Ok(())
}

fn effective_jvm_args(raw: &str) -> Vec<String> {
    let explicit: Vec<String> = raw
        .split_whitespace()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .collect();
    if !explicit.is_empty() {
        return explicit;
    }
    vec![
        "-XX:+UseG1GC".to_string(),
        "-XX:+ParallelRefProcEnabled".to_string(),
        "-XX:+UseStringDeduplication".to_string(),
        "-XX:MaxGCPauseMillis=200".to_string(),
    ]
}

fn wire_shared_cache(cache_dir: &Path, runtime_dir: &Path) -> Result<(), String> {
    for seg in ["assets", "libraries", "versions"] {
        let shared = cache_dir.join(seg);
        let local = runtime_dir.join(seg);
        fs::create_dir_all(&shared)
            .map_err(|e| format!("mkdir shared cache '{}' failed: {e}", shared.display()))?;
        if local.exists() {
            continue;
        }
        if create_dir_symlink(&shared, &local).is_err() {
            // Best-effort fallback where symlinks are unavailable.
            copy_dir_recursive(&shared, &local)?;
        }
    }
    Ok(())
}

fn resolve_java_executable(settings: &LauncherSettings) -> Result<String, String> {
    if !settings.java_path.trim().is_empty() {
        let p = PathBuf::from(settings.java_path.trim());
        if !p.exists() {
            return Err(format!(
                "Configured Java path does not exist: {}",
                settings.java_path
            ));
        }
        return Ok(p.display().to_string());
    }

    if let Ok(env_java) = std::env::var("MPM_JAVA_PATH") {
        let p = PathBuf::from(env_java.trim());
        if p.exists() {
            return Ok(p.display().to_string());
        }
    }

    match Command::new("java").arg("-version").output() {
        Ok(_) => Ok("java".to_string()),
        Err(e) => Err(format!(
            "Java not found. Set Java path in Settings > Launcher. ({e})"
        )),
    }
}

fn parse_java_major(version_text: &str) -> Option<u32> {
    let mut candidate = String::new();
    if let Some(start) = version_text.find('"') {
        let rest = &version_text[start + 1..];
        if let Some(end) = rest.find('"') {
            candidate = rest[..end].trim().to_string();
        }
    }
    if candidate.is_empty() {
        candidate = version_text.trim().to_string();
    }
    if candidate.is_empty() {
        return None;
    }
    let parts: Vec<&str> = candidate.split('.').collect();
    if parts.first().copied() == Some("1") {
        return parts.get(1).and_then(|p| p.parse::<u32>().ok());
    }
    parts.first().and_then(|p| p.parse::<u32>().ok())
}

fn detect_java_major(java_executable: &str) -> Result<(u32, String), String> {
    let output = Command::new(java_executable)
        .arg("-version")
        .output()
        .map_err(|e| format!("failed to run `{java_executable} -version`: {e}"))?;
    let stderr_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout_text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let combined = if !stderr_text.is_empty() {
        stderr_text
    } else {
        stdout_text
    };
    if combined.is_empty() {
        return Err(format!(
            "`{java_executable} -version` returned no output. Set a valid Java path in Settings."
        ));
    }
    let first_line = combined.lines().next().unwrap_or(&combined).trim().to_string();
    let major = parse_java_major(&first_line)
        .ok_or_else(|| format!("could not parse Java version from: {first_line}"))?;
    Ok((major, first_line))
}

fn maybe_add_java_candidate(path: PathBuf, out: &mut HashMap<String, JavaRuntimeCandidate>) {
    if !path.exists() || !path.is_file() {
        return;
    }
    let resolved = fs::canonicalize(&path).unwrap_or(path);
    let key = resolved.display().to_string();
    if out.contains_key(&key) {
        return;
    }
    if let Ok((major, version_line)) = detect_java_major(&key) {
        out.insert(
            key.clone(),
            JavaRuntimeCandidate {
                path: key,
                major,
                version_line,
            },
        );
    }
}

fn detect_java_runtimes_inner() -> Vec<JavaRuntimeCandidate> {
    let mut map: HashMap<String, JavaRuntimeCandidate> = HashMap::new();

    if let Ok(v) = std::env::var("MPM_JAVA_PATH") {
        maybe_add_java_candidate(PathBuf::from(v.trim()), &mut map);
    }
    if let Ok(v) = std::env::var("JAVA_HOME") {
        let home = PathBuf::from(v.trim());
        if cfg!(target_os = "windows") {
            maybe_add_java_candidate(home.join("bin").join("java.exe"), &mut map);
        } else {
            maybe_add_java_candidate(home.join("bin").join("java"), &mut map);
        }
    }

    if cfg!(target_os = "windows") {
        if let Ok(output) = Command::new("where").arg("java").output() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let p = PathBuf::from(line.trim());
                maybe_add_java_candidate(p, &mut map);
            }
        }
    } else {
        if let Ok(output) = Command::new("which").arg("java").output() {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let p = PathBuf::from(line.trim());
                maybe_add_java_candidate(p, &mut map);
            }
        }
        for path in [
            "/usr/local/bin/java",
            "/usr/bin/java",
            "/opt/homebrew/bin/java",
            "/usr/local/opt/openjdk/bin/java",
            "/opt/homebrew/opt/openjdk/bin/java",
            "/usr/local/opt/openjdk@21/bin/java",
            "/opt/homebrew/opt/openjdk@21/bin/java",
            "/usr/local/opt/openjdk@17/bin/java",
            "/opt/homebrew/opt/openjdk@17/bin/java",
        ] {
            maybe_add_java_candidate(PathBuf::from(path), &mut map);
        }

        if let Ok(home) = std::env::var("HOME") {
            let sdkman_root = PathBuf::from(&home).join(".sdkman").join("candidates").join("java");
            if let Ok(entries) = fs::read_dir(sdkman_root) {
                for ent in entries.flatten() {
                    maybe_add_java_candidate(ent.path().join("bin").join("java"), &mut map);
                }
            }
            let asdf_root = PathBuf::from(&home).join(".asdf").join("installs").join("java");
            if let Ok(entries) = fs::read_dir(asdf_root) {
                for ent in entries.flatten() {
                    maybe_add_java_candidate(ent.path().join("bin").join("java"), &mut map);
                }
            }
        }
    }

    if cfg!(target_os = "macos") {
        maybe_add_java_candidate(PathBuf::from("/usr/bin/java"), &mut map);
        let vm_root = PathBuf::from("/Library/Java/JavaVirtualMachines");
        if let Ok(entries) = fs::read_dir(vm_root) {
            for ent in entries.flatten() {
                let p = ent.path().join("Contents").join("Home").join("bin").join("java");
                maybe_add_java_candidate(p, &mut map);
            }
        }
        let user_vm_root = std::env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join("Library").join("Java").join("JavaVirtualMachines"));
        if let Some(vm_root) = user_vm_root {
            if let Ok(entries) = fs::read_dir(vm_root) {
                for ent in entries.flatten() {
                    let p = ent.path().join("Contents").join("Home").join("bin").join("java");
                    maybe_add_java_candidate(p, &mut map);
                }
            }
        }

        if let Ok(output) = Command::new("/usr/libexec/java_home").arg("-V").output() {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            for line in text.lines() {
                if let Some(start) = line.find('/') {
                    let candidate_home = line[start..].trim();
                    if !candidate_home.is_empty() {
                        let java_bin = PathBuf::from(candidate_home).join("bin").join("java");
                        maybe_add_java_candidate(java_bin, &mut map);
                    }
                }
            }
        }

        for version_hint in ["21", "17", "8"] {
            if let Ok(output) = Command::new("/usr/libexec/java_home")
                .arg("-v")
                .arg(version_hint)
                .output()
            {
                let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !text.is_empty() {
                    maybe_add_java_candidate(PathBuf::from(text).join("bin").join("java"), &mut map);
                }
            }
        }

        for brew_opt in ["/opt/homebrew/opt", "/usr/local/opt"] {
            if let Ok(entries) = fs::read_dir(brew_opt) {
                for ent in entries.flatten() {
                    let name = ent.file_name().to_string_lossy().to_lowercase();
                    if !name.starts_with("openjdk") {
                        continue;
                    }
                    maybe_add_java_candidate(ent.path().join("bin").join("java"), &mut map);
                }
            }
        }
    }

    let mut out: Vec<JavaRuntimeCandidate> = map.into_values().collect();
    out.sort_by(|a, b| {
        b.major
            .cmp(&a.major)
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    out
}

fn parse_mc_release_triplet(version: &str) -> Option<(u32, u32, u32)> {
    let trimmed = version.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

fn required_java_major_for_mc(mc_version: &str) -> u32 {
    if let Some((major, minor, patch)) = parse_mc_release_triplet(mc_version) {
        if major > 1 {
            return 21;
        }
        if minor > 20 || (minor == 20 && patch >= 5) {
            return 21;
        }
        if minor >= 18 {
            return 17;
        }
        if minor >= 17 {
            return 16;
        }
        return 8;
    }
    // Unknown/non-release version format: choose a safe modern baseline.
    17
}

fn tail_lines_from_file(path: &Path, max_lines: usize) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return None;
    }
    if lines.len() > max_lines {
        lines = lines.split_off(lines.len().saturating_sub(max_lines));
    }
    let joined = lines.join("\n").trim().to_string();
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

fn resolve_native_loader(client: &Client, instance: &Instance) -> Result<(Option<String>, Option<String>), String> {
    let loader = instance.loader.to_lowercase();
    match loader.as_str() {
        "vanilla" => Ok((None, None)),
        "fabric" => {
            let version = resolve_fabric_loader_version(client, &instance.mc_version)?;
            Ok((Some("fabric".to_string()), Some(version)))
        }
        "forge" => {
            let version = resolve_forge_loader_version(client, &instance.mc_version)?;
            Ok((Some("forge".to_string()), Some(version)))
        }
        other => Err(format!(
            "Native launch currently supports vanilla/fabric/forge. '{}' is not supported yet.",
            other
        )),
    }
}

fn upsert_launcher_account(app: &tauri::AppHandle, account: &LauncherAccount) -> Result<(), String> {
    let mut accounts = read_launcher_accounts(app)?;
    accounts.retain(|a| a.id != account.id);
    accounts.push(account.clone());
    accounts.sort_by(|a, b| a.username.to_lowercase().cmp(&b.username.to_lowercase()));
    write_launcher_accounts(app, &accounts)
}

fn launch_prism_instance(prism_root: &Path, prism_instance_id: &str) -> Result<(), String> {
    let mut attempts: Vec<(OsString, Vec<OsString>)> = Vec::new();
    let root = OsString::from(prism_root.as_os_str());
    let launch_arg = OsString::from(prism_instance_id);

    if let Ok(bin) = std::env::var("MPM_PRISM_BIN") {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            attempts.push((
                OsString::from(trimmed),
                vec![
                    OsString::from("--dir"),
                    root.clone(),
                    OsString::from("--launch"),
                    launch_arg.clone(),
                ],
            ));
        }
    }

    if cfg!(target_os = "macos") {
        attempts.push((
            OsString::from("/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher"),
            vec![
                OsString::from("--dir"),
                root.clone(),
                OsString::from("--launch"),
                launch_arg.clone(),
            ],
        ));
        attempts.push((
            OsString::from("/Applications/Prism Launcher.app/Contents/MacOS/PrismLauncher"),
            vec![
                OsString::from("--dir"),
                root.clone(),
                OsString::from("--launch"),
                launch_arg.clone(),
            ],
        ));
        attempts.push((
            OsString::from("open"),
            vec![
                OsString::from("-a"),
                OsString::from("Prism Launcher"),
                OsString::from("--args"),
                OsString::from("--dir"),
                root.clone(),
                OsString::from("--launch"),
                launch_arg.clone(),
            ],
        ));
    } else if cfg!(target_os = "windows") {
        attempts.push((
            OsString::from("prismlauncher.exe"),
            vec![
                OsString::from("--dir"),
                root.clone(),
                OsString::from("--launch"),
                launch_arg.clone(),
            ],
        ));
    } else {
        attempts.push((
            OsString::from("prismlauncher"),
            vec![
                OsString::from("--dir"),
                root.clone(),
                OsString::from("--launch"),
                launch_arg.clone(),
            ],
        ));
    }

    let mut errs: Vec<String> = Vec::new();
    for (bin, args) in attempts {
        let mut cmd = Command::new(&bin);
        cmd.args(&args);
        match cmd.spawn() {
            Ok(_) => return Ok(()),
            Err(e) => errs.push(format!("{}: {e}", PathBuf::from(&bin).display())),
        }
    }

    Err(format!(
        "Failed to launch Prism Launcher. {}",
        errs.join(" | ")
    ))
}

fn default_export_filename(instance_name: &str) -> String {
    let date = Local::now().format("%Y-%m-%d").to_string();
    let base = sanitize_filename(&instance_name.replace(' ', "-"));
    let clean = if base.is_empty() { "instance".to_string() } else { base };
    format!("{clean}-mods-{date}.zip")
}

fn build_selected_microsoft_auth(
    app: &tauri::AppHandle,
    client: &Client,
    settings: &LauncherSettings,
) -> Result<(LauncherAccount, String), String> {
    let selected_id = settings
        .selected_account_id
        .clone()
        .ok_or_else(|| "No Microsoft account selected. Connect one in Settings > Launcher.".to_string())?;
    let mut accounts = read_launcher_accounts(app)?;
    let mut account = accounts
        .iter()
        .find(|a| a.id == selected_id)
        .cloned()
        .ok_or_else(|| "Selected Microsoft account no longer exists. Reconnect account.".to_string())?;
    let client_id = resolve_oauth_client_id(app)?;
    let old_account_id = account.id.clone();
    let refresh = keyring_get_refresh_token_for_account(app, &account, &accounts)?;
    let refreshed = microsoft_refresh_access_token(client, &client_id, &refresh)?;
    if let Some(new_refresh) = refreshed.refresh_token.as_ref() {
        persist_refresh_token(app, &old_account_id, new_refresh)?;
    }
    let mc_access = microsoft_access_to_mc_token(client, &refreshed.access_token)?;
    ensure_minecraft_entitlement(client, &mc_access)?;
    let profile = fetch_minecraft_profile(client, &mc_access)?;
    let token_for_new_id = refreshed.refresh_token.as_ref().unwrap_or(&refresh);
    account.id = profile.id;
    if account.id != old_account_id {
        if let Err(e) = persist_refresh_token(app, &account.id, token_for_new_id) {
            eprintln!(
                "refresh token copy to updated account id failed ({} -> {}): {}",
                old_account_id, account.id, e
            );
        }
    }
    account.username = profile.name;
    upsert_launcher_account(app, &account)?;
    accounts.retain(|a| a.id != old_account_id && a.id != account.id);
    accounts.push(account.clone());
    write_launcher_accounts(app, &accounts)?;
    Ok((account, mc_access))
}

fn resolve_native_auth_and_loader(
    app: &tauri::AppHandle,
    settings: &LauncherSettings,
    instance: &Instance,
) -> Result<(LauncherAccount, String, Option<String>, Option<String>), String> {
    let client = build_http_client()?;
    let (account, mc_access_token) = build_selected_microsoft_auth(app, &client, settings)?;
    let (loader, loader_version) = resolve_native_loader(&client, instance)?;
    Ok((account, mc_access_token, loader, loader_version))
}

#[tauri::command]
fn get_launcher_settings(app: tauri::AppHandle) -> Result<LauncherSettings, String> {
    read_launcher_settings(&app)
}

#[tauri::command]
fn get_curseforge_api_status() -> Result<CurseforgeApiStatus, String> {
    let Some((api_key, source)) = curseforge_api_key_with_source() else {
        return Ok(CurseforgeApiStatus {
            configured: false,
            env_var: None,
            key_hint: None,
            validated: false,
            message: "No CurseForge API key configured. Set MPM_CURSEFORGE_API_KEY (or CURSEFORGE_API_KEY) and restart the app.".to_string(),
        });
    };

    let client = build_http_client()?;
    let url = format!(
        "{}/games/{}",
        CURSEFORGE_API_BASE, CURSEFORGE_GAME_ID_MINECRAFT
    );
    let resp = client
        .get(&url)
        .header("x-api-key", api_key.clone())
        .send();

    match resp {
        Ok(response) => {
            if response.status().is_success() {
                Ok(CurseforgeApiStatus {
                    configured: true,
                    env_var: Some(source),
                    key_hint: Some(mask_secret(&api_key)),
                    validated: true,
                    message: "CurseForge API key is valid.".to_string(),
                })
            } else {
                let status = response.status().as_u16();
                let body = response.text().unwrap_or_default();
                let trimmed = body.chars().take(220).collect::<String>();
                Ok(CurseforgeApiStatus {
                    configured: true,
                    env_var: Some(source),
                    key_hint: Some(mask_secret(&api_key)),
                    validated: false,
                    message: if trimmed.is_empty() {
                        format!("CurseForge API key validation failed (HTTP {}).", status)
                    } else {
                        format!(
                            "CurseForge API key validation failed (HTTP {}): {}",
                            status, trimmed
                        )
                    },
                })
            }
        }
        Err(e) => Ok(CurseforgeApiStatus {
            configured: true,
            env_var: Some(source),
            key_hint: Some(mask_secret(&api_key)),
            validated: false,
            message: format!(
                "Could not validate CurseForge key right now (network/request error): {}",
                e
            ),
        }),
    }
}

#[tauri::command]
fn set_launcher_settings(
    app: tauri::AppHandle,
    args: SetLauncherSettingsArgs,
) -> Result<LauncherSettings, String> {
    let mut settings = read_launcher_settings(&app)?;
    if let Some(method) = args.default_launch_method {
        let parsed = LaunchMethod::parse(&method)
            .ok_or_else(|| "defaultLaunchMethod must be prism or native".to_string())?;
        settings.default_launch_method = parsed;
    }
    if let Some(java_path) = args.java_path {
        settings.java_path = java_path.trim().to_string();
    }
    if let Some(client_id) = args.oauth_client_id {
        settings.oauth_client_id = client_id.trim().to_string();
    }
    if let Some(cadence) = args.update_check_cadence {
        settings.update_check_cadence = normalize_update_check_cadence(&cadence);
    }
    if let Some(mode) = args.update_auto_apply_mode {
        settings.update_auto_apply_mode = normalize_update_auto_apply_mode(&mode);
    }
    if let Some(scope) = args.update_apply_scope {
        settings.update_apply_scope = normalize_update_apply_scope(&scope);
    }
    write_launcher_settings(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn list_launcher_accounts(app: tauri::AppHandle) -> Result<Vec<LauncherAccount>, String> {
    read_launcher_accounts(&app)
}

#[tauri::command]
fn select_launcher_account(
    app: tauri::AppHandle,
    args: SelectLauncherAccountArgs,
) -> Result<LauncherSettings, String> {
    let accounts = read_launcher_accounts(&app)?;
    if !accounts.iter().any(|a| a.id == args.account_id) {
        return Err("Account not found".to_string());
    }
    let mut settings = read_launcher_settings(&app)?;
    settings.selected_account_id = Some(args.account_id);
    write_launcher_settings(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn logout_microsoft_account(
    app: tauri::AppHandle,
    args: LogoutMicrosoftAccountArgs,
) -> Result<Vec<LauncherAccount>, String> {
    let mut accounts = read_launcher_accounts(&app)?;
    accounts.retain(|a| a.id != args.account_id);
    write_launcher_accounts(&app, &accounts)?;
    delete_refresh_token_everywhere(&app, &args.account_id);
    let mut settings = read_launcher_settings(&app)?;
    if settings.selected_account_id.as_deref() == Some(args.account_id.as_str()) {
        settings.selected_account_id = None;
        write_launcher_settings(&app, &settings)?;
    }
    Ok(accounts)
}

#[tauri::command]
fn begin_microsoft_login(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<BeginMicrosoftLoginResult, String> {
    let (client_id, client_id_source) = resolve_oauth_client_id_with_source(&app)?;
    let session_id = format!("ms_{}", Uuid::new_v4());
    let client = build_http_client()?;

    let flow = microsoft_begin_device_code(&client, &client_id)?;
    let verification_uri = flow.verification_uri.clone();
    let user_code = flow.user_code.clone();
    let interval = if flow.interval == 0 { 5 } else { flow.interval };
    let expires_in = if flow.expires_in == 0 { 900 } else { flow.expires_in };
    let pending_message = flow
        .message
        .clone()
        .unwrap_or_else(|| format!("Open {} and enter code {}", verification_uri, user_code));

    set_login_session_state(
        &state.login_sessions,
        &session_id,
        "pending",
        Some(pending_message),
        None,
    );

    let sessions = state.login_sessions.clone();
    let app_for_thread = app.clone();
    let session_id_for_thread = session_id.clone();
    let client_id_for_thread = client_id.clone();
    let client_id_source_for_thread = client_id_source.clone();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(expires_in + 20);
        let mut poll_interval_secs = interval.max(2);

        let client = match build_http_client() {
            Ok(c) => c,
            Err(e) => {
                set_login_session_state(
                    &sessions,
                    &session_id_for_thread,
                    "error",
                    Some(format!("build http client failed: {e}")),
                    None,
                );
                return;
            }
        };

        loop {
            if Instant::now() >= deadline {
                set_login_session_state(
                    &sessions,
                    &session_id_for_thread,
                    "error",
                    Some("Microsoft login timed out. Please try again.".to_string()),
                    None,
                );
                return;
            }

            let params = [
                ("client_id", client_id_for_thread.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", flow.device_code.as_str()),
            ];
            let response = match client
                .post(MS_TOKEN_URL)
                .header("Accept", "application/json")
                .form(&params)
                .send()
            {
                Ok(r) => r,
                Err(e) => {
                    set_login_session_state(
                        &sessions,
                        &session_id_for_thread,
                        "error",
                        Some(format!("Microsoft device token polling failed: {e}")),
                        None,
                    );
                    return;
                }
            };

            if response.status().is_success() {
                let token = match response.json::<MsoTokenResponse>() {
                    Ok(v) => v,
                    Err(e) => {
                        set_login_session_state(
                            &sessions,
                            &session_id_for_thread,
                            "error",
                            Some(format!("parse Microsoft device token response failed: {e}")),
                            None,
                        );
                        return;
                    }
                };

                let result = (|| -> Result<LauncherAccount, String> {
                    let refresh = token
                        .refresh_token
                        .ok_or_else(|| "Microsoft login did not return refresh token.".to_string())?;
                    let mc_access = microsoft_access_to_mc_token(&client, &token.access_token)?;
                    ensure_minecraft_entitlement(&client, &mc_access)?;
                    let profile = fetch_minecraft_profile(&client, &mc_access)?;
                    let account = LauncherAccount {
                        id: profile.id,
                        username: profile.name,
                        added_at: now_iso(),
                    };
                    persist_refresh_token(&app_for_thread, &account.id, &refresh)?;
                    upsert_launcher_account(&app_for_thread, &account)?;

                    let mut settings = read_launcher_settings(&app_for_thread)?;
                    settings.selected_account_id = Some(account.id.clone());
                    write_launcher_settings(&app_for_thread, &settings)?;
                    Ok(account)
                })();

                match result {
                    Ok(account) => {
                        set_login_session_state(
                            &sessions,
                            &session_id_for_thread,
                            "success",
                            Some("Microsoft account connected.".to_string()),
                            Some(account),
                        );
                    }
                    Err(err) => {
                        set_login_session_state(
                            &sessions,
                            &session_id_for_thread,
                            "error",
                            Some(err),
                            None,
                        );
                    }
                }
                return;
            }

            let err_body = response
                .text()
                .unwrap_or_else(|_| "unknown token polling error".to_string());
            let parsed = serde_json::from_str::<serde_json::Value>(&err_body).ok();
            let err_code = parsed
                .as_ref()
                .and_then(|v| v.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let err_desc = parsed
                .as_ref()
                .and_then(|v| v.get("error_description"))
                .and_then(|v| v.as_str())
                .unwrap_or(err_body.as_str());

            if err_code.eq_ignore_ascii_case("authorization_pending") {
                thread::sleep(Duration::from_secs(poll_interval_secs));
                continue;
            }
            if err_code.eq_ignore_ascii_case("slow_down") {
                poll_interval_secs = (poll_interval_secs + 2).min(15);
                thread::sleep(Duration::from_secs(poll_interval_secs));
                continue;
            }
            if err_code.eq_ignore_ascii_case("authorization_declined")
                || err_code.eq_ignore_ascii_case("bad_verification_code")
                || err_code.eq_ignore_ascii_case("expired_token")
            {
                set_login_session_state(
                    &sessions,
                    &session_id_for_thread,
                    "error",
                    Some(format!("Microsoft login cancelled/expired: {err_desc}")),
                    None,
                );
                return;
            }

            set_login_session_state(
                &sessions,
                &session_id_for_thread,
                "error",
                Some(normalize_microsoft_login_error(
                    err_code,
                    err_desc,
                    &client_id_source_for_thread,
                )),
                None,
            );
            return;
        }
    });

    if let Err(e) = tauri::api::shell::open(&app.shell_scope(), verification_uri.clone(), None) {
        set_login_session_state(
            &state.login_sessions,
            &session_id,
            "pending",
            Some(format!(
                "Open {} and enter code {} (browser auto-open failed: {})",
                verification_uri, user_code, e
            )),
            None,
        );
    }

    Ok(BeginMicrosoftLoginResult {
        session_id,
        auth_url: verification_uri.clone(),
        user_code: Some(user_code),
        verification_uri: Some(verification_uri),
    })
}

#[tauri::command]
fn poll_microsoft_login(
    state: tauri::State<AppState>,
    args: PollMicrosoftLoginArgs,
) -> Result<MicrosoftLoginState, String> {
    let guard = state
        .login_sessions
        .lock()
        .map_err(|_| "lock login sessions failed".to_string())?;
    guard
        .get(&args.session_id)
        .cloned()
        .ok_or_else(|| "login session not found".to_string())
}

#[tauri::command]
fn list_running_instances(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<Vec<RunningInstance>, String> {
    let mut guard = state
        .running
        .lock()
        .map_err(|_| "lock running instances failed".to_string())?;
    let mut finished: Vec<String> = Vec::new();
    for (id, proc_entry) in guard.iter_mut() {
        if let Ok(mut child) = proc_entry.child.lock() {
            if let Ok(Some(status)) = child.try_wait() {
                finished.push(id.clone());
                emit_launch_state(
                    &app,
                    &proc_entry.meta.instance_id,
                    Some(&proc_entry.meta.launch_id),
                    &proc_entry.meta.method,
                    "exited",
                    &format!("Game exited with status {:?}", status.code()),
                );
            }
        }
    }
    for id in finished {
        guard.remove(&id);
    }
    let mut out: Vec<RunningInstance> = guard
        .values()
        .map(|v| {
            let mut meta = v.meta.clone();
            if meta.log_path.is_none() {
                meta.log_path = v.log_path.as_ref().map(|p| p.display().to_string());
            }
            meta
        })
        .collect();
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

#[tauri::command]
fn stop_running_instance(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    args: StopRunningInstanceArgs,
) -> Result<(), String> {
    let removed = {
        let mut guard = state
            .running
            .lock()
            .map_err(|_| "lock running instances failed".to_string())?;
        guard.remove(&args.launch_id)
    };
    let Some(proc_entry) = removed else {
        return Err("Running instance not found".to_string());
    };
    if let Ok(mut child) = proc_entry.child.lock() {
        let _ = child.kill();
    }
    emit_launch_state(
        &app,
        &proc_entry.meta.instance_id,
        Some(&proc_entry.meta.launch_id),
        &proc_entry.meta.method,
        "stopped",
        "Instance stop requested.",
    );
    Ok(())
}

#[tauri::command]
fn cancel_instance_launch(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    args: CancelInstanceLaunchArgs,
) -> Result<String, String> {
    let instance_id = args.instance_id.trim();
    if instance_id.is_empty() {
        return Err("instanceId is required".to_string());
    }

    mark_launch_cancel_request(&state, instance_id)?;

    let mut stopped_any = false;
    let removed = {
        let mut guard = state
            .running
            .lock()
            .map_err(|_| "lock running instances failed".to_string())?;
        let keys = guard
            .iter()
            .filter_map(|(id, proc_entry)| {
                if proc_entry.meta.instance_id == instance_id {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        let mut removed_entries = Vec::new();
        for key in keys {
            if let Some(entry) = guard.remove(&key) {
                removed_entries.push(entry);
            }
        }
        removed_entries
    };

    for proc_entry in removed {
        stopped_any = true;
        if let Ok(mut child) = proc_entry.child.lock() {
            let _ = child.kill();
        }
        emit_launch_state(
            &app,
            &proc_entry.meta.instance_id,
            Some(&proc_entry.meta.launch_id),
            &proc_entry.meta.method,
            "stopped",
            "Launch cancelled by user.",
        );
    }

    if stopped_any {
        Ok("Launch cancellation requested. Stop signal sent.".to_string())
    } else {
        Ok("Launch cancellation requested.".to_string())
    }
}

#[tauri::command]
fn open_instance_path(
    app: tauri::AppHandle,
    args: OpenInstancePathArgs,
) -> Result<OpenInstancePathResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    let (target, resolved_path, create_if_missing) =
        resolve_target_instance_path(&instance_dir, &args.target)?;
    open_path_in_shell(&resolved_path, create_if_missing)?;
    Ok(OpenInstancePathResult {
        target,
        path: resolved_path.display().to_string(),
    })
}

#[tauri::command]
fn reveal_config_editor_file(
    app: tauri::AppHandle,
    args: RevealConfigEditorFileArgs,
) -> Result<RevealConfigEditorFileResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    let scope = args.scope.trim().to_lowercase();

    if scope == "instance" {
        let (opened, _) = reveal_path_in_shell(&instance_dir, false)?;
        return Ok(RevealConfigEditorFileResult {
            opened_path: opened.display().to_string(),
            revealed_file: false,
            virtual_file: true,
            message: "Instance config files are localStorage-backed. Opened the instance folder instead."
                .to_string(),
        });
    }

    if scope == "world" {
        let world_id = args
            .world_id
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| "worldId is required for world scope".to_string())?;
        let file_path = args
            .path
            .as_ref()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| "path is required for world scope".to_string())?;
        let world_root = world_root_dir(&instances_dir, &args.instance_id, &world_id)?;
        let (resolved, _) = resolve_world_file_path(&world_root, &file_path, true)?;
        let (opened, revealed_file) = reveal_path_in_shell(&resolved, true)?;
        return Ok(RevealConfigEditorFileResult {
            opened_path: opened.display().to_string(),
            revealed_file,
            virtual_file: false,
            message: if revealed_file {
                "Revealed file in Finder.".to_string()
            } else {
                "Opened containing folder.".to_string()
            },
        });
    }

    Err("scope must be instance or world".to_string())
}

#[tauri::command]
fn read_instance_logs(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    args: ReadInstanceLogsArgs,
) -> Result<ReadInstanceLogsResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    let source_raw = args.source.trim().to_lowercase();
    let max_lines = args.max_lines.unwrap_or(2500).clamp(200, 12000);
    let before_line = args.before_line;

    let (source, path) = match source_raw.as_str() {
        "latest_crash" | "latest-crash" | "crash" => (
            "latest_crash".to_string(),
            latest_crash_report_path(&instance_dir),
        ),
        "latest_launch" | "latest-launch" | "launch" => (
            "latest_launch".to_string(),
            latest_launch_log_path(&instance_dir),
        ),
        "live" => {
            let guard = state
                .running
                .lock()
                .map_err(|_| "lock running instances failed".to_string())?;
            let mut best: Option<(String, PathBuf)> = None;
            for proc_entry in guard.values() {
                if proc_entry.meta.instance_id != args.instance_id
                    || !proc_entry.meta.method.eq_ignore_ascii_case("native")
                {
                    continue;
                }
                let Some(path) = proc_entry.log_path.clone() else {
                    continue;
                };
                match &best {
                    Some((started_at, _))
                        if started_at.as_str() >= proc_entry.meta.started_at.as_str() => {}
                    _ => {
                        best = Some((proc_entry.meta.started_at.clone(), path));
                    }
                }
            }
            (
                "live".to_string(),
                best.map(|(_, path)| path)
                    .or_else(|| latest_launch_log_path(&instance_dir)),
            )
        }
        _ => return Err("source must be live, latest_launch, or latest_crash".to_string()),
    };

    let Some(path) = path else {
        return Ok(ReadInstanceLogsResult {
            source,
            path: String::new(),
            available: false,
            total_lines: 0,
            returned_lines: 0,
            truncated: false,
            start_line_no: None,
            end_line_no: None,
            next_before_line: None,
            lines: Vec::new(),
            updated_at: 0,
            message: Some("No log file found for this source yet.".to_string()),
        });
    };

    if !path.exists() || !path.is_file() {
        return Ok(ReadInstanceLogsResult {
            source,
            path: path.display().to_string(),
            available: false,
            total_lines: 0,
            returned_lines: 0,
            truncated: false,
            start_line_no: None,
            end_line_no: None,
            next_before_line: None,
            lines: Vec::new(),
            updated_at: 0,
            message: Some("Log file does not exist yet.".to_string()),
        });
    }

    let (lines, total_lines, truncated, start_line_no, end_line_no, next_before_line) =
        read_windowed_log_lines(&path, &source, max_lines, before_line)?;
    let updated_at = fs::metadata(&path)
        .map(|meta| modified_millis(&meta))
        .unwrap_or(0);
    Ok(ReadInstanceLogsResult {
        source,
        path: path.display().to_string(),
        available: true,
        total_lines,
        returned_lines: lines.len(),
        truncated,
        start_line_no,
        end_line_no,
        next_before_line,
        lines,
        updated_at,
        message: None,
    })
}

#[tauri::command]
fn list_instance_snapshots(
    app: tauri::AppHandle,
    args: ListInstanceSnapshotsArgs,
) -> Result<Vec<SnapshotMeta>, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    list_snapshots(&instance_dir)
}

#[tauri::command]
fn rollback_instance(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    args: RollbackInstanceArgs,
) -> Result<RollbackResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    {
        let guard = state
            .running
            .lock()
            .map_err(|_| "lock running instances failed".to_string())?;
        if guard.values().any(|entry| entry.meta.instance_id == args.instance_id) {
            return Err("Stop the running Minecraft session before rolling back this instance.".to_string());
        }
    }
    let instance_dir = instances_dir.join(&args.instance_id);
    let snapshots = list_snapshots(&instance_dir)?;
    if snapshots.is_empty() {
        return Err("No snapshots found for this instance".to_string());
    }
    let selected = if let Some(snapshot_id) = args.snapshot_id.as_ref() {
        snapshots
            .into_iter()
            .find(|s| s.id == *snapshot_id)
            .ok_or_else(|| "Snapshot not found".to_string())?
    } else {
        snapshots
            .into_iter()
            .next()
            .ok_or_else(|| "No snapshots found for this instance".to_string())?
    };

    let snapshot_dir = snapshots_dir(&instance_dir).join(&selected.id);
    let lock_raw = fs::read_to_string(snapshot_lock_path(&snapshot_dir))
        .map_err(|e| format!("read snapshot lock failed: {e}"))?;
    let lock: Lockfile =
        serde_json::from_str(&lock_raw).map_err(|e| format!("parse snapshot lock failed: {e}"))?;

    let restored_files = restore_instance_content_zip(&snapshot_content_zip_path(&snapshot_dir), &instance_dir)?;
    write_lockfile(&instances_dir, &args.instance_id, &lock)?;

    Ok(RollbackResult {
        snapshot_id: selected.id,
        created_at: selected.created_at,
        restored_files,
        message: "Rollback complete.".to_string(),
    })
}

#[tauri::command]
fn list_instance_worlds(
    app: tauri::AppHandle,
    args: ListInstanceWorldsArgs,
) -> Result<Vec<InstanceWorld>, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    let saves_dir = instance_dir.join("saves");
    fs::create_dir_all(&saves_dir).map_err(|e| format!("mkdir saves failed: {e}"))?;

    let world_backups = list_world_backups(&instance_dir).unwrap_or_default();
    let mut backup_count_by_world: HashMap<String, usize> = HashMap::new();
    let mut latest_backup_by_world: HashMap<String, WorldBackupMeta> = HashMap::new();
    for meta in world_backups {
        *backup_count_by_world.entry(meta.world_id.clone()).or_insert(0) += 1;
        latest_backup_by_world
            .entry(meta.world_id.clone())
            .or_insert(meta);
    }

    let mut out = Vec::new();
    let entries = fs::read_dir(&saves_dir).map_err(|e| format!("read saves dir failed: {e}"))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read save entry failed: {e}"))?;
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().to_string();
        if name.trim().is_empty() {
            continue;
        }
        let latest = latest_backup_by_world.get(&name);
        out.push(InstanceWorld {
            id: name.clone(),
            name: name.clone(),
            path: path.display().to_string(),
            latest_backup_id: latest.map(|m| m.id.clone()),
            latest_backup_at: latest.map(|m| m.created_at.clone()),
            backup_count: backup_count_by_world.get(&name).copied().unwrap_or(0),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn running_instance_ids(state: &tauri::State<AppState>) -> Result<HashSet<String>, String> {
    let guard = state
        .running
        .lock()
        .map_err(|_| "lock running instances failed".to_string())?;
    Ok(guard
        .values()
        .map(|entry| entry.meta.instance_id.clone())
        .collect::<HashSet<_>>())
}

fn collect_world_config_files_recursive(
    world_root: &Path,
    current: &Path,
    out: &mut Vec<WorldConfigFileEntry>,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|e| format!("read world directory failed: {e}"))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("read world entry failed: {e}"))?;
        let path = ent.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("read world metadata failed: {e}"))?;
        let file_type = meta.file_type();
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_world_config_files_recursive(world_root, &path, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let rel = path
            .strip_prefix(world_root)
            .map_err(|_| "failed to compute relative world file path".to_string())?;
        let rel_text = rel.to_string_lossy().replace('\\', "/").trim_start_matches('/').to_string();
        if rel_text.is_empty() {
            continue;
        }

        let mut sample = Vec::new();
        if let Ok(mut file) = File::open(&path) {
            let mut buf = [0u8; 1024];
            if let Ok(read_len) = file.read(&mut buf) {
                sample.extend_from_slice(&buf[..read_len]);
            }
        }
        let text_like = file_is_text_like(&path, &sample);
        let kind = infer_world_file_kind(&path, text_like);
        let readonly_reason = describe_non_editable_reason(&kind, text_like);
        out.push(WorldConfigFileEntry {
            path: rel_text,
            size_bytes: meta.len(),
            modified_at: modified_millis(&meta),
            editable: readonly_reason.is_none(),
            kind,
            readonly_reason,
        });
    }
    Ok(())
}

#[tauri::command]
fn list_world_config_files(
    app: tauri::AppHandle,
    args: ListWorldConfigFilesArgs,
) -> Result<Vec<WorldConfigFileEntry>, String> {
    let instances_dir = app_instances_dir(&app)?;
    let world_root = world_root_dir(&instances_dir, &args.instance_id, &args.world_id)?;
    let mut out = Vec::new();
    collect_world_config_files_recursive(&world_root, &world_root, &mut out)?;
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn read_world_config_file(
    app: tauri::AppHandle,
    args: ReadWorldConfigFileArgs,
) -> Result<ReadWorldConfigFileResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let world_root = world_root_dir(&instances_dir, &args.instance_id, &args.world_id)?;
    let (resolved_path, normalized_path) = resolve_world_file_path(&world_root, &args.path, true)?;
    let meta = fs::metadata(&resolved_path).map_err(|e| format!("read world file metadata failed: {e}"))?;
    if !meta.is_file() {
        return Err("Requested world file is not a file".to_string());
    }

    let mut file = File::open(&resolved_path).map_err(|e| format!("open world file failed: {e}"))?;
    let mut sample_buf = vec![0u8; 4096];
    let read_len = file
        .read(&mut sample_buf)
        .map_err(|e| format!("read world file failed: {e}"))?;
    sample_buf.truncate(read_len);
    let text_like = file_is_text_like(&resolved_path, &sample_buf[..sample_buf.len().min(1024)]);
    let kind = infer_world_file_kind(&resolved_path, text_like);
    let readonly_reason = describe_non_editable_reason(&kind, text_like);
    if readonly_reason.is_some() {
        let preview = format_binary_preview(&sample_buf[..sample_buf.len().min(512)], meta.len(), &kind);
        return Ok(ReadWorldConfigFileResult {
            path: normalized_path,
            editable: false,
            kind,
            size_bytes: meta.len(),
            modified_at: modified_millis(&meta),
            readonly_reason,
            content: Some(preview),
            preview: Some("hex".to_string()),
        });
    }

    let mut bytes = sample_buf;
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("read world file failed: {e}"))?;
    let content = String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8 text.".to_string())?;
    Ok(ReadWorldConfigFileResult {
        path: normalized_path,
        editable: true,
        kind,
        size_bytes: meta.len(),
        modified_at: modified_millis(&meta),
        readonly_reason: None,
        content: Some(content),
        preview: None,
    })
}

#[tauri::command]
fn write_world_config_file(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    args: WriteWorldConfigFileArgs,
) -> Result<WriteWorldConfigFileResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let running_ids = running_instance_ids(&state)?;
    if running_ids.contains(&args.instance_id) {
        return Err("Stop the running Minecraft session before saving world files.".to_string());
    }

    let world_root = world_root_dir(&instances_dir, &args.instance_id, &args.world_id)?;
    let (resolved_path, normalized_path) = resolve_world_file_path(&world_root, &args.path, true)?;
    let before_meta =
        fs::metadata(&resolved_path).map_err(|e| format!("read world file metadata failed: {e}"))?;
    if !before_meta.is_file() {
        return Err("Requested world file is not a file".to_string());
    }
    if let Some(expected_modified_at) = args.expected_modified_at {
        let actual_modified_at = modified_millis(&before_meta);
        if expected_modified_at != actual_modified_at {
            return Err("File changed on disk. Reload and try saving again.".to_string());
        }
    }

    let mut sample = args.content.as_bytes().to_vec();
    if sample.len() > 1024 {
        sample.truncate(1024);
    }
    let text_like = file_is_text_like(&resolved_path, &sample);
    let kind = infer_world_file_kind(&resolved_path, text_like);
    if describe_non_editable_reason(&kind, text_like).is_some() {
        return Err("Binary or unsupported world file cannot be edited.".to_string());
    }

    let parent = resolved_path
        .parent()
        .ok_or_else(|| "Invalid world file path".to_string())?;
    let tmp_name = format!(".mpm-write-{}.tmp", Uuid::new_v4());
    let tmp_path = parent.join(tmp_name);
    fs::write(&tmp_path, args.content.as_bytes())
        .map_err(|e| format!("write temp world file failed: {e}"))?;
    if let Err(err) = fs::rename(&tmp_path, &resolved_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("replace world file failed: {err}"));
    }
    let after_meta =
        fs::metadata(&resolved_path).map_err(|e| format!("read world file metadata failed: {e}"))?;
    Ok(WriteWorldConfigFileResult {
        path: normalized_path,
        size_bytes: after_meta.len(),
        modified_at: modified_millis(&after_meta),
        message: "World file saved.".to_string(),
    })
}

#[tauri::command]
fn rollback_instance_world_backup(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    args: RollbackInstanceWorldBackupArgs,
) -> Result<WorldRollbackResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    {
        let guard = state
            .running
            .lock()
            .map_err(|_| "lock running instances failed".to_string())?;
        if guard.values().any(|entry| entry.meta.instance_id == args.instance_id) {
            return Err("Stop the running Minecraft session before rolling back this world.".to_string());
        }
    }
    let world_id = args.world_id.trim();
    if world_id.is_empty() {
        return Err("World ID is required".to_string());
    }
    let instance_dir = instances_dir.join(&args.instance_id);
    let backups = list_world_backups(&instance_dir)?;
    let selected = if let Some(backup_id) = args.backup_id.as_ref() {
        backups
            .into_iter()
            .find(|b| b.world_id == world_id && b.id == *backup_id)
            .ok_or_else(|| "World backup not found".to_string())?
    } else {
        backups
            .into_iter()
            .find(|b| b.world_id == world_id)
            .ok_or_else(|| "No world backup found for this world yet".to_string())?
    };

    let backup_dir = world_backups_dir(&instance_dir).join(&selected.id);
    let world_dir = instance_dir.join("saves").join(world_id);
    let restored_files = restore_world_backup_zip(&world_backup_zip_path(&backup_dir), &world_dir)?;
    Ok(WorldRollbackResult {
        world_id: world_id.to_string(),
        backup_id: selected.id.clone(),
        created_at: selected.created_at.clone(),
        restored_files,
        message: "World rollback complete.".to_string(),
    })
}

fn install_discover_content_inner(
    app: tauri::AppHandle,
    args: &InstallDiscoverContentArgs,
    snapshot_reason: Option<&str>,
) -> Result<InstalledMod, String> {
    let source = args.source.trim().to_lowercase();
    let content_type = normalize_lock_content_type(&args.content_type);
    if content_type == "modpacks" {
        return Err("Modpacks are template-only here. Use Import as Template in Modpacks & Presets.".to_string());
    }

    if content_type == "mods" {
        if source == "curseforge" {
            return install_curseforge_mod_inner(
                app,
                InstallCurseforgeModArgs {
                    instance_id: args.instance_id.clone(),
                    project_id: args.project_id.clone(),
                    project_title: args.project_title.clone(),
                },
                snapshot_reason,
            );
        }
        let modrinth_reason = snapshot_reason;
        return install_modrinth_mod_inner(
            app,
            InstallModrinthModArgs {
                instance_id: args.instance_id.clone(),
                project_id: args.project_id.clone(),
                project_title: args.project_title.clone(),
            },
            modrinth_reason,
        );
    }

    let instances_dir = app_instances_dir(&app)?;
    let instance = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&instance.id);
    let mut lock = read_lockfile(&instances_dir, &args.instance_id)?;
    let client = build_http_client()?;

    if let Some(reason) = snapshot_reason {
        let _ = create_instance_snapshot(&instances_dir, &args.instance_id, reason);
    }

    let new_entry = if source == "curseforge" {
        let api_key = curseforge_api_key()
            .ok_or_else(|| "CurseForge API key missing. Set MPM_CURSEFORGE_API_KEY.".to_string())?;
        install_curseforge_content_inner(
            &instance,
            &instance_dir,
            &mut lock,
            &client,
            &api_key,
            &args.project_id,
            args.project_title.as_deref(),
            &content_type,
            &args.target_worlds,
        )?
    } else {
        install_modrinth_content_inner(
            &instance,
            &instance_dir,
            &mut lock,
            &client,
            &args.project_id,
            args.project_title.as_deref(),
            &content_type,
            &args.target_worlds,
        )?
    };

    lock.entries
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    write_lockfile(&instances_dir, &args.instance_id, &lock)?;
    Ok(lock_entry_to_installed(&instance_dir, &new_entry))
}

#[tauri::command]
fn install_discover_content(
    app: tauri::AppHandle,
    args: InstallDiscoverContentArgs,
) -> Result<InstalledMod, String> {
    let reason = format!("before-install-discover:{}", args.project_id);
    install_discover_content_inner(app, &args, Some(reason.as_str()))
}

#[tauri::command]
fn preview_preset_apply(
    app: tauri::AppHandle,
    args: PreviewPresetApplyArgs,
) -> Result<PresetApplyPreview, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    let existing_worlds: HashSet<String> = list_instance_world_names(&instance_dir)?.into_iter().collect();
    let use_all_worlds_for_datapacks = args
        .preset
        .settings
        .datapack_target_policy
        .trim()
        .eq_ignore_ascii_case("all_worlds");

    let mut installable = 0usize;
    let mut skipped_disabled = 0usize;
    let mut missing_world_targets = Vec::new();
    let mut provider_warnings = Vec::new();
    let mut seen = HashSet::new();
    let mut duplicates = 0usize;

    let has_cf = args
        .preset
        .entries
        .iter()
        .any(|e| e.source.eq_ignore_ascii_case("curseforge") && e.enabled);
    if has_cf && curseforge_api_key().is_none() {
        provider_warnings.push("CurseForge API key missing. CurseForge entries cannot be installed.".to_string());
    }

    for entry in &args.preset.entries {
        if !entry.enabled {
            skipped_disabled += 1;
            continue;
        }
        let content_type = normalize_lock_content_type(&entry.content_type);
        let key = format!(
            "{}:{}:{}:{}",
            entry.source.to_lowercase(),
            content_type,
            entry.project_id.to_lowercase(),
            entry.target_worlds.join("|")
        );
        if !seen.insert(key) {
            duplicates += 1;
        }

        if content_type == "datapacks" {
            let mut missing = false;
            if entry.target_worlds.is_empty() {
                if !use_all_worlds_for_datapacks {
                    missing = true;
                }
            } else {
                for world in &entry.target_worlds {
                    if !existing_worlds.contains(world) {
                        missing = true;
                        break;
                    }
                }
            }
            if missing {
                missing_world_targets.push(format!("{} ({})", entry.title, entry.project_id));
                continue;
            }
        }
        installable += 1;
    }

    let valid = missing_world_targets.is_empty() && provider_warnings.is_empty();
    Ok(PresetApplyPreview {
        valid,
        installable_entries: installable,
        skipped_disabled_entries: skipped_disabled,
        missing_world_targets,
        provider_warnings,
        duplicate_entries: duplicates,
    })
}

#[tauri::command]
fn apply_preset_to_instance(
    app: tauri::AppHandle,
    args: ApplyPresetToInstanceArgs,
) -> Result<PresetApplyResult, String> {
    let preview = preview_preset_apply(
        app.clone(),
        PreviewPresetApplyArgs {
            instance_id: args.instance_id.clone(),
            preset: args.preset.clone(),
        },
    )?;
    if !preview.valid {
        let mut reasons = Vec::new();
        if !preview.provider_warnings.is_empty() {
            reasons.push(preview.provider_warnings.join("; "));
        }
        if !preview.missing_world_targets.is_empty() {
            reasons.push(format!(
                "Missing datapack targets: {}",
                preview.missing_world_targets.join(", ")
            ));
        }
        return Err(reasons.join(" | "));
    }

    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let mut snapshot_id: Option<String> = None;
    let snapshot_requested = args.preset.settings.snapshot_before_apply;
    if snapshot_requested && preview.installable_entries > 0 {
        let snapshot = create_instance_snapshot(&instances_dir, &args.instance_id, "before-apply-preset")?;
        snapshot_id = Some(snapshot.id);
    }

    let mut installed = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut by_content_type: HashMap<String, usize> = HashMap::new();
    let all_worlds = list_instance_world_names(&instances_dir.join(&args.instance_id)).unwrap_or_default();
    let use_all_worlds_for_datapacks = args
        .preset
        .settings
        .datapack_target_policy
        .trim()
        .eq_ignore_ascii_case("all_worlds");
    for entry in &args.preset.entries {
        if !entry.enabled {
            skipped += 1;
            continue;
        }
        let content_type = normalize_lock_content_type(&entry.content_type);
        let resolved_target_worlds = if content_type == "datapacks"
            && entry.target_worlds.is_empty()
            && use_all_worlds_for_datapacks
        {
            all_worlds.clone()
        } else {
            entry.target_worlds.clone()
        };
        let result = install_discover_content_inner(
            app.clone(),
            &InstallDiscoverContentArgs {
                instance_id: args.instance_id.clone(),
                source: entry.source.clone(),
                project_id: entry.project_id.clone(),
                project_title: Some(entry.title.clone()),
                content_type: content_type.clone(),
                target_worlds: resolved_target_worlds,
            },
            None,
        );
        match result {
            Ok(_) => {
                installed += 1;
                *by_content_type.entry(content_type).or_insert(0) += 1;
            }
            Err(_) => {
                failed += 1;
            }
        }
    }

    Ok(PresetApplyResult {
        message: if failed == 0 {
            format!("Applied preset '{}' successfully.", args.preset.name)
        } else {
            format!(
                "Applied preset '{}' with {} failed entr{}.",
                args.preset.name,
                failed,
                if failed == 1 { "y" } else { "ies" }
            )
        },
        installed_entries: installed,
        skipped_entries: skipped,
        failed_entries: failed,
        snapshot_id,
        by_content_type,
    })
}

#[tauri::command]
fn search_discover_content(args: SearchDiscoverContentArgs) -> Result<DiscoverSearchResult, String> {
    std::panic::catch_unwind(|| search_discover_content_inner(args))
        .map_err(|_| "Discover search encountered an unexpected error".to_string())?
}

fn search_discover_content_inner(args: SearchDiscoverContentArgs) -> Result<DiscoverSearchResult, String> {
    let source = args.source.trim().to_lowercase();
    let client = build_http_client()?;
    if source == "modrinth" {
        return search_modrinth_discover(&client, &args);
    }
    if source == "curseforge" {
        return search_curseforge_discover(&client, &args);
    }

    let mut sub = args.clone();
    sub.offset = 0;
    sub.limit = (args.offset + args.limit).max(args.limit);

    let modrinth = search_modrinth_discover(&client, &sub).unwrap_or(DiscoverSearchResult {
        hits: vec![],
        offset: 0,
        limit: sub.limit,
        total_hits: 0,
    });

    let curseforge = if curseforge_api_key().is_some() {
        search_curseforge_discover(&client, &sub).unwrap_or(DiscoverSearchResult {
            hits: vec![],
            offset: 0,
            limit: sub.limit,
            total_hits: 0,
        })
    } else {
        DiscoverSearchResult {
            hits: vec![],
            offset: 0,
            limit: sub.limit,
            total_hits: 0,
        }
    };

    let mut merged = modrinth.hits;
    merged.extend(curseforge.hits);
    sort_discover_hits(&mut merged, &args.index);
    let total_hits = modrinth
        .total_hits
        .saturating_add(curseforge.total_hits);
    let hits = merged
        .into_iter()
        .skip(args.offset)
        .take(args.limit)
        .collect::<Vec<_>>();

    Ok(DiscoverSearchResult {
        hits,
        offset: args.offset,
        limit: args.limit,
        total_hits,
    })
}

#[tauri::command]
fn get_curseforge_project_detail(
    args: GetCurseforgeProjectArgs,
) -> Result<CurseforgeProjectDetail, String> {
    let api_key = curseforge_api_key()
        .ok_or_else(|| "CurseForge API key missing. Set MPM_CURSEFORGE_API_KEY.".to_string())?;
    let project_id = parse_curseforge_project_id(&args.project_id)?;
    let client = build_http_client()?;

    let mod_resp = client
        .get(format!("{}/mods/{}", CURSEFORGE_API_BASE, project_id))
        .header("Accept", "application/json")
        .header("x-api-key", api_key.clone())
        .send()
        .map_err(|e| format!("CurseForge project lookup failed: {e}"))?;
    if !mod_resp.status().is_success() {
        return Err(format!(
            "CurseForge project lookup failed with status {}",
            mod_resp.status()
        ));
    }
    let project = mod_resp
        .json::<CurseforgeModResponse>()
        .map_err(|e| format!("parse CurseForge project failed: {e}"))?
        .data;

    let desc_url = format!("{}/mods/{}/description", CURSEFORGE_API_BASE, project_id);
    let description = match client
        .get(&desc_url)
        .header("Accept", "application/json")
        .header("x-api-key", api_key.clone())
        .send()
    {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>() {
            Ok(v) => v
                .get("data")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| project.summary.clone()),
            Err(_) => project.summary.clone(),
        },
        _ => project.summary.clone(),
    };

    let files_resp = client
        .get(format!(
            "{}/mods/{}/files?pageSize=60&index=0",
            CURSEFORGE_API_BASE, project_id
        ))
        .header("Accept", "application/json")
        .header("x-api-key", api_key)
        .send()
        .map_err(|e| format!("CurseForge files lookup failed: {e}"))?;
    if !files_resp.status().is_success() {
        return Err(format!(
            "CurseForge files lookup failed with status {}",
            files_resp.status()
        ));
    }
    let mut files = files_resp
        .json::<CurseforgeFilesResponse>()
        .map_err(|e| format!("parse CurseForge files failed: {e}"))?
        .data;
    files.sort_by(|a, b| b.file_date.cmp(&a.file_date));
    let detail_files = files
        .into_iter()
        .take(40)
        .map(|f| CurseforgeProjectFileDetail {
            file_id: f.id.to_string(),
            display_name: f.display_name,
            file_name: f.file_name,
            file_date: f.file_date,
            game_versions: f.game_versions,
            download_url: f.download_url,
        })
        .collect::<Vec<_>>();

    let project_id_text = project.id.to_string();
    let external_url = Some(format!(
        "https://www.curseforge.com/minecraft/mc-mods/{}",
        project.slug.clone().unwrap_or_else(|| project_id_text.clone())
    ));
    let author_names = project.authors.into_iter().map(|a| a.name).collect::<Vec<_>>();
    let categories = project
        .categories
        .into_iter()
        .map(|c| c.name)
        .filter(|c| !c.trim().is_empty())
        .collect::<Vec<_>>();

    Ok(CurseforgeProjectDetail {
        source: "curseforge".to_string(),
        project_id: format!("cf:{}", project_id_text),
        title: project.name,
        slug: project.slug,
        summary: project.summary,
        description,
        author_names,
        downloads: project.download_count.max(0.0) as u64,
        categories,
        icon_url: project.logo.map(|l| l.url),
        date_modified: project.date_modified,
        external_url,
        files: detail_files,
    })
}

#[tauri::command]
fn import_provider_modpack_template(
    args: ImportProviderModpackArgs,
) -> Result<CreatorPreset, String> {
    let source = args.source.trim().to_lowercase();
    let client = build_http_client()?;
    if source == "curseforge" {
        let api_key = curseforge_api_key()
            .ok_or_else(|| "CurseForge API key missing. Set MPM_CURSEFORGE_API_KEY.".to_string())?;
        return import_curseforge_modpack_template_inner(
            &client,
            &api_key,
            &args.project_id,
            args.project_title.as_deref(),
        );
    }
    import_modrinth_modpack_template_inner(&client, &args.project_id, args.project_title.as_deref())
}

#[tauri::command]
fn export_presets_json(args: ExportPresetsJsonArgs) -> Result<PresetsJsonIoResult, String> {
    let path_text = args.output_path.trim();
    if path_text.is_empty() {
        return Err("outputPath is required".to_string());
    }

    let items = if let Some(arr) = args.payload.as_array() {
        arr.len()
    } else if let Some(arr) = args
        .payload
        .get("presets")
        .and_then(|v| v.as_array())
    {
        arr.len()
    } else {
        return Err("Preset payload must be an array or { presets: [] }".to_string());
    };

    let path = PathBuf::from(path_text);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir export directory failed: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(&args.payload)
        .map_err(|e| format!("serialize presets failed: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write presets file failed: {e}"))?;

    Ok(PresetsJsonIoResult {
        path: path.display().to_string(),
        items,
    })
}

#[tauri::command]
fn import_presets_json(args: ImportPresetsJsonArgs) -> Result<serde_json::Value, String> {
    let path_text = args.input_path.trim();
    if path_text.is_empty() {
        return Err("inputPath is required".to_string());
    }
    let path = PathBuf::from(path_text);
    if !path.exists() || !path.is_file() {
        return Err("Preset file does not exist".to_string());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read presets file failed: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse presets file failed: {e}"))?;

    if parsed.is_array()
        || parsed
            .get("presets")
            .and_then(|v| v.as_array())
            .is_some()
    {
        Ok(parsed)
    } else {
        Err("Preset file must contain an array or { presets: [] }".to_string())
    }
}

#[tauri::command]
fn get_selected_account_diagnostics(app: tauri::AppHandle) -> Result<AccountDiagnostics, String> {
    let total_started = Instant::now();
    let settings = read_launcher_settings(&app)?;
    let mut diag = make_account_diagnostics_base(&settings);
    let Some(selected_id) = settings.selected_account_id.clone() else {
        return Ok(diag);
    };

    let accounts = read_launcher_accounts(&app)?;
    let Some(account) = accounts.iter().find(|a| a.id == selected_id).cloned() else {
        return Ok(fail_account_diag(
            diag,
            "account-not-found",
            "Selected account is missing. Reconnect Microsoft account.".to_string(),
        ));
    };
    diag.account = Some(account.clone());

    let (client_id, source) = match resolve_oauth_client_id_with_source(&app) {
        Ok(v) => v,
        Err(e) => return Ok(fail_account_diag(diag, "oauth-client-id-missing", e)),
    };
    diag.client_id_source = source;

    let refresh = match keyring_get_refresh_token_for_account(&app, &account, &accounts) {
        Ok(v) => v,
        Err(e) => return Ok(fail_account_diag(diag, "refresh-token-read-failed", e)),
    };

    let client = match build_http_client() {
        Ok(c) => c,
        Err(e) => {
            return Ok(fail_account_diag(
                diag,
                "http-client-build-failed",
                format!("build http client failed: {e}"),
            ))
        }
    };

    let refresh_started = Instant::now();
    let refreshed = match microsoft_refresh_access_token(&client, &client_id, &refresh) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[account_diag] microsoft-refresh-failed after {}ms",
                refresh_started.elapsed().as_millis()
            );
            return Ok(fail_account_diag(diag, "microsoft-refresh-failed", e));
        }
    };
    let refresh_ms = refresh_started.elapsed().as_millis();
    if refresh_ms > 350 {
        eprintln!("[account_diag] microsoft_refresh_access_token: {refresh_ms}ms");
    }
    if let Some(new_refresh) = refreshed.refresh_token.as_ref() {
        if let Err(e) = persist_refresh_token(&app, &account.id, new_refresh) {
            return Ok(fail_account_diag(diag, "refresh-token-write-failed", e));
        }
    }

    let token_exchange_started = Instant::now();
    let mc_access = match microsoft_access_to_mc_token(&client, &refreshed.access_token) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[account_diag] token-exchange-failed after {}ms",
                token_exchange_started.elapsed().as_millis()
            );
            return Ok(fail_account_diag(diag, "token-exchange-failed", e));
        }
    };
    let token_exchange_ms = token_exchange_started.elapsed().as_millis();
    if token_exchange_ms > 350 {
        eprintln!("[account_diag] microsoft_access_to_mc_token: {token_exchange_ms}ms");
    }
    diag.token_exchange_status = "minecraft-token-ok".to_string();

    let entitlements_started = Instant::now();
    if let Err(e) = ensure_minecraft_entitlement(&client, &mc_access) {
        eprintln!(
            "[account_diag] entitlements-check-failed after {}ms",
            entitlements_started.elapsed().as_millis()
        );
        return Ok(fail_account_diag(diag, "entitlements-check-failed", e));
    }
    let entitlements_ms = entitlements_started.elapsed().as_millis();
    if entitlements_ms > 350 {
        eprintln!("[account_diag] ensure_minecraft_entitlement: {entitlements_ms}ms");
    }
    diag.entitlements_ok = true;

    let profile_started = Instant::now();
    let profile = match fetch_minecraft_profile(&client, &mc_access) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[account_diag] profile-fetch-failed after {}ms",
                profile_started.elapsed().as_millis()
            );
            return Ok(fail_account_diag(diag, "profile-fetch-failed", e));
        }
    };
    let profile_ms = profile_started.elapsed().as_millis();
    if profile_ms > 350 {
        eprintln!("[account_diag] fetch_minecraft_profile: {profile_ms}ms");
    }

    diag.minecraft_uuid = Some(profile.id.clone());
    diag.minecraft_username = Some(profile.name.clone());
    diag.skins = summarize_cosmetics(&profile.skins);
    diag.capes = summarize_cosmetics(&profile.capes);
    diag.cape_count = diag.capes.len();
    diag.skin_url = diag
        .skins
        .iter()
        .find(|s| s.state.eq_ignore_ascii_case("active"))
        .map(|s| s.url.clone())
        .or_else(|| diag.skins.first().map(|s| s.url.clone()));

    if account.username != profile.name {
        let mut updated = account.clone();
        updated.username = profile.name.clone();
        if let Err(e) = upsert_launcher_account(&app, &updated) {
            return Ok(fail_account_diag(diag, "account-sync-failed", e));
        }
        diag.account = Some(updated);
    }

    diag.status = "connected".to_string();
    diag.token_exchange_status = "ok".to_string();
    diag.last_error = None;
    let total_ms = total_started.elapsed().as_millis();
    if total_ms > 600 {
        eprintln!("[account_diag] get_selected_account_diagnostics total: {total_ms}ms");
    }
    Ok(diag)
}

#[tauri::command]
fn export_instance_mods_zip(
    app: tauri::AppHandle,
    args: ExportInstanceModsZipArgs,
) -> Result<ExportModsResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let instance = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    let mods_dir = instance_dir.join("mods");
    if !mods_dir.exists() {
        return Err("Instance mods folder does not exist".to_string());
    }

    let output = if let Some(custom) = args.output_path.as_ref() {
        PathBuf::from(custom)
    } else {
        let base = home_dir()
            .map(|h| h.join("Downloads"))
            .filter(|p| p.exists())
            .unwrap_or_else(|| instance_dir.clone());
        base.join(default_export_filename(&instance.name))
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir export directory failed: {e}"))?;
    }

    let file = File::create(&output).map_err(|e| format!("create zip failed: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut files_count = 0usize;

    let read = fs::read_dir(&mods_dir).map_err(|e| format!("read mods directory failed: {e}"))?;
    for ent in read {
        let ent = ent.map_err(|e| format!("read mods entry failed: {e}"))?;
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "invalid file name in mods directory".to_string())?;
        let lower = name.to_lowercase();
        if !(lower.ends_with(".jar") || lower.ends_with(".disabled")) {
            continue;
        }
        let mut src = File::open(&path).map_err(|e| format!("open '{}' failed: {e}", name))?;
        zip.start_file(name, options)
            .map_err(|e| format!("zip write header failed: {e}"))?;
        std::io::copy(&mut src, &mut zip).map_err(|e| format!("zip write '{}' failed: {e}", name))?;
        files_count += 1;
    }

    zip.finish().map_err(|e| format!("finalize zip failed: {e}"))?;

    Ok(ExportModsResult {
        output_path: output.display().to_string(),
        files_count,
    })
}

#[tauri::command]
fn list_instances(app: tauri::AppHandle) -> Result<Vec<Instance>, String> {
    let dir = app_instances_dir(&app)?;
    let idx = read_index(&dir)?;
    Ok(idx.instances)
}

fn create_instance_internal(
    app: &tauri::AppHandle,
    clean_name: String,
    clean_mc: String,
    loader_lc: String,
    icon_path: Option<String>,
) -> Result<Instance, String> {
    if clean_name.trim().is_empty() {
        return Err("name is required".to_string());
    }
    if clean_mc.trim().is_empty() {
        return Err("mc_version is required".to_string());
    }
    if parse_loader_for_instance(&loader_lc).is_none() {
        return Err("loader must be one of vanilla/fabric/forge/neoforge/quilt".to_string());
    }

    let dir = app_instances_dir(app)?;
    let mut idx = read_index(&dir)?;

    let mut inst = Instance {
        id: gen_id(),
        name: clean_name,
        mc_version: clean_mc,
        loader: loader_lc,
        created_at: now_iso(),
        icon_path: None,
        settings: InstanceSettings::default(),
    };

    let inst_dir = dir.join(&inst.id);
    fs::create_dir_all(inst_dir.join("mods")).map_err(|e| format!("mkdir mods failed: {e}"))?;
    fs::create_dir_all(inst_dir.join("config")).map_err(|e| format!("mkdir config failed: {e}"))?;
    fs::create_dir_all(inst_dir.join("resourcepacks"))
        .map_err(|e| format!("mkdir resourcepacks failed: {e}"))?;
    fs::create_dir_all(inst_dir.join("shaderpacks"))
        .map_err(|e| format!("mkdir shaderpacks failed: {e}"))?;
    fs::create_dir_all(inst_dir.join("saves"))
        .map_err(|e| format!("mkdir saves failed: {e}"))?;

    let picked_icon_path = icon_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    if let Some(icon_source) = picked_icon_path {
        inst.icon_path = Some(copy_instance_icon_to_dir(&icon_source, &inst_dir)?);
    }

    write_instance_meta(&inst_dir, &inst)?;
    write_lockfile(&dir, &inst.id, &Lockfile::default())?;

    idx.instances.insert(0, inst.clone());
    write_index(&dir, &idx)?;

    Ok(inst)
}

#[tauri::command]
fn create_instance(app: tauri::AppHandle, args: CreateInstanceArgs) -> Result<Instance, String> {
    let loader_lc = parse_loader_for_instance(&args.loader)
        .ok_or_else(|| "loader must be one of vanilla/fabric/forge/neoforge/quilt".to_string())?;

    let clean_name = sanitize_name(&args.name);
    if clean_name.is_empty() {
        return Err("name is required".into());
    }
    let clean_mc = args.mc_version.trim().to_string();
    if clean_mc.is_empty() {
        return Err("mc_version is required".into());
    }
    create_instance_internal(&app, clean_name, clean_mc, loader_lc, args.icon_path)
}

#[tauri::command]
fn create_instance_from_modpack_file(
    app: tauri::AppHandle,
    args: CreateInstanceFromModpackFileArgs,
) -> Result<CreateInstanceFromModpackFileResult, String> {
    let file_path = PathBuf::from(args.file_path.trim());
    if !file_path.exists() || !file_path.is_file() {
        return Err("Selected modpack archive was not found.".to_string());
    }
    let (default_name, mc_version, loader, override_roots, mut warnings) =
        parse_modpack_file_info(&file_path)?;
    let final_name = sanitize_name(args.name.as_deref().unwrap_or(&default_name));
    if final_name.trim().is_empty() {
        return Err("Imported modpack name is empty.".to_string());
    }
    let instance = create_instance_internal(
        &app,
        final_name,
        mc_version,
        loader,
        args.icon_path.clone(),
    )?;
    let instances_dir = app_instances_dir(&app)?;
    let instance_dir = instances_dir.join(&instance.id);
    let imported_files = extract_overrides_from_modpack(&file_path, &instance_dir, &override_roots)?;
    if imported_files == 0 {
        warnings.push("No override files were found in the archive.".to_string());
    }
    Ok(CreateInstanceFromModpackFileResult {
        instance,
        imported_files,
        warnings,
    })
}

#[tauri::command]
fn list_launcher_import_sources() -> Result<Vec<LauncherImportSource>, String> {
    Ok(list_launcher_import_sources_inner())
}

#[tauri::command]
fn import_instance_from_launcher(
    app: tauri::AppHandle,
    args: ImportInstanceFromLauncherArgs,
) -> Result<ImportInstanceFromLauncherResult, String> {
    let source = list_launcher_import_sources_inner()
        .into_iter()
        .find(|s| s.id == args.source_id)
        .ok_or_else(|| "Selected launcher source was not found.".to_string())?;
    let source_path = PathBuf::from(source.source_path.trim());
    if !source_path.exists() || !source_path.is_dir() {
        return Err("Source launcher directory is unavailable.".to_string());
    }
    let fallback_name = format!("{} import", source.label);
    let final_name = sanitize_name(args.name.as_deref().unwrap_or(&fallback_name));
    if final_name.trim().is_empty() {
        return Err("Imported instance name is required.".to_string());
    }
    let loader = parse_loader_for_instance(&source.loader).unwrap_or_else(|| "vanilla".to_string());
    let instance = create_instance_internal(
        &app,
        final_name,
        source.mc_version.clone(),
        loader,
        args.icon_path.clone(),
    )?;
    let instances_dir = app_instances_dir(&app)?;
    let instance_dir = instances_dir.join(&instance.id);
    let imported_files = copy_launcher_source_into_instance(&source_path, &instance_dir)?;
    Ok(ImportInstanceFromLauncherResult {
        instance,
        imported_files,
    })
}

#[tauri::command]
fn update_instance(app: tauri::AppHandle, args: UpdateInstanceArgs) -> Result<Instance, String> {
    let dir = app_instances_dir(&app)?;
    let mut idx = read_index(&dir)?;
    let pos = idx
        .instances
        .iter()
        .position(|x| x.id == args.instance_id)
        .ok_or_else(|| "instance not found".to_string())?;
    let mut inst = idx.instances[pos].clone();

    if let Some(name) = args.name.as_ref() {
        let clean_name = sanitize_name(name);
        if clean_name.is_empty() {
            return Err("name is required".to_string());
        }
        inst.name = clean_name;
    }
    if let Some(mc_version) = args.mc_version.as_ref() {
        let clean_mc = mc_version.trim().to_string();
        if clean_mc.is_empty() {
            return Err("mc_version is required".to_string());
        }
        inst.mc_version = clean_mc;
    }
    if let Some(loader) = args.loader.as_ref() {
        let parsed = parse_loader_for_instance(loader)
            .ok_or_else(|| "loader must be one of vanilla/fabric/forge/neoforge/quilt".to_string())?;
        inst.loader = parsed;
    }
    if let Some(settings) = args.settings {
        inst.settings = normalize_instance_settings(settings);
    } else {
        inst.settings = normalize_instance_settings(inst.settings);
    }

    let inst_dir = dir.join(&inst.id);
    fs::create_dir_all(&inst_dir).map_err(|e| format!("mkdir instance dir failed: {e}"))?;
    write_instance_meta(&inst_dir, &inst)?;
    idx.instances[pos] = inst.clone();
    write_index(&dir, &idx)?;
    Ok(inst)
}

#[tauri::command]
fn detect_java_runtimes() -> Result<Vec<JavaRuntimeCandidate>, String> {
    Ok(detect_java_runtimes_inner())
}

#[tauri::command]
fn set_instance_icon(app: tauri::AppHandle, args: SetInstanceIconArgs) -> Result<Instance, String> {
    let dir = app_instances_dir(&app)?;
    let mut idx = read_index(&dir)?;
    let pos = idx
        .instances
        .iter()
        .position(|x| x.id == args.instance_id)
        .ok_or_else(|| "instance not found".to_string())?;

    let mut inst = idx.instances[pos].clone();
    let inst_dir = dir.join(&inst.id);
    fs::create_dir_all(&inst_dir).map_err(|e| format!("mkdir instance dir failed: {e}"))?;

    let next_icon_path = args
        .icon_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    inst.icon_path = if let Some(path) = next_icon_path {
        Some(copy_instance_icon_to_dir(&path, &inst_dir)?)
    } else {
        clear_instance_icon_files(&inst_dir)?;
        None
    };

    write_instance_meta(&inst_dir, &inst)?;
    idx.instances[pos] = inst.clone();
    write_index(&dir, &idx)?;
    Ok(inst)
}

#[tauri::command]
fn read_local_image_data_url(args: ReadLocalImageDataUrlArgs) -> Result<String, String> {
    let trimmed = args.path.trim();
    if trimmed.is_empty() {
        return Err("path is required".to_string());
    }
    let path = Path::new(trimmed);
    if !path.exists() || !path.is_file() {
        return Err("image file not found".to_string());
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.trim().to_ascii_lowercase())
        .ok_or_else(|| "image file must have an extension".to_string())?;
    if !allowed_icon_extension(&ext) {
        return Err("image must be png/jpg/jpeg/webp/bmp/gif".to_string());
    }

    let bytes = fs::read(path).map_err(|e| format!("read image failed: {e}"))?;
    if bytes.len() > MAX_LOCAL_IMAGE_BYTES {
        return Err("image file is too large (max 8MB)".to_string());
    }

    let mime = image_mime_for_extension(&ext).ok_or_else(|| "unsupported image type".to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[tauri::command]
fn delete_instance(app: tauri::AppHandle, args: DeleteInstanceArgs) -> Result<(), String> {
    let dir = app_instances_dir(&app)?;
    let mut idx = read_index(&dir)?;

    let before = idx.instances.len();
    idx.instances.retain(|x| x.id != args.id);
    if idx.instances.len() == before {
        return Err("instance not found".into());
    }

    let inst_dir = dir.join(&args.id);
    if inst_dir.exists() {
        fs::remove_dir_all(inst_dir).map_err(|e| format!("remove dir failed: {e}"))?;
    }

    write_index(&dir, &idx)?;
    Ok(())
}

fn install_modrinth_mod_inner(
    app: tauri::AppHandle,
    args: InstallModrinthModArgs,
    snapshot_reason: Option<&str>,
) -> Result<InstalledMod, String> {
    let instances_dir = app_instances_dir(&app)?;
    let instance = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&instance.id);
    let mods_dir = instance_dir.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| format!("mkdir mods failed: {e}"))?;

    let mut lock = read_lockfile(&instances_dir, &args.instance_id)?;

    emit_install_progress(
        &app,
        InstallProgressEvent {
            instance_id: args.instance_id.clone(),
            project_id: args.project_id.clone(),
            stage: "resolving".into(),
            downloaded: 0,
            total: None,
            percent: None,
            message: Some("Resolving compatible versions and required dependencies…".into()),
        },
    );

    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("build http client failed: {e}"))?;

    let plan = resolve_modrinth_install_plan(&client, &instance, &args.project_id)?;
    let total_mods = plan.len();
    let dependency_mods = total_mods.saturating_sub(1);
    let total_actions = count_plan_install_actions(&instance_dir, &lock, &plan);

    if total_actions > 0 {
        if let Some(reason) = snapshot_reason {
            let _ = create_instance_snapshot(&instances_dir, &args.instance_id, reason);
        }
    }

    emit_install_progress(
        &app,
        InstallProgressEvent {
            instance_id: args.instance_id.clone(),
            project_id: args.project_id.clone(),
            stage: "resolving".into(),
            downloaded: 0,
            total: Some(total_actions as u64),
            percent: Some(if total_actions == 0 { 100.0 } else { 0.0 }),
            message: Some(format!(
                "Install plan ready: {} mod(s) total ({} required dependencies)",
                total_mods, dependency_mods
            )),
        },
    );

    let mut title_cache: HashMap<String, String> = HashMap::new();
    let mut root_installed: Option<InstalledMod> = None;
    let mut completed_actions: usize = 0;

    for item in plan {
        let safe_filename =
            safe_mod_filename(&item.project_id, &item.version.id, &item.file.filename);

        if is_plan_entry_up_to_date(&instance_dir, &lock, &item) {
            if item.project_id == args.project_id {
                if let Some(existing) = lock.entries.iter().find(|e| e.project_id == args.project_id) {
                    root_installed = Some(lock_entry_to_installed(&instance_dir, existing));
                }
            }
            continue;
        }

        let final_path = mods_dir.join(&safe_filename);
        let tmp_path = mods_dir.join(format!("{safe_filename}.part"));
        if tmp_path.exists() {
            fs::remove_file(&tmp_path).map_err(|e| format!("remove old temp file failed: {e}"))?;
        }

        let mut download_resp = client
            .get(&item.file.url)
            .send()
            .map_err(|e| format!("download failed for {}: {e}", item.project_id))?;
        if !download_resp.status().is_success() {
            return Err(format!(
                "download failed for {} with status {}",
                item.project_id,
                download_resp.status()
            ));
        }

        let file_total = download_resp.content_length();
        emit_install_progress(
            &app,
            InstallProgressEvent {
                instance_id: args.instance_id.clone(),
                project_id: args.project_id.clone(),
                stage: "downloading".into(),
                downloaded: completed_actions as u64,
                total: Some(total_actions as u64),
                percent: Some(if total_actions == 0 {
                    100.0
                } else {
                    (completed_actions as f64 / total_actions as f64) * 100.0
                }),
                message: Some(format!("Installing {} ({safe_filename})", item.project_id)),
            },
        );

        let mut out =
            File::create(&tmp_path).map_err(|e| format!("create temp file failed: {e}"))?;
        let mut downloaded_bytes: u64 = 0;
        let mut buf = vec![0_u8; 64 * 1024];
        let mut last_emit = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);

        loop {
            let n = download_resp
                .read(&mut buf)
                .map_err(|e| format!("read download stream failed: {e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])
                .map_err(|e| format!("write mod file failed: {e}"))?;
            downloaded_bytes += n as u64;

            if last_emit.elapsed() >= Duration::from_millis(90) {
                let ratio = file_total
                    .map(|t| {
                        if t == 0 {
                            0.0
                        } else {
                            downloaded_bytes as f64 / t as f64
                        }
                    })
                    .unwrap_or(0.0);
                let overall = if total_actions == 0 {
                    100.0
                } else {
                    ((completed_actions as f64 + ratio) / total_actions as f64) * 100.0
                };
                emit_install_progress(
                    &app,
                    InstallProgressEvent {
                        instance_id: args.instance_id.clone(),
                        project_id: args.project_id.clone(),
                        stage: "downloading".into(),
                        downloaded: completed_actions as u64,
                        total: Some(total_actions as u64),
                        percent: Some(overall),
                        message: Some(format!("Installing {} ({safe_filename})", item.project_id)),
                    },
                );
                last_emit = Instant::now();
            }
        }

        out.flush()
            .map_err(|e| format!("flush mod file failed: {e}"))?;

        if final_path.exists() {
            fs::remove_file(&final_path)
                .map_err(|e| format!("remove old mod file failed: {e}"))?;
        }
        fs::rename(&tmp_path, &final_path).map_err(|e| format!("move mod file failed: {e}"))?;

        remove_replaced_entries_for_project(
            &mut lock,
            &instance_dir,
            &item.project_id,
            Some(&safe_filename),
        )?;

        let fallback_name = item
            .version
            .name
            .clone()
            .unwrap_or_else(|| item.project_id.clone());
        let resolved_name = if item.project_id == args.project_id {
            if let Some(title) = args.project_title.as_ref() {
                let clean = title.trim();
                if clean.is_empty() {
                    fetch_project_title(&client, &item.project_id).unwrap_or(fallback_name)
                } else {
                    clean.to_string()
                }
            } else {
                fetch_project_title(&client, &item.project_id).unwrap_or(fallback_name)
            }
        } else if let Some(cached) = title_cache.get(&item.project_id) {
            cached.clone()
        } else {
            let fetched = fetch_project_title(&client, &item.project_id).unwrap_or(fallback_name);
            title_cache.insert(item.project_id.clone(), fetched.clone());
            fetched
        };

        let new_entry = LockEntry {
            source: "modrinth".into(),
            project_id: item.project_id.clone(),
            version_id: item.version.id.clone(),
            name: resolved_name,
            version_number: item.version.version_number.clone(),
            filename: safe_filename,
            content_type: "mods".to_string(),
            target_scope: "instance".to_string(),
            target_worlds: vec![],
            pinned_version: None,
            enabled: true,
            hashes: item.file.hashes.clone(),
        };

        lock.entries.push(new_entry.clone());
        lock.entries
            .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        write_lockfile(&instances_dir, &args.instance_id, &lock)?;

        if item.project_id == args.project_id {
            root_installed = Some(lock_entry_to_installed(&instance_dir, &new_entry));
        }

        completed_actions += 1;
    }

    if root_installed.is_none() {
        if let Some(root_entry) = lock.entries.iter().find(|e| e.project_id == args.project_id) {
            root_installed = Some(lock_entry_to_installed(&instance_dir, root_entry));
        }
    }

    let root_installed =
        root_installed.ok_or_else(|| "Root mod was not installed in lockfile".to_string())?;

    emit_install_progress(
        &app,
        InstallProgressEvent {
            instance_id: args.instance_id.clone(),
            project_id: args.project_id.clone(),
            stage: "completed".into(),
            downloaded: completed_actions as u64,
            total: Some(total_actions as u64),
            percent: Some(100.0),
            message: Some(format!(
                "Installed {} mod(s) ({} dependency mods)",
                total_mods, dependency_mods
            )),
        },
    );

    Ok(root_installed)
}

#[tauri::command]
fn install_modrinth_mod(
    app: tauri::AppHandle,
    args: InstallModrinthModArgs,
) -> Result<InstalledMod, String> {
    let reason = format!("before-install-modrinth:{}", args.project_id);
    install_modrinth_mod_inner(app, args, Some(reason.as_str()))
}

#[tauri::command]
fn install_curseforge_mod(
    app: tauri::AppHandle,
    args: InstallCurseforgeModArgs,
) -> Result<InstalledMod, String> {
    let reason = format!("before-install-curseforge:{}", args.project_id);
    install_curseforge_mod_inner(app, args, Some(reason.as_str()))
}

fn install_curseforge_mod_inner(
    app: tauri::AppHandle,
    args: InstallCurseforgeModArgs,
    snapshot_reason: Option<&str>,
) -> Result<InstalledMod, String> {
    let instances_dir = app_instances_dir(&app)?;
    let instance = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&instance.id);
    let api_key = curseforge_api_key()
        .ok_or_else(|| "CurseForge API key missing. Set MPM_CURSEFORGE_API_KEY.".to_string())?;
    let client = build_http_client()?;

    emit_install_progress(
        &app,
        InstallProgressEvent {
            instance_id: args.instance_id.clone(),
            project_id: args.project_id.clone(),
            stage: "resolving".to_string(),
            downloaded: 0,
            total: Some(1),
            percent: Some(0.0),
            message: Some("Resolving CurseForge file…".to_string()),
        },
    );

    if let Some(reason) = snapshot_reason {
        let _ = create_instance_snapshot(&instances_dir, &args.instance_id, reason);
    }
    let mut lock = read_lockfile(&instances_dir, &args.instance_id)?;

    emit_install_progress(
        &app,
        InstallProgressEvent {
            instance_id: args.instance_id.clone(),
            project_id: args.project_id.clone(),
            stage: "downloading".to_string(),
            downloaded: 0,
            total: Some(1),
            percent: Some(10.0),
            message: Some("Downloading file…".to_string()),
        },
    );
    let entry = install_curseforge_content_inner(
        &instance,
        &instance_dir,
        &mut lock,
        &client,
        &api_key,
        &args.project_id,
        args.project_title.as_deref(),
        "mods",
        &[],
    )?;

    lock.entries.push(entry.clone());
    lock.entries
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    write_lockfile(&instances_dir, &args.instance_id, &lock)?;

    emit_install_progress(
        &app,
        InstallProgressEvent {
            instance_id: args.instance_id.clone(),
            project_id: args.project_id,
            stage: "completed".to_string(),
            downloaded: 1,
            total: Some(1),
            percent: Some(100.0),
            message: Some("CurseForge install complete".to_string()),
        },
    );

    Ok(lock_entry_to_installed(&instance_dir, &entry))
}

#[tauri::command]
fn preview_modrinth_install(
    app: tauri::AppHandle,
    args: InstallModrinthModArgs,
) -> Result<InstallPlanPreview, String> {
    let instances_dir = app_instances_dir(&app)?;
    let instance = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&instance.id);
    let lock = read_lockfile(&instances_dir, &args.instance_id)?;

    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("build http client failed: {e}"))?;

    let plan = resolve_modrinth_install_plan(&client, &instance, &args.project_id)?;
    let total_mods = plan.len();
    let dependency_mods = total_mods.saturating_sub(1);
    let will_install_mods = count_plan_install_actions(&instance_dir, &lock, &plan);

    Ok(InstallPlanPreview {
        total_mods,
        dependency_mods,
        will_install_mods,
    })
}

#[tauri::command]
fn import_local_mod_file(
    app: tauri::AppHandle,
    args: ImportLocalModFileArgs,
) -> Result<InstalledMod, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    let mods_dir = instance_dir.join("mods");
    fs::create_dir_all(&mods_dir).map_err(|e| format!("mkdir mods failed: {e}"))?;

    let source_path = PathBuf::from(&args.file_path);
    if !source_path.exists() || !source_path.is_file() {
        return Err("Selected file does not exist".into());
    }
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "jar" {
        return Err("Only .jar files are supported".into());
    }

    let source_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid file name")?;
    let safe_filename = sanitize_filename(source_name);
    if safe_filename.is_empty() {
        return Err("Invalid file name".into());
    }

    let dest_path = mods_dir.join(&safe_filename);
    let disabled_path = mods_dir.join(format!("{safe_filename}.disabled"));
    if dest_path.exists() {
        fs::remove_file(&dest_path).map_err(|e| format!("replace existing mod failed: {e}"))?;
    }
    if disabled_path.exists() {
        fs::remove_file(&disabled_path).map_err(|e| format!("cleanup disabled mod failed: {e}"))?;
    }
    fs::copy(&source_path, &dest_path).map_err(|e| format!("copy mod file failed: {e}"))?;

    let mut lock = read_lockfile(&instances_dir, &args.instance_id)?;
    lock.entries.retain(|e| e.filename != safe_filename);

    let project_id = format!("local:{}", safe_filename.to_lowercase());
    let new_entry = LockEntry {
        source: "local".into(),
        project_id,
        version_id: format!("local_{}", now_millis()),
        name: infer_local_name(&safe_filename),
        version_number: "local-file".into(),
        filename: safe_filename.clone(),
        content_type: "mods".to_string(),
        target_scope: "instance".to_string(),
        target_worlds: vec![],
        pinned_version: None,
        enabled: true,
        hashes: HashMap::new(),
    };

    lock.entries.push(new_entry.clone());
    lock.entries
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    write_lockfile(&instances_dir, &args.instance_id, &lock)?;

    Ok(lock_entry_to_installed(&instance_dir, &new_entry))
}

#[tauri::command]
fn check_modrinth_updates(
    app: tauri::AppHandle,
    args: CheckUpdatesArgs,
) -> Result<ModUpdateCheckResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let instance = find_instance(&instances_dir, &args.instance_id)?;
    let lock = read_lockfile(&instances_dir, &args.instance_id)?;

    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("build http client failed: {e}"))?;

    check_modrinth_updates_inner(&client, &instance, &lock)
}

#[tauri::command]
fn update_all_modrinth_mods(
    app: tauri::AppHandle,
    args: CheckUpdatesArgs,
) -> Result<UpdateAllResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let instance = find_instance(&instances_dir, &args.instance_id)?;
    let lock = read_lockfile(&instances_dir, &args.instance_id)?;

    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("build http client failed: {e}"))?;

    let check = check_modrinth_updates_inner(&client, &instance, &lock)?;
    if !check.updates.is_empty() {
        let _ = create_instance_snapshot(&instances_dir, &args.instance_id, "before-update-all");
    }
    let mut updated_mods = 0usize;
    for update in &check.updates {
        install_modrinth_mod_inner(
            app.clone(),
            InstallModrinthModArgs {
                instance_id: args.instance_id.clone(),
                project_id: update.project_id.clone(),
                project_title: Some(update.name.clone()),
            },
            None,
        )?;
        updated_mods += 1;
    }

    Ok(UpdateAllResult {
        checked_mods: check.checked_mods,
        updated_mods,
    })
}

#[tauri::command]
async fn launch_instance(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    args: LaunchInstanceArgs,
) -> Result<LaunchResult, String> {
    let instances_dir = app_instances_dir(&app)?;
    let instance = find_instance(&instances_dir, &args.instance_id)?;
    let instance_settings = normalize_instance_settings(instance.settings.clone());
    let app_instance_dir = instances_dir.join(&args.instance_id);
    let settings = read_launcher_settings(&app)?;
    let method = if let Some(input) = args.method.as_ref() {
        LaunchMethod::parse(input).ok_or_else(|| "method must be prism or native".to_string())?
    } else {
        settings.default_launch_method.clone()
    };
    clear_launch_cancel_request(&state, &instance.id)?;

    match method {
        LaunchMethod::Prism => {
            if is_launch_cancel_requested(&state, &instance.id)? {
                emit_launch_state(
                    &app,
                    &instance.id,
                    None,
                    LaunchMethod::Prism.as_str(),
                    "stopped",
                    "Launch cancelled by user.",
                );
                clear_launch_cancel_request(&state, &instance.id)?;
                return Err("Launch cancelled by user.".to_string());
            }
            let prism_root = prism_root_dir()?;
            let prism_instance_id = find_prism_instance_id(&prism_root, &instance)?;
            let prism_mc_dir = prism_root
                .join("instances")
                .join(&prism_instance_id)
                .join("minecraft");

            emit_launch_state(
                &app,
                &instance.id,
                None,
                LaunchMethod::Prism.as_str(),
                "starting",
                "Preparing Prism sync…",
            );
            sync_prism_instance_content(&app_instance_dir, &prism_mc_dir)?;
            if is_launch_cancel_requested(&state, &instance.id)? {
                emit_launch_state(
                    &app,
                    &instance.id,
                    None,
                    LaunchMethod::Prism.as_str(),
                    "stopped",
                    "Launch cancelled by user.",
                );
                clear_launch_cancel_request(&state, &instance.id)?;
                return Err("Launch cancelled by user.".to_string());
            }
            launch_prism_instance(&prism_root, &prism_instance_id)?;
            clear_launch_cancel_request(&state, &instance.id)?;

            Ok(LaunchResult {
                method: "prism".to_string(),
                launch_id: None,
                pid: None,
                prism_instance_id: Some(prism_instance_id),
                prism_root: Some(prism_root.display().to_string()),
                message: "Synced mods/config to Prism instance and launched it.".into(),
            })
        }
        LaunchMethod::Native => {
            let mut existing_native_runs_for_instance = 0usize;
            {
                let mut guard = state
                    .running
                    .lock()
                    .map_err(|_| "lock running instances failed".to_string())?;
                let mut finished: Vec<String> = Vec::new();
                for (id, proc_entry) in guard.iter_mut() {
                    if proc_entry.meta.instance_id != instance.id
                        || !proc_entry.meta.method.eq_ignore_ascii_case("native")
                    {
                        continue;
                    }
                    if let Ok(mut child) = proc_entry.child.lock() {
                        if let Ok(Some(_)) = child.try_wait() {
                            finished.push(id.clone());
                        } else {
                            existing_native_runs_for_instance += 1;
                        }
                    }
                }
                for id in finished {
                    guard.remove(&id);
                }
            }
            if is_launch_cancel_requested(&state, &instance.id)? {
                emit_launch_state(
                    &app,
                    &instance.id,
                    None,
                    LaunchMethod::Native.as_str(),
                    "stopped",
                    "Launch cancelled by user.",
                );
                clear_launch_cancel_request(&state, &instance.id)?;
                return Err("Launch cancelled by user.".to_string());
            }

            emit_launch_state(
                &app,
                &instance.id,
                None,
                LaunchMethod::Native.as_str(),
                "starting",
                "Preparing native launch…",
            );

            let java_executable = if !instance_settings.java_path.trim().is_empty() {
                let p = PathBuf::from(instance_settings.java_path.trim());
                if !p.exists() {
                    return Err(format!(
                        "Instance Java path does not exist: {}",
                        instance_settings.java_path
                    ));
                }
                p.display().to_string()
            } else {
                resolve_java_executable(&settings)?
            };
            let (java_major, java_version_line) = detect_java_major(&java_executable)?;
            let required_java = required_java_major_for_mc(&instance.mc_version);
            if java_major < required_java {
                return Err(format!(
                    "Java {} detected ({}), but Minecraft {} needs Java {}+. Update Java path in Instance Settings > Java & Memory or Settings > Launcher.",
                    java_major, java_version_line, instance.mc_version, required_java
                ));
            }
            if is_launch_cancel_requested(&state, &instance.id)? {
                emit_launch_state(
                    &app,
                    &instance.id,
                    None,
                    LaunchMethod::Native.as_str(),
                    "stopped",
                    "Launch cancelled by user.",
                );
                clear_launch_cancel_request(&state, &instance.id)?;
                return Err("Launch cancelled by user.".to_string());
            }

            emit_launch_state(
                &app,
                &instance.id,
                None,
                LaunchMethod::Native.as_str(),
                "starting",
                "Refreshing Microsoft session…",
            );
            let app_for_auth = app.clone();
            let settings_for_auth = settings.clone();
            let instance_for_auth = instance.clone();
            let (account, mc_access_token, loader, loader_version) = await_launch_stage_with_cancel(
                &app,
                &state,
                &instance.id,
                LaunchMethod::Native.as_str(),
                "Authentication",
                150,
                async move {
                    tauri::async_runtime::spawn_blocking(move || {
                        resolve_native_auth_and_loader(
                            &app_for_auth,
                            &settings_for_auth,
                            &instance_for_auth,
                        )
                    })
                    .await
                    .map_err(|e| format!("native auth task join failed: {e}"))?
                },
            )
            .await?;

            let launch_id = format!("native_{}", Uuid::new_v4());
            let use_isolated_runtime_session = existing_native_runs_for_instance > 0;
            let runtime_session_cleanup_dir = if use_isolated_runtime_session {
                Some(
                    app_instance_dir
                        .join("runtime_sessions")
                        .join(launch_id.replace(':', "_")),
                )
            } else {
                None
            };
            let runtime_dir = runtime_session_cleanup_dir
                .clone()
                .unwrap_or_else(|| app_instance_dir.join("runtime"));
            emit_launch_state(
                &app,
                &instance.id,
                None,
                LaunchMethod::Native.as_str(),
                "starting",
                if use_isolated_runtime_session {
                    "Preparing isolated runtime session…"
                } else {
                    "Preparing runtime files…"
                },
            );
            let app_instance_dir_for_sync = app_instance_dir.clone();
            let app_for_sync = app.clone();
            let runtime_dir_for_sync = runtime_dir.clone();
            let use_isolated_runtime_for_sync = use_isolated_runtime_session;
            await_launch_stage_with_cancel(
                &app,
                &state,
                &instance.id,
                LaunchMethod::Native.as_str(),
                if use_isolated_runtime_for_sync {
                    "Isolated runtime prep"
                } else {
                    "Runtime preparation"
                },
                150,
                async move {
                    tauri::async_runtime::spawn_blocking(move || {
                        fs::create_dir_all(&runtime_dir_for_sync)
                            .map_err(|e| format!("mkdir native runtime failed: {e}"))?;
                        if use_isolated_runtime_for_sync {
                            sync_instance_runtime_content_isolated(
                                &app_instance_dir_for_sync,
                                &runtime_dir_for_sync,
                            )?;
                        } else {
                            sync_instance_runtime_content(&app_instance_dir_for_sync, &runtime_dir_for_sync)?;
                        }
                        let cache_dir = launcher_cache_dir(&app_for_sync)?;
                        fs::create_dir_all(&cache_dir)
                            .map_err(|e| format!("mkdir launcher cache failed: {e}"))?;
                        wire_shared_cache(&cache_dir, &runtime_dir_for_sync)?;
                        Ok(())
                    })
                    .await
                    .map_err(|e| format!("runtime preparation task join failed: {e}"))?
                },
            )
            .await?;

            let runtime_dir_str = runtime_dir.display().to_string();
            let mc_version = instance.mc_version.clone();
            let username = account.username.clone();
            let profile_id = account.id.clone();

            let mut launcher = OpenLauncher::new(
                &runtime_dir_str,
                &java_executable,
                ol_version::Version {
                    minecraft_version: mc_version,
                    loader,
                    loader_version,
                },
            )
            .await;
            launcher.auth(ol_auth::Auth::new(
                "msa".to_string(),
                "{}".to_string(),
                username,
                profile_id,
                mc_access_token,
            ));
            launcher.jvm_arg(&format!("-Xmx{}M", instance_settings.memory_mb));
            for arg in effective_jvm_args(&instance_settings.jvm_args) {
                launcher.jvm_arg(&arg);
            }
            emit_launch_state(
                &app,
                &instance.id,
                None,
                LaunchMethod::Native.as_str(),
                "starting",
                "Installing game version files…",
            );
            await_launch_stage_with_cancel(
                &app,
                &state,
                &instance.id,
                LaunchMethod::Native.as_str(),
                "Version install",
                300,
                async {
                    launcher
                        .install_version()
                        .await
                        .map_err(|e| format!("native install version failed: {e}"))
                },
            )
            .await?;
            emit_launch_state(
                &app,
                &instance.id,
                None,
                LaunchMethod::Native.as_str(),
                "starting",
                "Installing assets…",
            );
            await_launch_stage_with_cancel(
                &app,
                &state,
                &instance.id,
                LaunchMethod::Native.as_str(),
                "Assets install",
                900,
                async {
                    launcher
                        .install_assets()
                        .await
                        .map_err(|e| format!("native install assets failed: {e}"))
                },
            )
            .await?;
            emit_launch_state(
                &app,
                &instance.id,
                None,
                LaunchMethod::Native.as_str(),
                "starting",
                "Installing libraries…",
            );
            await_launch_stage_with_cancel(
                &app,
                &state,
                &instance.id,
                LaunchMethod::Native.as_str(),
                "Libraries install",
                900,
                async {
                    launcher
                        .install_libraries()
                        .await
                        .map_err(|e| format!("native install libraries failed: {e}"))
                },
            )
            .await?;

            let persistent_logs_dir = launch_logs_dir(&app_instance_dir);
            fs::create_dir_all(&persistent_logs_dir)
                .map_err(|e| format!("create launch logs directory failed: {e}"))?;
            let launch_log_file_name = format!(
                "{}-{}.log",
                Local::now().format("%Y%m%d-%H%M%S"),
                launch_id.replace(':', "_")
            );
            let launch_log_path = persistent_logs_dir.join(launch_log_file_name);
            let launch_log_file = File::create(&launch_log_path)
                .map_err(|e| format!("create native launch log failed: {e}"))?;
            let launch_log_file_err = launch_log_file
                .try_clone()
                .map_err(|e| format!("clone native launch log handle failed: {e}"))?;
            emit_launch_state(
                &app,
                &instance.id,
                None,
                LaunchMethod::Native.as_str(),
                "starting",
                "Starting Java process…",
            );
            let mut command = launcher
                .command()
                .map_err(|e| format!("native launch command build failed: {e}"))?;
            command.stdout(Stdio::from(launch_log_file));
            command.stderr(Stdio::from(launch_log_file_err));
            let mut child = command
                .spawn()
                .map_err(|e| format!("native launch spawn failed: {e}"))?;
            if is_launch_cancel_requested(&state, &instance.id)? {
                let _ = child.kill();
                emit_launch_state(
                    &app,
                    &instance.id,
                    None,
                    LaunchMethod::Native.as_str(),
                    "stopped",
                    "Launch cancelled by user.",
                );
                clear_launch_cancel_request(&state, &instance.id)?;
                return Err("Launch cancelled by user.".to_string());
            }
            thread::sleep(Duration::from_millis(900));
            if let Ok(Some(status)) = child.try_wait() {
                let tail = tail_lines_from_file(&launch_log_path, 24)
                    .map(|t| format!("\nRecent native-launch.log:\n{t}"))
                    .unwrap_or_default();
                return Err(format!(
                    "Native launch exited immediately with status {:?}. Check Java version/runtime mods. Log file: {}{}",
                    status.code(),
                    launch_log_path.display(),
                    tail
                ));
            }

            let pid = child.id();
            let child = Arc::new(Mutex::new(child));
            let keep_launcher_open = instance_settings.keep_launcher_open_while_playing;
            let close_launcher_on_exit = instance_settings.close_launcher_on_game_exit;
            let world_backup_interval_secs =
                u64::from(instance_settings.world_backup_interval_minutes.clamp(5, 15)) * 60;
            let world_backup_retention_count =
                usize::try_from(instance_settings.world_backup_retention_count.clamp(1, 2)).unwrap_or(1);
            let log_path_text = launch_log_path.display().to_string();
            let running_meta = RunningInstance {
                launch_id: launch_id.clone(),
                instance_id: instance.id.clone(),
                instance_name: instance.name.clone(),
                method: "native".to_string(),
                pid,
                started_at: now_iso(),
                log_path: Some(log_path_text),
            };
            {
                let mut guard = state
                    .running
                    .lock()
                    .map_err(|_| "lock running instances failed".to_string())?;
                guard.insert(
                    launch_id.clone(),
                    RunningProcess {
                        meta: running_meta.clone(),
                        child: child.clone(),
                        log_path: Some(launch_log_path.clone()),
                    },
                );
            }
            clear_launch_cancel_request(&state, &instance.id)?;
            if !keep_launcher_open {
                if let Some(window) = app.get_window("main") {
                    let _ = window.minimize();
                }
            }
            emit_launch_state(
                &app,
                &instance.id,
                Some(&launch_id),
                LaunchMethod::Native.as_str(),
                "running",
                if use_isolated_runtime_session {
                    "Native launch started in isolated concurrent mode."
                } else {
                    "Native launch started."
                },
            );

            let running_state = state.running.clone();
            let app_for_thread = app.clone();
            let launch_id_for_thread = launch_id.clone();
            let instance_id_for_thread = instance.id.clone();
            let instances_dir_for_thread = instances_dir.clone();
            let keep_launcher_open_for_thread = keep_launcher_open;
            let close_launcher_on_exit_for_thread = close_launcher_on_exit;
            let world_backup_interval_secs_for_thread = world_backup_interval_secs;
            let world_backup_retention_count_for_thread = world_backup_retention_count;
            let run_world_backups_for_thread = !use_isolated_runtime_session;
            let runtime_session_cleanup_for_thread = runtime_session_cleanup_dir.clone();
            thread::spawn(move || {
                let mut next_world_backup_at =
                    Instant::now() + Duration::from_secs(world_backup_interval_secs_for_thread);
                let exit_message = loop {
                    if run_world_backups_for_thread && Instant::now() >= next_world_backup_at {
                        let _ = create_world_backups_for_instance(
                            &instances_dir_for_thread,
                            &instance_id_for_thread,
                            "auto-world-backup",
                            world_backup_retention_count_for_thread,
                        );
                        next_world_backup_at =
                            Instant::now() + Duration::from_secs(world_backup_interval_secs_for_thread);
                    }
                    let waited = if let Ok(mut c) = child.lock() {
                        match c.try_wait() {
                            Ok(Some(status)) => Some(format!("Game exited with status {:?}", status.code())),
                            Ok(None) => None,
                            Err(e) => Some(format!("Failed to wait for game process: {e}")),
                        }
                    } else {
                        Some("Failed to lock child process handle.".to_string())
                    };
                    if let Some(message) = waited {
                        break message;
                    }
                    thread::sleep(Duration::from_millis(450));
                };
                if let Ok(mut guard) = running_state.lock() {
                    guard.remove(&launch_id_for_thread);
                }
                if let Some(path) = runtime_session_cleanup_for_thread {
                    let _ = remove_path_if_exists(&path);
                }
                emit_launch_state(
                    &app_for_thread,
                    &instance_id_for_thread,
                    Some(&launch_id_for_thread),
                    LaunchMethod::Native.as_str(),
                    "exited",
                    &exit_message,
                );
                if close_launcher_on_exit_for_thread {
                    app_for_thread.exit(0);
                    return;
                }
                if !keep_launcher_open_for_thread {
                    if let Some(window) = app_for_thread.get_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            });

            Ok(LaunchResult {
                method: "native".to_string(),
                launch_id: Some(launch_id),
                pid: Some(pid),
                prism_instance_id: None,
                prism_root: None,
                message: if use_isolated_runtime_session {
                    "Native launch started in isolated concurrent mode. This run uses temporary saves/config and will auto-clean on exit.".to_string()
                } else {
                    "Native launch started.".to_string()
                },
            })
        }
    }
}

#[tauri::command]
fn list_installed_mods(
    app: tauri::AppHandle,
    args: ListInstalledModsArgs,
) -> Result<Vec<InstalledMod>, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let lock = read_lockfile(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);

    let mut out: Vec<InstalledMod> = lock
        .entries
        .iter()
        .map(|e| lock_entry_to_installed(&instance_dir, e))
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
fn set_installed_mod_enabled(
    app: tauri::AppHandle,
    args: SetInstalledModEnabledArgs,
) -> Result<InstalledMod, String> {
    let instances_dir = app_instances_dir(&app)?;
    let _ = find_instance(&instances_dir, &args.instance_id)?;
    let instance_dir = instances_dir.join(&args.instance_id);
    let mut lock = read_lockfile(&instances_dir, &args.instance_id)?;

    let idx = lock
        .entries
        .iter()
        .position(|e| e.version_id == args.version_id)
        .ok_or_else(|| "installed mod entry not found".to_string())?;

    let mut changed = false;
    {
        let entry = &mut lock.entries[idx];
        if normalize_lock_content_type(&entry.content_type) != "mods" {
            return Err("Enable/disable is currently supported for mods only".to_string());
        }
        let (enabled_path, disabled_path) = mod_paths(&instance_dir, &entry.filename);

        if entry.enabled != args.enabled {
            if args.enabled {
                if enabled_path.exists() {
                    // already in place
                } else if disabled_path.exists() {
                    if enabled_path.exists() {
                        fs::remove_file(&enabled_path)
                            .map_err(|e| format!("remove existing enabled file failed: {e}"))?;
                    }
                    fs::rename(&disabled_path, &enabled_path)
                        .map_err(|e| format!("enable mod failed: {e}"))?;
                } else {
                    return Err("mod file not found on disk".into());
                }
            } else if disabled_path.exists() {
                // already disabled path
            } else if enabled_path.exists() {
                if disabled_path.exists() {
                    fs::remove_file(&disabled_path)
                        .map_err(|e| format!("remove existing disabled file failed: {e}"))?;
                }
                fs::rename(&enabled_path, &disabled_path)
                    .map_err(|e| format!("disable mod failed: {e}"))?;
            } else {
                return Err("mod file not found on disk".into());
            }

            entry.enabled = args.enabled;
            changed = true;
        }
    }

    if changed {
        write_lockfile(&instances_dir, &args.instance_id, &lock)?;
    }

    let entry = lock.entries[idx].clone();
    Ok(lock_entry_to_installed(&instance_dir, &entry))
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_instances,
            create_instance,
            create_instance_from_modpack_file,
            list_launcher_import_sources,
            import_instance_from_launcher,
            update_instance,
            set_instance_icon,
            read_local_image_data_url,
            detect_java_runtimes,
            delete_instance,
            search_discover_content,
            install_modrinth_mod,
            install_curseforge_mod,
            preview_modrinth_install,
            check_modrinth_updates,
            update_all_modrinth_mods,
            import_local_mod_file,
            list_installed_mods,
            set_installed_mod_enabled,
            launch_instance,
            get_launcher_settings,
            get_curseforge_api_status,
            set_launcher_settings,
            list_launcher_accounts,
            select_launcher_account,
            logout_microsoft_account,
            begin_microsoft_login,
            poll_microsoft_login,
            list_running_instances,
            stop_running_instance,
            cancel_instance_launch,
            list_instance_snapshots,
            list_instance_worlds,
            list_world_config_files,
            read_world_config_file,
            write_world_config_file,
            rollback_instance,
            rollback_instance_world_backup,
            read_instance_logs,
            install_discover_content,
            preview_preset_apply,
            apply_preset_to_instance,
            get_curseforge_project_detail,
            import_provider_modpack_template,
            export_presets_json,
            import_presets_json,
            get_selected_account_diagnostics,
            open_instance_path,
            reveal_config_editor_file,
            export_instance_mods_zip
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
