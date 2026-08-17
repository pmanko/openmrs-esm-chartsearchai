import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfig, usePatient } from '@openmrs/esm-framework';
import AiSearchPanel from './ai-search-panel.component';
import { type ChatMessage } from '../hooks/useChartSearchAi';

const mockUseConfig = useConfig as Mock;
const mockUsePatient = usePatient as Mock;

const mockSubmitQuestion = vi.fn();
const mockClearMessages = vi.fn();
const mockStopCurrent = vi.fn();

let mockMessages: ChatMessage[] = [];
let mockIsAnyLoading = false;

vi.mock('../hooks/useChartSearchAi', () => ({
  useChartSearchAi: () => ({
    messages: mockMessages,
    isAnyLoading: mockIsAnyLoading,
    submitQuestion: mockSubmitQuestion,
    clearMessages: mockClearMessages,
    stopCurrent: mockStopCurrent,
  }),
}));

const mockStartListening = vi.fn();
const mockStopListening = vi.fn();
const mockClearSpeechError = vi.fn();
let mockIsListening = false;
let mockIsSpeechSupported = false;
let mockSpeechError: string | null = null;
let capturedOnResult: ((transcript: string) => void) | null = null;

vi.mock('../hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: (onResult: (transcript: string) => void) => {
    capturedOnResult = onResult;
    return {
      isListening: mockIsListening,
      isSupported: mockIsSpeechSupported,
      error: mockSpeechError,
      startListening: mockStartListening,
      stopListening: mockStopListening,
      clearError: mockClearSpeechError,
    };
  },
}));

vi.mock('../api/chartsearchai', async (importActual) => ({
  ...(await importActual<typeof import('../api/chartsearchai')>()),
  submitFeedback: vi.fn().mockResolvedValue(undefined),
}));

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    question: 'What meds is this patient on?',
    answer: 'The patient is on metformin.',
    references: [],
    safetyWarnings: [],
    questionId: 'q-1',
    isLoading: false,
    error: null,
    reasoning: '',
    ...overrides,
  };
}

beforeEach(() => {
  mockMessages = [];
  mockIsAnyLoading = false;
  mockIsListening = false;
  mockIsSpeechSupported = false;
  mockSpeechError = null;
  capturedOnResult = null;
  mockSubmitQuestion.mockClear();
  mockClearMessages.mockClear();
  mockStopCurrent.mockClear();
  mockStartListening.mockClear();
  mockStopListening.mockClear();
  mockClearSpeechError.mockClear();

  mockUseConfig.mockReturnValue({
    aiSearchPlaceholder: 'Ask AI about this patient...',
    maxQuestionLength: 1000,
    useStreaming: true,
  });

  mockUsePatient.mockReturnValue({
    patient: { id: 'test-patient-uuid' },
    isLoading: false,
    error: null,
    patientUuid: 'test-patient-uuid',
  });
});

