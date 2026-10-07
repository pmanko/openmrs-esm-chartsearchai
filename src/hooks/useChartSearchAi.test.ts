import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConfig } from '@openmrs/esm-framework';
import { NO_ANSWER_LIMITS } from '../utils/answer-limits';
import { useChartSearchAi } from './useChartSearchAi';
import { type AiSearchResponse, chatPatientChartStream, fetchChatHistory, startNewChat } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';

vi.mock('../api/chartsearchai', () => ({
  chatPatientChartStream: vi.fn(),
  fetchChatHistory: vi.fn(),
  startNewChat: vi.fn(),
}));

const mockChatStream = chatPatientChartStream as Mock;
const mockFetchHistory = fetchChatHistory as Mock;
const mockStartNewChat = startNewChat as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  (useConfig as Mock).mockReturnValue({ useStreaming: true, showReasoning: true });
  chatSessionStore.setState({
    messagesByPatient: {},
    sessionUuidByPatient: {},
    selectedProfileId: 'single-e4b-checked',
    profileDiscoveryStatus: 'ready',
    selectedProviderId: 'hub',
  });
  // Default: empty hydration so tests opt-in to populated history.
  mockFetchHistory.mockResolvedValue({ session: 'srv-session-default', messages: [] });
});

describe('useChartSearchAi', () => {
  it('returns empty messages and not loading initially', () => {
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    expect(result.current.messages).toEqual([]);
    expect(result.current.isAwaitingAnswer).toBe(false);
  });

  it('hydrates chat history on mount and stores the server session uuid', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-1',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'First Q', createdAt: 1 },
        { messageId: 'a-1', role: 'assistant', content: 'First A', createdAt: 2 },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].question).toBe('First Q');
    expect(result.current.messages[0].answer).toBe('First A');
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-1');
  });

  it('hydrates a failed terminal turn as an error with its persisted problem code', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-1',
      messages: [
        { messageId: 'request-1', role: 'user', content: 'First Q', createdAt: 1 },
        {
          messageId: 'turn-1',
          role: 'assistant',
          content: '',
          terminalState: 'turn_error',
          problemCode: 'provider_failure',
          createdAt: 2,
        },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].id).toBe('request-1');
    expect(result.current.messages[0].phase).toBe('error');
    expect(result.current.messages[0].error).toBe('provider_failure');
  });

  it("syncs selectedProviderId to the restored conversation's real provider on hydration", async () => {
    // Hydration must synchronize the picker with the provider bound to the restored conversation.
    chatSessionStore.setState({ selectedProviderId: 'hub' });
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-bundled',
      provider: 'bundled',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'What medications is the patient on?', createdAt: 1 },
        { messageId: 'a-1', role: 'assistant', content: 'Lisinopril 10 mg [1].', createdAt: 2 },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(chatSessionStore.getState().selectedProviderId).toBe('bundled');
  });

  it('leaves selectedProviderId alone when the restored conversation has no provider (e.g. no history yet)', async () => {
    chatSessionStore.setState({ selectedProviderId: 'hub' });
    mockFetchHistory.mockResolvedValueOnce({ session: 'srv-session-empty', messages: [] });

    renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());
    expect(chatSessionStore.getState().selectedProviderId).toBe('hub');
  });

  it('hydrates a stale pending In-Depth as failed instead of showing a permanent spinner', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-1',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'First Q', createdAt: 1 },
        {
          messageId: 'a-1',
          role: 'assistant',
          content: 'First A',
          inDepth: { status: 'pending', answer: '' },
          createdAt: 2,
        },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].inDepth).toEqual({
      status: 'failed',
      answer: '',
      error: 'In-Depth was interrupted.',
    });
  });

  it('hydrates a stale checking answer as check unavailable', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-1',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'First Q', createdAt: 1 },
        {
          messageId: 'a-1',
          role: 'assistant',
          content: 'First A',
          answerValidation: { status: 'checking', label: 'Checking answer' },
          createdAt: 2,
        },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].answerValidation).toEqual({
      status: 'unavailable',
      label: 'Check unavailable',
      summary: 'The answer check was interrupted before completion.',
    });
  });

  it('appends a loading message on submitQuestion and calls chatPatientChartStream with null session before hydration', async () => {
    // Force hydration to never resolve so the session uuid stays null
    // when submitQuestion fires — this exercises the "first turn ever"
    // path the server resolves to opening a fresh session.
    mockFetchHistory.mockReturnValueOnce(new Promise(() => {}));
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].question).toBe('What meds?');
    expect(result.current.messages[0].phase).toBe('answering');
    expect(result.current.messages[0].answer).toBe('');
    expect(result.current.isAwaitingAnswer).toBe(true);
    expect(mockChatStream).toHaveBeenCalledWith(
      'patient-uuid',
      null,
      'What meds?',
      expect.objectContaining({
        onSession: expect.any(Function),
        onAnswerDone: expect.any(Function),
        onDone: expect.any(Function),
        onError: expect.any(Function),
      }),
      expect.any(AbortController),
      'single-e4b-checked',
      'hub',
    );
  });

  it('does not call chat when product profile discovery is unavailable', () => {
    chatSessionStore.setState({ profileDiscoveryStatus: 'unavailable', selectedProfileId: null });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });

    expect(mockChatStream).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toEqual(
      expect.objectContaining({
        question: 'What meds?',
        phase: 'error',
        error: 'AI profiles are unavailable. Check the med-agent-hub connection.',
      }),
    );
  });

  it('submits bundled turns without med-agent-hub profile discovery', () => {
    chatSessionStore.setState({
      selectedProviderId: 'bundled',
      profileDiscoveryStatus: 'unavailable',
      selectedProfileId: null,
    });
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });

    expect(mockChatStream).toHaveBeenCalledWith(
      'patient-uuid',
      null,
      'What meds?',
      expect.any(Object),
      expect.any(AbortController),
      undefined,
      'bundled',
    );
    expect(result.current.messages[0].phase).toBe('answering');
  });

  it('does not call chat when discovery is ready without a selected product profile', () => {
    chatSessionStore.setState({ profileDiscoveryStatus: 'ready', selectedProfileId: null });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });

    expect(mockChatStream).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toEqual(
      expect.objectContaining({
        question: 'What meds?',
        phase: 'error',
        error: 'No AI profile is selected. Refresh the available profiles and try again.',
      }),
    );
  });

  it('captures session uuid via onSession and reuses it on the next submit', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q1');
    });

    const callbacks1 = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks1.onSession('srv-session-captured');
      callbacks1.onDone({ answer: 'A1', references: [], session: 'srv-session-captured', messageId: 'm-1' });
    });
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-captured');

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q2');
    });

    expect(mockChatStream).toHaveBeenLastCalledWith(
      'patient-uuid',
      'srv-session-captured',
      'Q2',
      expect.any(Object),
      expect.any(AbortController),
      'single-e4b-checked',
      'hub',
    );
  });

  it('drops the prior conversation from view when the backend silently starts a new one', async () => {
    // A different session UUID indicates that the backend opened a new conversation, so turns
    // from the prior conversation must not remain in the same visible thread.
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-old-bundled',
      provider: 'bundled',
      messages: [
        { messageId: 'u-0', role: 'user', content: 'What medications is the patient on?', createdAt: 1 },
        { messageId: 'a-0', role: 'assistant', content: 'Lisinopril 10 mg [1].', createdAt: 2 },
      ],
    });
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Does the patient have any allergies?');
    });
    expect(result.current.messages).toHaveLength(2);

    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onSession('srv-session-new-hub');
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].question).toBe('Does the patient have any allergies?');
  });

  it('does not let a late-arriving hydration response clobber a session a turn already corrected', async () => {
    // Real race: the mount-time history GET (fast, no LLM) can still resolve AFTER the first
    // real turn's own onSession callback has already set the correct session — e.g. right after
    // a provider switch, the hydration response reflects the OLD provider's conversation while
    // the in-flight turn already opened and was told about a NEW one for the new provider. If
    // hydration is allowed to overwrite unconditionally, the next submit sends the stale session,
    // and the backend — seeing a provider/mode mismatch — silently opens yet another new
    // conversation instead of continuing the one the user is actually mid-turn on.
    let resolveHydration: (value: { session: string; messages: never[] }) => void;
    mockFetchHistory.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHydration = resolve;
      }),
    );
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q1');
    });
    const callbacks1 = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks1.onSession('srv-session-from-turn-1');
      callbacks1.onDone({ answer: 'A1', references: [], session: 'srv-session-from-turn-1', messageId: 'm-1' });
    });
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-from-turn-1');

    // The hydration fetch (from mount, before Q1 was even sent) finally resolves — with a STALE
    // session that has nothing to do with the turn that already completed.
    await act(async () => {
      resolveHydration({ session: 'srv-session-stale-hydration', messages: [] });
    });

    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-from-turn-1');
  });

  it.each([
    { timing: 'before the session event', session: undefined },
    { timing: 'after an unchanged session event', session: 'srv-session-existing' },
  ])('keeps the live question when history arrives $timing', async ({ session }) => {
    if (session) {
      chatSessionStore.setState({ sessionUuidByPatient: { 'patient-uuid': session } });
    }
    let resolveHistory!: (response: Awaited<ReturnType<typeof fetchChatHistory>>) => void;
    mockFetchHistory.mockReturnValueOnce(new Promise((resolve) => (resolveHistory = resolve)));
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    act(() => result.current.submitQuestion('patient-uuid', 'Current question'));
    const callbacks = mockChatStream.mock.calls[0][3];
    if (session) act(() => callbacks.onSession(session));

    await act(async () => {
      resolveHistory({
        session: 'srv-session-existing',
        provider: 'hub',
        messages: [
          { messageId: 'old-user', role: 'user', content: 'Old question', createdAt: 1 },
          { messageId: 'old-answer', role: 'assistant', content: 'Old answer', createdAt: 2 },
        ],
      });
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].question).toBe('Current question');
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe(session);

    act(() => {
      callbacks.onSession('srv-session-existing');
      callbacks.onDone({ answer: 'Current answer', references: [], messageId: 'current-answer' });
    });
    expect(result.current.messages[0]).toMatchObject({
      question: 'Current question',
      answer: 'Current answer',
      phase: 'complete',
    });
  });

  it('sets the answer whole on answer_done (the hub delivers a complete answer, not tokens)', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Summary?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];

    act(() => {
      callbacks.onAnswerDone({ answer: 'Hello world', references: [], messageId: 'm1' });
    });

    expect(result.current.messages[0].answer).toBe('Hello world');
    // No validator in this payload → settle immediately (composer unlocks).
    expect(result.current.messages[0].phase).toBe('settled');
  });

  it('keeps the canonical safety result from answer_done while later phases settle', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Is ibuprofen safe?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];

    act(() => {
      callbacks.onAnswerDone({
        answer: 'Ibuprofen could be considered [1].',
        references: [],
        messageId: 'm1',
        safetyStatus: 'limited',
        safetyCheck: {
          schema_version: 'drug_safety.v1',
          status: 'limited',
          package: { id: 'research-seed-v1', review_state: 'proposed' },
          issues: ['source_not_clinically_approved'],
        },
      });
      callbacks.onDone({ answer: 'Ibuprofen could be considered [1].', references: [] });
    });

    expect(result.current.messages[0].safetyCheck?.issues).toEqual(['source_not_clinically_approved']);
    expect(result.current.messages[0].phase).toBe('complete');
  });

  it('leaves inDepth unset on answer_done when the provider has no In-Depth capability at all', async () => {
    // Only an explicit in-depth event may create a pending In-Depth state. Providers without the
    // capability do not emit that event, so answer_done must not fabricate a pending section.
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What medications is the patient on?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];

    act(() => {
      callbacks.onAnswerDone({ answer: 'Lisinopril 10 mg [1].', references: [], messageId: 'm1' });
    });

    expect(result.current.messages[0].inDepth).toBeUndefined();
  });

  it('finalizes last message on streaming done with auditLogId separately from messageId', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Summary?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    const finalResponse = {
      answer: 'Final answer.',
      references: [{ index: 1, resourceType: 'Obs', resourceUuid: 'uuid-10', date: '2025-06-01' }],
      session: 'srv-session-1',
      messageId: 'msg-final',
      auditLogId: 42,
    };

    act(() => {
      callbacks.onDone(finalResponse);
    });

    expect(result.current.messages[0].answer).toBe('Final answer.');
    expect(result.current.messages[0].references).toEqual(finalResponse.references);
    expect(result.current.messages[0].auditLogId).toBe(42);
    expect(result.current.messages[0].phase).toBe('complete');
  });

  it('carries blocks from streaming done onto the message', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'List meds');
    });
    const callbacks = mockChatStream.mock.calls[0][3];

    const finalResponse = {
      answer: 'See table.',
      references: [{ index: 1, resourceType: 'order', resourceUuid: 'uuid-100', date: '2024-01-01' }],
      blocks: [
        {
          kind: 'table' as const,
          title: 'Medications',
          columns: [{ key: 'name', label: 'Medication' }],
          rows: [{ cells: { name: { text: 'Lisinopril', refs: [1] } } }],
        },
      ],
      session: 'srv-session-1',
      messageId: 'msg-blocks',
    };

    act(() => {
      callbacks.onDone(finalResponse);
    });

    expect(result.current.messages[0].blocks).toEqual(finalResponse.blocks);
  });

  it('hydrates blocks from chat history rows so reloads restore tables', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-h',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'List meds', createdAt: 1 },
        {
          messageId: 'a-1',
          role: 'assistant',
          content: 'See table.',
          blocks: [
            {
              kind: 'table',
              title: 'Medications',
              columns: [{ key: 'name', label: 'Medication' }],
              rows: [{ cells: { name: { text: 'Lisinopril', refs: [1] } } }],
            },
          ],
          createdAt: 2,
        },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].answer).toBe('See table.');
    expect(result.current.messages[0].blocks).toHaveLength(1);
    expect(result.current.messages[0].blocks?.[0].title).toBe('Medications');
  });

  it('hydrates safetyWarnings from chat history rows so reloads restore the safety chips', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-sw',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'Is ibuprofen safe?', createdAt: 1 },
        {
          messageId: 'a-1',
          role: 'assistant',
          content: 'Ibuprofen is an option [1].',
          safetyWarnings: [
            { type: 'contraindication', drug: 'Ibuprofen', detail: 'the patient has a recorded allergy to Ibuprofen' },
          ],
          createdAt: 2,
        },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].safetyWarnings).toEqual([
      { type: 'contraindication', drug: 'Ibuprofen', detail: 'the patient has a recorded allergy to Ibuprofen' },
    ]);
  });

  it('hydrates safetyStatus from chat history rows even when there are no warnings', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-status',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'What medications is the patient on?', createdAt: 1 },
        {
          messageId: 'a-1',
          role: 'assistant',
          content: 'Lisinopril 10 mg [1].',
          safetyWarnings: [],
          safetyStatus: 'unavailable',
          createdAt: 2,
        },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].safetyStatus).toBe('unavailable');
  });

  it('hydrates the canonical safety result so limitation reasons survive reload', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-safety-check',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'Is ibuprofen safe?', createdAt: 1 },
        {
          messageId: 'a-1',
          role: 'assistant',
          content: 'Ibuprofen could be considered [1].',
          safetyWarnings: [],
          safetyStatus: 'limited',
          safetyCheck: {
            schema_version: 'drug_safety.v1',
            status: 'limited',
            package: { id: 'research-seed-v1', review_state: 'proposed' },
            issues: ['source_not_clinically_approved'],
          },
          createdAt: 2,
        },
      ],
    });

    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].safetyCheck).toEqual({
      schema_version: 'drug_safety.v1',
      status: 'limited',
      package: { id: 'research-seed-v1', review_state: 'proposed' },
      issues: ['source_not_clinically_approved'],
    });
  });

  it('sets error on streaming onError', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];

    act(() => {
      callbacks.onError('Stream failed');
    });

    expect(result.current.messages[0].error).toBe('Stream failed');
    expect(result.current.messages[0].phase).toBe('error');
    expect(result.current.isAwaitingAnswer).toBe(false);
  });

  it('clearMessages resets to empty array and aborts in-flight request', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q?');
    });

    const abortController = mockChatStream.mock.calls[0][4] as AbortController;
    expect(result.current.messages).toHaveLength(1);
    expect(abortController.signal.aborted).toBe(false);

    act(() => {
      result.current.clearMessages();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.isAwaitingAnswer).toBe(false);
    expect(abortController.signal.aborted).toBe(true);
  });

  it('stopCurrent preserves partial answer and keeps prior message history', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'First?');
    });
    const firstCallbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      firstCallbacks.onDone({ answer: 'Answer.', references: [], session: 's', messageId: 'm-1' });
    });

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Second?');
    });
    const secondCallbacks = mockChatStream.mock.calls[1][3];
    act(() => {
      // Answer has landed (whole, via answer_done) and in-depth is generating; the user stops here.
      secondCallbacks.onAnswerDone({
        answer: 'Partial answer.',
        references: [],
        messageId: 'm-2',
        answerValidation: { status: 'checking', label: 'Checking answer' },
      });
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].answer).toBe('Partial answer.');

    act(() => {
      result.current.stopCurrent();
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].answer).toBe('Answer.');
    expect(result.current.messages[1].phase).toBe('complete');
    expect(result.current.messages[1].answer).toBe('Partial answer.');
    expect(result.current.messages[1].answerValidation?.status).toBe('unavailable');
  });

  it('stopCurrent removes the message bubble when no answer was received', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'First?');
    });
    const firstCallbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      firstCallbacks.onDone({ answer: 'Answer.', references: [], session: 's', messageId: 'm-1' });
    });

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Second?');
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].answer).toBe('');

    act(() => {
      result.current.stopCurrent();
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].answer).toBe('Answer.');
  });

  it('drops a second submitQuestion call while the first is in flight', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'First?');
      result.current.submitQuestion('patient-uuid', 'Second?');
    });

    expect(result.current.messages).toHaveLength(1);
    expect(mockChatStream).toHaveBeenCalledTimes(1);
  });

  it('startNewChatSession clears local state and opens a fresh server session', async () => {
    mockStartNewChat.mockResolvedValue({ session: 'srv-session-2', messages: [] });
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    // Seed state via a completed turn
    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onSession('srv-session-1');
      callbacks.onDone({ answer: 'A.', references: [], session: 'srv-session-1', messageId: 'm-1' });
    });
    expect(result.current.messages).toHaveLength(1);

    await act(async () => {
      result.current.startNewChatSession('patient-uuid');
    });

    expect(result.current.messages).toEqual([]);
    expect(mockStartNewChat).toHaveBeenCalledWith('patient-uuid', 'hub');
    await waitFor(() => expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-2'));
  });

  it('blocks submission until a requested new session exists', async () => {
    let resolveSession!: (value: { session: string; messages: never[] }) => void;
    mockStartNewChat.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => result.current.startNewChatSession('patient-uuid'));
    expect(result.current.isAwaitingAnswer).toBe(true);

    act(() => result.current.submitQuestion('patient-uuid', 'Too early'));
    expect(mockChatStream).not.toHaveBeenCalled();

    await act(async () => resolveSession({ session: 'srv-session-2', messages: [] }));
    await waitFor(() => expect(result.current.isAwaitingAnswer).toBe(false));

    act(() => result.current.submitQuestion('patient-uuid', 'Now ready'));
    expect(mockChatStream).toHaveBeenCalledWith(
      'patient-uuid',
      'srv-session-2',
      'Now ready',
      expect.any(Object),
      expect.any(AbortController),
      'single-e4b-checked',
      'hub',
    );
  });

  it('preserves the current conversation when starting a new session fails', async () => {
    mockStartNewChat.mockRejectedValue(new Error('server unavailable'));
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => result.current.submitQuestion('patient-uuid', 'Q?'));
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onSession('srv-session-1');
      callbacks.onDone({ answer: 'A.', references: [], session: 'srv-session-1', messageId: 'm-1' });
    });

    await act(async () => result.current.startNewChatSession('patient-uuid'));
    await waitFor(() => expect(result.current.isAwaitingAnswer).toBe(false));

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].answer).toBe('A.');
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-1');
  });

  it('keeps an active turn running when starting a new session fails', async () => {
    mockStartNewChat.mockRejectedValue(new Error('server unavailable'));
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => result.current.submitQuestion('patient-uuid', 'Still running?'));
    const controller = mockChatStream.mock.calls[0][4] as AbortController;
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() =>
      callbacks.onAnswerDone({
        answer: 'Visible answer.',
        references: [],
        answerValidation: { status: 'checking', label: 'Checking answer' },
      }),
    );

    await act(async () => result.current.startNewChatSession('patient-uuid'));

    expect(controller.signal.aborted).toBe(false);
    expect(result.current.messages[0]).toMatchObject({
      answer: 'Visible answer.',
      phase: 'checking',
      error: null,
    });
  });

  it('aborts in-flight request on unmount', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Question?');
    });

    const abortController = mockChatStream.mock.calls[0][4] as AbortController;
    expect(abortController.signal.aborted).toBe(false);

    unmount();
    expect(abortController.signal.aborted).toBe(true);
    expect(chatSessionStore.getState().messagesByPatient['patient-uuid']).toEqual([]);
  });

  it('records the resolved model from the streaming done event onto the message', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Summary?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];

    act(() => {
      callbacks.onDone({
        answer: 'Done.',
        references: [],
        session: 's',
        messageId: 'm-1',
        resolvedModel: 'med-agent-team',
      });
    });

    expect(result.current.messages[0].resolvedModel).toBe('med-agent-team');
  });

  it('passes the picker selection as the per-request backend override', async () => {
    mockChatStream.mockImplementation(() => {});
    chatSessionStore.setState({
      selectedProfileId: 'team-med-checked',
    });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });

    expect(mockChatStream).toHaveBeenLastCalledWith(
      'patient-uuid',
      expect.anything(),
      'What meds?',
      expect.any(Object),
      expect.any(AbortController),
      'team-med-checked',
      'hub',
    );
  });

  it('passes the selected provider as the per-request override', async () => {
    mockChatStream.mockImplementation(() => {});
    chatSessionStore.setState({ selectedProviderId: 'hub' });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });

    expect(mockChatStream).toHaveBeenLastCalledWith(
      'patient-uuid',
      expect.anything(),
      'What meds?',
      expect.any(Object),
      expect.any(AbortController),
      'single-e4b-checked',
      'hub',
    );
  });

  // The single source of truth: one explicit `phase` per turn that mirrors the backend staged
  // SSE events. Everything else (composer lock, section split, DOM signals) derives from it.
  it('tracks the turn phase through the staged lifecycle', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q1?');
    });
    const cb = mockChatStream.mock.calls[0][3];
    const phase = () => result.current.messages[0].phase;

    expect(phase()).toBe('answering');

    act(() =>
      cb.onAnswerDone({
        answer: 'Aspirin [1].',
        references: [],
        answerValidation: { status: 'checking', label: 'Checking answer' },
        messageId: 'm-1',
      }),
    );
    expect(phase()).toBe('checking');

    act(() =>
      cb.onAnswerValidation({
        answer: 'Aspirin [1].',
        references: [],
        answerValidation: { status: 'checked', label: 'Checked' },
        messageId: 'm-1',
      }),
    );
    expect(phase()).toBe('settled');

    // answer_validation now carries final grounding, so the answer is already safe to preempt.
    // delivers the in-depth answer whole on indepth_done, it does not token-stream it.
    act(() =>
      cb.onInDepthPending({
        messageId: 'm-1',
        references: [
          {
            index: 1,
            resourceType: 'Order',
            resourceUuid: 'order-1',
            date: '2026-07-10',
            groundingStatus: 'verified',
          },
        ],
        inDepth: { status: 'pending', answer: '' },
      }),
    );
    expect(phase()).toBe('in-depth');
    expect(result.current.messages[0].references?.[0].groundingStatus).toBe('verified');

    act(() =>
      cb.onInDepthDone({
        references: [
          {
            index: 1,
            resourceType: 'Order',
            resourceUuid: 'order-1',
            date: '2026-07-10',
            sourceText: 'Aspirin order',
            groundingStatus: 'verified',
            groundingScope: 'record',
            usage: [{ location: 'answer', text: 'Aspirin [1].' }],
          },
        ],
        inDepth: { status: 'complete', answer: 'In-depth detail.' },
      }),
    );
    expect(phase()).toBe('settled');
    expect(result.current.messages[0].references?.[0]).toMatchObject({
      sourceText: 'Aspirin order',
      groundingScope: 'record',
      usage: [{ location: 'answer', text: 'Aspirin [1].' }],
    });
  });

  it('merges final evidence into the existing assistant row', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => result.current.submitQuestion('patient-uuid', 'Q?'));
    const cb = mockChatStream.mock.calls[0][3];
    act(() =>
      cb.onAnswerDone({
        answer: 'Aspirin [1].',
        references: [{ index: 1, groundingStatus: 'checking' }],
        messageId: 'm-1',
      }),
    );
    act(() =>
      cb.onEvidenceUpdated({
        answer: 'Aspirin [1].',
        references: [
          {
            index: 1,
            resourceType: 'Order',
            resourceUuid: 'order-1',
            resolutionStatus: 'resolved',
            groundingStatus: 'verified',
          },
        ],
        messageId: 'm-1',
      }),
    );

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].references[0]).toMatchObject({
      resourceUuid: 'order-1',
      groundingStatus: 'verified',
    });
  });

  it('ignores phase callbacks after the assistant row is terminal', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => result.current.submitQuestion('patient-uuid', 'Q?'));
    const cb = mockChatStream.mock.calls[0][3];
    act(() => cb.onDone({ answer: 'Done.', references: [], messageId: 'm-1' }));
    act(() => cb.onInDepthPending({ inDepth: { status: 'pending', answer: '' } }));

    expect(result.current.messages[0].phase).toBe('complete');
    expect(result.current.messages[0].inDepth).toBeUndefined();
  });

  it('preserves a needs-review in-depth outcome through error and final events', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => result.current.submitQuestion('patient-uuid', 'Q?'));
    const cb = mockChatStream.mock.calls[0][3];
    const withheld = {
      status: 'needs_review' as const,
      answer: '',
      error: 'All claims were withheld.',
      validation: { mode: 'enforce', status: 'needs_review' },
      reviewDraft: '- Rejected model claim [1].',
      reviewReferences: [
        {
          index: 1,
          resourceType: 'Observation',
          resourceUuid: 'obs-1',
          date: '2026-07-10',
          resolutionStatus: 'resolved' as const,
        },
      ],
    };
    act(() => cb.onAnswerDone({ answer: 'A.', references: [], messageId: 'm-1' }));
    act(() => cb.onInDepthPending({ inDepth: { status: 'pending', answer: '' } }));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].phase).toBe('in-depth');

    act(() => cb.onInDepthError({ inDepth: withheld }));
    expect(result.current.messages[0].inDepth).toEqual(withheld);
    expect(result.current.messages).toHaveLength(1);

    act(() => cb.onDone({ answer: 'A.', references: [], inDepth: withheld }));
    expect(result.current.messages[0].inDepth).toEqual(withheld);
    expect(result.current.messages[0].phase).toBe('complete');
  });

  it('settles immediately at answer_done when no validation is pending (no validator configured)', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q?');
    });
    // answer_done with NO answerValidation → no validation phase is coming; settle now so the composer
    // unlocks (mirrors the hub emitting answer_done without a `checking` status when no validator).
    act(() =>
      mockChatStream.mock.calls[0][3].onAnswerDone({
        answer: 'A [1].',
        references: [],
        inDepth: { status: 'pending', answer: '' },
        messageId: 'm-1',
      }),
    );

    expect(result.current.messages[0].phase).toBe('settled');
    expect(result.current.isAwaitingAnswer).toBe(false);
  });

  it('moves to error phase when answer generation fails', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() =>
      callbacks.onAnswerDone({
        answer: 'Partial answer.',
        references: [],
        answerValidation: { status: 'checking', label: 'Checking answer' },
      }),
    );
    act(() => callbacks.onError('Stream failed'));

    expect(result.current.messages[0].phase).toBe('error');
    expect(result.current.messages[0].answer).toBe('Partial answer.');
    expect(result.current.messages[0].answerValidation?.status).toBe('unavailable');
    // The stream failed before any indepth_pending event ever arrived, so In-Depth was never
    // shown as pending in the first place — there is nothing to mark "interrupted".
    expect(result.current.messages[0].inDepth).toBeUndefined();
  });

  it('marks a genuinely pending In-Depth as interrupted when the stream fails mid-flight', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() =>
      callbacks.onAnswerDone({
        answer: 'Partial answer.',
        references: [],
        answerValidation: { status: 'checking', label: 'Checking answer' },
      }),
    );
    act(() => callbacks.onInDepthPending({ inDepth: { status: 'pending', answer: '' } }));
    act(() => callbacks.onError('Stream failed'));

    expect(result.current.messages[0].inDepth).toEqual({
      status: 'failed',
      answer: '',
      error: 'In-Depth was interrupted.',
    });
  });

  // Interactive-first: the answer settles (answer + validation) BEFORE the terminal `done`, while
  // in-depth is still generating. isAwaitingAnswer must drop then (unlocking the composer) even
  // though the turn is still running through to `done`.
  it('drops isAwaitingAnswer once the answer settles while in-depth still generates', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q1?');
    });
    const cb = mockChatStream.mock.calls[0][3];

    // Still producing the answer → awaiting.
    expect(result.current.isAwaitingAnswer).toBe(true);
    expect(result.current.messages[0].phase).toBe('answering');

    act(() => {
      cb.onAnswerDone({ answer: 'A1', references: [], messageId: 'm-1' });
      cb.onAnswerValidation({
        answer: 'A1 checked',
        references: [],
        answerValidation: { status: 'checked', label: 'Checked' },
        messageId: 'm-1',
      });
      cb.onInDepthPending({ messageId: 'm-1', inDepth: { status: 'pending', answer: '' } });
    });

    // Answer settled + in-depth generating: composer unlocks, but the turn is still running.
    expect(result.current.isAwaitingAnswer).toBe(false);
    expect(result.current.messages[0].phase).toBe('in-depth');

    act(() => {
      cb.onDone({ answer: 'A1 checked', references: [], session: 's', messageId: 'm-1' });
    });
    expect(result.current.messages[0].phase).toBe('complete');
  });

  it('preempts the trailing in-depth when a new question is submitted after the answer settles', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q1?');
    });
    const firstController = mockChatStream.mock.calls[0][4] as AbortController;
    const cb1 = mockChatStream.mock.calls[0][3];

    act(() => {
      cb1.onAnswerDone({ answer: 'A1', references: [], messageId: 'm-1' });
      cb1.onAnswerValidation({
        answer: 'A1 checked',
        references: [],
        answerValidation: { status: 'checked', label: 'Checked' },
        messageId: 'm-1',
      });
      cb1.onInDepthPending({ messageId: 'm-1', inDepth: { status: 'pending', answer: 'Partial in-depth.' } });
    });

    // New question while in-depth generates → preempt the first turn and start the second.
    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q2?');
    });

    expect(mockChatStream).toHaveBeenCalledTimes(2);
    expect(firstController.signal.aborted).toBe(true);
    expect(result.current.messages).toHaveLength(2);

    // Q1 is finalized with an honest interrupted state (no perpetual spinner).
    const q1 = result.current.messages[0];
    expect(q1.phase).toBe('complete');
    expect(q1.answer).toBe('A1 checked');
    expect(q1.inDepth).toEqual({
      status: 'failed',
      answer: 'Partial in-depth.',
      error: 'In-Depth was interrupted.',
    });

    // Q2 is the new in-flight turn.
    const q2 = result.current.messages[1];
    expect(q2.question).toBe('Q2?');
    expect(q2.phase).toBe('answering');
    expect(result.current.isAwaitingAnswer).toBe(true);
  });

  it('preserves checked validation when a no-review profile preempts after final grounding', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q1?');
    });
    const firstController = mockChatStream.mock.calls[0][4] as AbortController;
    const cb1 = mockChatStream.mock.calls[0][3];

    act(() => {
      cb1.onAnswerDone({
        answer: 'A1',
        references: [{ index: 1, groundingStatus: 'checking' }],
        answerValidation: { status: 'checking', label: 'Checking answer' },
        messageId: 'm-1',
      });
      cb1.onInDepthPending({
        answer: 'A1',
        references: [{ index: 1, groundingStatus: 'verified' }],
        answerValidation: { status: 'checked', label: 'Checked' },
        messageId: 'm-1',
        inDepth: { status: 'pending', answer: '' },
      });
    });

    expect(result.current.messages[0].phase).toBe('in-depth');
    expect(result.current.messages[0].answerValidation?.status).toBe('checked');

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q2?');
    });

    expect(firstController.signal.aborted).toBe(true);
    expect(result.current.messages[0].answerValidation).toEqual({
      status: 'checked',
      label: 'Checked',
    });
    expect(result.current.messages[0].inDepth?.status).toBe('failed');
  });
});

