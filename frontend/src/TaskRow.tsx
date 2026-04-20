import { Badge, Box, Flex, HStack, Spinner, Text } from "@chakra-ui/react";
import { Branch, Session } from "./api";

export interface Task {
  session?: Session;
  branch?: Branch;
}

interface TaskRowProps {
  task: Task;
  isSelected: boolean;
  pending?: string;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent, branch: Branch) => void;
}

export function TaskRow({ task, isSelected, pending, onSelect, onContextMenu }: TaskRowProps) {
  const { session: s, branch: b } = task;
  const archived = !b;
  const deleting = pending === "deleting";
  const name = b?.name ?? s?.branch ?? "(unknown)";

  return (
    <Box
      role="button"
      tabIndex={archived || deleting ? -1 : 0}
      aria-disabled={archived || deleting}
      onClick={archived || deleting ? undefined : onSelect}
      onKeyDown={(e) => {
        if (archived || deleting) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      onContextMenu={(e) => {
        if (!b || deleting) return;
        onContextMenu(e, b);
      }}
      cursor={archived || deleting ? "default" : "pointer"}
      bg={isSelected ? "gray.800" : undefined}
      opacity={deleting ? 0.4 : archived ? 0.6 : 1}
      borderRadius="md"
      px={3}
      py={2}
      textAlign="left"
      w="100%"
      _hover={{ bg: deleting ? undefined : "gray.800" }}
      _focusVisible={{
        outline: "none",
        borderColor: "blue.400",
        boxShadow: "0 0 0 1px var(--chakra-colors-blue-400)",
      }}
      transition="border-color 120ms, background 120ms, opacity 120ms"
    >
      <Flex align="center" gap={2} minW={0}>
        <Text
          fontFamily="mono"
          fontSize="sm"
          whiteSpace="nowrap"
          overflow="hidden"
          textOverflow="ellipsis"
          flex="1"
          minW={0}
        >
          {name}
        </Text>
        {deleting ? (
          <HStack gap={1} flexShrink={0}>
            <Spinner size="xs" />
            <Text fontSize="2xs" color="gray.500">deleting…</Text>
          </HStack>
        ) : (
          b?.isTrunk && (
            <Badge colorPalette="purple" variant="subtle" fontSize="2xs" flexShrink={0}>
              Dashboard
            </Badge>
          )
        )}
      </Flex>
    </Box>
  );
}
