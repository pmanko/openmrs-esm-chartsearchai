import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useChartSearchAi } from './useChartSearchAi';
import { chatPatientChartStream, fetchChatHistory, startNewChat } from '../api/chartsearchai';
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
  chatSessionStore.setState({
    messagesByPatient: {},
    sessionUuidByPatient: {},
    selectedProfileId: 'single-e4b-checked',
    profileDiscoveryStatus: 'ready',
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
      expect.any(String),
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
      expect.any(String),
    );
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
    expect(mockStartNewChat).toHaveBeenCalledWith('patient-uuid');
    await waitFor(() => expect(chatSessionStore.getState().sessionUuidByPatient['patient-uuid']).toBe('srv-session-2'));
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
      expect.any(String),
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
    expect(phase()).toBe('complete');
    expect(result.current.messages[0].references?.[0]).toMatchObject({
      sourceText: 'Aspirin order',
      groundingScope: 'record',
      usage: [{ location: 'answer', text: 'Aspirin [1].' }],
    });
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
    act(() => {
      cb.onAnswerDone({ answer: 'A.', references: [], messageId: 'm-1' });
      cb.onInDepthError({ inDepth: withheld });
    });
    expect(result.current.messages[0].inDepth).toEqual(withheld);

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
