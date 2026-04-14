import { useEffect, useState, useCallback } from "react";
import { flushSync } from "react-dom";
import {
  Badge,
  Box,
  Button,
  Code,
  Dialog,
  Field,
  Flex,
  HStack,
  Heading,
  Input,
  NativeSelect,
  Portal,
  Spinner,
  Stack,
  Table,
  Text,
  Tooltip,
  useClipboard,
  useDisclosure,
} from "@chakra-ui/react";
import { api, Branch, Repo, Settings } from "./api";
import { SettingsModal } from "./SettingsModal";
import { TerminalModal, TerminalKind } from "./TerminalModal";
import { RepoSwitcher } from "./RepoSwitcher";
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
  const createDisclosure = useDisclosure();
  const [submittingCreate, setSubmittingCreate] = useState(false);
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("trunk");
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [terminalPanel, setTerminalPanel] = useState<{ branch: Branch; kind: TerminalKind } | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [panelAnimating, setPanelAnimating] = useState(false);
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

  useEffect(() => {
    if (terminalPanel) {
      const id = requestAnimationFrame(() => setTerminalOpen(true));
      return () => cancelAnimationFrame(id);
    }
  }, [terminalPanel]);

  useEffect(() => {
    if (!createDisclosure.open) return;
    api.gitBranches().then((res) => setGitBranches(res.branches)).catch(() => {});
  }, [createDisclosure.open]);

  useEffect(() => {
    setPanelAnimating(true);
    const t = window.setTimeout(() => setPanelAnimating(false), 260);
    return () => window.clearTimeout(t);
  }, [terminalOpen, terminalFullscreen]);

  function closeTerminal() {
    setTerminalOpen(false);
    setTerminalFullscreen(false);
    window.setTimeout(() => setTerminalPanel(null), 220);
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

  async function onCreate() {
    if (!name.trim() || submittingCreate) return;
    setSubmittingCreate(true);
    try {
      await api.create({ name: name.trim(), base: baseBranch });
      setName("");
      createDisclosure.onClose();
      await refresh();
    } catch (err: any) {
      toaster.create({ type: "error", title: err?.message ?? "Create failed", duration: 6000 });
    } finally {
      setSubmittingCreate(false);
    }
  }

  async function onToggle(b: Branch) {
    await withPending(b.id, b.status === "running" ? "stopping" : "starting", async () => {
      await api.toggle(b.id);
      await refresh();
    });
  }

  async function onPreview(b: Branch) {
    await withPending(b.id, "preview", async () => {
      await api.switch(b.id);
      setActiveId(b.id);
      await api.startDashboard(b.id);
      window.open("http://my.localhost:3000", "_blank");
    });
  }

  async function onOpenEditor(b: Branch) {
    await withPending(b.id, "editor", async () => {
      await api.openEditor(b.id);
    });
  }

  const trimmedName = name.trim();
  const existingNames = new Set<string>([
    ...branches.filter((b) => !b.isTrunk).map((b) => b.name),
    ...gitBranches,
  ]);
  const nameCollides = !!trimmedName && existingNames.has(trimmedName);

  const [remoteExists, setRemoteExists] = useState(false);
  const [checkingRemote, setCheckingRemote] = useState(false);
  useEffect(() => {
    if (!createDisclosure.open || !trimmedName || nameCollides) {
      setRemoteExists(false);
      setCheckingRemote(false);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setCheckingRemote(true);
      try {
        const res = await api.remoteBranchExists(trimmedName);
        if (!cancelled) setRemoteExists(res.exists);
      } catch {
        if (!cancelled) setRemoteExists(false);
      } finally {
        if (!cancelled) setCheckingRemote(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmedName, nameCollides, createDisclosure.open]);

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

  return (
    <Flex w="100vw" h="100vh" overflow="hidden" direction="row">
      <Box
        flex={terminalOpen ? "1 1 50%" : "1 1 auto"}
        minW={0}
        maxW={terminalOpen ? "none" : "1100px"}
        mx={terminalOpen ? 0 : "auto"}
        px={6}
        py={6}
        w="100%"
        overflowX={panelAnimating ? "hidden" : "auto"}
        overflowY={panelAnimating ? "hidden" : "auto"}
        transition="flex-basis 260ms ease"
      >
        <Flex
          justify="space-between"
          align="center"
          mb={5}
          gap={4}
          flexWrap="nowrap"
          minH="40px"
          overflow="hidden"
        >
          <HStack gap={3} minW={0} flexShrink={1}>
            <Heading size="md" flexShrink={0} whiteSpace="nowrap">
              Calypso Multi-Agent
            </Heading>
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
          </HStack>
          <HStack gap={2} flexShrink={0} flexWrap="nowrap">
            <Button
              colorPalette="blue"
              size="sm"
              disabled={!activeRepoId}
              onClick={createDisclosure.onOpen}
            >
              Add branch
            </Button>
            <Button variant="outline" size="sm" onClick={settingsDisclosure.onOpen}>
              Settings
            </Button>
          </HStack>
        </Flex>

        {!branchesLoaded ? (
          <Box
            p={10}
            textAlign="center"
            color="gray.500"
            borderWidth={1}
            borderColor="gray.700"
            borderRadius="md"
          >
            <HStack justify="center" gap={3}>
              <Spinner size="sm" />
              <Text>Loading branches…</Text>
            </HStack>
          </Box>
        ) : branches.length === 0 ? (
          <Box p={10} textAlign="center" color="gray.400" borderWidth={1} borderColor="gray.700" borderRadius="md">
            No branches yet. Click "Add branch" to start.
          </Box>
        ) : (
          <Box borderWidth={1} borderColor="gray.700" borderRadius="md" overflowX="auto">
            <Table.Root size="sm" variant="line">
              <Table.Header bg="gray.800">
                <Table.Row>
                  <Table.ColumnHeader color="gray.400">Branch</Table.ColumnHeader>
                  <Table.ColumnHeader color="gray.400">Status</Table.ColumnHeader>
                  <Table.ColumnHeader color="gray.400">Tools</Table.ColumnHeader>
                  <Table.ColumnHeader color="gray.400">Lifecycle</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {branches.map((b) => (
                  <BranchRow
                    key={b.id}
                    branch={b}
                    isActive={b.id === activeId}
                    pending={pending[b.id]}
                    openTerminalKind={
                      terminalPanel && terminalPanel.branch.id === b.id ? terminalPanel.kind : undefined
                    }
                    onToggle={onToggle}
                    onPreview={onPreview}
                    onDelete={onDelete}
                    onOpenEditor={onOpenEditor}
                    onOpenTerminal={(kind) => {
                      if (terminalPanel && terminalPanel.branch.id === b.id) {
                        closeTerminal();
                      } else {
                        setTerminalPanel({ branch: b, kind });
                      }
                    }}
                  />
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
      </Box>

      <Box
        flex={terminalOpen ? "1 1 50%" : "0 0 0"}
        minW={0}
        overflow="hidden"
        borderLeftWidth={terminalOpen && !terminalFullscreen ? "1px" : "0"}
        borderColor="gray.700"
        transition="flex-basis 260ms ease, border-left-width 260ms ease"
        position={terminalFullscreen ? "fixed" : undefined}
        inset={terminalFullscreen ? 0 : undefined}
        zIndex={terminalFullscreen ? 100 : undefined}
        css={{ viewTransitionName: "terminal-pane" }}
      >
        {terminalPanel && (
          <TerminalModal
            key={`${terminalPanel.branch.id}:${terminalPanel.kind}`}
            branch={terminalPanel.branch}
            kind={terminalPanel.kind}
            fullscreen={terminalFullscreen}
            onFullscreenToggle={toggleFullscreen}
            onKindChange={(kind) =>
              setTerminalPanel((prev) => (prev ? { ...prev, kind } : prev))
            }
            onClose={closeTerminal}
          />
        )}
      </Box>

      <Dialog.Root
        open={createDisclosure.open}
        onOpenChange={(e) => (e.open ? createDisclosure.onOpen() : createDisclosure.onClose())}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>Add Branch</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <Stack gap={4}>
                  <Field.Root invalid={nameCollides}>
                    <Field.Label fontSize="xs" color="gray.400">Branch name</Field.Label>
                    <Input
                      autoFocus
                      placeholder="e.g. fix/header-bug"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !nameCollides) onCreate();
                      }}
                    />
                    {nameCollides && (
                      <Field.ErrorText fontSize="xs">
                        A branch named <Code>{trimmedName}</Code> already exists.
                      </Field.ErrorText>
                    )}
                  </Field.Root>
                  <Field.Root disabled={remoteExists}>
                    <Field.Label fontSize="xs" color="gray.400">Base branch</Field.Label>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={baseBranch}
                        onChange={(e) => setBaseBranch(e.currentTarget.value)}
                      >
                        {gitBranches.length === 0 && <option value="trunk">trunk</option>}
                        {gitBranches.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </NativeSelect.Field>
                      <NativeSelect.Indicator />
                    </NativeSelect.Root>
                    <Field.HelperText fontSize="xs" color="gray.500">
                      {checkingRemote
                        ? "Checking branch…"
                        : remoteExists
                        ? `"${trimmedName}" already exists on origin — it will be checked out as-is.`
                        : "Base is used only when creating a new branch."}
                    </Field.HelperText>
                  </Field.Root>
                </Stack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack gap={2}>
                  <Button variant="outline" onClick={createDisclosure.onClose} disabled={submittingCreate}>
                    Cancel
                  </Button>
                  <Button
                    colorPalette="blue"
                    onClick={onCreate}
                    loading={submittingCreate}
                    disabled={!trimmedName || nameCollides}
                  >
                    Add
                  </Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <SettingsModal
        open={settingsDisclosure.open}
        activeRepo={repos.find((r) => r.id === activeRepoId) ?? null}
        firstRun={repos.length === 0}
        onClose={settingsDisclosure.onClose}
        onAddRepo={async () => {
          try {
            const picked = await api.pickFolder();
            if (!picked) return;
            await api.addRepo({ linkTarget: picked.path });
            await refreshRepos();
            await refresh();
            settingsDisclosure.onClose();
          } catch (e: any) {
            toaster.create({ type: "error", title: e.message, duration: 6000 });
          }
        }}
        onSaved={async () => {
          await refreshRepos();
        }}
      />
    </Flex>
  );
}

function ExternalIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 17L17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

interface BranchRowProps {
  branch: Branch;
  isActive: boolean;
  pending?: string;
  openTerminalKind?: TerminalKind;
  onToggle: (b: Branch) => void;
  onPreview: (b: Branch) => void;
  onDelete: (b: Branch) => void;
  onOpenEditor: (b: Branch) => void;
  onOpenTerminal: (kind: TerminalKind) => void;
}

function BranchRow({
  branch: b,
  isActive,
  pending: p,
  openTerminalKind,
  onToggle,
  onPreview,
  onDelete,
  onOpenEditor,
  onOpenTerminal,
}: BranchRowProps) {
  const busy = !!p && p !== "preview";
  const running = b.status === "running";
  const clipboard = useClipboard({ value: b.name });

  const handleCopy = () => {
    clipboard.copy();
    toaster.create({
      type: "info",
      title: "Copied",
      duration: 1500,
    });
  };

  const statusPalette = running
    ? "green"
    : b.status === "error"
    ? "red"
    : b.status === "creating" || b.status === "starting"
    ? "blue"
    : "gray";

  return (
    <Table.Row>
      <Table.Cell>
        <HStack gap={2}>
          <Tooltip.Root openDelay={300}>
            <Tooltip.Trigger asChild>
              <Code
                colorPalette="gray"
                cursor="pointer"
                onClick={handleCopy}
                px={3}
                py={1}
                borderRadius="md"
                borderWidth="1px"
                bg={isActive ? "gray.solid" : undefined}
                color={isActive ? "gray.contrast" : undefined}
                borderColor={isActive ? "gray.solid" : "gray.700"}
                maxW="240px"
                whiteSpace="nowrap"
                overflow="hidden"
                textOverflow="ellipsis"
                display="inline-block"
                _hover={{ bg: isActive ? "gray.solid" : "gray.700", borderColor: isActive ? "gray.solid" : "gray.600" }}
                transition="background 120ms, border-color 120ms"
              >
                {b.name}
              </Code>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content>{b.name}</Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        </HStack>
      </Table.Cell>
      <Table.Cell>
        <Badge colorPalette={statusPalette} textTransform="uppercase">{p || b.status}</Badge>
      </Table.Cell>
      <Table.Cell>
        <HStack gap={2}>
          <Button
            size="xs"
            disabled={busy || !running || (!b.sandboxName && b.id !== "trunk")}
            colorPalette="gray"
            variant={openTerminalKind ? "solid" : "outline"}
            onClick={() => onOpenTerminal("claude")}
          >
            Shell
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !b.worktreePath}
            loading={p === "editor"}
            onClick={() => onOpenEditor(b)}
          >
            Open in Editor <ExternalIcon />
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || b.status !== "running"}
            loading={p === "preview"}
            onClick={() => onPreview(b)}
          >
            Visit <ExternalIcon />
          </Button>
        </HStack>
      </Table.Cell>
      <Table.Cell>
        {b.id !== "trunk" && (
          <HStack gap={2}>
            {running ? (
              <Button size="xs" variant="outline" disabled={busy} loading={p === "stopping"} onClick={() => onToggle(b)}>
                Stop
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={busy || b.status === "creating"}
                loading={p === "starting"}
                onClick={() => onToggle(b)}
              >
                Start
              </Button>
            )}
            <Button size="xs" colorPalette="red" disabled={busy} loading={p === "deleting"} onClick={() => onDelete(b)}>
              Delete
            </Button>
          </HStack>
        )}
      </Table.Cell>
    </Table.Row>
  );
}
