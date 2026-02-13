export type ModrinthIndex = "relevance" | "downloads" | "follows" | "updated" | "newest";

export type SearchHit = {
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
};

export type SearchResponse = {
  hits: SearchHit[];
  offset: number;
  limit: number;
  total_hits: number;
};

export type Project = {
  id: string;
  title: string;
  slug: string;
  description: string;
  categories: string[];
  client_side: string;
  server_side: string;
  body?: string;
  icon_url?: string | null;
  downloads: number;
  followers: number;
  versions: string[];
  link_urls?: Record<string, string>;
  wiki_url?: string | null;
  issues_url?: string | null;
  source_url?: string | null;
  discord_url?: string | null;
};

export type ProjectVersion = {
  id: string;
  name: string;
  version_number: string;
  changelog?: string | null;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  downloads: number;
  files: {
    filename: string;
    size?: number;
    primary?: boolean;
  }[];
};

export type ProjectMember = {
  role: string;
  user: {
    username: string;
    name?: string | null;
    avatar_url?: string | null;
  };
};

const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
const apiEnv = viteEnv?.VITE_MODRINTH_API_BASE;
const API = (apiEnv?.trim() || "https://api.modrinth.com/v2").replace(/\/+$/, "");

function headers() {
  return {
    "Accept": "application/json",
    // Modrinth asks for a user-agent. Desktop app name is enough here.
    "User-Agent": "ModpackManager/0.0.1 (Tauri)",
  };
}

function facets(andGroups: string[][]): string | undefined {
  // Modrinth facets are expressed as JSON array-of-arrays:
  // - outer array: AND between groups
  // - each inner group: OR between facets inside the group
  if (andGroups.length === 0) return undefined;
  return JSON.stringify(andGroups);
}

export async function searchMods(input: {
  query: string;
  loaders?: string[];
  gameVersion?: string | null;
  categories?: string[]; // additional non-loader categories
  index: ModrinthIndex;
  limit: number;
  offset: number;
  showAll?: boolean; // includes non-mod results later; currently unused
}): Promise<SearchResponse> {
  const params = new URLSearchParams();
  params.set("query", input.query || "");
  params.set("index", input.index);
  params.set("limit", String(input.limit));
  params.set("offset", String(input.offset));

  const groups: string[][] = [["project_type:mod"]];
  if (input.loaders && input.loaders.length) {
    groups.push(input.loaders.map((loader) => `categories:${loader}`));
  }
  if (input.gameVersion) groups.push([`versions:${input.gameVersion}`]);
  if (input.categories && input.categories.length) {
    groups.push(input.categories.map((c) => `categories:${c}`));
  }
  const facetStr = facets(groups);
  if (facetStr) params.set("facets", facetStr);

  const url = `${API}/search?${params.toString()}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Modrinth search failed (${res.status})`);
  return (await res.json()) as SearchResponse;
}

export async function getProject(projectId: string): Promise<Project> {
  const res = await fetch(`${API}/project/${projectId}`, { headers: headers() });
  if (!res.ok) throw new Error(`Modrinth project failed (${res.status})`);
  return (await res.json()) as Project;
}

export async function getProjectVersions(projectId: string): Promise<ProjectVersion[]> {
  const res = await fetch(`${API}/project/${projectId}/version`, { headers: headers() });
  if (!res.ok) throw new Error(`Modrinth versions failed (${res.status})`);
  return (await res.json()) as ProjectVersion[];
}

export async function getProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const res = await fetch(`${API}/project/${projectId}/members`, { headers: headers() });
  if (!res.ok) throw new Error(`Modrinth members failed (${res.status})`);
  return (await res.json()) as ProjectMember[];
}
