import { useState } from "react";
import {
  Badge,
  Button,
  HStack,
  Menu,
  Portal,
  Spinner,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import { api, Repo } from "./api";
import { toaster } from "./Toaster";

async function syncRepo(repo: Repo, onChanged: () => void, setBusy: (s: string | null) => void) {
  setBusy(`sync:${repo.id}`);
  try {
    await api.syncRepo(repo.id);
    toaster.create({ type: "info", title: `${repo.name} synced`, duration: 2000 });
    onChanged();
  } catch (e: any) {
    toaster.create({ type: "error", title: e.message, duration: 6000 });
  } finally {
    setBusy(null);
  }
}

interface Props {
  repos: Repo[];
  activeRepoId?: string;
  onChanged: () => void;
  onSettings?: () => void;
}

export function RepoSwitcher({ repos, activeRepoId, onChanged, onSettings }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const active = repos.find((r) => r.id === activeRepoId);

  async function activate(id: string): Promise<void> {
    if (id === activeRepoId) return;
    setBusy("activate");
    try {
      await api.activateRepo(id);
      onChanged();
    } catch (e: any) {
      toaster.create({ type: "error", title: e.message, duration: 6000 });
    } finally {
      setBusy(null);
    }
  }

  async function addRepo(): Promise<void> {
    setBusy("add");
    try {
      const picked = await api.pickFolder();
      if (!picked) return;
      await api.addRepo({ linkTarget: picked.path });
      onChanged();
    } catch (e: any) {
      toaster.create({ type: "error", title: e.message, duration: 6000 });
    } finally {
      setBusy(null);
    }
  }

  async function removeRepo(repo: Repo): Promise<void> {
    if (!confirm(`Remove repo "${repo.name}"? This stops and removes all of its branches and sandboxes.`)) return;
    setBusy(`remove:${repo.id}`);
    try {
      await api.removeRepo(repo.id);
      onChanged();
    } catch (e: any) {
      toaster.create({ type: "error", title: e.message, duration: 6000 });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Menu.Root>
      {/*
        The trigger row: repo name + chevron (opens the switcher dropdown),
        plus inline action buttons for the frequently-used per-repo ops
        (settings, pull latest). The actions sit OUTSIDE <Menu.Trigger> so
        clicking them doesn't pop the menu — they always target the
        currently-active repo.
      */}
      <HStack gap={1} w="100%">
        <Menu.Trigger asChild>
          <Button
            size="sm"
            variant="ghost"
            flex={1}
            minW={0}
            justifyContent="space-between"
            px={2}
          >
            <HStack gap={2} minW={0}>
              {busy === "activate" && <Spinner size="xs" />}
              <Text truncate fontFamily="mono" fontSize="sm">
                {active?.name ?? "No repo"}
              </Text>
            </HStack>
            <Text color="gray.500" ml={2}>▾</Text>
          </Button>
        </Menu.Trigger>
        {active && onSettings && (
          <Tooltip.Root openDelay={300}>
            <Tooltip.Trigger asChild>
              <Button
                size="2xs"
                variant="ghost"
                aria-label="Settings"
                onClick={onSettings}
              >
                ⚙
              </Button>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content>Settings</Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        )}
        {active && (
          <Tooltip.Root openDelay={300}>
            <Tooltip.Trigger asChild>
              <Button
                size="2xs"
                variant="ghost"
                aria-label="Pull latest"
                loading={busy === `sync:${active.id}`}
                onClick={() => syncRepo(active, onChanged, setBusy)}
              >
                ↻
              </Button>
            </Tooltip.Trigger>
            <Portal>
              <Tooltip.Positioner>
                <Tooltip.Content>Pull latest</Tooltip.Content>
              </Tooltip.Positioner>
            </Portal>
          </Tooltip.Root>
        )}
      </HStack>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="260px">
            {repos.length === 0 && (
              <Menu.Item value="empty" disabled>
                <Text color="gray.500">No repos yet</Text>
              </Menu.Item>
            )}
            {repos.map((r) => (
              <Menu.Item key={r.id} value={r.id} onClick={() => activate(r.id)}>
                <HStack justify="space-between" w="100%" gap={2}>
                  <HStack gap={2} minW={0}>
                    <Text truncate fontFamily="mono" fontSize="sm">
                      {r.name}
                    </Text>
                    {r.id === activeRepoId && (
                      <Badge colorPalette="green" variant="subtle" size="xs">
                        active
                      </Badge>
                    )}
                  </HStack>
                  <Tooltip.Root openDelay={300}>
                    <Tooltip.Trigger asChild>
                      <Button
                        size="2xs"
                        variant="ghost"
                        colorPalette="red"
                        aria-label="Remove repo"
                        loading={busy === `remove:${r.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRepo(r);
                        }}
                      >
                        ✕
                      </Button>
                    </Tooltip.Trigger>
                    <Portal>
                      <Tooltip.Positioner>
                        <Tooltip.Content>Remove repo</Tooltip.Content>
                      </Tooltip.Positioner>
                    </Portal>
                  </Tooltip.Root>
                </HStack>
              </Menu.Item>
            ))}
            <Menu.Separator />
            <Menu.Item value="add" onClick={addRepo}>
              <HStack gap={2}>
                {busy === "add" && <Spinner size="xs" />}
                <Text>+ Add repo…</Text>
              </HStack>
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}