/**
 * The answer-limit measurements (issue #26). Where they arrive from depends on the server:
 * with `chartsearchai.grounding.async=false` the `done` event carries them, and with it true
 * `done` is emitted before validation runs so they arrive only on the trailing `grounded`
 * event. A hook that reads `done` alone renders none of the disclosure on such a server.
 */
describe('useChartSearchAi answer-limit measurements', () => {
  const disclosure = {
    misattributedOrderCitations: [177, 166, 155],
    unstatedFindingSeverities: [350, 351],
    conditionRuleCoverage: 'absent',
    interactionPairs: { found: 18, reported: 10 },
    // The fifth measurement, added to the backend after the other four. It rides the same merge,
    // so listing it HERE is what gives it end-to-end streaming coverage: every test below that
    // asserts on `disclosure` now asserts this key survives the early-`done`-then-`grounded`
    // path, refuses to be erased by a later null, and is refused after a stop.
    activeOrderClaims: { stated: 5, uncited: 3 },
    // Not a limit, but it rides the same merge, so listing it here gives it the same coverage.
    orderStopDates: [{ citation: 350, stopDate: '2026-09-23' }],
    // Every key the merge carries is listed, for the same reason: a key left out of this object is
    // one whose loss between `done`, `grounded` and the message no test here can see.
    doseCeilingCoverage: 'unloaded',
    unfoundedFindingSeverities: [{ citation: 351, rating: 'Major' }],
    unfaithfullyRenderedCitations: [177],
    cautionLedOverWithholding: [{ citation: 350, rating: 'Major' }],
    interactionClaimPairs: { judged: 2, misattributedCitations: [166], unfounded: 1 },
    unsupportedEndedOrderClaims: ['Nevirapine'],
    unstatedSignificanceQualifiers: [46],
    answeredByTheModule: true,
    findingsStatedByTheModule: [55],
    asksWhetherSheHasTakenADrug: true,
  };

  it('covers every upstream answer-limit field across staged events', () => {
    expect(Object.keys(disclosure).sort()).toEqual(Object.keys(NO_ANSWER_LIMITS).sort());
  });

  async function startTurn() {
    mockChatStream.mockImplementation(() => {});
    const view = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());
    act(() => {
      view.result.current.submitQuestion('patient-uuid', 'Safe to start clarithromycin?');
    });
    return { ...view, callbacks: mockChatStream.mock.calls[0][3] };
  }

  it('starts a message with no measurement stated', async () => {
    const { result } = await startTurn();
    const msg = result.current.messages[0];
    expect(msg.misattributedOrderCitations).toBeNull();
    expect(msg.unstatedFindingSeverities).toBeNull();
    expect(msg.conditionRuleCoverage).toBeNull();
    expect(msg.interactionPairs).toBeNull();
    expect(msg.activeOrderClaims).toBeNull();
  });

  it('carries the measurements stated on answer_done onto the message', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onAnswerDone({ answer: 'No — [350].', references: [], ...disclosure });
    });
    expect(result.current.messages[0]).toMatchObject(disclosure);
  });

  it('keeps an empty measurement distinct from an absent one', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onAnswerDone({
        answer: 'Text.',
        references: [],
        misattributedOrderCitations: [],
        unstatedFindingSeverities: [],
        conditionRuleCoverage: 'absent',
      });
    });
    expect(result.current.messages[0].misattributedOrderCitations).toEqual([]);
    expect(result.current.messages[0].unstatedFindingSeverities).toEqual([]);
    expect(result.current.messages[0].conditionRuleCoverage).toBe('absent');
    expect(result.current.messages[0].interactionPairs).toBeNull();
    expect(result.current.messages[0].activeOrderClaims).toBeNull();
  });

  it('carries measurements that arrive only on the trailing evidence_updated event', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onAnswerDone({ answer: 'No — [350].', references: [], safetyWarnings: [] });
    });
    act(() => {
      callbacks.onEvidenceUpdated({
        answer: 'No — [350].',
        references: [
          { index: 350, resourceType: 'safety_finding', resourceUuid: 'interaction:Clarithromycin', date: '' },
        ],
        safetyWarnings: [{ type: 'interaction', drug: 'Clarithromycin', detail: 'x', severity: 'Major' }],
        ...disclosure,
      });
    });
    expect(result.current.messages[0]).toMatchObject(disclosure);
    expect(result.current.messages[0].safetyWarnings).toHaveLength(1);
    expect(result.current.messages[0].references).toHaveLength(1);
  });

  it('does not let a later event erase a measurement an earlier one stated', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onAnswerDone({ answer: 'Text.', references: [], ...disclosure });
    });
    act(() => {
      callbacks.onEvidenceUpdated({ answer: 'Text.', references: [], conditionRuleCoverage: null });
    });
    act(() => {
      callbacks.onDone({ answer: 'Text.', references: [] });
    });
    expect(result.current.messages[0]).toMatchObject(disclosure);
  });

  it('does not blank the citation list when a later event omits references', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onAnswerDone({
        answer: 'Has it [1]',
        references: [{ index: 1, resourceType: 'condition', resourceUuid: 'uuid-7', date: '2022-11-13' }],
      });
    });
    act(() => {
      callbacks.onEvidenceUpdated({
        answer: 'Has it [1]',
        interactionPairs: { found: 3, reported: 2 },
      } as AiSearchResponse);
    });
    expect(result.current.messages[0].references).toHaveLength(1);
    expect(result.current.messages[0].interactionPairs).toEqual({ found: 3, reported: 2 });
  });

  it('clears draft citations when answer validation supplies an authoritative empty list', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onAnswerDone({
        answer: 'Draft claim [1].',
        references: [{ index: 1, resourceType: 'condition', resourceUuid: 'uuid-7', date: '2022-11-13' }],
        answerValidation: { status: 'checking', label: 'Checking answer' },
      });
    });
    act(() => {
      callbacks.onAnswerValidation({
        answer: 'The checked answer makes no chart claim.',
        references: [],
        answerValidation: { status: 'edited', label: 'Updated after check' },
      });
    });

    expect(result.current.messages[0].references).toEqual([]);
  });

  it('does not let a trailing evidence_updated event dress up an answer the user stopped', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onToken('Clarithromycin inter');
    });
    act(() => {
      result.current.stopCurrent();
    });
    act(() => {
      callbacks.onEvidenceUpdated({
        answer: 'Clarithromycin interacts with warfarin [350].',
        references: [{ index: 350, resourceType: 'safety_finding', resourceUuid: 'x', date: '' }],
        safetyWarnings: [{ type: 'interaction', drug: 'Clarithromycin', detail: 'x', severity: 'Major' }],
        ...disclosure,
      });
    });
    const msg = result.current.messages[0];
    expect(msg.answer).toBe('Clarithromycin inter');
    expect(msg.references).toHaveLength(0);
    expect(msg.interactionPairs).toBeNull();
    expect(msg.conditionRuleCoverage).toBeNull();
    expect(msg.unstatedFindingSeverities).toBeNull();
  });

  it('persists the measurements the turn published and hydrates them on reload', async () => {
    mockFetchHistory.mockResolvedValueOnce({
      session: 'srv-session-1',
      messages: [
        { messageId: 'u-1', role: 'user', content: 'Q', createdAt: 1 },
        { messageId: 'a-1', role: 'assistant', content: 'A [350]', createdAt: 2, ...disclosure },
      ],
    });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]).toMatchObject(disclosure);
  });
});

