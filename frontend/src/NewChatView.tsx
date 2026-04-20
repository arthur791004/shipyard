import { RefObject, useState } from "react";
import { Box, Button, Flex, HStack, Heading, Text } from "@chakra-ui/react";
import { Branch, Session } from "./api";
import { ShipyardIcon, SidebarIcon } from "./Icons";
import { SidebarContent } from "./SidebarContent";
import { CommandInput } from "./CommandInput";
import { Task } from "./TaskRow";

const SIDEBAR_WIDTH = 260;

interface Props {
  isMobile: boolean;
  sidebarCollapsed: boolean;
  trunk: Branch | undefined;
  sessionTasks: Task[];
  activeRepoId: string | undefined;
  branches: Branch[];
  sessions: Session[];
  commandInputRef: RefObject<HTMLInputElement | null>;
  onToggleSidebar: () => void;
  onToggleMobileMenu: () => void;
  onNewChat: () => void;
  onSelectTask: (b: Branch) => void;
  onCreated: (branch: Branch) => void;
  onRefresh: () => Promise<void>;
  onSessionsRefresh: () => void;
}

export function NewChatView({
  isMobile,
  sidebarCollapsed,
  trunk,
  sessionTasks,
  activeRepoId,
  branches,
  sessions,
  commandInputRef,
  onToggleSidebar,
  onToggleMobileMenu,
  onNewChat,
  onSelectTask,
  onCreated,
  onRefresh,
  onSessionsRefresh,
}: Props) {
  const [sidebarHover, setSidebarHover] = useState(false);

  return (
    <Flex direction="column" h="100%">
      {/* Header */}
      <Flex h="48px" px={3} align="center" flexShrink={0} gap={2}>
        {(isMobile || sidebarCollapsed) && (
          <Box
            position="relative"
            onMouseEnter={() => { if (!isMobile) setSidebarHover(true); }}
            onMouseLeave={() => { if (!isMobile) setSidebarHover(false); }}
          >
            <Button
              aria-label="Toggle sidebar"
              variant="ghost"
              size="xs"
              px={1}
              onClick={() => {
                if (isMobile) {
                  onToggleMobileMenu();
                } else {
                  onToggleSidebar();
                }
              }}
            >
              <SidebarIcon />
            </Button>
            {sidebarHover && !isMobile && (
              <>
              {/* Bridge element to prevent hover loss between button and dropdown */}
              <Box position="absolute" top="100%" left={0} w="100%" h="8px" />
              <Box
                position="absolute"
                top="100%"
                left={0}
                mt={1}
                w={`${SIDEBAR_WIDTH}px`}
                maxH="400px"
                overflowY="auto"
                bg="gray.900"
                borderWidth={1}
                borderColor="gray.700"
                borderRadius="md"
                boxShadow="lg"
                p={3}
                zIndex={30}
              >
                <SidebarContent
                  trunk={trunk}
                  sessionTasks={sessionTasks}
                  selectedBranchId={undefined}
                  onNewChat={() => { setSidebarHover(false); onNewChat(); }}
                  onSelectTask={(b) => { setSidebarHover(false); onSelectTask(b); }}
                />
              </Box>
              </>
            )}
          </Box>
        )}
        <HStack gap={2} color="gray.300">
          <ShipyardIcon width={32} height={16} />
          <Heading size="lg">Shipyard</Heading>
        </HStack>
      </Flex>
      <Flex flex="1" direction="column" align="center" justify="center" px={4} w="100%">
        <Text
          fontSize={{ base: "3xl", md: "5xl" }}
          fontWeight="semibold"
          letterSpacing="-0.02em"
          color="gray.200"
          mb={8}
          textAlign="center"
          whiteSpace="nowrap"
        >
          What would you like to work on?
        </Text>
        <Box w="100%" maxW="640px">
          <CommandInput
            activeRepoId={activeRepoId}
            branches={branches}
            sessions={sessions}
            showPills
            inputRef={commandInputRef}
            onCreated={onCreated}
            onRefresh={onRefresh}
            onSessionsRefresh={onSessionsRefresh}
          />
        </Box>
      </Flex>
    </Flex>
  );
}
