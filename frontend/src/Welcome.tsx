import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Code,
  Field,
  Flex,
  HStack,
  Heading,
  Input,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { ShipyardIcon } from "./Icons";
import { COMMANDS } from "./commands";
import { api, SystemCheck } from "./api";
import { toaster } from "./Toaster";

type Step = 0 | 1 | 2;

interface Props {
  onDone: () => Promise<void> | void;
}

export function Welcome({ onDone }: Props) {
  const [step, setStep] = useState<Step>(0);
  const [checks, setChecks] = useState<SystemCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [linkTarget, setLinkTarget] = useState("");
  const [installCmd, setInstallCmd] = useState("");
  const [startCmd, setStartCmd] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function runChecks() {
    setChecking(true);
    setErr(null);
    try {
      const res = await api.systemCheck();
      setChecks(res.checks);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (step === 1 && !checks && !checking) runChecks();
  }, [step, checks, checking]);

  async function pick() {
    setPicking(true);
    setErr(null);
    try {
      const picked = await api.pickFolder();
      if (picked) setLinkTarget(picked.path);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPicking(false);
    }
  }

  async function addRepo() {
    if (!linkTarget) return;
    setAdding(true);
    setErr(null);
    try {
      const repo = await api.addRepo({
        linkTarget,
        dashboardInstallCmd: installCmd.trim() || undefined,
        dashboardStartCmd: startCmd.trim() || undefined,
      });
      if (previewUrl.trim()) {
        await api.updateRepo(repo.repo.id, { previewUrl: previewUrl.trim() });
      }
      await onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setAdding(false);
    }
  }

  const requiredOk = (checks ?? []).filter((c) => c.required).every((c) => c.ok);
  const canContinueFromChecks = !!checks && requiredOk;

  return (
    <Flex
      w="100vw"
      h="100vh"
      align="center"
      justify="center"
      bg="#0a0c10"
      px={6}
      overflow="auto"
    >
      <Box
        w="100%"
        maxW="720px"
        minH="600px"
        borderWidth="1px"
        borderColor="gray.700"
        borderRadius="lg"
        p={8}
        bg="gray.900"
        display="flex"
        flexDirection="column"
      >
        <Flex justify="space-between" align="center" mb={6}>
          <HStack gap={2}>
            <ShipyardIcon width={32} height={16} />
            <Heading size="lg">Shipyard</Heading>
          </HStack>
          <StepDots current={step} />
        </Flex>
        <Box flex={1} display="flex" flexDirection="column">

        {step === 0 && (
          <Stack gap={5} flex={1}>
            <Text color="gray.300">
              Hand Claude a GitHub issue or a Linear ticket and it gets to work in its own isolated
              workspace. Kick off several at once and check in on any of them from one window.
            </Text>
            <Stack gap={2} color="gray.400" fontSize="sm">
              {COMMANDS.map((cmd) => (
                <BulletRow key={cmd.verb}>
                  <Code>{cmd.usage}</Code> — {cmd.desc}.
                </BulletRow>
              ))}
            </Stack>
            <Flex justify="flex-end" mt="auto">
              <Button colorPalette="blue" onClick={() => setStep(1)}>
                Get started →
              </Button>
            </Flex>
          </Stack>
        )}

        {step === 1 && (
          <Stack gap={5} flex={1}>
            <Stack gap={1}>
              <Heading size="md">Check dependencies</Heading>
              <Text color="gray.400" fontSize="sm">
                These are the CLIs Shipyard shells out to. Required ones must be present
                before you can continue; optional ones enable extra features.
              </Text>
            </Stack>

            {checking && !checks ? (
              <HStack color="gray.400">
                <Spinner size="sm" />
                <Text>Running checks…</Text>
              </HStack>
            ) : (
              <Stack gap={2}>
                {(checks ?? []).map((c) => (
                  <CheckRow key={c.name} check={c} />
                ))}
              </Stack>
            )}

            {err && <Text color="red.400" fontSize="sm">{err}</Text>}

            <Flex justify="space-between" mt="auto">
              <Button variant="outline" onClick={() => setStep(0)} disabled={checking}>
                ← Back
              </Button>
              <HStack gap={2}>
                <Button variant="subtle" onClick={runChecks} loading={checking}>
                  Re-run checks
                </Button>
                <Button
                  colorPalette="blue"
                  onClick={() => setStep(2)}
                  disabled={!canContinueFromChecks}
                >
                  Next →
                </Button>
              </HStack>
            </Flex>
          </Stack>
        )}

        {step === 2 && (
          <Stack gap={5} flex={1}>
            <Stack gap={1}>
              <Heading size="md">Add your first repo</Heading>
              <Text color="gray.400" fontSize="sm">
                Pick your existing git checkout — no copies, no cloning, your <Code>node_modules</Code>{" "}
                and caches stay put. Everything below is optional; you can change it later in Settings.
              </Text>
            </Stack>

            <Field.Root>
              <Field.Label fontSize="xs" color="gray.400" textTransform="uppercase">
                Repo folder
              </Field.Label>
              <HStack gap={2} w="100%">
                <Box
                  flex={1}
                  px={3}
                  py={2}
                  borderWidth="1px"
                  borderColor="gray.700"
                  borderRadius="md"
                  bg="gray.800"
                  fontFamily="mono"
                  fontSize="sm"
                  color={linkTarget ? "gray.100" : "gray.500"}
                  cursor="pointer"
                  onClick={pick}
                  minW={0}
                >
                  <Text truncate>{linkTarget || "No folder selected"}</Text>
                </Box>
                <Button variant="subtle" onClick={pick} loading={picking} disabled={adding}>
                  {linkTarget ? "Change…" : "Choose…"}
                </Button>
              </HStack>
            </Field.Root>

            <Field.Root>
              <Field.Label fontSize="xs" color="gray.400" textTransform="uppercase">
                Install command
              </Field.Label>
              <Input
                placeholder="yarn install"
                value={installCmd}
                onChange={(e) => setInstallCmd(e.target.value)}
                disabled={adding}
                fontFamily="mono"
                fontSize="sm"
              />
              <Field.HelperText fontSize="xs" color="gray.500">
                Runs in each worktree before the dev server. Leave blank for <Code>yarn install</Code>.
              </Field.HelperText>
            </Field.Root>

            <Field.Root>
              <Field.Label fontSize="xs" color="gray.400" textTransform="uppercase">
                Start command
              </Field.Label>
              <Input
                placeholder="yarn start-dashboard"
                value={startCmd}
                onChange={(e) => setStartCmd(e.target.value)}
                disabled={adding}
                fontFamily="mono"
                fontSize="sm"
              />
              <Field.HelperText fontSize="xs" color="gray.500">
                Invoked as <Code>PORT=&lt;port&gt; &lt;cmd&gt;</Code>. Leave blank for{" "}
                <Code>yarn start-dashboard</Code>.
              </Field.HelperText>
            </Field.Root>

            <Field.Root>
              <Field.Label fontSize="xs" color="gray.400" textTransform="uppercase">
                Preview URL
              </Field.Label>
              <Input
                placeholder="http://my.localhost:3000"
                value={previewUrl}
                onChange={(e) => setPreviewUrl(e.target.value)}
                disabled={adding}
                fontFamily="mono"
                fontSize="sm"
              />
              <Field.HelperText fontSize="xs" color="gray.500">
                Opened in a new tab when you click <Code>Visit</Code> on a task. Leave blank for{" "}
                <Code>http://my.localhost:3000</Code>.
              </Field.HelperText>
            </Field.Root>

            {err && <Text color="red.400" fontSize="sm">{err}</Text>}

            <Flex justify="space-between" mt="auto">
              <Button variant="outline" onClick={() => setStep(1)} disabled={adding}>
                ← Back
              </Button>
              <Button colorPalette="blue" onClick={addRepo} loading={adding} disabled={!linkTarget}>
                Add repo & finish
              </Button>
            </Flex>
          </Stack>
        )}
        </Box>
      </Box>
    </Flex>
  );
}