describe('useChartSearchAi token streaming', () => {
  async function startTurn() {
    mockChatStream.mockImplementation(() => {});
    const view = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());
    act(() => {
      view.result.current.submitQuestion('patient-uuid', 'Summary?');
    });
    return { ...view, callbacks: mockChatStream.mock.calls[0][3] };
  }

  it('accumulates answer_delta tokens on the in-flight message while it is still answering', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onToken('Hello');
      callbacks.onToken(' world');
    });
    expect(result.current.messages[0].answer).toBe('Hello world');
    expect(result.current.messages[0].phase).toBe('answering');
  });

  it('lets answer_done state the whole answer over the accumulated tokens', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onToken('Hello wor');
    });
    act(() => {
      callbacks.onAnswerDone({ answer: 'Hello world.', references: [] });
    });
    expect(result.current.messages[0].answer).toBe('Hello world.');
    expect(result.current.messages[0].phase).toBe('settled');
  });

  it('renders a provider that sends no deltas exactly as before: the answer lands whole on answer_done', async () => {
    const { result, callbacks } = await startTurn();
    expect(result.current.messages[0].answer).toBe('');
    act(() => {
      callbacks.onAnswerDone({ answer: 'Whole answer.', references: [] });
    });
    expect(result.current.messages[0].answer).toBe('Whole answer.');
  });

  it('accumulates reasoning_delta and retains it for inspection after the answer', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onReasoning('Checking ');
      callbacks.onReasoning('the chart');
    });
    expect(result.current.messages[0].reasoning).toBe('Checking the chart');
    act(() => {
      callbacks.onAnswerDone({ answer: 'Done.', references: [] });
    });
    expect(result.current.messages[0].reasoning).toBe('Checking the chart');
  });

  it('accumulates preliminary preview reasoning on its own channel', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onPreliminary('Scanning ');
      callbacks.onPreliminary('recent records');
    });
    expect(result.current.messages[0].preliminaryReasoning).toBe('Scanning recent records');
    // The preview is NOT committed reasoning: keeping them apart is what lets the panel render one
    // as provisional and replace it with the other.
    expect(result.current.messages[0].reasoning ?? '').toBe('');
  });

  it('strips a preview citation marker even when it is split across frames', async () => {
    // The preview reasons over an independently-numbered top-K chart, so its [N] markers index
    // records the committed answer does not cite. Stripping after concatenation is what catches a
    // marker whose brackets arrive in different frames.
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onPreliminary('Aspirin [');
      callbacks.onPreliminary('2] looks relevant');
    });
    // The shared strip pattern consumes one space before the marker, so removing it leaves no
    // double space behind.
    expect(result.current.messages[0].preliminaryReasoning).toBe('Aspirin looks relevant');
  });

  it('lets committed reasoning replace the preview rather than continue it', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onPreliminary('Provisional guess');
    });
    act(() => {
      callbacks.onReasoning('Checking the chart');
    });
    expect(result.current.messages[0].preliminaryReasoning).toBe('');
    expect(result.current.messages[0].reasoning).toBe('Checking the chart');
  });

  it('lets the first answer token replace the preview too', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onPreliminary('Provisional guess');
    });
    act(() => {
      callbacks.onToken('The answer');
    });
    expect(result.current.messages[0].preliminaryReasoning).toBe('');
    expect(result.current.messages[0].answer).toBe('The answer');
  });

  it('ignores a token that arrives after the user stopped the turn', async () => {
    const { result, callbacks } = await startTurn();
    act(() => {
      callbacks.onToken('Partial');
    });
    act(() => {
      result.current.stopCurrent();
    });
    act(() => {
      callbacks.onToken(' answer');
    });
    expect(result.current.messages[0].answer).toBe('Partial');
  });
});

