import { beforeEach, describe, expect, it } from 'vitest';
import { getSessionStore } from '@openmrs/esm-framework';
import { chatSessionStore, setupChatSessionLogoutCleanup } from './chat-session.store';

const sessionStore = getSessionStore();

const seedSession = () =>
  chatSessionStore.setState({
    messagesByPatient: {
      'patient-1': [
        {
          id: 'm1',
          question: 'q',
          answer: 'a',
          references: [],
          safetyWarnings: [],
          questionId: '',
          phase: 'complete',
          error: null,
        },
      ],
    },
    sessionUuidByPatient: { 'patient-1': 'server-session-handle-1' },
    selectedProfileId: 'single-e4b-checked',
  });

beforeEach(() => {
  chatSessionStore.setState({ messagesByPatient: {}, sessionUuidByPatient: {}, selectedProfileId: null });
  sessionStore.setState({ loaded: false, session: null });
});

describe('chatSessionStore logout cleanup', () => {
  it('clears all per-session state when the session transitions from a logged-in user to logged-out', () => {
    sessionStore.setState({
      loaded: true,
      session: { sessionId: 's1', authenticated: true, user: { uuid: 'user-1' } } as never,
    });

    const unsubscribe = setupChatSessionLogoutCleanup();
    seedSession();

    sessionStore.setState({
      loaded: true,
      session: { sessionId: '', authenticated: false } as never,
    });

    const state = chatSessionStore.getState();
    expect(state.messagesByPatient).toEqual({});
    expect(state.sessionUuidByPatient).toEqual({});
    expect(state.selectedProfileId).toBeNull();
    unsubscribe();
  });

  it('clears all per-session state when a different user logs in', () => {
    sessionStore.setState({
      loaded: true,
      session: { sessionId: 's1', authenticated: true, user: { uuid: 'user-1' } } as never,
    });

    const unsubscribe = setupChatSessionLogoutCleanup();
    seedSession();

    sessionStore.setState({
      loaded: true,
      session: { sessionId: 's2', authenticated: true, user: { uuid: 'user-2' } } as never,
    });

    const state = chatSessionStore.getState();
    // Cross-user leak vectors: server session handle and picked profile must not
    // bleed from user-1 into user-2's session.
    expect(state.messagesByPatient).toEqual({});
    expect(state.sessionUuidByPatient).toEqual({});
    expect(state.selectedProfileId).toBeNull();
    unsubscribe();
  });

  it('does not clear when the same user remains logged in across session refreshes', () => {
    sessionStore.setState({
      loaded: true,
      session: { sessionId: 's1', authenticated: true, user: { uuid: 'user-1' } } as never,
    });

    const unsubscribe = setupChatSessionLogoutCleanup();
    seedSession();

    sessionStore.setState({
      loaded: true,
      session: { sessionId: 's1', authenticated: true, user: { uuid: 'user-1' } } as never,
    });

    const state = chatSessionStore.getState();
    expect(state.messagesByPatient).not.toEqual({});
    expect(state.sessionUuidByPatient).not.toEqual({});
    expect(state.selectedProfileId).not.toBeNull();
    unsubscribe();
  });
});
