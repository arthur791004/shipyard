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
  isMobile?: boolean;
  onKindChange: (kind: TerminalKind) => void;
  onClose: () => void;
  onPreview: (b: Branch) => void;
  onPreviewInline?: (b: Branch) => void;
  onOpenEditor: (b: Branch) => void;
  onRefresh: (b: Branch) => void;
  onHardRefresh: (b: Branch) => void;
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
  writeRef?: MutableRefObject<((data: string) => void) | null>;
}

export function TerminalModal({
  branch,
  kind,
  isMobile,
  onKindChange,
  onClose,
  onPreview,
  onPreviewInline,
  onOpenEditor,
  onRefresh,
  onHardRefresh,
  onToggleSidebar,
  sidebarCollapsed,
  writeRef,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalDisabled = !branch.isTrunk && branch.status !== "running";
  const [reloadMenu, setReloadMenu] = useState<{ x: number; y: number } | null>(null);
  const [previewMenu, setPreviewMenu] = useState(false);

  useEffect(() => {
    const open = reloadMenu || previewMenu;
    if (!open) return;
    const close = () => { setReloadMenu(null); setPreviewMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [reloadMenu, previewMenu]);

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

    // `disposed` is hoisted above the callback registrations so every async
    // entry point (onmessage, onPaste, onResize, ResizeObserver, writeRef)
    // can early-return after cleanup. Without these guards xterm crashes
    // with "Cannot read properties of undefined (reading 'dimensions')"
    // when a queued event fires between term.dispose() and GC.
    let disposed = false;

    const onPaste = (ev: ClipboardEvent) => {
      if (disposed || readOnly) return;
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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        if (disposed) return;
        ws.send(`\x01resize:${term.cols},${term.rows}`);
      };
      ws.onmessage = (e) => {
        if (disposed) return;
        term.write(typeof e.data === "string" ? e.data : "");
      };
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
        if (disposed) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      };
    }

    const disposable = readOnly
      ? { dispose: () => {} }
      : term.onData((d) => {
          if (disposed) return;
          if (ws.readyState === WebSocket.OPEN) ws.send(d);
        });

    const onResize = () => {
      if (disposed) return;
      try { fit.fit(); } catch {}
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\x01resize:${term.cols},${term.rows}`);
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => onResize());
    ro.observe(containerRef.current);

    return () => {
      // Flip the flag FIRST so any in-flight callback that races the
      // cleanup early-returns before touching the disposed terminal.
      disposed = true;
      if (writeRef) writeRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("paste", onPaste, true);
      container.removeEventListener("mousedown", refocus);
      ro.disconnect();
      disposable.dispose();
      // Detach the WS handlers before closing so a late `onmessage` /
      // `onclose` can't trigger work on the terminal while it's being
      // disposed. `ws` may be undefined here if the very first connect()
      // synchronously failed — the optional-chain guards against that.
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.close();
      }
      try { term.dispose(); } catch {}
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
          {(isMobile || sidebarCollapsed) && onToggleSidebar && (
            <Button size="sm" variant="ghost" px={1} onClick={onToggleSidebar} flexShrink={0}>
              <SidebarIcon />
            </Button>
          )}
          <Heading size="sm" truncate flex="0 1 auto" minW={0}>
            {branch.isTrunk ? "Dashboard" : branch.name}
          </Heading>
          <Tabs.Root
            value={kind}
            onValueChange={(e) => {
              if (terminalDisabled) return;
              onKindChange(e.value as TerminalKind);
            }}
            flexShrink={0}
            css={{ "--tabs-height": "48px" }}
          >
            <Tabs.List borderBottom="none">
              <Tabs.Trigger value="claude" disabled={terminalDisabled}>Claude</Tabs.Trigger>
              <Tabs.Trigger value="shell" disabled={terminalDisabled}>Terminal</Tabs.Trigger>
              <Tabs.Trigger value="logs" disabled={terminalDisabled}>Logs</Tabs.Trigger>
            </Tabs.List>
          </Tabs.Root>
        </HStack>
        <HStack gap={2}>
          {!branch.isTrunk && (
          <Box
            position="relative"
            onContextMenu={(e) => {
              e.preventDefault();
              setReloadMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <IconButton
              label="Reload"
              onClick={(_e) => onRefresh(branch)}
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
          )}
          <Box
            position="relative"
            onContextMenu={(e) => {
              e.preventDefault();
              setPreviewMenu(true);
            }}
          >
            <IconButton
              label="Preview"
              onClick={(_e) => onPreview(branch)}
              disabled={branch.status !== "running"}
            >
              <PreviewIcon />
            </IconButton>
            {previewMenu && (
                <Box
                  position="absolute"
                  right={0}
                  top="100%"
                  mt={1}
                  zIndex={1000}
                  bg="gray.900"
                  borderWidth={1}
                  borderColor="gray.700"
                  borderRadius="md"
                  boxShadow="lg"
                  minW="160px"
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
                    onClick={() => { setPreviewMenu(false); onPreview(branch); }}
                  >
                    Open in new tab
                  </Button>
                  {onPreviewInline && (
                    <Button
                      w="100%"
                      size="sm"
                      variant="ghost"
                      justifyContent="flex-start"
                      borderRadius={0}
                      _hover={{ bg: "gray.800" }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => { setPreviewMenu(false); onPreviewInline(branch); }}
                    >
                      Open in panel
                    </Button>
                  )}
                </Box>
            )}
          </Box>
          {!isMobile && (
            <IconButton
              label="Open in editor"
              onClick={(_e) => onOpenEditor(branch)}
              disabled={!branch.worktreePath}
            >
              <EditorIcon />
            </IconButton>
          )}
        </HStack>
      </Flex>
      {!branch.isTrunk && branch.status !== "running" && (
        <Flex
          px={4}
          py={4}
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
      <Box
        flex="1"
        p={4}
        overflow="hidden"
        ref={containerRef}
        css={{
          ".xterm": { height: "100%" },
          // Style the xterm viewport scrollbar to match the dark terminal
          // chrome. The default is a fat white bar that's jarring against
          // the #0a0c10 background; we want something thin, translucent,
          // and only visible on hover.
          ".xterm .xterm-viewport": {
            scrollbarWidth: "thin",
            scrollbarColor: "rgba(255,255,255,0.15) transparent",
            transition: "scrollbar-color 160ms",
          },
          ".xterm .xterm-viewport:hover": {
            scrollbarColor: "rgba(255,255,255,0.3) transparent",
          },
          ".xterm .xterm-viewport::-webkit-scrollbar": {
            width: "10px",
            height: "10px",
          },
          ".xterm .xterm-viewport::-webkit-scrollbar-track": {
            background: "transparent",
          },
          ".xterm .xterm-viewport::-webkit-scrollbar-thumb": {
            background: "rgba(255,255,255,0.15)",
            borderRadius: "8px",
            border: "2px solid transparent",
            backgroundClip: "padding-box",
            transition: "background 160ms",
          },
          ".xterm .xterm-viewport::-webkit-scrollbar-thumb:hover": {
            background: "rgba(255,255,255,0.3)",
            backgroundClip: "padding-box",
          },
          ".xterm .xterm-viewport::-webkit-scrollbar-corner": {
            background: "transparent",
          },
        }}
      />
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

function SidebarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
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

function EditorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 18l6-6-6-6" />
      <path d="M8 6l-6 6 6 6" />
    </svg>
  );
}
