import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Flex,
  Portal,
  useBreakpointValue,
  useDisclosure,
} from "@chakra-ui/react";
import { api, Branch, Session } from "./api";
import { TerminalModal, TerminalKind } from "./TerminalModal";
import { SettingsModal } from "./SettingsModal";
import { Welcome } from "./Welcome";
import { toaster } from "./Toaster";
import { Task } from "./TaskRow";
import { Sidebar } from "./Sidebar";
import { NewChatView } from "./NewChatView";
import { SidebarContent } from "./SidebarContent";
import { ContextMenu } from "./ContextMenu";
import { useRepos, useBranches, useSessions, useDismissible } from "./hooks";

const SIDEBAR_WIDTH = 260;

export function App() {
  const { repos, activeRepoId, settings, refreshRepos } = useRepos();
  const { branches, branchesLoaded, activeId, setActiveId, refresh, resetForRepoSwitch } = useBranches();
  const { sessions, refreshSessions } = useSessions();

  const settingsDisclosure = useDisclosure();
  const [terminalPanel, setTerminalPanel] = useState<{ branch: Branch; kind: TerminalKind } | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});

  const withPending = useCallback(
    async (id: string, action: string, fn: () => Promise<void>) => {
      setPending((p) => ({ ...p, [id]: action }));
      try {
        await fn();
      } catch (err: any) {
        toaster.create({ type: "error", title: err?.message ?? "Action failed", duration: 6000 });
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
      }
    },
    []
  );

  const [ctxMenu, setCtxMenu] = useDismissible<{ x: number; y: number; branch: Branch; session?: Session }>();

  const isMobile = useBreakpointValue({ base: true, md: false }) ?? false;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarAnimated, setSidebarAnimated] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile dropdown on outside click or Escape
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setMobileMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileMenuOpen]);

  const commandInputRef = useRef<HTMLInputElement>(null);
  const terminalWriteRef = useRef<((data: string) => void) | null>(null);

  // Cmd+P → new chat
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setTerminalPanel(null);
        setMobileMenuOpen(false);
        setTimeout(() => commandInputRef.current?.focus(), 100);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- Branch actions ---

  async function onPreview(b: Branch) {
    await withPending(b.id, "preview", async () => {
      await api.switch(b.id);
      setActiveId(b.id);
      await api.startDashboard(b.id);
      const repo = repos.find((r) => r.id === b.repoId);
      const url = repo?.previewUrl?.trim() || "http://my.localhost:3000";
      window.open(url, "_blank");
    });
  }

  async function onOpenEditor(b: Branch) {
    await withPending(b.id, "editor", async () => {
      await api.openEditor(b.id);
    });
  }

  async function onPushAndPR(b: Branch) {
    try {
      const res = await api.pushAndPR(b.id);
      if (res.url) {
        toaster.create({
          type: "info",
          title: res.created ? "PR created" : "Pushed",
          description: res.url,
          duration: 8000,
        });
        window.open(res.url, "_blank");
      }
    } catch (err: any) {
      toaster.create({ type: "error", title: err?.message ?? "Push failed", duration: 6000 });
    }
  }

  async function onRefreshSandbox(b: Branch, hard = false) {
    try {
      await api.refreshSandbox(b.id, hard);
      await refresh();
      toaster.create({ type: "info", title: hard ? "Sandbox rebuilt" : "Sandbox restarted", duration: 2000 });
    } catch (err: any) {
      toaster.create({ type: "error", title: err?.message ?? "Restart failed", duration: 6000 });
    }
  }

  async function onDelete(b: Branch) {
    if (!confirm(`Delete branch "${b.name}"? Worktree will be removed.`)) return;
    if (terminalPanel && terminalPanel.branch.id === b.id) {
      setTerminalPanel(null);
    }
    await withPending(b.id, "deleting", async () => {
      await api.remove(b.id);
      await refresh();
    });
  }

  async function onAddRepo() {
    try {
      const picked = await api.pickFolder();
      if (!picked) return;
      await api.addRepo({ linkTarget: picked.path });
      await refreshRepos();
      await refresh();
    } catch (err: any) {
      toaster.create({ type: "error", title: err?.message ?? "Add repo failed", duration: 6000 });
    }
  }

  // --- Navigation ---

  function onSelectTask(b: Branch) {
    if (!terminalPanel || terminalPanel.branch.id !== b.id) {
      setTerminalPanel({ branch: b, kind: "claude" });
    }
    const needsStart = !b.isTrunk && (b.status === "stopped" || b.status === "error");
    if (needsStart) {
      withPending(b.id, "starting", async () => {
        await api.toggle(b.id);
        await refresh();
      });
    }
  }

  function handleNewChat() {
    setTerminalPanel(null);
    setMobileMenuOpen(false);
    setTimeout(() => commandInputRef.current?.focus(), 100);
  }

  function handleSelectFromDropdown(b: Branch) {
    onSelectTask(b);
    setMobileMenuOpen(false);
  }

  // --- Derived data ---

  if (settings && repos.length === 0) {
    return (
      <Welcome
        onDone={async () => {
          await refreshRepos();
          await refresh();
        }}
      />
    );
  }

  const trunk = branches.find((b) => b.isTrunk);
  const activeRepoName = repos.find((r) => r.id === activeRepoId)?.name;
  const sessionTasks: Task[] = (() => {
    const all = sessions
      .filter((s) => !activeRepoName || s.repo === activeRepoName)
      .map((s) => ({
        session: s,
        branch: branches.find((b) => !b.isTrunk && b.name === s.branch),
      }))
      .filter((t) => !!t.branch);
    const seen = new Set<string>();
    const deduped: Task[] = [];
    for (const t of all) {
      const name = t.branch!.name;
      if (seen.has(name)) continue;
      seen.add(name);
      deduped.push(t);
    }
    return deduped.sort((a, b) => (a.branch?.name ?? "").localeCompare(b.branch?.name ?? ""));
  })();

  return (
    <Flex w="100vw" h="100vh" overflow="hidden" direction="row">
      {/* Sidebar column (desktop only) */}
      {!isMobile && (
        <Sidebar
          trunk={trunk}
          sessionTasks={sessionTasks}
          branchesLoaded={branchesLoaded}
          selectedBranchId={terminalPanel?.branch.id}
          pending={pending}
          repos={repos}
          activeRepoId={activeRepoId}
          sidebarCollapsed={sidebarCollapsed}
          sidebarAnimated={sidebarAnimated}
          onToggleSidebar={() => { setSidebarAnimated(true); setSidebarCollapsed((v) => !v); }}
          onNewChat={handleNewChat}
          onSelectTask={onSelectTask}
          onContextMenu={(e, branch, session) => {
            setCtxMenu({ x: e.clientX, y: e.clientY, branch, session });
          }}
          onRepoChanged={async () => {
            resetForRepoSwitch();
            await refreshRepos();
            await refresh();
          }}
          onOpenSettings={settingsDisclosure.onOpen}
        />
      )}

      {/* Right panel */}
      <Flex direction="column" flex="1" minW={0} overflow="hidden" bg="#000" position="relative">
        <Box flex="1" overflow="hidden" position="relative">
          {terminalPanel ? (() => {
            const liveBranch =
              branches.find((b) => b.id === terminalPanel.branch.id) ?? terminalPanel.branch;
            return (
              <TerminalModal
                key={`${liveBranch.id}:${terminalPanel.kind}:${liveBranch.status}`}
                branch={liveBranch}
                kind={terminalPanel.kind}
                isMobile={isMobile}
                onKindChange={(kind) =>
                  setTerminalPanel((prev) => (prev ? { ...prev, kind } : prev))
                }
                onClose={() => setTerminalPanel(null)}
                onPreview={onPreview}
                onOpenEditor={onOpenEditor}
                onRefresh={(b) => onRefreshSandbox(b)}
                writeRef={terminalWriteRef}
                onHardRefresh={(b) => onRefreshSandbox(b, true)}
                onPush={(b) => onPushAndPR(b)}
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={() => {
                  if (isMobile) {
                    setMobileMenuOpen((v) => !v);
                  } else {
                    setSidebarAnimated(true);
                    setSidebarCollapsed((v) => !v);
                  }
                }}
              />
            );
          })() : (
            <NewChatView
              isMobile={isMobile}
              sidebarCollapsed={sidebarCollapsed}
              trunk={trunk}
              sessionTasks={sessionTasks}
              activeRepoId={activeRepoId}
              branches={branches}
              sessions={sessions}
              commandInputRef={commandInputRef}
              onToggleSidebar={() => { setSidebarAnimated(true); setSidebarCollapsed(false); }}
              onToggleMobileMenu={() => setMobileMenuOpen((v) => !v)}
              onNewChat={handleNewChat}
              onSelectTask={handleSelectFromDropdown}
              onCreated={(branch) => setTerminalPanel({ branch, kind: "claude" })}
              onRefresh={refresh}
              onSessionsRefresh={refreshSessions}
            />
          )}
        </Box>
      </Flex>

      {/* Mobile sidebar dropdown overlay */}
      {isMobile && mobileMenuOpen && (
        <Portal>
          <Box
            ref={mobileMenuRef}
            position="fixed"
            top="48px"
            left={0}
            w={`${SIDEBAR_WIDTH}px`}
            maxH="calc(100vh - 60px)"
            overflowY="auto"
            bg="gray.900"
            borderWidth={1}
            borderColor="gray.700"
            borderRadius="md"
            boxShadow="lg"
            p={3}
            zIndex={30}
            ml={2}
          >
            <SidebarContent
              trunk={trunk}
              sessionTasks={sessionTasks}
              selectedBranchId={terminalPanel?.branch.id}
              onNewChat={handleNewChat}
              onSelectTask={handleSelectFromDropdown}
            />
          </Box>
        </Portal>
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          branch={ctxMenu.branch}
          session={ctxMenu.session}
          onClose={() => setCtxMenu(null)}
          onPreview={onPreview}
          onPushAndPR={onPushAndPR}
          onOpenEditor={onOpenEditor}
          onRefresh={(b) => onRefreshSandbox(b)}
          onHardRefresh={(b) => onRefreshSandbox(b, true)}
          onDelete={onDelete}
        />
      )}

      <SettingsModal
        open={settingsDisclosure.open}
        activeRepo={repos.find((r) => r.id === activeRepoId) ?? null}
        firstRun={repos.length === 0}
        onClose={settingsDisclosure.onClose}
        onAddRepo={async () => {
          await onAddRepo();
          settingsDisclosure.onClose();
        }}
        onSaved={async () => {
          await refreshRepos();
        }}
      />
    </Flex>
  );
}
