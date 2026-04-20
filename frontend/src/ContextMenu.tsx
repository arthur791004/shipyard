import { Box, Button, Portal } from "@chakra-ui/react";
import { Branch, Session } from "./api";
import { toaster } from "./Toaster";

interface Props {
  x: number;
  y: number;
  branch: Branch;
  session?: Session;
  onClose: () => void;
  onPreview: (b: Branch) => void;
  onViewPr: (b: Branch) => void;
  onOpenEditor: (b: Branch) => void;
  onRefresh: (b: Branch) => void;
  onHardRefresh: (b: Branch) => void;
  onDelete: (b: Branch) => void;
}

export function ContextMenu({
  x,
  y,
  branch,
  session,
  onClose,
  onPreview,
  onViewPr,
  onOpenEditor,
  onRefresh,
  onHardRefresh,
  onDelete,
}: Props) {
  return (
    <Portal>
      <Box
        position="fixed"
        left={`${x}px`}
        top={`${y}px`}
        zIndex={1000}
        bg="gray.900"
        borderWidth={1}
        borderColor="gray.700"
        borderRadius="md"
        boxShadow="lg"
        minW="160px"
        py={1}
      >
        {/* Clipboard group */}
        <Button
          w="100%"
          size="sm"
          variant="ghost"
          justifyContent="flex-start"
          borderRadius={0}
          _hover={{ bg: "gray.800" }}
          onClick={async () => {
            onClose();
            try {
              await navigator.clipboard.writeText(branch.name);
              toaster.create({ type: "info", title: "Copied", duration: 1500 });
            } catch {}
          }}
        >
          Copy name
        </Button>

        {/* External links group */}
        {(session?.issueUrl || session?.linearUrl) && (
          <Box borderTopWidth={1} borderColor="gray.800" my={1} />
        )}
        {session?.issueUrl && (
          <Button
            w="100%"
            size="sm"
            variant="ghost"
            justifyContent="flex-start"
            borderRadius={0}
            _hover={{ bg: "gray.800" }}
            onClick={() => {
              const url = session?.issueUrl;
              onClose();
              if (url) window.open(url, "_blank");
            }}
          >
            Open issue
          </Button>
        )}
        {session?.linearUrl && (
          <Button
            w="100%"
            size="sm"
            variant="ghost"
            justifyContent="flex-start"
            borderRadius={0}
            _hover={{ bg: "gray.800" }}
            onClick={() => {
              const url = session?.linearUrl;
              onClose();
              if (url) window.open(url, "_blank");
            }}
          >
            Open in Linear
          </Button>
        )}

        {/* Branch actions group */}
        <Box borderTopWidth={1} borderColor="gray.800" my={1} />
        <Button
          w="100%"
          size="sm"
          variant="ghost"
          justifyContent="flex-start"
          borderRadius={0}
          _hover={{ bg: "gray.800" }}
          disabled={branch.status !== "running"}
          onClick={() => {
            onClose();
            onPreview(branch);
          }}
        >
          Preview
        </Button>
        <Button
          w="100%"
          size="sm"
          variant="ghost"
          justifyContent="flex-start"
          borderRadius={0}
          _hover={{ bg: "gray.800" }}
          disabled={!branch.worktreePath}
          onClick={() => {
            onClose();
            onOpenEditor(branch);
          }}
        >
          Open in editor
        </Button>
        {!branch.isTrunk && (
          <Button
            w="100%"
            size="sm"
            variant="ghost"
            justifyContent="flex-start"
            borderRadius={0}
            _hover={{ bg: "gray.800" }}
            disabled={!branch.worktreePath}
            onClick={() => {
              onClose();
              onViewPr(branch);
            }}
          >
            View PR
          </Button>
        )}

        {/* Reload group */}
        {!branch.isTrunk && (
          <>
            <Box borderTopWidth={1} borderColor="gray.800" my={1} />
            <Button
              w="100%"
              size="sm"
              variant="ghost"
              justifyContent="flex-start"
              borderRadius={0}
              _hover={{ bg: "gray.800" }}
              onClick={() => {
                onClose();
                onRefresh(branch);
              }}
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
              onClick={() => {
                onClose();
                onHardRefresh(branch);
              }}
            >
              Hard Reload
            </Button>
          </>
        )}

        {/* Destructive group */}
        {!branch.isTrunk && (
          <Button
            w="100%"
            size="sm"
            variant="ghost"
            colorPalette="red"
            justifyContent="flex-start"
            borderRadius={0}
            _hover={{ bg: "red.900" }}
            onClick={() => {
              onClose();
              onDelete(branch);
            }}
          >
            Delete
          </Button>
        )}
      </Box>
    </Portal>
  );
}
