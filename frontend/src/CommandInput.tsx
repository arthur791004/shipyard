import { RefObject, useRef, useState } from "react";
import { Box, Button, Code, HStack, Input, Portal, Text, Tooltip } from "@chakra-ui/react";
import { Branch, Session, api } from "./api";
import { TerminalKind } from "./TerminalModal";
import { SendIcon } from "./Icons";
import { toaster } from "./Toaster";

const COMMAND_MENU: { usage: string; prefix: string; desc: string }[] = [
  { usage: "/branch <name> [base]", prefix: "/branch ", desc: "start a blank sandbox" },
  { usage: "/gh-issue <url>", prefix: "/gh-issue ", desc: "Claude implements a GitHub issue" },
  { usage: "/linear <url>", prefix: "/linear ", desc: "Claude implements a Linear issue" },
];

interface Props {
  activeRepoId: string | undefined;
  branches: Branch[];
  sessions: Session[];
  showPills: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onCreated: (branch: Branch) => void;
  onRefresh: () => Promise<void>;
  onSessionsRefresh: () => void;
}

export function CommandInput({
  activeRepoId,
  branches,
  sessions,
  showPills,
  inputRef: externalRef,
  onCreated,
  onRefresh,
  onSessionsRefresh,
}: Props) {
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? internalRef;

  const [commandText, setCommandText] = useState("");
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandMenuIndex, setCommandMenuIndex] = useState(0);
  const [commandInputFocused, setCommandInputFocused] = useState(false);

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

  function validateCommand(text: string): string | null {
    if (!text.startsWith("/")) return null;
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

    if (!text.startsWith("/")) {
      toaster.create({ type: "error", title: "Type / for commands", duration: 3000 });
      return;
    }

    const error = validateCommand(text);
    if (error) {
      toaster.create({ type: "error", title: error, duration: 4000 });
      return;
    }
    setCommandBusy(true);
    try {
      const result = await api.command(text);
      setCommandText("");
      await onRefresh();
      onSessionsRefresh();
      if (result.branch) {
        onCreated(result.branch);
      }
    } catch (err: any) {
      toaster.create({ type: "error", title: err?.message ?? "Command failed", duration: 6000 });
    } finally {
      setCommandBusy(false);
    }
  }

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
          ref={inputRef as any}
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
      {showPills && (
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
                inputRef.current?.focus();
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
