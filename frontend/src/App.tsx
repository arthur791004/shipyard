import { useEffect, useRef, useState, useCallback } from "react";
import {
  Badge,
  Box,
  Button,
  Code,
  Flex,
  HStack,
  Heading,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
  Tooltip,
  useBreakpointValue,
  useDisclosure,
} from "@chakra-ui/react";
import { api, Branch, Repo, Session, Settings } from "./api";
import { SettingsModal } from "./SettingsModal";
import { RepoSwitcher } from "./RepoSwitcher";
import { TerminalModal, TerminalKind } from "./TerminalModal";
import { Welcome } from "./Welcome";
import { toaster } from "./Toaster";

export function App() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<string | undefined>();
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

  const refreshRepos = useCallback(async () => {
    const res = await api.listRepos();
    setRepos(res.repos);
    setActiveRepoId(res.activeRepoId);
    return res;
  }, []);

  useEffect(() => {
    (async () => {
      const [s, repoRes] = await Promise.all([api.getSettings(), api.listRepos()]);
      setSettings(s);
      setRepos(repoRes.repos);
      setActiveRepoId(repoRes.activeRepoId);
    })();
  }, []);

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

  const [commandText, setCommandText] = useState("");
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandMenuIndex, setCommandMenuIndex] = useState(0);
  const [commandInputFocused, setCommandInputFocused] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; branch: Branch; session?: Session } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const onClick = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  useEffect(() => {
    const load = () => api.sessions().then((r) => setSessions(r.sessions)).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // On narrow viewports we show one column at a time: task list by default,
  // terminal fullscreen when a task is selected. Back = close the terminal.
  const isMobile = useBreakpointValue({ base: true, md: false }) ?? false;

  const SIDEBAR_WIDTH = 260;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarHover, setSidebarHover] = useState(false);
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

  const taskListRef = useRef<HTMLDivElement>(null);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd+P / Ctrl+P → new chat (deselect task, focus input)
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        setTerminalPanel(null);
        setMobileMenuOpen(false);
        setTimeout(() => commandInputRef.current?.focus(), 100);
        return;
      }
      // Arrow keys → navigate task list (only when task list area is
      // focused, not when typing in the command input or terminal)
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const active = document.activeElement;
        const inTaskList =
          taskListRef.current?.contains(active) ||
          active === document.body;
        if (!inTaskList) return;
        e.preventDefault();
        const buttons = taskListRef.current?.querySelectorAll<HTMLElement>(
          '[role="button"]'
        );
        if (!buttons || buttons.length === 0) return;
        const currentIdx = Array.from(buttons).findIndex(
          (el) => el === active
        );
        let nextIdx: number;
        if (e.key === "ArrowDown") {
          nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % buttons.length;
        } else {
          nextIdx =
            currentIdx < 0
              ? buttons.length - 1
              : (currentIdx - 1 + buttons.length) % buttons.length;
        }
        buttons[nextIdx].focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function closeTerminal() {
    setTerminalPanel(null);
  }


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


  // Ref to write to the active terminal's WebSocket (set by TerminalModal)
  const terminalWriteRef = useRef<((data: string) => void) | null>(null);

  function validateCommand(text: string): string | null {
    if (!text.startsWith("/")) return null; // Free text — will be sent to PTY
    const parts = text.split(/\s+/);
    const verb = parts[0];
    const known = ["/branch", "/gh-issue", "/linear"];
    if (!known.includes(verb)) return `Unknown command: ${verb}`;
    if (verb === "/branch") {
      const name = parts[1];
      if (!name) return "Usage: /branch <name> [base]";
      if (branches.some((b) => !b.isTrunk && b.name === name)) {
        return `Branch "${name}" already exists`;
      }
      return null;
    }
    if (verb === "/gh-issue") {
      const url = parts[1];
      if (!url) return "Usage: /gh-issue <url>";
      const m = url.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
      if (!m) return "Not a GitHub issue URL";
      if (sessions.some((s) => s.issueUrl === url && !s.completedAt)) {
        return "Already running for this issue";
      }
      const derivedName = `issue-${m[1]}`;
      if (branches.some((b) => !b.isTrunk && b.name === derivedName)) {
        return `Branch "${derivedName}" already exists`;
      }
      return null;
    }
    if (verb === "/linear") {
      const url = parts[1];
      if (!url) return "Usage: /linear <url>";
      const m = url.match(/linear\.app\/[^/]+\/issue\/([A-Za-z]+-\d+)/);
      if (!m) return "Not a Linear issue URL";
      if (sessions.some((s) => s.linearUrl === url && !s.completedAt)) {
        return "Already running for this ticket";
      }
      const derivedName = m[1].toLowerCase();
      if (branches.some((b) => !b.isTrunk && b.name === derivedName)) {
        return `Branch "${derivedName}" already exists`;
      }
      return null;
    }
    return null;
  }

  async function onRunCommand() {
    const text = commandText.trim();
    if (!text || commandBusy) return;

    // Only slash commands allowed
    if (!text.startsWith("/")) {
      toaster.create({ type: "error", title: "Type / for commands", duration: 3000 });
      return;
    }

    // Slash command → validate + dispatch to backend
    const error = validateCommand(text);
    if (error) {
      toaster.create({ type: "error", title: error, duration: 4000 });
      return;
    }
    setCommandBusy(true);
    try {
      const result = await api.command(text);
      setCommandText("");
      await refresh();
      api.sessions().then((r) => setSessions(r.sessions)).catch(() => {});
      // Auto-open the newly created chat
      if (result.branch) {
        setTerminalPanel({ branch: result.branch, kind: "claude" });
      }
    } catch (err: any) {
      toaster.create({ type: "error", title: err?.message ?? "Command failed", duration: 6000 });
    } finally {
      setCommandBusy(false);
    }
  }

  async function onDelete(b: Branch) {
    if (!confirm(`Delete branch "${b.name}"? Worktree will be removed.`)) return;
    if (terminalPanel && terminalPanel.branch.id === b.id) {
      closeTerminal();
    }
    await withPending(b.id, "deleting", async () => {
      await api.remove(b.id);
      await refresh();
    });
  }

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
      // Hide archived rows — once the branch is gone, the task is gone too.
      .filter((t) => !!t.branch);
    // Deduplicate by branch name — sessions are sorted newest-first from the
    // backend, so the first match for each branch is the most recent session.
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
  const tasks: Task[] = trunk ? [{ branch: trunk }, ...sessionTasks] : sessionTasks;

  const showLeft = !isMobile;
  const showRight = true;

  function renderInputCard() {
    if (!activeRepoId) return null;
    return (
      <Box w="100%">
        <Box
          position="relative"
          borderWidth={1}
          borderColor={commandInputFocused ? "blue.500" : "gray.700"}
          borderRadius="lg"
          bg="gray.900"
          transition="border-color 120ms"
        >
          {commandMenuItems.length > 0 && (
            <Box
              position="absolute"
              left={0}
              right={0}
              bottom="100%"
              mb={3}
              borderWidth={1}
              borderColor="gray.700"
              borderRadius="md"
              bg="gray.900"
              boxShadow="lg"
              overflow="hidden"
              zIndex={10}
            >
              {commandMenuItems.map((item, i) => (
                <Box
                  key={item.prefix}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickCommand(item.prefix);
                  }}
                  onMouseEnter={() => setCommandMenuIndex(i)}
                  px={3}
                  py={2}
                  cursor="pointer"
                  bg={i === clampedMenuIndex ? "gray.800" : undefined}
                >
                  <HStack gap={2} justify="space-between">
                    <Code fontSize="xs" colorPalette="gray">
                      {item.usage}
                    </Code>
                    <Text fontSize="xs" color="gray.500">
                      {item.desc}
                    </Text>
                  </HStack>
                </Box>
              ))}
            </Box>
          )}
          <Input
            ref={commandInputRef}
            fontFamily="mono"
            placeholder="Type / for commands"
            value={commandText}
            onFocus={() => setCommandInputFocused(true)}
            onBlur={() => setCommandInputFocused(false)}
            onChange={(e) => {
              setCommandText(e.target.value);
              setCommandMenuIndex(0);
            }}
            onKeyDown={(e) => {
              if (commandMenuItems.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCommandMenuIndex((i) => (i + 1) % commandMenuItems.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCommandMenuIndex(
                    (i) => (i - 1 + commandMenuItems.length) % commandMenuItems.length
                  );
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickCommand(commandMenuItems[clampedMenuIndex].prefix);
                  return;
                }
              }
              if (e.key === "Enter") onRunCommand();
            }}
            disabled={commandBusy}
            border="none"
            outline="none"
            _focus={{ boxShadow: "none", outline: "none", borderColor: "transparent" }}
            _focusVisible={{ boxShadow: "none", outline: "none" }}
            px={4}
            pt={4}
            pb={2}
            fontSize="sm"
          />
          <HStack gap={3} px={3} pb={3} justify="flex-end">
            <Tooltip.Root openDelay={300}>
              <Tooltip.Trigger asChild>
                <Button
                  aria-label="Send"
                  size="sm"
                  colorPalette="blue"
                  borderRadius="full"
                  onClick={onRunCommand}
                  loading={commandBusy}
                  disabled={!commandText.trim()}
                  flexShrink={0}
                  px={2}
                >
                  <SendIcon />
                </Button>
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content>Send (Enter)</Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
          </HStack>
        </Box>
        {!terminalPanel && (
          <HStack gap={3} mt={6} justify="center" flexWrap="wrap">
            {[
              { label: "/gh-issue", prefix: "/gh-issue " },
              { label: "/linear", prefix: "/linear " },
              { label: "/branch", prefix: "/branch " },
            ].map((cmd) => (
              <Button
                key={cmd.label}
                size="sm"
                variant="outline"
                borderRadius="full"
                fontSize="xs"
                onClick={() => {
                  setCommandText(cmd.prefix);
                  commandInputRef.current?.focus();
                }}
              >
                {cmd.label}
              </Button>
            ))}
          </HStack>
        )}
      </Box>
    );
  }

  function onSelectTask(b: Branch) {
    // Open the terminal immediately so the user sees the status bar
    // ("Starting sandbox…", "Sandbox stopped", etc.) without waiting.
    openBranchTerminal(b);
    const needsStart = !b.isTrunk && (b.status === "stopped" || b.status === "error");
    if (needsStart) {
      // Fire-and-forget — the terminal auto-reconnects via the 2s
      // WebSocket retry loop once the sandbox reaches "running".
      withPending(b.id, "starting", async () => {
        await api.toggle(b.id);
        await refresh();
      });
    }
  }

  function openBranchTerminal(b: Branch) {
    if (terminalPanel && terminalPanel.branch.id === b.id) return;
    setTerminalPanel({ branch: b, kind: "claude" });
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


  const COMMAND_MENU: { usage: string; prefix: string; desc: string }[] = [
    { usage: "/branch <name> [base]", prefix: "/branch ", desc: "start a blank sandbox" },
    { usage: "/gh-issue <url>", prefix: "/gh-issue ", desc: "Claude implements a GitHub issue" },
    { usage: "/linear <url>", prefix: "/linear ", desc: "Claude implements a Linear issue" },
  ];
  const commandMenuOpen =
    commandInputFocused && commandText.startsWith("/") && !commandText.includes(" ");
  const commandMenuItems = commandMenuOpen
    ? COMMAND_MENU.filter((c) => c.prefix.trim().startsWith(commandText))
    : [];
  const clampedMenuIndex =
    commandMenuItems.length === 0
      ? 0
      : Math.min(commandMenuIndex, commandMenuItems.length - 1);

  function pickCommand(prefix: string) {
    setCommandText(prefix);
    setCommandMenuIndex(0);
  }

  return (
    <Flex w="100vw" h="100vh" overflow="hidden" direction="row">
      <Flex
        direction="column"
        w={isMobile ? "100%" : sidebarCollapsed ? "0px" : `${SIDEBAR_WIDTH}px`}
        minW={isMobile ? 0 : sidebarCollapsed ? 0 : `${SIDEBAR_WIDTH}px`}
        h="100%"
        overflow="hidden"
        whiteSpace="nowrap"
        display={showLeft ? "flex" : "none"}
        flexShrink={0}
        borderRightWidth={sidebarCollapsed ? 0 : 1}
        borderColor="gray.800"
        transition={sidebarAnimated ? "width 200ms ease, min-width 200ms ease" : "none"}
      >
        <Flex
          px={3}
          h="48px"
          align="center"
          gap={2}
          flexShrink={0}
        >
          <Button
            aria-label="Toggle sidebar"
            variant="ghost"
            size="xs"
            px={1}
            onClick={() => { setSidebarAnimated(true); setSidebarCollapsed((v) => !v); }}
          >
            <SidebarIcon />
          </Button>
        </Flex>

        <Box ref={taskListRef} flex="1" overflowY="auto" px={2} py={2}>
          {/* + New chat */}
          <Box
            px={3}
            py={2}
            borderRadius="md"
            cursor="pointer"
            _hover={{ bg: "gray.800" }}
            onClick={() => {
              setTerminalPanel(null);
              setTimeout(() => commandInputRef.current?.focus(), 100);
            }}
            mb={1}
          >
            <HStack gap={2}>
              <NewChatIcon />
              <Text fontFamily="mono" fontSize="sm" flex="1">New chat</Text>
              <Badge colorPalette="gray" variant="subtle" fontSize="2xs">⌘P</Badge>
            </HStack>
          </Box>

          {!branchesLoaded ? (
            <HStack justify="center" gap={3} py={10} color="gray.500">
              <Spinner size="sm" />
              <Text>Loading…</Text>
            </HStack>
          ) : (
            <>
              {/* Trunk */}
              {trunk && (
                <Box
                  px={3}
                  py={2}
                  borderRadius="md"
                  cursor="pointer"
                  bg={terminalPanel?.branch.id === trunk.id ? "gray.800" : undefined}
                  _hover={{ bg: "gray.800" }}
                  onClick={() => onSelectTask(trunk)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, branch: trunk });
                  }}
                  mb={2}
                >
                  <HStack gap={2}>
                    <DashboardIcon />
                    <Text fontFamily="mono" fontSize="sm" flex="1" truncate>Dashboard</Text>
                    <Badge colorPalette="gray" variant="subtle" fontSize="2xs">{trunk.name}</Badge>
                  </HStack>
                </Box>
              )}

              {/* Chats */}
              {sessionTasks.length > 0 && (
                <Text fontSize="xs" fontWeight="semibold" color="gray.500" px={3} pt={2} pb={1}>
                  Chats
                </Text>
              )}
              <Stack gap={0}>
                {sessionTasks.map((t) => (
                <TaskRow
                  key={t.session?.id ?? t.branch?.id ?? "task"}
                  task={t}
                  isSelected={!!t.branch && terminalPanel?.branch.id === t.branch.id}
                  pending={t.branch ? pending[t.branch.id] : undefined}
                  onSelect={() => t.branch && onSelectTask(t.branch)}
                  onContextMenu={(e, branch) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, branch, session: t.session });
                  }}
                />
              ))}
              </Stack>
            </>
          )}
        </Box>

        <Flex px={2} py={2} flexShrink={0}>
          <Box w="100%">
            <RepoSwitcher
              repos={repos}
              activeRepoId={activeRepoId}
              onChanged={async () => {
                setBranchesLoaded(false);
                setBranches([]);
                await refreshRepos();
                await refresh();
              }}
              onSettings={settingsDisclosure.onOpen}
            />
          </Box>
        </Flex>

      </Flex>

      <Flex
        direction="column"
        flex="1"
        minW={0}
        overflow="hidden"
        display={showRight ? "flex" : "none"}
        bg="#000"
        position="relative"
      >
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
              onClose={closeTerminal}
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
            <Flex direction="column" h="100%">
              {/* Header */}
              <Flex h="48px" px={3} align="center" flexShrink={0} gap={2}>
                {(isMobile || sidebarCollapsed) && (
                  <Box
                    position="relative"
                    onMouseEnter={() => { if (!isMobile) setSidebarHover(true); }}
                    onMouseLeave={() => { if (!isMobile) setSidebarHover(false); }}
                  >
                    <Button
                      aria-label="Toggle sidebar"
                      variant="ghost"
                      size="xs"
                      px={1}
                      onClick={() => {
                        if (isMobile) {
                          setMobileMenuOpen((v) => !v);
                        } else {
                          setSidebarCollapsed(false);
                        }
                      }}
                    >
                      <SidebarIcon />
                    </Button>
                    {sidebarHover && (
                      <>
                      {/* Bridge element to prevent hover loss between button and dropdown */}
                      <Box position="absolute" top="100%" left={0} w="100%" h="8px" />
                      <Box
                        position="absolute"
                        top="100%"
                        left={0}
                        mt={1}
                        w={`${SIDEBAR_WIDTH}px`}
                        maxH="400px"
                        overflowY="auto"
                        bg="gray.900"
                        borderWidth={1}
                        borderColor="gray.700"
                        borderRadius="md"
                        boxShadow="lg"
                        p={3}
                        zIndex={30}
                      >
                        {/* New chat */}
                        <Box
                          px={3}
                          py={2}
                          borderRadius="md"
                          cursor="pointer"
                          _hover={{ bg: "gray.800" }}
                          onClick={() => {
                            setTerminalPanel(null);
                            setSidebarHover(false);
                            setTimeout(() => commandInputRef.current?.focus(), 100);
                          }}
                        >
                          <HStack gap={2}>
                            <NewChatIcon />
                            <Text fontFamily="mono" fontSize="sm" flex="1">New chat</Text>
              <Badge colorPalette="gray" variant="subtle" fontSize="2xs">⌘P</Badge>
                          </HStack>
                        </Box>

                        {/* Trunk */}
                        {trunk && (
                          <Box
                            px={3}
                            py={2}
                            borderRadius="md"
                            cursor="pointer"
                            _hover={{ bg: "gray.800" }}
                            onClick={() => {
                              onSelectTask(trunk);
                              setSidebarHover(false);
                            }}
                          >
                            <HStack gap={2}>
                              <DashboardIcon />
                              <Text fontFamily="mono" fontSize="sm" flex="1" truncate>Dashboard</Text>
                              <Badge colorPalette="gray" variant="subtle" fontSize="2xs">{trunk.name}</Badge>
                            </HStack>
                          </Box>
                        )}

                        {/* Chats */}
                        {sessionTasks.length > 0 && (
                          <Text fontSize="xs" fontWeight="semibold" color="gray.500" pt={2} pb={1} px={3}>Chats</Text>
                        )}
                        <Stack gap={0}>
                          {sessionTasks.map((t: any) => (
                            <Box
                              key={t.session?.id ?? t.branch?.id ?? "t"}
                              px={3}
                              py={2}
                              borderRadius="md"
                              cursor="pointer"
                              _hover={{ bg: "gray.800" }}
                              onClick={() => {
                                if (t.branch) {
                                  onSelectTask(t.branch);
                                  setSidebarHover(false);
                                }
                              }}
                            >
                              <Text fontFamily="mono" fontSize="sm" truncate>
                                {t.branch?.name ?? t.session?.branch ?? "?"}
                              </Text>
                            </Box>
                          ))}
                        </Stack>
                      </Box>
                      </>
                    )}
                  </Box>
                )}
                <Heading size="lg" color="gray.300">Shipyard</Heading>
              </Flex>
              <Flex flex="1" direction="column" align="center" justify="center" px={4} w="100%" maxW="640px" mx="auto">
                <Text fontSize="lg" color="gray.400" mb={6}>
                  What would you like to work on?
                </Text>
                {/* Inline input card for welcome view */}
                {renderInputCard()}
              </Flex>
            </Flex>
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
            {/* New chat */}
            <Box
              px={3}
              py={2}
              borderRadius="md"
              cursor="pointer"
              _hover={{ bg: "gray.800" }}
              onClick={() => {
                setTerminalPanel(null);
                setMobileMenuOpen(false);
                setTimeout(() => commandInputRef.current?.focus(), 100);
              }}
            >
              <HStack gap={2}>
                <NewChatIcon />
                <Text fontFamily="mono" fontSize="sm" flex="1">New chat</Text>
                <Badge colorPalette="gray" variant="subtle" fontSize="2xs">⌘P</Badge>
              </HStack>
            </Box>

            {/* Trunk */}
            {trunk && (
              <Box
                px={3}
                py={2}
                borderRadius="md"
                cursor="pointer"
                bg={terminalPanel?.branch.id === trunk.id ? "gray.800" : undefined}
                _hover={{ bg: "gray.800" }}
                onClick={() => {
                  onSelectTask(trunk);
                  setMobileMenuOpen(false);
                }}
              >
                <HStack gap={2}>
                  <DashboardIcon />
                  <Text fontFamily="mono" fontSize="sm" flex="1" truncate>Dashboard</Text>
                  <Badge colorPalette="gray" variant="subtle" fontSize="2xs">{trunk.name}</Badge>
                </HStack>
              </Box>
            )}

            {/* Chats */}
            {sessionTasks.length > 0 && (
              <Text fontSize="xs" fontWeight="semibold" color="gray.500" pt={2} pb={1} px={3}>Chats</Text>
            )}
            <Stack gap={0}>
              {sessionTasks.map((t: any) => (
                <Box
                  key={t.session?.id ?? t.branch?.id ?? "t"}
                  px={3}
                  py={2}
                  borderRadius="md"
                  cursor="pointer"
                  bg={t.branch && terminalPanel?.branch.id === t.branch.id ? "gray.800" : undefined}
                  _hover={{ bg: "gray.800" }}
                  onClick={() => {
                    if (t.branch) {
                      onSelectTask(t.branch);
                      setMobileMenuOpen(false);
                    }
                  }}
                >
                  <Text fontFamily="mono" fontSize="sm" truncate>
                    {t.branch?.name ?? t.session?.branch ?? "?"}
                  </Text>
                </Box>
              ))}
            </Stack>
          </Box>
        </Portal>
      )}

      {ctxMenu && (
        <Portal>
          <Box
            position="fixed"
            left={`${ctxMenu.x}px`}
            top={`${ctxMenu.y}px`}
            zIndex={1000}
            bg="gray.900"
            borderWidth={1}
            borderColor="gray.700"
            borderRadius="md"
            boxShadow="lg"
            minW="160px"
            py={1}
          >
            {/* Clipboard group */}
            <Button
              w="100%"
              size="sm"
              variant="ghost"
              justifyContent="flex-start"
              borderRadius={0}
              _hover={{ bg: "gray.800" }}
              onClick={async () => {
                const b = ctxMenu.branch;
                setCtxMenu(null);
                try {
                  await navigator.clipboard.writeText(b.name);
                  toaster.create({ type: "info", title: "Copied", duration: 1500 });
                } catch {}
              }}
            >
              Copy name
            </Button>

            {/* External links group */}
            {(ctxMenu.session?.issueUrl || ctxMenu.session?.linearUrl) && (
              <Box borderTopWidth={1} borderColor="gray.800" my={1} />
            )}
            {ctxMenu.session?.issueUrl && (
              <Button
                w="100%"
                size="sm"
                variant="ghost"
                justifyContent="flex-start"
                borderRadius={0}
                _hover={{ bg: "gray.800" }}
                onClick={() => {
                  const url = ctxMenu.session?.issueUrl;
                  setCtxMenu(null);
                  if (url) window.open(url, "_blank");
                }}
              >
                Open issue
              </Button>
            )}
            {ctxMenu.session?.linearUrl && (
              <Button
                w="100%"
                size="sm"
                variant="ghost"
                justifyContent="flex-start"
                borderRadius={0}
                _hover={{ bg: "gray.800" }}
                onClick={() => {
                  const url = ctxMenu.session?.linearUrl;
                  setCtxMenu(null);
                  if (url) window.open(url, "_blank");
                }}
              >
                Open in Linear
              </Button>
            )}

            {/* Branch actions group */}
            <Box borderTopWidth={1} borderColor="gray.800" my={1} />
            <Button
              w="100%"
              size="sm"
              variant="ghost"
              justifyContent="flex-start"
              borderRadius={0}
              _hover={{ bg: "gray.800" }}
              disabled={ctxMenu.branch.status !== "running"}
              onClick={() => {
                const b = ctxMenu.branch;
                setCtxMenu(null);
                onPreview(b);
              }}
            >
              Preview
            </Button>
            {!ctxMenu.branch.isTrunk && (
              <Button
                w="100%"
                size="sm"
                variant="ghost"
                justifyContent="flex-start"
                borderRadius={0}
                _hover={{ bg: "gray.800" }}
                disabled={!ctxMenu.branch.worktreePath}
                onClick={() => {
                  const b = ctxMenu.branch;
                  setCtxMenu(null);
                  onPushAndPR(b);
                }}
              >
                Push & PR
              </Button>
            )}
            <Button
              w="100%"
              size="sm"
              variant="ghost"
              justifyContent="flex-start"
              borderRadius={0}
              _hover={{ bg: "gray.800" }}
              disabled={!ctxMenu.branch.worktreePath}
              onClick={() => {
                const b = ctxMenu.branch;
                setCtxMenu(null);
                onOpenEditor(b);
              }}
            >
              Open in editor
            </Button>

            {/* Reload group */}
            {!ctxMenu.branch.isTrunk && (
              <>
                <Box borderTopWidth={1} borderColor="gray.800" my={1} />
                <Button
                  w="100%"
                  size="sm"
                  variant="ghost"
                  justifyContent="flex-start"
                  borderRadius={0}
                  _hover={{ bg: "gray.800" }}
                  onClick={() => {
                    const b = ctxMenu.branch;
                    setCtxMenu(null);
                    onRefreshSandbox(b);
                  }}
                >
                  Reload
                </Button>
                <Button
                  w="100%"
                  size="sm"
                  variant="ghost"
                  justifyContent="flex-start"
                  borderRadius={0}
                  _hover={{ bg: "gray.800" }}
                  onClick={() => {
                    const b = ctxMenu.branch;
                    setCtxMenu(null);
                    onRefreshSandbox(b, true);
                  }}
                >
                  Hard Reload
                </Button>
              </>
            )}

            {/* Destructive group */}
            {!ctxMenu.branch.isTrunk && (
              <>
                <Button
                  w="100%"
                  size="sm"
                  variant="ghost"
                  colorPalette="red"
                  justifyContent="flex-start"
                  borderRadius={0}
                  _hover={{ bg: "red.900" }}
                  onClick={() => {
                    const b = ctxMenu.branch;
                    setCtxMenu(null);
                    onDelete(b);
                  }}
                >
                  Delete
                </Button>
              </>
            )}
          </Box>
        </Portal>
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

function DashboardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M15.673 3.913a3.121 3.121 0 1 1 4.414 4.414l-5.937 5.937a5 5 0 0 1-2.828 1.415l-2.18.31a1 1 0 0 1-1.132-1.132l.31-2.18a5 5 0 0 1 1.415-2.828l5.938-5.936zM17.087 5.327a1.121 1.121 0 0 0-1.586 0L9.564 11.264a3 3 0 0 0-.849 1.697l-.123.86.86-.122a3 3 0 0 0 1.697-.849l5.938-5.937a1.121 1.121 0 0 0 0-1.586zM11 4A1 1 0 0 1 10 5c-.998 0-1.702.008-2.253.06-.54.052-.862.141-1.109.267a3 3 0 0 0-1.311 1.311c-.126.247-.215.569-.266 1.109C5.008 8.298 5 9.002 5 10v4c0 .998.008 1.702.06 2.253.051.54.14.862.266 1.109a3 3 0 0 0 1.311 1.311c.247.126.569.215 1.109.266C8.298 18.992 9.002 19 10 19h4c.998 0 1.702-.008 2.253-.06.54-.051.862-.14 1.109-.266a3 3 0 0 0 1.311-1.311c.126-.247.215-.569.266-1.109.053-.551.06-1.255.06-2.253a1 1 0 1 1 2 0v.056c0 .925 0 1.716-.06 2.356-.065.659-.2 1.243-.544 1.767a5 5 0 0 1-2.185 2.185c-.524.344-1.108.48-1.767.544-.64.06-1.431.06-2.356.06h-4.112c-.925 0-1.716 0-2.356-.06-.659-.064-1.243-.2-1.767-.544a5 5 0 0 1-2.185-2.185c-.344-.524-.48-1.108-.544-1.767C2 17.773 2 16.982 2 16.056v-4.112c0-.925 0-1.716.06-2.356.065-.659.2-1.243.544-1.767a5 5 0 0 1 2.185-2.185c.524-.344 1.108-.48 1.767-.544C7.216 5.032 8.007 5.031 8.932 5.031L10 5a1 1 0 0 1 1-1z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

interface Task {
  session?: Session;
  branch?: Branch;
}


interface TaskRowProps {
  task: Task;
  isSelected: boolean;
  pending?: string;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent, branch: Branch) => void;
}

function TaskRow({ task, isSelected, pending, onSelect, onContextMenu }: TaskRowProps) {
  const { session: s, branch: b } = task;
  const archived = !b;
  const deleting = pending === "deleting";
  const name = b?.name ?? s?.branch ?? "(unknown)";

  return (
    <Box
      role="button"
      tabIndex={archived || deleting ? -1 : 0}
      aria-disabled={archived || deleting}
      onClick={archived || deleting ? undefined : onSelect}
      onKeyDown={(e) => {
        if (archived || deleting) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onContextMenu={(e) => {
        if (!b || deleting) return;
        onContextMenu(e, b);
      }}
      cursor={archived || deleting ? "default" : "pointer"}
      bg={isSelected ? "gray.800" : undefined}
      opacity={deleting ? 0.4 : archived ? 0.6 : 1}
      borderRadius="md"
      px={3}
      py={2}
      textAlign="left"
      w="100%"
      _hover={{ bg: deleting ? undefined : "gray.800" }}
      _focusVisible={{
        outline: "none",
        borderColor: "blue.400",
        boxShadow: "0 0 0 1px var(--chakra-colors-blue-400)",
      }}
      transition="border-color 120ms, background 120ms, opacity 120ms"
    >
      <Flex align="center" gap={2} minW={0}>
        <Text
          fontFamily="mono"
          fontSize="sm"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          flex="1"
          minW={0}
        >
          {name}
        </Text>
        {deleting ? (
          <HStack gap={1} flexShrink={0}>
            <Spinner size="xs" />
            <Text fontSize="2xs" color="gray.500">deleting…</Text>
          </HStack>
        ) : (
          b?.isTrunk && (
            <Badge colorPalette="purple" variant="subtle" fontSize="2xs" flexShrink={0}>
              Dashboard
            </Badge>
          )
        )}
      </Flex>
    </Box>
  );
}
