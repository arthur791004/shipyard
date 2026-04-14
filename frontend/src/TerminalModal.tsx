import { useEffect, useRef } from "react";
import { Box, Button, Flex, HStack, Heading, Tabs } from "@chakra-ui/react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { Branch } from "./api";

export type TerminalKind = "claude" | "shell" | "logs";

interface Props {
  branch: Branch;
  kind: TerminalKind;
  fullscreen: boolean;
  onFullscreenToggle: () => void;
  onKindChange: (kind: TerminalKind) => void;
  onClose: () => void;
}

export function TerminalModal({ branch, kind, fullscreen, onFullscreenToggle, onKindChange, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

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
    const ws = new WebSocket(
      `${wsProto}://${window.location.host}/api/branches/${encodeURIComponent(branch.id)}/terminal?kind=${wsKind}`
    );

    ws.onopen = () => {
      ws.send(`\x01resize:${term.cols},${term.rows}`);
    };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : "");
    ws.onclose = () => term.write("\r\n[connection closed]\r\n");

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
      window.removeEventListener("resize", onResize);
      window.removeEventListener("paste", onPaste, true);
      container.removeEventListener("mousedown", refocus);
      ro.disconnect();
      disposable.dispose();
      ws.close();
      term.dispose();
    };
  }, [branch.id, kind]);

  return (
    <Flex direction="column" h="100%" bg="#0a0c10">
      <Flex justify="space-between" align="center" px={3} pt={6} pb={5} gap={4}>
        <HStack gap={4} minW={0}>
          <Heading size="md" truncate>{branch.name}</Heading>
          <Tabs.Root
            value={kind}
            onValueChange={(e) => onKindChange(e.value as TerminalKind)}
            size="sm"
            variant="plain"
          >
            <Tabs.List bg="bg.muted" rounded="l3" p="1">
              <Tabs.Trigger value="claude">Claude</Tabs.Trigger>
              <Tabs.Trigger value="shell">Terminal</Tabs.Trigger>
              <Tabs.Trigger value="logs">Logs</Tabs.Trigger>
              <Tabs.Indicator rounded="l2" />
            </Tabs.List>
          </Tabs.Root>
        </HStack>
        <HStack gap={2}>
          <Button size="sm" variant="outline" onClick={onFullscreenToggle}>
            {fullscreen ? "Exit full screen" : "Full screen"}
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </HStack>
      </Flex>
      <Box flex="1" p={2} overflow="hidden" ref={containerRef} css={{ ".xterm": { height: "100%" } }} />
    </Flex>
  );
}