function StepDots({ current }: { current: number }) {
  return (
    <HStack gap={2}>
      {[0, 1, 2].map((i) => (
        <Box
          key={i}
          w="8px"
          h="8px"
          borderRadius="full"
          bg={i === current ? "blue.400" : i < current ? "blue.700" : "gray.700"}
          transition="background 160ms"
        />
      ))}
    </HStack>
  );
}

function BulletRow({ children }: { children: React.ReactNode }) {
  return (
    <HStack align="start" gap={2}>
      <Text color="blue.400" lineHeight="1.4">•</Text>
      <Text color="gray.400">{children}</Text>
    </HStack>
  );
}

function CheckRow({ check }: { check: SystemCheck }) {
  const palette = check.ok ? "green" : check.required ? "red" : "yellow";
  return (
    <Flex
      justify="space-between"
      align="center"
      px={3}
      h="52px"
      borderWidth="1px"
      borderColor="gray.700"
      borderRadius="md"
      bg="gray.800"
      gap={3}
    >
      <HStack gap={3} minW={0} flex={1}>
        <Box
          w="18px"
          h="18px"
          flexShrink={0}
          display="flex"
          alignItems="center"
          justifyContent="center"
          color={check.ok ? "green.400" : check.required ? "red.400" : "yellow.400"}
        >
          {check.ok ? <CheckIcon /> : <CrossIcon />}
        </Box>
        <Stack gap={0} minW={0} flex={1}>
          <Text
            fontSize="sm"
            fontWeight="medium"
            color="gray.100"
            lineHeight="1.3"
            truncate
          >
            {check.name}
          </Text>
          <Text fontSize="xs" color="gray.500" lineHeight="1.3" truncate>
            {check.detail || (check.ok ? "installed" : "not found")}
          </Text>
        </Stack>
      </HStack>
      <Badge colorPalette={palette} size="xs" textTransform="uppercase" flexShrink={0}>
        {check.ok ? "ok" : check.required ? "missing" : "optional"}
      </Badge>
    </Flex>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 011.4-1.4L8.5 12l6.8-6.7a1 1 0 011.4 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M4.3 4.3a1 1 0 011.4 0L10 8.6l4.3-4.3a1 1 0 111.4 1.4L11.4 10l4.3 4.3a1 1 0 01-1.4 1.4L10 11.4l-4.3 4.3a1 1 0 01-1.4-1.4L8.6 10 4.3 5.7a1 1 0 010-1.4z"
        clipRule="evenodd"
      />
    </svg>
  );
}
