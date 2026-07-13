import { createGlobalStore, getSessionStore } from '@openmrs/esm-framework';
import type { ChatMessage } from '../hooks/useChartSearchAi';

export interface ChatSessionState {
  messagesByPatient: Record<string, ChatMessage[]>;
  /**
   * Server-pinned conversation handle per patient. Captured from the
   * X-ChartSearchAi-Session response header on the first chat POST, then
   * threaded into every subsequent post for the same patient. Cleared on
   * logout (see {@link setupChatSessionLogoutCleanup}) and on "New chat".
   */
  sessionUuidByPatient: Record<string, string | null>;
  /** Hub product profile selected for this browser session. */
  selectedProfileId: string | null;
  /** Whether product-profile discovery can safely authorize a chat request. */
  profileDiscoveryStatus: 'loading' | 'ready' | 'unavailable' | 'disabled';
}

export const chatSessionStore = createGlobalStore<ChatSessionState>('chartsearchai-chat-session', {
  messagesByPatient: {},
  sessionUuidByPatient: {},
  selectedProfileId: null,
  profileDiscoveryStatus: 'loading',
});

export function setupChatSessionLogoutCleanup(): () => void {
  const sessionStore = getSessionStore();
  const readUserUuid = (state = sessionStore.getState()) => (state.loaded ? state.session?.user?.uuid : undefined);
  let previousUserUuid = readUserUuid();
  return sessionStore.subscribe((state) => {
    const currentUserUuid = readUserUuid(state);
    if (currentUserUuid !== previousUserUuid) {
      chatSessionStore.setState({
        messagesByPatient: {},
        sessionUuidByPatient: {},
        selectedProfileId: null,
        profileDiscoveryStatus: 'loading',
      });
      previousUserUuid = currentUserUuid;
    }
  });
}
