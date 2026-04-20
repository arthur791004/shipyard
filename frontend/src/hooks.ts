import { useCallback, useEffect, useState } from "react";
import { api, Branch, Repo, Session, Settings } from "./api";

export function useRepos() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<string | undefined>();
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    (async () => {
      const [s, repoRes] = await Promise.all([api.getSettings(), api.listRepos()]);
      setSettings(s);
      setRepos(repoRes.repos);
      setActiveRepoId(repoRes.activeRepoId);
    })();
  }, []);

  const refreshRepos = useCallback(async () => {
    const res = await api.listRepos();
    setRepos(res.repos);
    setActiveRepoId(res.activeRepoId);
    return res;
  }, []);

  const refreshSettings = useCallback(async () => {
    const s = await api.getSettings();
    setSettings(s);
    return s;
  }, []);

  return { repos, activeRepoId, settings, refreshRepos, refreshSettings };
}

export function useBranches() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const res = await api.list();
    setBranches(res.branches);
    setActiveId(res.activeBranchId);
    setBranchesLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const resetForRepoSwitch = useCallback(() => {
    setBranchesLoaded(false);
    setBranches([]);
  }, []);

  return { branches, branchesLoaded, activeId, setActiveId, refresh, resetForRepoSwitch };
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);

  const refreshSessions = useCallback(() => {
    api.sessions().then((r) => setSessions(r.sessions)).catch(() => {});
  }, []);

  useEffect(() => {
    refreshSessions();
    const t = setInterval(refreshSessions, 5000);
    return () => clearInterval(t);
  }, [refreshSessions]);

  return { sessions, refreshSessions };
}

export function useDismissible<T>(initial: T | null = null) {
  const [value, setValue] = useState<T | null>(initial);

  useEffect(() => {
    if (!value) return;
    const onClick = () => setValue(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setValue(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [value]);

  return [value, setValue] as const;
}