describe('useChartSearchAi after the panel closes', () => {
  it('does not resurrect an empty stopped message when a decoded done event arrives after unmount', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());
    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    unmount();
    act(() => {
      callbacks.onAnswerDone({ answer: 'Late answer.', references: [], conditionRuleCoverage: 'absent' });
      callbacks.onDone({ answer: 'Late answer.', references: [] });
    });
    const stored = chatSessionStore.getState().messagesByPatient['patient-uuid'];
    expect(stored).toEqual([]);
  });

  it('preserves a partial answer and ignores an error arriving after unmount', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());
    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onToken('Partial answer.');
    });
    unmount();
    act(() => {
      callbacks.onError('boom');
    });
    const stored = chatSessionStore.getState().messagesByPatient['patient-uuid'];
    expect(stored[0].phase).toBe('complete');
    expect(stored[0].answer).toBe('Partial answer.');
    expect(stored[0].error).toBeNull();
  });
});

describe('useChartSearchAi late events', () => {
  it('settles rather than throwing when done carries no reference list', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());
    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onDone({ answer: 'Text.' } as never);
    });
    expect(result.current.messages[0].phase).toBe('complete');
    expect(result.current.messages[0].references).toEqual([]);
    expect(() => result.current.messages[0].references.some(() => true)).not.toThrow();
  });

  it('does not let a done in the last chunk replace an answer the user stopped', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());
    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onToken('Partial answer');
    });
    act(() => {
      result.current.stopCurrent();
    });
    expect(result.current.messages[0].answer).toBe('Partial answer');
    act(() => {
      callbacks.onDone({ answer: 'THE FULL ANSWER', references: [] });
    });
    expect(result.current.messages[0].answer).toBe('Partial answer');
  });
});

