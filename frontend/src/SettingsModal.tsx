import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Code,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  Stack,
  Switch,
  Text,
} from "@chakra-ui/react";
import { api, Repo, Settings } from "./api";

interface Props {
  open: boolean;
  activeRepo: Repo | null;
  firstRun: boolean;
  settings: Settings | null;
  onClose: () => void;
  onAddRepo: () => Promise<void> | void;
  onSaved: (r: Repo) => void;
  onSettingsSaved: (s: Settings) => void;
}

export function SettingsModal({ open, activeRepo, firstRun, settings, onClose, onAddRepo, onSaved, onSettingsSaved }: Props) {
  const [installCmd, setInstallCmd] = useState<string>(activeRepo?.dashboardInstallCmd ?? "");
  const [startCmd, setStartCmd] = useState<string>(activeRepo?.dashboardStartCmd ?? "");
  const [previewUrl, setPreviewUrl] = useState<string>(activeRepo?.previewUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setInstallCmd(activeRepo?.dashboardInstallCmd ?? "");
    setStartCmd(activeRepo?.dashboardStartCmd ?? "");
    setPreviewUrl(activeRepo?.previewUrl ?? "");
  }, [
    activeRepo?.id,
    activeRepo?.dashboardInstallCmd,
    activeRepo?.dashboardStartCmd,
    activeRepo?.previewUrl,
  ]);

  async function save() {
    if (!activeRepo) return;
    setSaving(true);
    setErr(null);
    try {
      const next = await api.updateRepo(activeRepo.id, {
        dashboardInstallCmd: installCmd.trim(),
        dashboardStartCmd: startCmd.trim(),
        previewUrl: previewUrl.trim(),
      });
      onSaved(next);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open && !firstRun) onClose();
      }}
      placement="center"
      size="lg"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Settings</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={5}>
                {!activeRepo ? (
                  <Stack gap={3}>
                    <Text color="gray.400">
                      No repo configured yet. Add your first one to get started.
                    </Text>
                    <HStack>
                      <Button colorPalette="blue" onClick={() => onAddRepo()}>
                        + Add repo…
                      </Button>
                    </HStack>
                  </Stack>
                ) : (
                  <>
                    <Stack gap={1}>
                      <Text fontSize="xs" color="gray.400" textTransform="uppercase">
                        Active repo
                      </Text>
                      <Text fontFamily="mono" fontSize="sm" truncate>
                        {activeRepo.name}{" "}
                        <Text as="span" color="gray.500">
                          ({activeRepo.linkTarget})
                        </Text>
                      </Text>
                      <Text fontSize="xs" color="gray.500">
                        Default branch: <Code>{activeRepo.defaultBranch}</Code>. Use the repo switcher in the header
                        to add another repo or change the active one.
                      </Text>
                    </Stack>
                    <Field.Root>
                      <Field.Label fontSize="xs" color="gray.400">
                        Install command
                      </Field.Label>
                      <Input
                        placeholder="yarn install"
                        value={installCmd}
                        onChange={(e) => setInstallCmd(e.target.value)}
                        disabled={saving}
                      />
                      <Field.HelperText fontSize="xs" color="gray.500">
                        Runs in each worktree before the dev server. Leave blank for <Code>yarn install</Code>.
                      </Field.HelperText>
                    </Field.Root>
                    <Field.Root>
                      <Field.Label fontSize="xs" color="gray.400">
                        Start command
                      </Field.Label>
                      <Input
                        placeholder="yarn start-dashboard"
                        value={startCmd}
                        onChange={(e) => setStartCmd(e.target.value)}
                        disabled={saving}
                      />
                      <Field.HelperText fontSize="xs" color="gray.500">
                        Invoked as <Code>PORT=&lt;port&gt; &lt;cmd&gt;</Code>. Leave blank for{" "}
                        <Code>yarn start-dashboard</Code>.
                      </Field.HelperText>
                    </Field.Root>
                    <Field.Root>
                      <Field.Label fontSize="xs" color="gray.400">
                        Preview URL
                      </Field.Label>
                      <Input
                        placeholder="http://my.localhost:3000"
                        value={previewUrl}
                        onChange={(e) => setPreviewUrl(e.target.value)}
                        disabled={saving}
                      />
                      <Field.HelperText fontSize="xs" color="gray.500">
                        Opened in a new tab when you click <Code>Visit</Code>. Leave blank for{" "}
                        <Code>http://my.localhost:3000</Code>.
                      </Field.HelperText>
                    </Field.Root>
                  </>
                )}
                <Box borderTopWidth={1} borderColor="gray.800" pt={4}>
                  <Text fontSize="xs" color="gray.400" textTransform="uppercase" mb={3}>
                    Development
                  </Text>
                  <HStack justify="space-between" align="start">
                    <Stack gap={0} flex={1} pr={4}>
                      <Text fontSize="sm">Dry-run push mode</Text>
                      <Text fontSize="xs" color="gray.500">
                        When on, every <Code>shipyard:sandbox push</Code> from the sandbox is
                        silently routed through dry-run. Claude builds, commits, and "pushes"
                        as normal — nothing lands on origin or creates a real PR. Perfect for
                        testing the end-to-end flow.
                      </Text>
                    </Stack>
                    <Switch.Root
                      size="md"
                      checked={settings?.pushDryRun === true}
                      onCheckedChange={async (e) => {
                        try {
                          const next = await api.saveSettings({ pushDryRun: e.checked });
                          onSettingsSaved(next);
                        } catch (err: any) {
                          setErr(err?.message ?? "Failed to save dry-run mode");
                        }
                      }}
                    >
                      <Switch.HiddenInput />
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                    </Switch.Root>
                  </HStack>
                </Box>
                {err && (
                  <Alert.Root status="error">
                    <Alert.Indicator />
                    <Alert.Title>{err}</Alert.Title>
                  </Alert.Root>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2}>
                {!firstRun && (
                  <Button variant="outline" onClick={onClose} disabled={saving}>
                    Close
                  </Button>
                )}
                {activeRepo && (
                  <Button colorPalette="blue" onClick={save} loading={saving}>
                    Save
                  </Button>
                )}
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
