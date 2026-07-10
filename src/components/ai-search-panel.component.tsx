import React, { useCallback, useState } from 'react';
import AiChatContent from './ai-chat-content.component';
import styles from './ai-search-panel.scss';

interface AiSearchPanelProps {
  onClose: () => void;
}

const AiSearchPanel: React.FC<AiSearchPanelProps> = ({ onClose }) => {
  // Maximize toggles the floating panel between its docked size and a near-
  // full-screen modal. A single AiChatContent instance is kept across the
  // toggle so in-flight streams and chat state survive maximize/restore.
  const [isExpanded, setIsExpanded] = useState(false);
  const toggleExpand = useCallback(() => setIsExpanded((prev) => !prev), []);

  return (
    <>
      {isExpanded && <div className={styles.backdrop} aria-hidden="true" onClick={toggleExpand} />}
      <div className={`${styles.panelContainer} ${isExpanded ? styles.panelContainerExpanded : ''}`}>
        <AiChatContent mode="floating" onClose={onClose} isExpanded={isExpanded} onToggleExpand={toggleExpand} />
      </div>
    </>
  );
};

export default AiSearchPanel;