describe('upstream reasoning and Stop behavior in conversations', () => {
  it('ingests no reasoning at all when showReasoning is off', () => {
    // The operator switch is enforced at INGESTION, not at the render: reasoning that will never
    // be drawn is reasoning there is no reason to hold on a message. Covers the preview channel
    // too — that is model reasoning as well, only earlier and less certain.
    (useConfig as Mock).mockReturnValue({ useStreaming: true, showReasoning: false });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];

    act(() => {
      callbacks.onPreliminary('Quick look: records mention aspirin.');
      callbacks.onReasoning('Scanning drug orders.');
      callbacks.onDone({ answer: 'Aspirin [1]', references: [], questionId: 'q-1' });
    });

    expect(result.current.messages[0].reasoning).toBe('');
    expect(result.current.messages[0].preliminaryReasoning).toBe('');
    // The answer itself is untouched by the switch.
    expect(result.current.messages[0].answer).toBe('Aspirin [1]');
  });

  it('keeps a stopped message that streamed reasoning but no answer', () => {
    // The stop that matters. The reasoning phase is the LONG one, so it is where a reader actually
    // presses Stop — often BECAUSE the notes were going somewhere they did not want — and the text
    // was on screen when they did. Removing the message deleted what they had just been shown,
    // which is the one case the disclosure exists for.
    //
    // A stop with nothing streamed still removes the bubble: see the test above, which reaches
    // this through the non-streaming path and so carries no reasoning.
    (useConfig as Mock).mockReturnValue({ useStreaming: true, showReasoning: true });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onReasoning('Scanning drug orders, then active problems.');
    });
    expect(result.current.messages[0].answer).toBe('');

    act(() => {
      result.current.stopCurrent();
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].reasoning).toBe('Scanning drug orders, then active problems.');
    expect(result.current.messages[0].phase).toBe('complete');
    expect(result.current.messages[0].answer).toBe('');
  });

  it('still removes a stopped message carrying only the provisional preview', () => {
    // The asymmetry is deliberate: the preview is never persisted (its [N] markers index the
    // focused chart, not the answer's records), so a message holding only that has nothing behind
    // its disclosure row — an empty bubble rather than something a reader can open.
    (useConfig as Mock).mockReturnValue({ useStreaming: true, showReasoning: true });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));

    act(() => {
      result.current.submitQuestion('patient-uuid', 'What meds?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onPreliminary('Quick look: records mention aspirin.');
    });
    expect(result.current.messages[0].preliminaryReasoning).toBe('Quick look: records mention aspirin.');

    act(() => {
      result.current.stopCurrent();
    });

    expect(result.current.messages).toHaveLength(0);
  });
});

