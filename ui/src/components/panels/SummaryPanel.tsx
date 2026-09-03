import { SidePanel } from "../sidebar/SidePanel";
import { renderMarkdown } from "../../utils/renderMarkdown";

interface Props {
  summary: string;
  onClose: () => void;
}

export function SummaryPanel({ summary, onClose }: Props) {
  return (
    <SidePanel title="Overview" onClose={onClose}>
      <div className="summary-body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(summary) }} />
    </SidePanel>
  );
}
