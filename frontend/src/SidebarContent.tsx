import { Badge, Box, HStack, Stack, Text } from "@chakra-ui/react";
import { Branch } from "./api";
import { Task } from "./TaskRow";
import { DashboardIcon, NewChatIcon } from "./Icons";

interface Props {
  trunk: Branch | undefined;
  sessionTasks: Task[];
  selectedBranchId: string | undefined;
  onNewChat: () => void;
  onSelectTask: (b: Branch) => void;
}

export function SidebarContent({
  trunk,
  sessionTasks,
  selectedBranchId,
  onNewChat,
  onSelectTask,
}: Props) {
  return (
    <>
      {/* New chat */}
      <Box
        px={3}
        py={2}
        borderRadius="md"
        cursor="pointer"
        _hover={{ bg: "gray.800" }}
        onClick={onNewChat}
      >
        <HStack gap={2}>
          <NewChatIcon />
          <Text fontFamily="mono" fontSize="sm" flex="1">New chat</Text>
          <Badge colorPalette="gray" variant="subtle" fontSize="2xs">⌘P</Badge>
        </HStack>
      </Box>

      {/* Trunk */}
      {trunk && (
        <Box
          px={3}
          py={2}
          borderRadius="md"
          cursor="pointer"
          bg={selectedBranchId === trunk.id ? "gray.800" : undefined}
          _hover={{ bg: "gray.800" }}
          onClick={() => onSelectTask(trunk)}
        >
          <HStack gap={2}>
            <DashboardIcon />
            <Text fontFamily="mono" fontSize="sm" flex="1" truncate>Dashboard</Text>
            <Badge colorPalette="gray" variant="subtle" fontSize="2xs">{trunk.name}</Badge>
          </HStack>
        </Box>
      )}

      {/* Chats */}
      {sessionTasks.length > 0 && (
        <Text fontSize="xs" fontWeight="semibold" color="gray.500" pt={2} pb={1} px={3}>Chats</Text>
      )}
      <Stack gap={0}>
        {sessionTasks.map((t) => (
          <Box
            key={t.session?.id ?? t.branch?.id ?? "t"}
            px={3}
            py={2}
            borderRadius="md"
            cursor="pointer"
            bg={t.branch && selectedBranchId === t.branch.id ? "gray.800" : undefined}
            _hover={{ bg: "gray.800" }}
            onClick={() => {
              if (t.branch) onSelectTask(t.branch);
            }}
          >
            <Text fontFamily="mono" fontSize="sm" truncate>
              {t.branch?.name ?? t.session?.branch ?? "?"}
            </Text>
          </Box>
        ))}
      </Stack>
    </>
  );
}