describe('conversation streaming preference and optional capabilities', () => {
  it.each([
    ['bundled', true],
    ['bundled', false],
    ['hub', true],
    ['hub', false],
  ] as const)('keeps the %s conversation and profile with streaming %s', async (provider, useStreaming) => {
    (useConfig as Mock).mockReturnValue({ useStreaming, showReasoning: true });
    mockFetchHistory.mockResolvedValueOnce({ session: 'restored-session', provider, messages: [] });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() =>
      expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('restored-session'),
    );
    act(() => result.current.submitQuestion('patient-uuid', 'What medications?'));
    const request = mockChatStream.mock.calls[0];
    expect(request[1]).toBe('restored-session');
    expect(request[5]).toBe(provider === 'hub' ? 'single-e4b-checked' : undefined);
    expect(request[6]).toBe(provider);
    const callbacks = request[3];
    act(() => {
      callbacks.onToken('Partial');
      callbacks.onReasoning('Checking records');
    });
    expect(result.current.messages[0].answer).toBe(useStreaming ? 'Partial' : '');
    expect(result.current.messages[0].reasoning ?? '').toBe(useStreaming ? 'Checking records' : '');
    // The final response can omit every optional feature without inventing pending work or passed checks.
    act(() => {
      callbacks.onAnswerDone({ answer: 'Completed answer.', references: [] });
      callbacks.onDone({ answer: 'Completed answer.', references: [], session: 'restored-session' });
    });
    expect(result.current.messages[0]).toMatchObject({ answer: 'Completed answer.', phase: 'complete' });
    expect(result.current.messages[0].reasoning).toBe('Checking records');
    expect(result.current.messages[0].inDepth).toBeUndefined();
    expect(result.current.messages[0].answerValidation).toBeUndefined();
    expect(result.current.messages[0].safetyStatus).toBeUndefined();
    expect(result.current.isAwaitingAnswer).toBe(false);
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('restored-session');
    act(() => result.current.submitQuestion('patient-uuid', 'Next question'));
    expect(result.current.messages[0].answer).toBe('Completed answer.');
    expect(mockChatStream.mock.calls[1][1]).toBe('restored-session');
    expect(mockChatStream.mock.calls[1][6]).toBe(provider);
  });

  it('ends announced but unfinished review and In-Depth honestly when the turn finishes', async () => {
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());
    act(() => result.current.submitQuestion('patient-uuid', 'Question'));
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => {
      callbacks.onAnswerDone({
        answer: 'Usable answer.',
        references: [],
        answerValidation: { status: 'checking', label: 'Checking answer' },
      });
      callbacks.onInDepthPending({ inDepth: { status: 'pending', answer: '' } });
      callbacks.onDone({ answer: 'Usable answer.', references: [] });
    });
    expect(result.current.messages[0]).toMatchObject({
      answer: 'Usable answer.',
      phase: 'complete',
      answerValidation: { status: 'unavailable', summary: 'The answer check was interrupted before completion.' },
      inDepth: { status: 'failed', error: 'In-Depth was interrupted.' },
    });
    expect(result.current.isAwaitingAnswer).toBe(false);
  });
});

