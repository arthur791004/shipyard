import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Portal,
  Text,
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
  const [previewPanel, setPreviewPanel] = useState<{ src: string; url: string } | null>(null);
  const [previewViewport, setPreviewViewport] = useState<"desktop" | "mobile">("desktop");

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

  async function startPreview(b: Branch): Promise<string> {
    await api.switch(b.id);
    setActiveId(b.id);
    await api.startDashboard(b.id);
    const repo = repos.find((r) => r.id === b.repoId);
    return repo?.previewUrl?.trim() || "http://my.localhost:3000";
  }

  async function onPreview(b: Branch) {
    await withPending(b.id, "preview", async () => {
      const url = await startPreview(b);
      window.open(url, "_blank");
    });
  }

  async function onPreviewInline(b: Branch) {
    await withPending(b.id, "preview", async () => {
      const url = await startPreview(b);
      // Use the same preview URL (branchProxy) for the iframe.
      // startPreview already called api.switch() to set this branch as active.
      // Cross-origin iframes are allowed — the browser only restricts JS
      // access between origins, not loading the iframe itself.
      setPreviewPanel({ src: url, url });
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
      setPreviewPanel(null);
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
      <Flex flex="1" minW={0} overflow="hidden" bg="#000" position="relative">
        <Flex direction="column" flex="1" minW={0} overflow="hidden">
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
                  onPreviewInline={!isMobile ? onPreviewInline : undefined}
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

        {/* Inline preview panel */}
        {previewPanel && !isMobile && (
          <Flex
            direction="column"
            w="50%"
            maxW="50%"
            minW="300px"
            h="100%"
            borderLeftWidth={1}
            borderColor="gray.800"
          >
            <Flex
              h="48px"
              px={4}
              align="center"
              justify="space-between"
              flexShrink={0}
              borderBottomWidth={1}
              borderColor="gray.800"
            >
              <HStack gap={2} minW={0} flex="1">
                <PreviewPanelIcon />
                <Text fontSize="sm" color="gray.400" truncate>{previewPanel.url}</Text>
              </HStack>
              <HStack gap={1}>
                <Button
                  size="sm"
                  variant={previewViewport === "desktop" ? "solid" : "ghost"}
                  px={2}
                  aria-label="Desktop viewport"
                  onClick={() => setPreviewViewport("desktop")}
                >
                  <DesktopIcon />
                </Button>
                <Button
                  size="sm"
                  variant={previewViewport === "mobile" ? "solid" : "ghost"}
                  px={2}
                  aria-label="Mobile viewport"
                  onClick={() => setPreviewViewport("mobile")}
                >
                  <MobileIcon />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  px={2}
                  aria-label="Open in new tab"
                  onClick={() => window.open(previewPanel.url, "_blank")}
                >
                  <ExternalLinkIcon />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  px={2}
                  aria-label="Refresh preview"
                  onClick={() => {
                    const p = previewPanel;
                    setPreviewPanel(null);
                    setTimeout(() => setPreviewPanel(p), 0);
                  }}
                >
                  <RefreshPanelIcon />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  px={2}
                  aria-label="Close preview"
                  onClick={() => setPreviewPanel(null)}
                >
                  <CloseIcon />
                </Button>
              </HStack>
            </Flex>
            <Flex
              flex="1"
              bg="gray.950"
              align={previewViewport === "mobile" ? "start" : "stretch"}
              justify={previewViewport === "mobile" ? "center" : "flex-start"}
              overflow="auto"
            >
              <Box
                w={previewViewport === "mobile" ? "375px" : "100%"}
                minW={previewViewport === "desktop" ? "1280px" : undefined}
                h={previewViewport === "mobile" ? "812px" : "auto"}
                minH={previewViewport === "desktop" ? "100%" : undefined}
                bg="white"
                borderRadius={previewViewport === "mobile" ? "md" : 0}
                overflow="hidden"
                mt={previewViewport === "mobile" ? 4 : 0}
                flexShrink={0}
                boxShadow={previewViewport === "mobile" ? "0 0 0 1px var(--chakra-colors-gray-700)" : "none"}
              >
                <iframe
                  src={previewPanel.src}
                  style={{ width: "100%", height: "100%", border: "none" }}
                  title="Preview"
                />
              </Box>
            </Flex>
          </Flex>
        )}
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

function PreviewPanelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function RefreshPanelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function DesktopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function MobileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <line x1="12" y1="18" x2="12" y2="18" />
    </svg>
  );
}
