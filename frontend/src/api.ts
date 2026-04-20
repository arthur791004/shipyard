export interface Branch {
  id: string;
  name: string;
  repoId: string;
  isTrunk?: boolean;
  worktreePath: string;
  sandboxName?: string;
  port: number;
  status: "creating" | "stopped" | "starting" | "restarting" | "running" | "error";
  createdAt: number;
  error?: string;
  hasChanges?: boolean;
}

export interface Repo {
  id: string;
  name: string;
  linkTarget: string;
  repoPath: string;
  worktreesDir: string;
  defaultBranch: string;
  dashboardInstallCmd?: string;
  dashboardStartCmd?: string;
  previewUrl?: string;
  sandboxName?: string;
  createdAt: number;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Settings {
  repoUrl: string;
  configured: boolean;
  maxConcurrentSandboxes?: number;
  /**
   * When on, every `shipyard:sandbox push` from the sandbox is silently
   * routed through the backend's dry-run path — no git push, no PR
   * created on origin. Toggled from the Settings modal.
   */
  pushDryRun?: boolean;
}

export interface Session {
  id: string;
  repo: string;
  branch: string;
  issueUrl?: string;
  linearUrl?: string;
  summary?: string;
  createdAt: number;
  completedAt?: number;
}

export interface SystemCheck {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export const api = {
  getSettings: () => fetch("/api/settings").then(j<Settings>),
  systemCheck: () => fetch("/api/system-check").then(j<{ checks: SystemCheck[] }>),
  saveSettings: (body: Partial<Settings>) =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<Settings>),
  pickFolder: async (): Promise<{ path: string } | null> => {
    const res = await fetch("/api/pick-folder", { method: "POST" });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return await res.json();
  },
  listRepos: () =>
    fetch("/api/repos").then(j<{ repos: Repo[]; activeRepoId?: string }>),
  addRepo: (body: { linkTarget: string; dashboardInstallCmd?: string; dashboardStartCmd?: string }) =>
    fetch("/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<{ repo: Repo; activeRepoId: string }>),
  updateRepo: (id: string, body: Partial<Pick<Repo, "dashboardInstallCmd" | "dashboardStartCmd" | "previewUrl">>) =>
    fetch(`/api/repos/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<Repo>),
  activateRepo: (id: string) =>
    fetch(`/api/repos/${id}/activate`, { method: "POST" }).then(j<{ repo: Repo; activeRepoId: string }>),
  removeRepo: (id: string) =>
    fetch(`/api/repos/${id}`, { method: "DELETE" }).then(j<{ ok: true; activeRepoId?: string }>),
  list: () => fetch("/api/branches").then(j<{ branches: Branch[]; activeBranchId?: string }>),
  create: (body: { name: string; base?: string }) =>
    fetch("/api/branches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(j<Branch>),
  command: (command: string) =>
    fetch("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    }).then(j<{ kind: string; branch?: Branch }>),
  gitBranches: () =>
    fetch("/api/git-branches").then(j<{ branches: string[] }>),
  remoteBranchExists: (name: string) =>
    fetch(`/api/branches/remote-exists?name=${encodeURIComponent(name)}`).then(j<{ exists: boolean }>),
  toggle: (id: string) =>
    fetch(`/api/branches/${encodeURIComponent(id)}/toggle`, { method: "POST" }).then(j<Branch>),
  startDashboard: (id: string) =>
    fetch(`/api/branches/${encodeURIComponent(id)}/start-dashboard`, { method: "POST" }).then(
      j<{ running: true }>
    ),
  refreshSandbox: (id: string, hard = false) =>
    fetch(`/api/branches/${encodeURIComponent(id)}/refresh${hard ? "?hard=1" : ""}`, { method: "POST" }).then(
      j<{ ok: true }>
    ),
  openEditor: (id: string) =>
    fetch(`/api/branches/${encodeURIComponent(id)}/open-editor`, { method: "POST" }).then(
      j<{ ok: true }>
    ),
  switch: (id: string) =>
    fetch(`/api/branches/${encodeURIComponent(id)}/switch`, { method: "POST" }).then(
      j<{ activeBranchId: string }>
    ),
  logs: (id: string) =>
    fetch(`/api/branches/${encodeURIComponent(id)}/logs`).then(j<{ logs: string }>),
  remove: (id: string) =>
    fetch(`/api/branches/${encodeURIComponent(id)}`, { method: "DELETE" }).then(j<{ ok: true }>),
  getPr: (id: string) =>
    fetch(`/api/branches/${encodeURIComponent(id)}/pr`).then(j<{ url: string | null }>),
  syncRepo: (id: string) =>
    fetch(`/api/repos/${id}/sync`, { method: "POST" }).then(j<{ ok: true }>),
  sessions: () => fetch("/api/sessions").then(j<{ sessions: Session[] }>),
};
