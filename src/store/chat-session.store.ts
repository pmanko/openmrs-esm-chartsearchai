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
  /**
   * The backend the picker selected for THIS browser session. Sent as a
   * per-request override `{endpointUrl, modelName}` on each chat post. `null` =
   * use chartsearchai's config-controlled global default (which the picker shows
   * with a faded "default" tag). The picker NEVER mutates the global default.
   */
  selectedBackend: { endpointUrl: string; modelName: string } | null;
}

export const chatSessionStore = createGlobalStore<ChatSessionState>('chartsearchai-chat-session', {
  messagesByPatient: {},
  sessionUuidByPatient: {},
  selectedBackend: null,
});

export function setupChatSessionLogoutCleanup(): () => void {
  const sessionStore = getSessionStore();
  const readUserUuid = (state = sessionStore.getState()) => (state.loaded ? state.session?.user?.uuid : undefined);
  let previousUserUuid = readUserUuid();
  return sessionStore.subscribe((state) => {
    const currentUserUuid = readUserUuid(state);
    if (currentUserUuid !== previousUserUuid) {
      chatSessionStore.setState({ messagesByPatient: {}, sessionUuidByPatient: {}, selectedBackend: null });
      previousUserUuid = currentUserUuid;
    }
  });
}
