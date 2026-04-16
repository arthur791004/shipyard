import { useEffect, useState, useCallback } from "react";
import { flushSync } from "react-dom";
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
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
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

  // Resizable left column — persisted width, clamped to [280, 720].
  const LEFT_WIDTH_KEY = "calypso.leftWidth";
  const LEFT_WIDTH_MIN = 280;
  const LEFT_WIDTH_MAX = 720;
  const LEFT_WIDTH_DEFAULT = 440;
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(LEFT_WIDTH_KEY);
      if (!raw) return LEFT_WIDTH_DEFAULT;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return LEFT_WIDTH_DEFAULT;
      return Math.min(LEFT_WIDTH_MAX, Math.max(LEFT_WIDTH_MIN, n));
    } catch {
      return LEFT_WIDTH_DEFAULT;
    }
  });
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const next = Math.min(LEFT_WIDTH_MAX, Math.max(LEFT_WIDTH_MIN, e.clientX));
      setLeftWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      try {
        localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth));
      } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing, leftWidth]);

  function closeTerminal() {
    setTerminalFullscreen(false);
    setTerminalPanel(null);
  }

  function toggleFullscreen() {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (doc.startViewTransition) {
      doc.startViewTransition(() => {
        flushSync(() => setTerminalFullscreen((v) => !v));
      });
    } else {
      setTerminalFullscreen((v) => !v);
    }
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


  function validateCommand(text: string): string | null {
    if (!text.startsWith("/")) return "Commands must start with /";
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
    const error = validateCommand(text);
    if (error) {
      toaster.create({ type: "error", title: error, duration: 4000 });
      return;
    }
    setCommandBusy(true);
    try {
      await api.command(text);
      setCommandText("");
      await refresh();
      api.sessions().then((r) => setSessions(r.sessions)).catch(() => {});
    } catch (err: any) {
      toaster.create({ type: "error", title: err?.message ?? "Command failed", duration: 6000 });
    } finally {
      setCommandBusy(false);
    }
  }

  async function onDelete(b: Branch) {
    if (!confirm(`Delete branch "${b.name}"? Worktree will be removed.`)) return;
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

  // Backend cap counts only sandbox VMs; trunk runs as a dashboard process and
  // isn't a sandbox. Display-side we add 1 so the user sees trunk included in
  // the totals.
  const sandboxCap = settings?.maxConcurrentSandboxes ?? 9;
  const cap = sandboxCap + 1;
  const runningCount = branches.filter((b) => b.status === "running").length;
  const runningSandboxCount = branches.filter((b) => !b.isTrunk && b.status === "running").length;
  const atCap = runningSandboxCount >= sandboxCap;
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

  const showLeft = !isMobile || !terminalPanel;
  const showRight = !isMobile || !!terminalPanel;

  async function onSelectTask(b: Branch) {
    const needsStart = !b.isTrunk && (b.status === "stopped" || b.status === "error");
    if (needsStart) {
      await withPending(b.id, "starting", async () => {
        await api.toggle(b.id);
        await refresh();
      });
    }
    openBranchTerminal(b);
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
        w={isMobile ? "100%" : `${leftWidth}px`}
        minW={isMobile ? 0 : `${leftWidth}px`}
        h="100%"
        overflow="hidden"
        display={showLeft ? "flex" : "none"}
        flexShrink={0}
      >
        <Flex
          px={4}
          h="64px"
          borderBottomWidth={1}
          borderColor="gray.800"
          align="center"
          gap={3}
          overflow="hidden"
          flexShrink={0}
        >
          <Heading size="sm" truncate flex="1" minW={0}>
            Calypso Multi-Agent
          </Heading>
          <Box flexShrink={0}>
            <RepoSwitcher
              repos={repos}
              activeRepoId={activeRepoId}
              onChanged={async () => {
                setBranchesLoaded(false);
                setBranches([]);
                await refreshRepos();
                await refresh();
              }}
            />
          </Box>
          <Tooltip.Root openDelay={300}>
            <Tooltip.Trigger asChild>
              <Button
                aria-label="Settings"
                variant="ghost"
                size="xs"
                px={1}
                flexShrink={0}
                onClick={settingsDisclosure.onOpen}
              >
                <GearIcon />
              </Button>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content>Settings</Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        </Flex>

        <Box flex="1" overflowY="auto" px={4} py={3}>
          {!branchesLoaded ? (
            <HStack justify="center" gap={3} py={10} color="gray.500">
              <Spinner size="sm" />
              <Text>Loading…</Text>
            </HStack>
          ) : tasks.length === 0 ? (
            <Box p={6} textAlign="center" color="gray.400" borderWidth={1} borderColor="gray.700" borderRadius="md">
              No tasks yet. Use <Code fontSize="xs">/issue</Code> or <Code fontSize="xs">/branch</Code> below.
            </Box>
          ) : (
            <Stack gap={2}>
              {tasks.map((t) => (
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
          )}
        </Box>

        <Flex justify="flex-end" px={4} py={1}>
          <Tooltip.Root openDelay={300}>
            <Tooltip.Trigger asChild>
              <Text
                fontSize="2xs"
                color={runningCount >= cap ? "orange.400" : "gray.600"}
                fontVariantNumeric="tabular-nums"
              >
                {runningCount}/{cap} running
              </Text>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content>Running sandboxes / concurrency cap</Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        </Flex>

        {activeRepoId && (
          <Box px={4} py={3} borderTopWidth={1} borderColor="gray.800">
            <Stack gap={2}>
              <Box position="relative">
                {commandMenuItems.length > 0 && (
                  <Box
                    position="absolute"
                    left={0}
                    right={0}
                    bottom="100%"
                    mb={1}
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
                <HStack gap={2}>
                  <Input
                    size="sm"
                    fontFamily="mono"
                    placeholder={atCap ? "At sandbox cap — stop one to run more" : "Type / for commands"}
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
                    disabled={commandBusy || atCap}
                  />
                  <Button
                    size="sm"
                    colorPalette="blue"
                    onClick={onRunCommand}
                    loading={commandBusy}
                    disabled={!commandText.trim() || atCap}
                    flexShrink={0}
                  >
                    Run
                  </Button>
                </HStack>
              </Box>
            </Stack>
          </Box>
        )}
      </Flex>

      {!isMobile && showLeft && showRight && (
        <Box
          position="relative"
          w="6px"
          ml="-1px"
          flexShrink={0}
          cursor="col-resize"
          onMouseDown={(e) => {
            e.preventDefault();
            setResizing(true);
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize task list"
          css={{
            "&::before": {
              content: '""',
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "50%",
              width: "1px",
              transform: "translateX(-50%)",
              background: resizing ? "var(--chakra-colors-blue-400)" : "var(--chakra-colors-gray-700)",
              transition: "background 120ms, width 120ms",
            },
            "&:hover::before": {
              width: "2px",
              background: "var(--chakra-colors-blue-400)",
            },
          }}
        />
      )}

      <Box
        flex="1"
        minW={0}
        overflow="hidden"
        display={showRight ? "block" : "none"}
        position={terminalFullscreen ? "fixed" : undefined}
        inset={terminalFullscreen ? 0 : undefined}
        zIndex={terminalFullscreen ? 100 : undefined}
        bg="gray.950"
        css={{ viewTransitionName: "terminal-pane" }}
      >
        {terminalPanel ? (
          <TerminalModal
            key={`${terminalPanel.branch.id}:${terminalPanel.kind}`}
            branch={terminalPanel.branch}
            kind={terminalPanel.kind}
            fullscreen={terminalFullscreen}
            isMobile={isMobile}
            onFullscreenToggle={toggleFullscreen}
            onKindChange={(kind) =>
              setTerminalPanel((prev) => (prev ? { ...prev, kind } : prev))
            }
            onClose={closeTerminal}
            onPreview={onPreview}
            onOpenEditor={onOpenEditor}
          />
        ) : (
          <Flex h="100%" align="center" justify="center" color="gray.600" textAlign="center" px={8}>
            <Stack gap={2} align="center">
              <Text fontSize="sm">Select a branch on the left to see its terminal.</Text>
              <Text fontSize="xs">Or run /gh-issue, /linear, /branch below.</Text>
            </Stack>
          </Flex>
        )}
      </Box>

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

            {/* Destructive group */}
            {!ctxMenu.branch.isTrunk && (
              <>
                <Box borderTopWidth={1} borderColor="gray.800" my={1} />
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
      borderWidth={1}
      borderColor={isSelected ? "blue.500" : "gray.700"}
      bg={isSelected ? "gray.800" : undefined}
      opacity={deleting ? 0.4 : archived ? 0.6 : 1}
      borderRadius="md"
      px={4}
      py={4}
      textAlign="left"
      w="100%"
      _hover={{ borderColor: deleting ? "gray.700" : archived ? "gray.700" : isSelected ? "blue.400" : "gray.500" }}
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
          fontWeight="semibold"
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
