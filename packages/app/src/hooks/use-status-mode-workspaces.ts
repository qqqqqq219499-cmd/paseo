import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";

/** Project key → display name map used by the flat sessions sidebar headers. */
export function useProjectNamesMap(serverId: string | null): Map<string, string> {
  const workspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.workspaces : undefined,
  );

  return useMemo(() => {
    const map = new Map<string, string>();
    if (!serverId || !workspaces) return map;
    for (const workspace of workspaces.values()) {
      const key = workspace.project?.projectKey ?? workspace.projectId;
      if (!map.has(key)) {
        map.set(key, workspace.projectCustomName ?? workspace.projectDisplayName);
      }
    }
    return map;
  }, [serverId, workspaces]);
}
