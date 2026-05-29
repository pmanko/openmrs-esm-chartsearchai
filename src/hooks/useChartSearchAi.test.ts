import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConfig } from '@openmrs/esm-framework';
import { useChartSearchAi } from './useChartSearchAi';
import { chatPatientChartStream, fetchChatHistory, startNewChat } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';

const mockUseConfig = useConfig as Mock;

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
  mockUseConfig.mockReturnValue({ useStreaming: true });
  chatSessionStore.setState({ messagesByPatient: {}, sessionUuidByPatient: {} });
  // Default: empty hydration so tests opt-in to populated history.
  mockFetchHistory.mockResolvedValue({ session: 'srv-session-default', messages: [] });
});

describe('useChartSearchAi', () => {
  it('returns empty messages and not loading initially', () => {
    const { result } = renderHook(() => useChartSearchAi('patient-uuid'));
    expect(result.current.messages).toEqual([]);
    expect(result.current.isAnyLoading).toBe(false);
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
    expect(result.current.messages[0].isLoading).toBe(true);
    expect(result.current.messages[0].answer).toBe('');
    expect(result.current.isAnyLoading).toBe(true);
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
    expect(result.current.messages[0].isLoading).toBe(true);
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
      references: [{ index: 1, resourceType: 'Obs', resourceId: 10, date: '2025-06-01' }],
      session: 'srv-session-1',
      messageId: 'msg-final',
    };

    act(() => {
      callbacks.onDone(finalResponse);
    });

    expect(result.current.messages[0].answer).toBe('Final answer.');
    expect(result.current.messages[0].references).toEqual(finalResponse.references);
    expect(result.current.messages[0].questionId).toBe('msg-final');
    expect(result.current.messages[0].isLoading).toBe(false);
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
      references: [{ index: 1, resourceType: 'order', resourceId: 100, date: '2024-01-01' }],
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
    expect(result.current.messages[0].isLoading).toBe(false);
    expect(result.current.isAnyLoading).toBe(false);
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
    expect(result.current.isAnyLoading).toBe(false);
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
      secondCallbacks.onToken('Partial...');
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].answer).toBe('Partial...');

    act(() => {
      result.current.stopCurrent();
    });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].answer).toBe('Answer.');
    expect(result.current.messages[1].isLoading).toBe(false);
    expect(result.current.messages[1].answer).toBe('Partial...');
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
});
