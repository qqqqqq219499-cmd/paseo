import { SwarmBoardView, type SwarmBoardViewProps } from "@/subagents/swarm-board-view";
import type { ReactElement } from "react";

/** Native / default fallback: keep the existing card board. */
export function SwarmGraphView(props: SwarmBoardViewProps): ReactElement {
  return <SwarmBoardView {...props} />;
}
