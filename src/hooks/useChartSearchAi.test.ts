import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConfig } from '@openmrs/esm-framework';
import { useChartSearchAi } from './useChartSearchAi';
import { chatPatientChartStream, fetchChatHistory, refreshChartSnapshot, startNewChat } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';

const mockUseConfig = useConfig as Mock;

vi.mock('../api/chartsearchai', () => ({
  chatPatientChartStream: vi.fn(),
  fetchChatHistory: vi.fn(),
  refreshChartSnapshot: vi.fn(),
  startNewChat: vi.fn(),
}));

const mockChatStream = chatPatientChartStream as Mock;
const mockFetchHistory = fetchChatHistory as Mock;
const mockRefreshSnapshot = refreshChartSnapshot as Mock;
const mockStartNewChat = startNewChat as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockUseConfig.mockReturnValue({ useStreaming: true });
  chatSessionStore.setState({ messagesByPatient: {}, sessionUuidByPatient: {}, selectedBackend: null });
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
        onToken: expect.any(Function),
        onDone: expect.any(Function),
        onError: expect.any(Function),
      }),
      expect.any(AbortController),
      // No per-session pick → null backend → server uses its config default.
      null,
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
      null,
    );
  });

  it('accumulates tokens into the last message during streaming', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Summary?');
    });
    const callbacks = mockChatStream.mock.calls[0][3];

    act(() => {
      callbacks.onToken('Hello');
      callbacks.onToken(' world');
    });

    expect(result.current.messages[0].answer).toBe('Hello world');
    expect(result.current.messages[0].phase).toBe('answering');
  });

  it('finalizes last message on streaming done with messageId as questionId', async () => {
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
    };

    act(() => {
      callbacks.onDone(finalResponse);
    });

    expect(result.current.messages[0].answer).toBe('Final answer.');
    expect(result.current.messages[0].references).toEqual(finalResponse.references);
    expect(result.current.messages[0].questionId).toBe('msg-final');
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
      secondCallbacks.onThinking('Still thinking...');
      secondCallbacks.onToken('Partial...');
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].answer).toBe('Partial...');

    act(() => {
      result.current.stopCurrent();
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].answer).toBe('Answer.');
    expect(result.current.messages[1].phase).toBe('complete');
    expect(result.current.messages[1].answer).toBe('Partial...');
    // The settled message keeps no leftover reasoning scratchpad (mirrors `done`).
    expect(result.current.messages[1].reasoning).toBe('');
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
    chatSessionStore.setState({ selectedBackend: { endpointUrl: 'http://hub/v1', modelName: 'med-agent-team' } });
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
      { endpointUrl: 'http://hub/v1', modelName: 'med-agent-team' },
    );
  });

  it('refreshClinicalContext appends an in-thread system notice on success', async () => {
    mockRefreshSnapshot.mockResolvedValue({ session: 'srv-session-1' });
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    await act(async () => {
      await result.current.refreshClinicalContext('patient-uuid');
    });

    expect(result.current.messages).toHaveLength(1);
    const notice = result.current.messages[0];
    expect(notice.kind).toBe('system');
    expect(notice.answer).toMatch(/clinical context refreshed/i);
    expect(notice.phase).toBe('complete');
  });

  it('refreshClinicalContext rejects without dropping a notice when the refresh fails', async () => {
    mockRefreshSnapshot.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    await expect(
      act(async () => {
        await result.current.refreshClinicalContext('patient-uuid');
      }),
    ).rejects.toThrow('boom');

    expect(result.current.messages).toHaveLength(0);
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

    act(() => cb.onToken('Aspirin'));
    expect(phase()).toBe('answering');

    act(() => cb.onAnswerDone({ answer: 'Aspirin [1].', references: [], messageId: 'm-1' }));
    expect(phase()).toBe('validating');

    act(() =>
      cb.onAnswerValidation({
        answer: 'Aspirin [1].',
        references: [],
        answerValidation: { status: 'checked', label: 'Checked' },
        messageId: 'm-1',
      }),
    );
    expect(phase()).toBe('settled');

    act(() => cb.onInDepthToken('In-depth detail.'));
    expect(phase()).toBe('in-depth');

    act(() => cb.onInDepthDone({ status: 'complete', answer: 'In-depth detail.' }));
    expect(phase()).toBe('complete');
  });

  it('moves to error phase when answer generation fails', async () => {
    mockChatStream.mockImplementation(() => {});
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    await waitFor(() => expect(mockFetchHistory).toHaveBeenCalled());

    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q?');
    });
    act(() => mockChatStream.mock.calls[0][3].onError('Stream failed'));

    expect(result.current.messages[0].phase).toBe('error');
  });

  // Interactive-first: the answer settles (answer + validation) BEFORE the terminal `done`, while
  // in-depth is still streaming. isAwaitingAnswer must drop then (unlocking the composer) even
  // though the turn is still streaming through to `done`.
  it('drops isAwaitingAnswer once the answer settles while in-depth still streams', async () => {
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
      cb.onInDepthToken('In-depth detail.');
    });

    // Answer settled + in-depth streaming: composer unlocks, but the turn is still streaming.
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
      cb1.onInDepthToken('Partial in-depth.');
    });

    // New question while in-depth streams → preempt the first turn and start the second.
    act(() => {
      result.current.submitQuestion('patient-uuid', 'Q2?');
    });

    expect(mockChatStream).toHaveBeenCalledTimes(2);
    expect(firstController.signal.aborted).toBe(true);
    expect(result.current.messages).toHaveLength(2);

    // Q1 is finalized, keeping the partial in-depth (marked complete, no perpetual spinner).
    const q1 = result.current.messages[0];
    expect(q1.phase).toBe('complete');
    expect(q1.answer).toBe('A1 checked');
    expect(q1.inDepth).toEqual({ status: 'complete', answer: 'Partial in-depth.' });

    // Q2 is the new in-flight turn.
    const q2 = result.current.messages[1];
    expect(q2.question).toBe('Q2?');
    expect(q2.phase).toBe('answering');
    expect(result.current.isAwaitingAnswer).toBe(true);
  });
});