describe('AiSearchPanel', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
  });

  it('renders the header and input', () => {
    render(<AiSearchPanel onClose={onClose} />);

    expect(screen.getByText('AI Chart Search')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Ask AI about this patient...')).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', async () => {
    const user = userEvent.setup();
    render(<AiSearchPanel onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('submits a question when the send button is clicked', async () => {
    const user = userEvent.setup();
    render(<AiSearchPanel onClose={onClose} />);

    const input = screen.getByPlaceholderText('Ask AI about this patient...');
    await user.type(input, 'What medications is this patient on?');
    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(mockSubmitQuestion).toHaveBeenCalledWith('test-patient-uuid', 'What medications is this patient on?');
  });

  it('clears the input after submitting', async () => {
    const user = userEvent.setup();
    render(<AiSearchPanel onClose={onClose} />);

    const input = screen.getByPlaceholderText('Ask AI about this patient...');
    await user.type(input, 'Any allergies?');
    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(input).toHaveValue('');
  });

  it('submits on Enter key press', async () => {
    const user = userEvent.setup();
    render(<AiSearchPanel onClose={onClose} />);

    const input = screen.getByPlaceholderText('Ask AI about this patient...');
    await user.type(input, 'Any allergies?{enter}');

    expect(mockSubmitQuestion).toHaveBeenCalledWith('test-patient-uuid', 'Any allergies?');
  });

  it('closes the panel when Escape is pressed', async () => {
    const user = userEvent.setup();
    render(<AiSearchPanel onClose={onClose} />);

    const input = screen.getByPlaceholderText('Ask AI about this patient...');
    await user.click(input);
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('disables send button when input is empty', () => {
    render(<AiSearchPanel onClose={onClose} />);

    const sendButton = screen.getByRole('button', { name: /send/i });
    expect(sendButton).toBeDisabled();
  });

  it('does not submit whitespace-only input', async () => {
    const user = userEvent.setup();
    render(<AiSearchPanel onClose={onClose} />);

    const input = screen.getByPlaceholderText('Ask AI about this patient...');
    await user.type(input, '   {enter}');

    expect(mockSubmitQuestion).not.toHaveBeenCalled();
  });

  it('shows loading indicator when the last message is loading with no answer yet', () => {
    mockMessages = [makeMessage({ answer: '', isLoading: true, questionId: '' })];
    mockIsAnyLoading = true;
    render(<AiSearchPanel onClose={onClose} />);

    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('shows stop button while loading', () => {
    mockMessages = [makeMessage({ answer: 'partial', isLoading: true })];
    mockIsAnyLoading = true;
    render(<AiSearchPanel onClose={onClose} />);

    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('calls stopCurrent when the stop button is clicked', async () => {
    mockMessages = [makeMessage({ answer: 'partial', isLoading: true })];
    mockIsAnyLoading = true;
    const user = userEvent.setup();
    render(<AiSearchPanel onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: /stop/i }));
    expect(mockStopCurrent).toHaveBeenCalled();
  });

  it('shows error message when a message has an error', () => {
    mockMessages = [makeMessage({ answer: '', error: 'Something went wrong' })];
    render(<AiSearchPanel onClose={onClose} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows no patient selected message when patient is unavailable', () => {
    mockUsePatient.mockReturnValue({
      patient: null,
      isLoading: false,
      error: null,
      patientUuid: null,
    });
    render(<AiSearchPanel onClose={onClose} />);

    expect(screen.getByText('No patient selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  describe('chat history', () => {
    it('renders a question bubble for each message', () => {
      mockMessages = [
        makeMessage({ id: 'a', question: 'First question?' }),
        makeMessage({ id: 'b', question: 'Second question?' }),
      ];
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.getByText('First question?')).toBeInTheDocument();
      expect(screen.getByText('Second question?')).toBeInTheDocument();
    });

    it('renders an answer bubble for each message', () => {
      mockMessages = [
        makeMessage({ id: 'a', question: 'Q1?', answer: 'Answer one.' }),
        makeMessage({ id: 'b', question: 'Q2?', answer: 'Answer two.' }),
      ];
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.getByText('Answer one.')).toBeInTheDocument();
      expect(screen.getByText('Answer two.')).toBeInTheDocument();
    });

    it('allows sending a second message without clearing history', async () => {
      mockMessages = [makeMessage({ id: 'a', question: 'First?', answer: 'First answer.' })];
      const user = userEvent.setup();
      render(<AiSearchPanel onClose={onClose} />);

      const input = screen.getByPlaceholderText('Ask AI about this patient...');
      await user.type(input, 'Second?{enter}');

      expect(mockSubmitQuestion).toHaveBeenCalledWith('test-patient-uuid', 'Second?');
      // History still visible
      expect(screen.getByText('First answer.')).toBeInTheDocument();
    });
  });

  describe('voice input', () => {
    beforeEach(() => {
      mockIsSpeechSupported = true;
    });

    it('shows mic button when speech is supported', () => {
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.getByRole('button', { name: /voice input/i })).toBeInTheDocument();
    });

    it('does not show mic button when speech is not supported', () => {
      mockIsSpeechSupported = false;
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.queryByRole('button', { name: /voice input/i })).not.toBeInTheDocument();
    });

    it('calls startListening when mic button is clicked', async () => {
      const user = userEvent.setup();
      render(<AiSearchPanel onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /voice input/i }));
      expect(mockStartListening).toHaveBeenCalled();
    });

    it('calls stopListening when active mic button is clicked', async () => {
      mockIsListening = true;
      const user = userEvent.setup();
      render(<AiSearchPanel onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /stop listening/i }));
      expect(mockStopListening).toHaveBeenCalled();
    });

    it('shows microphone permission error', () => {
      mockSpeechError = 'not-allowed';
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.getByText(/microphone access was denied/i)).toBeInTheDocument();
    });

    it('shows generic speech error', () => {
      mockSpeechError = 'network';
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.getByText(/speech recognition failed/i)).toBeInTheDocument();
    });

    it('auto-submits after speech result', () => {
      render(<AiSearchPanel onClose={onClose} />);

      act(() => {
        capturedOnResult?.('What are the allergies?');
      });

      expect(mockSubmitQuestion).toHaveBeenCalledWith('test-patient-uuid', 'What are the allergies?');
    });

    it('does not auto-submit speech result when a request is in flight', () => {
      mockIsAnyLoading = true;
      mockMessages = [makeMessage({ isLoading: true })];
      render(<AiSearchPanel onClose={onClose} />);

      act(() => {
        capturedOnResult?.('What are the allergies?');
      });

      expect(mockSubmitQuestion).not.toHaveBeenCalled();
    });

    it('hides mic button while loading', () => {
      mockIsAnyLoading = true;
      mockMessages = [makeMessage({ isLoading: true })];
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.queryByRole('button', { name: /voice input/i })).not.toBeInTheDocument();
    });
  });

  describe('feedback', () => {
    it('shows feedback widget when answer is complete', () => {
      mockMessages = [makeMessage({ answer: 'The patient has diabetes.', questionId: 'q-123' })];
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.getByText('Was this helpful?')).toBeInTheDocument();
    });

    it('does not show feedback widget while loading', () => {
      mockMessages = [makeMessage({ answer: 'partial', questionId: 'q-123', isLoading: true })];
      mockIsAnyLoading = true;
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.queryByText('Was this helpful?')).not.toBeInTheDocument();
    });

    it('shows thumbs up and thumbs down buttons', () => {
      mockMessages = [makeMessage({ answer: 'The patient has diabetes.', questionId: 'q-123' })];
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.getByRole('button', { name: 'Helpful' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Not helpful' })).toBeInTheDocument();
    });

    it('shows feedback widget for each completed message', () => {
      mockMessages = [
        makeMessage({ id: 'a', question: 'Q1?', answer: 'A1.', questionId: 'q-1' }),
        makeMessage({ id: 'b', question: 'Q2?', answer: 'A2.', questionId: 'q-2' }),
      ];
      render(<AiSearchPanel onClose={onClose} />);

      expect(screen.getAllByText('Was this helpful?')).toHaveLength(2);
    });

    it('shows thanks message after positive feedback', async () => {
      mockMessages = [makeMessage({ answer: 'The patient has diabetes.', questionId: 'q-123' })];
      const user = userEvent.setup();
      render(<AiSearchPanel onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: 'Helpful' }));
      expect(screen.getByText('Thanks for your feedback')).toBeInTheDocument();
    });

    it('shows comment form after negative feedback', async () => {
      mockMessages = [makeMessage({ answer: 'The patient has diabetes.', questionId: 'q-123' })];
      const user = userEvent.setup();
      render(<AiSearchPanel onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: 'Not helpful' }));
      expect(screen.getByPlaceholderText('What was wrong? (optional)')).toBeInTheDocument();
    });
  });
});
