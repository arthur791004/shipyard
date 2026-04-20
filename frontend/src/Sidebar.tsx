import { useRef, useEffect } from "react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Branch, Repo, Session } from "./api";
import { RepoSwitcher } from "./RepoSwitcher";
import { SidebarIcon, DashboardIcon, NewChatIcon } from "./Icons";
import { TaskRow, Task } from "./TaskRow";

interface Props {
  trunk: Branch | undefined;
  sessionTasks: Task[];
  branchesLoaded: boolean;
  selectedBranchId: string | undefined;
  pending: Record<string, string>;
  repos: Repo[];
  activeRepoId: string | undefined;
  sidebarCollapsed: boolean;
  sidebarAnimated: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  onSelectTask: (b: Branch) => void;
  onContextMenu: (e: React.MouseEvent, branch: Branch, session?: Session) => void;
  onRepoChanged: () => Promise<void>;
  onOpenSettings: () => void;
}

export function Sidebar({
  trunk,
  sessionTasks,
  branchesLoaded,
  selectedBranchId,
  pending,
  repos,
  activeRepoId,
  sidebarCollapsed,
  sidebarAnimated,
  onToggleSidebar,
  onNewChat,
  onSelectTask,
  onContextMenu,
  onRepoChanged,
  onOpenSettings,
}: Props) {
  const taskListRef = useRef<HTMLDivElement>(null);

  // Arrow key navigation within the task list
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const active = document.activeElement;
      const inTaskList =
        taskListRef.current?.contains(active) || active === document.body;
      if (!inTaskList) return;
      e.preventDefault();
      const buttons = taskListRef.current?.querySelectorAll<HTMLElement>(
        '[role="button"]'
      );
      if (!buttons || buttons.length === 0) return;
      const currentIdx = Array.from(buttons).findIndex((el) => el === active);
      let nextIdx: number;
      if (e.key === "ArrowDown") {
        nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % buttons.length;
      } else {
        nextIdx =
          currentIdx < 0
            ? buttons.length - 1
            : (currentIdx - 1 + buttons.length) % buttons.length;
      }
      buttons[nextIdx].focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Flex
      direction="column"
      w={sidebarCollapsed ? "0px" : "260px"}
      minW={sidebarCollapsed ? 0 : "260px"}
      h="100%"
      overflow="hidden"
      whiteSpace="nowrap"
      flexShrink={0}
      borderRightWidth={sidebarCollapsed ? 0 : 1}
      borderColor="gray.800"
      transition={sidebarAnimated ? "width 200ms ease, min-width 200ms ease" : "none"}
    >
      <Flex px={3} h="48px" align="center" gap={2} flexShrink={0}>
        <Button
          aria-label="Toggle sidebar"
          variant="ghost"
          size="xs"
          px={1}
          onClick={onToggleSidebar}
        >
          <SidebarIcon />
        </Button>
      </Flex>

      <Box
        ref={taskListRef}
        flex="1"
        overflowY="auto"
        overflowX="hidden"
        px={2}
        py={2}
      >
        {/* + New chat */}
        <Box
          px={3}
          py={2}
          borderRadius="md"
          cursor="pointer"
          _hover={{ bg: "gray.800" }}
          onClick={onNewChat}
          mb={1}
        >
          <HStack gap={2}>
            <NewChatIcon />
            <Text fontFamily="mono" fontSize="sm" flex="1">New chat</Text>
            <Badge colorPalette="gray" variant="subtle" fontSize="2xs">⌘P</Badge>
          </HStack>
        </Box>

        {!branchesLoaded ? (
          <HStack justify="center" gap={3} py={10} color="gray.500">
            <Spinner size="sm" />
            <Text>Loading…</Text>
          </HStack>
        ) : (
          <>
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu(e, trunk);
                }}
                mb={2}
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
              <Text fontSize="xs" fontWeight="semibold" color="gray.500" px={3} pt={2} pb={1}>
                Chats
              </Text>
            )}
            <Stack gap={0}>
              {sessionTasks.map((t) => (
                <TaskRow
                  key={t.session?.id ?? t.branch?.id ?? "task"}
                  task={t}
                  isSelected={!!t.branch && selectedBranchId === t.branch.id}
                  pending={t.branch ? pending[t.branch.id] : undefined}
                  onSelect={() => t.branch && onSelectTask(t.branch)}
                  onContextMenu={(e, branch) => {
                    e.preventDefault();
                    onContextMenu(e, branch, t.session);
                  }}
                />
              ))}
            </Stack>
          </>
        )}
      </Box>

      <Flex px={2} py={2} flexShrink={0}>
        <Box w="100%">
          <RepoSwitcher
            repos={repos}
            activeRepoId={activeRepoId}
            onChanged={onRepoChanged}
            onSettings={onOpenSettings}
          />
        </Box>
      </Flex>
    </Flex>
  );
}
