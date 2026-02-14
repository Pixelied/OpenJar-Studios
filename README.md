````md
# OpenJar Launcher

**OpenJar Launcher** is a **good-looking, Mac-first Minecraft launcher / “Creator Studio”** built with **Tauri (Rust)** + **React (Vite + TypeScript)**.

It’s designed to feel clean and modern while still being powerful: manage instances, import from other launchers, browse Modrinth/CurseForge, install & update content with lockfiles, edit configs with a real UI, and launch safely — even running multiple copies at once.

---

## Table of contents

- [Screenshots](#screenshots)
- [Highlights](#highlights)
- [Features](#features)
  - [Instance Management](#instance-management)
  - [Import / Export](#import--export)
  - [Discover + Install (Multi-provider)](#discover--install-multi-provider)
  - [Installed Mods (Per instance)](#installed-mods-per-instance)
  - [Updates (Modrinth)](#updates-modrinth)
  - [Snapshots + Rollback (installed content)](#snapshots--rollback-installed-content)
  - [World Backups + World Rollback (your saves)](#world-backups--world-rollback-your-saves)
  - [Launching](#launching)
  - [Multi-Launch Explained (Isolated Runtime Sessions)](#multi-launch-explained-isolated-runtime-sessions)
  - [Microsoft Account / Auth (Native Launch)](#microsoft-account--auth-native-launch)
  - [Logs + Crash Hints](#logs--crash-hints)
  - [Config Editor (UI-first, powerful)](#config-editor-ui-first-powerful)
  - [Presets / Creator Tools (experimental)](#presets--creator-tools-experimental)
- [Where your data lives](#where-your-data-lives)
- [CurseForge API Key](#curseforge-api-key)
- [Tech Stack](#tech-stack)
- [Platform support & testing](#platform-support--testing)
- [Dev Setup](#dev-setup)

---

## Screenshots

Drop images into `docs/screenshots/` and embed them like this:

<p align="center">
  <img src="docs/screenshots/instances.png" width="32%" alt="Instances" />
  <img src="docs/screenshots/discover.png" width="32%" alt="Discover" />
  <img src="docs/screenshots/config.png" width="32%" alt="Config Editor" />
</p>

---

## Highlights

- **Clean, modern UI** (macOS-friendly look & feel)
- **Instance management** + import from Vanilla / Prism
- **Multi-provider discovery**: Modrinth + CurseForge
- **Dependency-aware installs** (Modrinth) + per-instance **lockfile** tracking
- **Per-mod enable/disable** (rename to `.disabled`)
- **Updates** (Modrinth) + “Update all”
- **Config Editor** experience (file browser + editors + helpers)
- **Snapshots / rollback** tooling (for installed content)
- **Native launching** + Microsoft account login
- **Multi-launch support** using **isolated runtime sessions** (run many copies safely)

---

## Features

### Instance Management

Create and manage self-contained “instances” (your own Minecraft folders with their own mods, packs, saves, and settings).

What you can do:
- Create, list, rename, edit, delete instances
- Open/reveal instance folders and common paths
- Instance icons (store an icon path + load local images for display)

Per-instance launch settings (these affect the actual launch):
- Java executable path (or auto-detect a runtime)
- Memory limit (adds `-Xmx####M`)
- Extra JVM args
- “Keep launcher open” / “Close on game exit”

Note on settings:
- Some extra toggles exist in the UI/settings model (graphics preset, shader toggle, vsync, prefer releases, etc.)
- If something doesn’t change the game yet, it means it isn’t fully hooked up in the current build.

---

### Import / Export

Move your existing setup into OpenJar and back out again.

Create instance from a modpack archive (“From File” flow):
- Supports **Modrinth `.mrpack`** and **CurseForge** modpack zips
- Reads pack name / Minecraft version / loader from pack metadata
- Imports **override files** (configs/resources/scripts/etc.) into the instance

Important:
- It does **not** automatically download the modpack’s mods yet — it currently extracts overrides only.

Import instances from other launchers:
- **Vanilla Minecraft** (`.minecraft`)
- **Prism Launcher** instances (auto-detected)
- Copies common folders like:
  - `mods/`, `config/`, `resourcepacks/`, `shaderpacks/`, `saves/`
  - plus `options.txt` and `servers.dat`

Other import/export tools:
- Import a local mod **`.jar`** into an instance (“Add from file”)
- Export installed mods as a **ZIP**
  - Includes enabled `.jar` files and disabled `.disabled` files

---

### Discover + Install (Multi-provider)

Find content and install it straight into an instance.

Discover/search supports:
- **Modrinth**
- **CurseForge** (partial / in progress)

Filters include:
- Content type: mods / resourcepacks / shaderpacks / datapacks / modpacks
- Loader: Fabric / Forge / Quilt / NeoForge (and Vanilla where relevant)
- Minecraft version
- Sort: downloads / updated / newest / follows (depends on provider)

#### Modrinth (works now)

- Install Modrinth projects into an instance with progress events
- Install planning/preview (“here’s what will be installed before we do it”)
- Automatically installs **required dependencies**
- Writes installs to a per-instance lockfile (`lock.json`) so OpenJar can:
  - check for updates later
  - roll back installed content reliably

#### CurseForge (partial / in progress)

What currently exists (may vary depending on your build/UI state):
- API status check (key/network/config troubleshooting)
- Project detail fetch for detail views

Note:
- Install flows exist behind the scenes, but some UI wiring may still feel incomplete.

---

### Installed Mods (Per instance)

Keep track of what’s installed, and quickly disable something that’s causing crashes.

- View installed content list (from `lock.json`)
- Enable/disable mods:
  - Disabling renames `SomeMod.jar` → `SomeMod.jar.disabled`
  - Enabling renames it back to `.jar`
  - (Currently enable/disable is supported for **mods** only.)
- Lockfile tracking (`lock.json` stored inside the instance folder)
  - Stores provider IDs + chosen version + filename + hashes + enabled/disabled state

---

### Updates (Modrinth)

Stay current without playing “guess which mod broke my game.”

- Check for updates for installed Modrinth mods
- “Update all” flow
- Before update-all, OpenJar creates a snapshot (see below) so you can roll back if something breaks

---

### Snapshots + Rollback (installed content)

Snapshots are your “undo” button for **installed content** — not your entire world.

What a snapshot is:
- A stored copy of specific *content folders* + the lockfile at that moment,
  so you can revert after a bad install/update.

What gets snapshotted:
- `mods/`
- `resourcepacks/`
- `shaderpacks/`
- each world’s `saves/<world>/datapacks/`
- the instance `lock.json`

What does *not* get snapshotted:
- Your world data (region/playerdata/etc.) — that’s handled by **World Backups**
- Other world files outside `datapacks/`
- General config folders (for now)

When snapshots are created:
- Before installing content (when there are real actions to apply)
- Before applying presets (if enabled)
- Before “Update all” (when updates exist)

How rollback works:
- Snapshots are kept (up to 20) and listed in the UI
- Rolling back restores the snapshot’s content folders + the saved `lock.json`
- You must stop Minecraft before rolling back

---

### World Backups + World Rollback (your saves)

This is the “I don’t want to lose my world” safety net.

What it does:
- OpenJar can periodically back up each world in `saves/`
- Each backup is a **zip of the entire world folder**
  (region, playerdata, data, advancements, etc.)
- Backups are stored under `world_backups/` inside the instance folder

How you control it (per instance):
- Backup interval (minutes)
  - Example: every 10 minutes OpenJar zips your world and stores a backup
  - Default: **10 minutes**
- Retention count (per world)
  - Example: keep the last 3 backups of each world, delete older ones automatically
  - Default: **1 backup per world**

World rollback (restore a backup):
- Choose a backup (most recent or a specific one)
- Restoring **replaces** `saves/<world>` with the backed-up copy
- You must stop Minecraft before restoring a world

Important nuance (multi-launch):
- When OpenJar launches additional copies using an **isolated runtime session**,
  it copies worlds/configs into a temporary folder so those extra sessions can’t corrupt
  your main world.
- In isolated mode, auto world backups are not run for that session.

---

### Launching

Two launch modes depending on how you prefer to run Minecraft.

Native launch mode (no Prism required):
- Loader support includes Vanilla / Fabric / Forge (auto resolution logic)
- Uses shared caches under app data (assets/libraries/versions caching)

Prism launch mode:
- Syncs instance content into a Prism instance folder
- Uses symlinks when possible, with copy fallback
- Launches through Prism’s workflow

Basic safety controls:
- Tracks running launches (per-launch IDs)
- Stop a running instance
- Cancel an in-progress launch
- Prevents unsafe duplicate native launch of the *same* instance folder

---

### Multi-Launch Explained (Isolated Runtime Sessions)

When you launch a second (or third…) copy of the same instance, OpenJar creates a **runtime session** folder.

How it behaves:
- First launch: the game uses the normal instance runtime folder
- Additional launches: OpenJar makes `runtime_sessions/<launch_id>/` and:
  - links mods/resourcepacks/shaderpacks (fast, shared)
  - copies config + saves into the session (so changes don’t touch your main instance)
  - copies `options.txt` + `servers.dat`
- When the game closes, that runtime session folder is deleted automatically

Why it exists:
- It avoids two Minecraft clients writing to the same world/config and corrupting things.

---

### Microsoft Account / Auth (Native Launch)

Sign in and stay signed in.

- Microsoft device-code login flow (begin + poll)
- List saved accounts
- Select active account
- Logout/disconnect
- Account diagnostics (helps when auth gets weird)
- Tokens are stored in the system keychain (with a safe fallback file inside app data)

---

### Logs + Crash Hints

OpenJar can read the latest instance logs and give you faster signals.

- Read instance logs
- Frontend log analyzer:
  - counts errors/warnings
  - tries to identify likely causes (“suspects”) based on common patterns
    (mod mentioned in a stack trace, missing dependency, incompatible loader/version, etc.)

---

### Config Editor (UI-first, powerful)

A full config editing experience inside the app.

Core workflow:
- Instance picker dropdown
- Optional world picker (lists worlds in `saves/`)
- Config file browser (lists config files)
- Reveal/open files in Finder

Editing tools:
- Read and save files
- Create new config files (New File modal)
- Specialized editors:
  - JSON editor (parsing + friendly error display)
  - Text editor
  - `servers.dat` editor (edit server list)
- Advanced editor mode
- Inspector panel (context + suggestions)
- Helper features (formatting + suggestions)

---

### Presets / Creator Tools (experimental)

This area is wired but still marked as “in progress.”

- Preview preset apply (see what will change before applying)
- Apply preset to an instance
- Export presets to JSON
- Import presets from JSON
- Provider modpack template import is wired

---

## Where your data lives

OpenJar stores everything in your OS app data directory (Tauri app data). Per instance you’ll typically see:

- `mods/`, `resourcepacks/`, `shaderpacks/`, `config/`, `saves/`
- `lock.json` (installed content lockfile)
- `snapshots/` (content snapshots)
- `world_backups/` (world save backups)
- `runtime/` and `runtime_sessions/` (runtime prep folders for launching)

---

## CurseForge API Key

CurseForge requests require an API key:

- Set `MPM_CURSEFORGE_API_KEY` in your environment before running/building.

---

## Tech Stack

- **Tauri v1** + **Rust** backend
- **React + TypeScript** frontend (**Vite**)
- Multi-provider content flows (**Modrinth + CurseForge**)
- Clean separation between UI, commands, and instance filesystem operations

---

## Platform support & testing

OpenJar Launcher is **built and tested primarily on macOS** and is optimized to run smoothly on Mac.

Because it’s built on **Tauri + Rust**, it should also work on Windows (and likely Linux), but those platforms are not as heavily tested yet.

- macOS: actively tested / primary target
- Windows: expected to work, but less tested
- Linux: likely workable, currently unverified

If you try Windows/Linux and run into issues, please open a GitHub Issue with:
- OS + version (and whether it’s Intel/AMD or ARM)
- steps to reproduce
- error messages
- relevant logs (and screenshots if helpful)

---

## Dev Setup

### Requirements

- Node.js **18+** recommended
- Rust toolchain (**stable**)
- Tauri prerequisites for your OS

### Install

```bash
npm install
````

### Run (dev)

Frontend only (Vite):

```bash
npm run dev
```

Full desktop app (Tauri + Vite):

```bash
npm run tauri:dev
```

### Build

Frontend build:

```bash
npm run build
```

Tauri desktop build:

```bash
npm run tauri:build
```

### Preview (frontend build)

```bash
npm run preview
```

```
```