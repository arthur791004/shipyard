import { MutableRefObject, useEffect, useRef, useState } from "react";
import { Box, Button, Flex, HStack, Heading, Portal, Tabs, Text, Tooltip } from "@chakra-ui/react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { Branch } from "./api";

export type TerminalKind = "claude" | "shell" | "logs";

interface Props {
  branch: Branch;
  kind: TerminalKind;
  fullscreen: boolean;
  isMobile?: boolean;
  onFullscreenToggle: () => void;
  onKindChange: (kind: TerminalKind) => void;
  onClose: () => void;
  onPreview: (b: Branch) => void;
  onOpenEditor: (b: Branch) => void;
  onRefresh: (b: Branch) => void;
  onHardRefresh: (b: Branch) => void;
  onPush: (b: Branch) => void;
  writeRef?: MutableRefObject<((data: string) => void) | null>;
}

export function TerminalModal({
  branch,
  kind,
  fullscreen,
  isMobile,
  onFullscreenToggle,
  onKindChange,
  onClose,
  onPreview,
  onOpenEditor,
  onRefresh,
  onHardRefresh,
  onPush,
  writeRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalDisabled = !branch.isTrunk && branch.status !== "running";
  const [reloadMenu, setReloadMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!reloadMenu) return;
    const close = () => setReloadMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [reloadMenu]);

  useEffect(() => {
    if (!containerRef.current) return;
    // Don't mount the terminal or open a websocket until the branch is
    // actually running — otherwise the backend would immediately close the
    // connection (no worktree / no sandbox yet) and xterm would paint a
    // misleading "[branch has no worktree][connection closed]" on screen.
    // The status bar above the terminal already tells the user what's going
    // on during creating/starting/stopped/error states.
    //
    // Trunk is excluded from this guard: trunk has no sandbox, and its
    // Claude/shell ptys run on the host via sharedPty regardless of the
    // dashboard status. So trunk terminals always connect.
    if (!branch.isTrunk && branch.status !== "running") return;

    const readOnly = kind === "logs";
    const term = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontSize: 13,
      fontFamily: "ui-monospace, Menlo, monospace",
      theme: { background: "#0a0c10", foreground: "#e6e8eb" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const container = containerRef.current;
    term.open(container);
    fit.fit();
    term.focus();

    const refocus = () => term.focus();
    container.addEventListener("mousedown", refocus);

    const onPaste = (ev: ClipboardEvent) => {
      if (readOnly) return;
      // Skip if the paste is targeting a real text input outside the terminal
      // (e.g. the Add Branch name field) — we don't want to steal from those.
      const active = document.activeElement;
      const isExternalInput =
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
        !container.contains(active);
      if (isExternalInput) return;
      const text = ev.clipboardData?.getData("text");
      if (!text) return;
      ev.preventDefault();
      ev.stopPropagation();
      term.focus();
      if (ws.readyState === WebSocket.OPEN) {
        // Write straight to the pty, wrapping in bracketed-paste markers so
        // Claude / shells treat it as a single paste rather than keystrokes.
        ws.send(`\x1b[200~${text}\x1b[201~`);
      }
    };
    window.addEventListener("paste", onPaste, true);

    const wsProto = window.location.protocol === "https:" ? "wss" : "ws";
    const wsKind = kind === "logs" ? "dashboard" : kind;
    const wsUrl = `${wsProto}://${window.location.host}/api/branches/${encodeURIComponent(branch.id)}/terminal?kind=${wsKind}`;

    let ws: WebSocket;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(`\x01resize:${term.cols},${term.rows}`);
      };
      ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
      ws.onclose = () => {
        if (disposed) return;
        // Auto-reconnect after 2s — handles PTY not ready yet,
        // transient docker hiccups, and backend restarts.
        reconnectTimer = setTimeout(() => {
          if (!disposed) connect();
        }, 2000);
      };
    }
    connect();

    // Expose a write function so the chat input can send text to the PTY
    if (writeRef) {
      writeRef.current = (data: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      };
    }

    const disposable = readOnly
      ? { dispose: () => {} }
      : term.onData((d) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(d);
        });

    const onResize = () => {
      try { fit.fit(); } catch {}
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\x01resize:${term.cols},${term.rows}`);
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => onResize());
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      if (writeRef) writeRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("paste", onPaste, true);
      container.removeEventListener("mousedown", refocus);
      ro.disconnect();
      disposable.dispose();
      ws.close();
      term.dispose();
    };
  }, [branch.id, branch.status, kind]);

  return (
    <Flex direction="column" h="100%" bg="#0a0c10">
      <Flex
        justify="space-between"
        align="center"
        px={4}
        h="48px"
        flexShrink={0}
        gap={4}
        borderBottomWidth={1}
        borderColor="gray.800"
      >
        <HStack gap={3} minW={0} flex="1">
          {isMobile && (
            <Button size="sm" variant="ghost" px={2} onClick={onClose} flexShrink={0}>
              ←
            </Button>
          )}
          <Heading size="sm" truncate flex="0 1 auto" minW={0}>
            {branch.name}
          </Heading>
          <Tabs.Root
            value={kind}
            onValueChange={(e) => {
              if (terminalDisabled) return;
              onKindChange(e.value as TerminalKind);
            }}
            size="sm"
            variant="plain"
            flexShrink={0}
            css={{
              "--tabs-indicator-bg": "colors.gray.subtle",
              "--tabs-indicator-shadow": "shadows.xs",
            }}
          >
            <Tabs.List>
              <Tabs.Trigger value="claude" disabled={terminalDisabled}>Claude</Tabs.Trigger>
              <Tabs.Trigger value="shell" disabled={terminalDisabled}>Terminal</Tabs.Trigger>
              <Tabs.Trigger value="logs" disabled={terminalDisabled}>Logs</Tabs.Trigger>
              <Tabs.Indicator />
            </Tabs.List>
          </Tabs.Root>
        </HStack>
        <HStack gap={2}>
          <Box
            position="relative"
            onContextMenu={(e) => {
              if (branch.isTrunk) return;
              e.preventDefault();
              setReloadMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <IconButton
              label="Reload"
              onClick={(_e) => onRefresh(branch)}
              disabled={branch.isTrunk}
            >
              <RefreshIcon />
            </IconButton>
            {reloadMenu && (
              <Portal>
                <Box
                  position="fixed"
                  left={`${reloadMenu.x}px`}
                  top={`${reloadMenu.y}px`}
                  zIndex={1000}
                  bg="gray.900"
                  borderWidth={1}
                  borderColor="gray.700"
                  borderRadius="md"
                  boxShadow="lg"
                  minW="140px"
                  py={1}
                >
                  <Button
                    w="100%"
                    size="sm"
                    variant="ghost"
                    justifyContent="flex-start"
                    borderRadius={0}
                    _hover={{ bg: "gray.800" }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => { setReloadMenu(null); onRefresh(branch); }}
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
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => { setReloadMenu(null); onHardRefresh(branch); }}
                  >
                    Hard Reload
                  </Button>
                </Box>
              </Portal>
            )}
          </Box>
          <IconButton
            label="Preview"
            onClick={(_e) => onPreview(branch)}
            disabled={branch.status !== "running"}
          >
            <PreviewIcon />
          </IconButton>
          {!branch.isTrunk && (
            <IconButton
              label="Push & create PR"
              onClick={(_e) => onPush(branch)}
              disabled={!branch.worktreePath}
            >
              <PushIcon />
            </IconButton>
          )}
          {!isMobile && (
            <IconButton
              label="Open in editor"
              onClick={(_e) => onOpenEditor(branch)}
              disabled={!branch.worktreePath}
            >
              <EditorIcon />
            </IconButton>
          )}
          {!isMobile && (
            <IconButton
              label={fullscreen ? "Exit full screen" : "Full screen"}
              onClick={(_e) => onFullscreenToggle()}
            >
              {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
            </IconButton>
          )}
          {!isMobile && (
            <IconButton label="Close" onClick={(_e) => onClose()}>
              <CloseIcon />
            </IconButton>
          )}
        </HStack>
      </Flex>
      {!branch.isTrunk && branch.status !== "running" && (
        <Flex
          px={4}
          py={2}
          bg={branch.status === "error" ? "red.900" : "gray.900"}
          borderBottomWidth={1}
          borderColor="gray.800"
          gap={2}
          align="center"
        >
          <Text
            fontSize="xs"
            color={
              branch.status === "error"
                ? "red.300"
                : branch.status === "creating" || branch.status === "starting" || branch.status === "restarting"
                ? "blue.300"
                : "gray.400"
            }
          >
            {branch.status === "creating"
              ? "Creating sandbox…"
              : branch.status === "starting"
              ? "Starting sandbox…"
              : branch.status === "restarting"
              ? "Restarting sandbox…"
              : branch.status === "error"
              ? `Error${branch.error ? `: ${branch.error}` : ""}`
              : "Sandbox stopped"}
          </Text>
        </Flex>
      )}
      <Box flex="1" p={2} overflow="hidden" ref={containerRef} css={{ ".xterm": { height: "100%" } }} />
    </Flex>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip.Root openDelay={300}>
      <Tooltip.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          px={2}
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content>{label}</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}

function FullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </svg>
  );
}

function ExitFullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4v5H4" />
      <path d="M15 4v5h5" />
      <path d="M9 20v-5H4" />
      <path d="M15 20v-5h5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12" />
      <path d="M6 18L18 6" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function PushIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function EditorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 18l6-6-6-6" />
      <path d="M8 6l-6 6 6 6" />
    </svg>
  );
}