it('drops cached reasoning for all patients when the operator disables reasoning', () => {
  chatSessionStore.setState({
    messagesByPatient: {
      'patient-uuid': [
        {
          id: 'a',
          question: 'First question',
          answer: 'Shown answer',
          references: [],
          ...NO_ANSWER_LIMITS,
          phase: 'complete',
          error: null,
          reasoning: 'Earlier working notes',
        },
      ],
      'another-patient': [
        {
          id: 'b',
          question: 'Other question',
          answer: 'Other answer',
          references: [],
          ...NO_ANSWER_LIMITS,
          phase: 'complete',
          error: null,
          reasoning: 'Other working notes',
          preliminaryReasoning: 'Temporary preview',
        },
      ],
    },
  });
  const { rerender } = renderHook(() => useChartSearchAi('patient-uuid'));
  (useConfig as Mock).mockReturnValue({ useStreaming: true, showReasoning: false });
  rerender();
  const messages = chatSessionStore.getState().messagesByPatient;
  expect(messages['patient-uuid'][0]).toMatchObject({
    answer: 'Shown answer',
    reasoning: '',
    preliminaryReasoning: '',
  });
  expect(messages['another-patient'][0]).toMatchObject({
    answer: 'Other answer',
    reasoning: '',
    preliminaryReasoning: '',
  });
});

