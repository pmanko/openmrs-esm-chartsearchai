import { createGlobalStore, getSessionStore } from '@openmrs/esm-framework';
import type { HubProfileMetadata } from '../api/chartsearchai';
import type { ChatMessage } from '../hooks/useChartSearchAi';

export interface ChatSessionState {
  messagesByPatient: Record<string, ChatMessage[]>;
  /**
   * Server-pinned conversation handle per patient. Captured from the stream's
   * `turn_started` event and from the history and New chat responses, then
   * threaded into every subsequent post for the same patient. Cleared on
   * logout (see {@link setupChatSessionLogoutCleanup}).
   */
  sessionUuidByPatient: Record<string, string | null>;
  /**
   * Provider bound to each patient's active conversation, populated from
   * history hydration, `/chat/new` and `turn_started`. Follow-up turns on an
   * existing conversation send this provider rather than the global selection,
   * so switching provider on another patient cannot silently close an earlier
   * patient's conversation.
   */
  providerByPatient?: Record<string, string | null>;
  /** Hub product profile selected for this browser session. */
  selectedProfileId: string | null;
  /** Whether selectedProfileId was chosen explicitly by the user through the profile menu. */
  profileExplicitlySelected?: boolean;
  /**
   * Whether product-profile discovery can safely authorize a chat request: `ready` when the
   * selected profile is one the Hub currently offers; `unavailable` when `/models` could not be
   * read or the Hub offers no profile to fall back to; `selection-unavailable` when the Hub
   * answered but no longer offers the user's explicit pick, which the user must replace.
   */
  profileDiscoveryStatus: 'loading' | 'ready' | 'unavailable' | 'selection-unavailable';
  /**
   * The Hub's product profiles from the last successful `/models` read; null before the first
   * read and after a failed one.
   */
  hubProfiles?: HubProfileMetadata[] | null;
  /**
   * Clinical-answer provider selected for this browser session. Null means the
   * backend applies its configured default (bundled on a fresh install); it is
   * never a silent cross-provider fallback.
   */
  selectedProviderId: string | null;
  /**
   * The capabilities each provider advertises on `/providers`, recorded by `useSystemProviderDiscovery`.
   * Passed with each turn so the stream client can reject events the provider never declared;
   * absent until `/providers` has been read, in which case only the event order is checked.
   */
  providerCapabilities?: Record<string, string[]>;
  /**
   * Whether the reader wants an answer's reasoning disclosure open, remembered for the session so
   * the choice costs one click rather than one per answer.
   *
   * `undefined` is NOT `false`. It means no preference has been expressed, and each disclosure
   * then follows its phase: open while the model is still reasoning (the progress indicator the
   * live text was added to be), collapsed once the answer is on screen. An explicit `false` is a
   * reader saying "keep it shut", and closes it in both phases.
   *
   * Only the preference lives here. The reasoning text itself is on the message, and neither is
   * ever written to browser storage — it reasons over chart records.
   */
  reasoningExpanded?: boolean;
  /**
   * Patients with a New chat request in flight. Shared, so every panel open on that patient locks
   * its composer until the new conversation is in place, not only the panel that asked for it.
   */
  newChatPendingByPatient?: Record<string, boolean>;
  /** Whether optional In-Depth generation is enabled live when supported by the provider. */
  inDepthEnabled?: boolean;
  /** Patients whose last New chat request failed: every panel on the patient says so. */
  newChatErrorByPatient?: Record<string, string | null>;
}

let userGeneration = 0;

/**
 * Counts user changes. A request records it when it starts and drops its response if it has moved,
 * so a reply meant for the previous user never lands in the next user's cleared state.
 */
export function chatSessionUserGeneration(): number {
  return userGeneration;
}

/**
 * The provider a request about this patient goes to: its conversation's provider while it has one,
 * else the browser session's selection. Each panel's pickers show this, so what a panel shows is
 * what it sends even while panels on different patients are open.
 */
export function requestProviderFor(state: ChatSessionState, patientUuid?: string | null): string | null {
  const conversationProvider =
    patientUuid && state.sessionUuidByPatient[patientUuid] ? state.providerByPatient?.[patientUuid] : undefined;
  return conversationProvider ?? state.selectedProviderId;
}

/** A fresh session's state: the store starts from it, and a user change replaces the state with it. */
export const initialChatSessionState = (): ChatSessionState => ({
  messagesByPatient: {},
  sessionUuidByPatient: {},
  providerByPatient: {},
  selectedProfileId: null,
  profileExplicitlySelected: false,
  profileDiscoveryStatus: 'loading',
  hubProfiles: null,
  selectedProviderId: null,
});

export function setInDepthEnabled(enabled: boolean): void {
  chatSessionStore.setState({ inDepthEnabled: enabled });
}

export function providerSupportsInDepth(state: ChatSessionState, providerId?: string | null): boolean {
  if (!providerId) return false;
  const capabilities = state.providerCapabilities?.[providerId];
  return Array.isArray(capabilities) && capabilities.includes('indepth');
}

export const chatSessionStore = createGlobalStore<ChatSessionState>(
  'chartsearchai-chat-session',
  initialChatSessionState(),
);

export function setupChatSessionLogoutCleanup(): () => void {
  const sessionStore = getSessionStore();
  const readUserUuid = (state = sessionStore.getState()) => (state.loaded ? state.session?.user?.uuid : undefined);
  let previousUserUuid = readUserUuid();
  return sessionStore.subscribe((state) => {
    // A failed refetch leaves the store unloaded (framework 5.5 to 10), which says nothing about who is
    // signed in. Logout and a user switch arrive loaded.
    if (!state.loaded) {
      return;
    }
    const currentUserUuid = readUserUuid(state);
    if (currentUserUuid !== previousUserUuid) {
      userGeneration += 1;
      // Replaced, not merged, so no field outlives the user who set it. The reasoning preference
      // goes with the history: an O3 workstation is shared, and the next user has expressed no view
      // on whether the model's working notes should be open. The provider capabilities are
      // configuration read from /providers, not a user's state, so they stay.
      const { providerCapabilities } = chatSessionStore.getState();
      chatSessionStore.setState(
        { ...initialChatSessionState(), ...(providerCapabilities ? { providerCapabilities } : {}) },
        true,
      );
      previousUserUuid = currentUserUuid;
    }
  });
}
