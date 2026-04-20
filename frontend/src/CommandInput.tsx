import { RefObject, useRef, useState } from "react";
import { Box, Button, Code, HStack, Input, Portal, Text, Tooltip } from "@chakra-ui/react";
import { Branch, Session, api } from "./api";
import { TerminalKind } from "./TerminalModal";
import { SendIcon } from "./Icons";
import { toaster } from "./Toaster";
import { COMMANDS, findCommand } from "./commands";

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
    ? COMMANDS.filter((c) => c.verb.startsWith(commandText))
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
    const def = findCommand(parts[0]);
    if (!def) return `Unknown command: ${parts[0]}`;
    return def.validate(parts, { branches, sessions });
  }

  async function onRunCommand() {
    const text = commandText.trim();
    if (!text || commandBusy) return;

    // Slash-prefixed input goes through the per-verb validator below.
    // Anything else is a free-form prompt — the backend will generate a
    // branch name (or auto-route if it's a GH/Linear URL) and hand the
    // text to the sandboxed Claude as the task.
    if (text.startsWith("/")) {
      const error = validateCommand(text);
      if (error) {
        toaster.create({ type: "error", title: error, duration: 4000 });
        return;
      }
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
          placeholder="Describe a task, paste an issue URL, or type / for commands"
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
          {COMMANDS.map((cmd) => (
            <Tooltip.Root key={cmd.prefix} openDelay={300}>
              <Tooltip.Trigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  borderRadius="full"
                  fontSize="xs"
                  onClick={() => {
                    setCommandText(cmd.prefix);
                    inputRef.current?.focus();
                  }}
                >
                  {cmd.chip}
                </Button>
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content>{cmd.desc}</Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
          ))}
        </HStack>
      )}
    </Box>
  );
}