describe('reviewed conversation lifecycle', () => {
  it.each([true, false])('honors disabling reasoning during a turn with streaming %s', async (useStreaming) => {
    (useConfig as Mock).mockReturnValue({ useStreaming, showReasoning: true });
    const { result, rerender } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() =>
      expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-default'),
    );
    act(() => result.current.submitQuestion('patient-uuid', 'Question'));
    const callbacks = mockChatStream.mock.calls[0][3];
    act(() => callbacks.onReasoning('Early notes'));
    (useConfig as Mock).mockReturnValue({ useStreaming, showReasoning: false });
    rerender();
    act(() => {
      callbacks.onPreliminary('Late preview');
      callbacks.onReasoning('Late notes');
      callbacks.onAnswerDone({ answer: 'Supported answer', references: [] });
      callbacks.onDone({ answer: 'Supported answer', references: [] });
    });
    expect(result.current.messages[0]).toMatchObject({
      answer: 'Supported answer',
      phase: 'complete',
      reasoning: '',
      preliminaryReasoning: '',
    });
  });

  const strictWrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.StrictMode, null, children);

  it('restores history after StrictMode effect replay', async () => {
    mockFetchHistory.mockResolvedValue({
      session: 'restored-session',
      messages: [
        { messageId: 'user-1', role: 'user', content: 'Earlier question', createdAt: 1 },
        { messageId: 'answer-1', role: 'assistant', content: 'Earlier answer', createdAt: 2 },
      ],
    });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'), { wrapper: strictWrapper });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].answer).toBe('Earlier answer');
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('restored-session');
  });

  it('opens a new conversation after StrictMode effect replay', async () => {
    mockStartNewChat.mockResolvedValueOnce({ session: 'new-session', messages: [] });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'), { wrapper: strictWrapper });
    await act(async () => result.current.startNewChatSession('patient-uuid'));
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('new-session');
    expect(result.current.isAwaitingAnswer).toBe(false);
  });

  it.each(['onSession', 'onAnswerDone', 'onDone'])(
    'ignores an old %s after a new question preempts it',
    async (event) => {
      const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
      await waitFor(() =>
        expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-default'),
      );
      act(() => result.current.submitQuestion('patient-uuid', 'First question'));
      const oldCallbacks = mockChatStream.mock.calls[0][3];
      act(() => oldCallbacks.onAnswerDone({ answer: 'First answer', references: [] }));
      act(() => result.current.submitQuestion('patient-uuid', 'Second question'));
      expect(mockChatStream.mock.calls[0][4].signal.aborted).toBe(true);
      act(() =>
        oldCallbacks[event](
          event === 'onSession'
            ? 'stale-session'
            : {
                answer: 'Stale answer',
                references: [],
                session: 'stale-session',
              },
        ),
      );
      expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-default');
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].answer).toBe('First answer');
      expect(result.current.messages[1].question).toBe('Second question');
    },
  );

  it('ignores an old session callback after New chat clears its turn', async () => {
    mockStartNewChat.mockResolvedValueOnce({ session: 'new-session', messages: [] });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() =>
      expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-default'),
    );
    act(() => result.current.submitQuestion('patient-uuid', 'Old question'));
    const oldCallbacks = mockChatStream.mock.calls[0][3];
    await act(async () => result.current.startNewChatSession('patient-uuid'));
    act(() => oldCallbacks.onSession('stale-session'));
    expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('new-session');
    expect(result.current.messages).toHaveLength(0);
  });
});
