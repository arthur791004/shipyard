import { useState } from "react";
import {
  Badge,
  Button,
  HStack,
  Menu,
  Portal,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { api, Repo } from "./api";
import { toaster } from "./Toaster";

interface Props {
  repos: Repo[];
  activeRepoId?: string;
  onChanged: () => void;
}

export function RepoSwitcher({ repos, activeRepoId, onChanged }: Props) {
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
      <Menu.Trigger asChild>
        <Button size="sm" variant="outline" minW="0" maxW="140px" justifyContent="space-between">
          <HStack gap={2} minW={0}>
            {busy === "activate" && <Spinner size="xs" />}
            <Text truncate fontFamily="mono" fontSize="sm">
              {active?.name ?? "No repo"}
            </Text>
          </HStack>
          <Text color="gray.500" ml={2}>▾</Text>
        </Button>
      </Menu.Trigger>
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
                  <Button
                    size="2xs"
                    variant="ghost"
                    colorPalette="red"
                    loading={busy === `remove:${r.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeRepo(r);
                    }}
                  >
                    ✕
                  </Button>
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
