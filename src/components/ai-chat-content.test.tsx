import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfig, usePatient } from '@openmrs/esm-framework';
import { useChartSearchAi } from '../hooks/useChartSearchAi';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import AiChatContent from './ai-chat-content.component';

vi.mock('../hooks/useChartSearchAi', () => ({
  useChartSearchAi: vi.fn(),
}));
vi.mock('../hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: vi.fn(),
}));
vi.mock('./ai-response-panel.component', () => ({
  __esModule: true,
  default: ({
    answer,
    error,
    safetyWarnings,
    safetyStatus,
  }: {
    answer: string;
    error: string | null;
    safetyWarnings?: Array<{ type: string; drug: string; detail: string }>;
    safetyStatus?: string;
  }) => (
    <div data-testid="ai-response">
      {error ?? answer}
      {safetyWarnings && safetyWarnings.length > 0 ? (
        <span data-testid="ai-response-safety">{safetyWarnings.map((w) => `${w.type}:${w.drug}`).join('|')}</span>
      ) : null}
      {safetyStatus ? <span data-testid="ai-response-safety-status">{safetyStatus}</span> : null}
    </div>
  ),
}));

const mockUseConfig = useConfig as Mock;
const mockUsePatient = usePatient as Mock;
const mockUseChartSearchAi = useChartSearchAi as Mock;
const mockUseSpeechRecognition = useSpeechRecognition as Mock;

let mockSubmitQuestion: Mock;
let mockStopCurrent: Mock;
let mockStartNewChatSession: Mock;
let speechCallback: ((transcript: string) => void) | null;

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmitQuestion = vi.fn();
  mockStopCurrent = vi.fn();
  mockStartNewChatSession = vi.fn();
  speechCallback = null;
  mockUseConfig.mockReturnValue({ aiSearchPlaceholder: 'Ask AI...', maxQuestionLength: 1000 });
  mockUsePatient.mockReturnValue({ patient: { id: 'p1' }, isLoading: false });
  mockUseChartSearchAi.mockReturnValue({
    messages: [],
    isAwaitingAnswer: false,
    submitQuestion: mockSubmitQuestion,
    stopCurrent: mockStopCurrent,
    clearMessages: vi.fn(),
    startNewChatSession: mockStartNewChatSession,
  });
  mockUseSpeechRecognition.mockImplementation((onResult) => {
    speechCallback = onResult;
    return {
      isListening: false,
      isSupported: true,
      error: null,
      startListening: vi.fn(),
      stopListening: vi.fn(),
      clearError: vi.fn(),
    };
  });
});

function message(overrides = {}) {
  return {
    id: 'm1',
    question: 'What meds?',
    answer: '',
    references: [],
    auditLogId: undefined,
    phase: 'answering',
    error: null,
    ...overrides,
  };
}

describe('AiChatContent', () => {
  it('shows a "Thinking..." indicator while the answer is generating (no answer yet)', () => {
    mockUseChartSearchAi.mockReturnValue({
      messages: [message({ phase: 'answering', answer: '' })],
      isAwaitingAnswer: true,
      submitQuestion: mockSubmitQuestion,
      stopCurrent: mockStopCurrent,
      clearMessages: vi.fn(),
    });
    render(<AiChatContent mode="workspace" />);

    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });

  it('drops the "Thinking..." indicator once answer text arrives', () => {
    mockUseChartSearchAi.mockReturnValue({
      messages: [message({ answer: 'Aspirin [1]' })],
      isAwaitingAnswer: true,
      submitQuestion: mockSubmitQuestion,
      stopCurrent: mockStopCurrent,
      clearMessages: vi.fn(),
    });
    render(<AiChatContent mode="workspace" />);

    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();
  });

  describe('submit guards', () => {
    it('does not submit when input is empty', async () => {
      const user = userEvent.setup();
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      await user.click(screen.getByRole('button', { name: /send/i }));
      expect(mockSubmitQuestion).not.toHaveBeenCalled();
    });

    it('does not submit when patientUuid is missing', async () => {
      mockUsePatient.mockReturnValue({ patient: null, isLoading: false });
      const user = userEvent.setup();
      render(<AiChatContent mode="floating" />);
      await user.type(screen.getByRole('textbox'), 'Hello');
      await user.keyboard('{Enter}');
      expect(mockSubmitQuestion).not.toHaveBeenCalled();
    });

    it('disables the composer while awaiting the answer', async () => {
      mockUseChartSearchAi.mockReturnValue({
        messages: [],
        isAwaitingAnswer: true,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      const input = screen.getByRole('textbox');
      expect(input).toBeDisabled();
    });

    it('submits and clears input on Enter', async () => {
      const user = userEvent.setup();
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      const input = screen.getByRole('textbox');
      await user.type(input, 'What meds?');
      await user.keyboard('{Enter}');
      expect(mockSubmitQuestion).toHaveBeenCalledWith('p1', 'What meds?');
      expect(input).toHaveValue('');
    });
  });

  describe('speech recognition', () => {
    it('appends transcript to existing text and auto-submits', async () => {
      const user = userEvent.setup();
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      await user.type(screen.getByRole('textbox'), 'Tell me about');
      act(() => speechCallback!('the patient'));
      expect(mockSubmitQuestion).toHaveBeenCalledWith('p1', 'Tell me about the patient');
    });

    it('does not submit speech result when patientUuid is missing', () => {
      mockUsePatient.mockReturnValue({ patient: null, isLoading: false });
      render(<AiChatContent mode="floating" />);
      act(() => speechCallback!('hello'));
      expect(mockSubmitQuestion).not.toHaveBeenCalled();
    });

    it('does not submit speech result while awaiting the answer', () => {
      mockUseChartSearchAi.mockReturnValue({
        messages: [],
        isAwaitingAnswer: true,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      act(() => speechCallback!('hello'));
      expect(mockSubmitQuestion).not.toHaveBeenCalled();
    });
  });

  // Interactive-first: once the answer + validation land (phase 'settled'), the composer unlocks
  // even though in-depth is still streaming. A new question can then be asked, which preempts the
  // trailing in-depth in the hook.
  describe('interactive-first composer (in-depth streaming in background)', () => {
    const settledWhileInDepth = () =>
      mockUseChartSearchAi.mockReturnValue({
        messages: [message({ answer: 'Aspirin [1].', phase: 'settled', inDepth: { status: 'pending', answer: '' } })],
        isAwaitingAnswer: false,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });

    it('keeps the composer enabled and shows Send (not Stop) once the answer settles', () => {
      settledWhileInDepth();
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      expect(screen.getByRole('textbox')).toBeEnabled();
      expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    });

    it('submits a new question while in-depth is still streaming (preempt path)', async () => {
      settledWhileInDepth();
      const user = userEvent.setup();
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      const input = screen.getByRole('textbox');
      await user.type(input, 'And allergies?');
      await user.keyboard('{Enter}');
      expect(mockSubmitQuestion).toHaveBeenCalledWith('p1', 'And allergies?');
    });
  });

  describe('auto-scroll', () => {
    it('brings the answer check back into view when checking finishes', () => {
      const streaming = {
        id: 'm1',
        question: 'Any allergies?',
        answer: 'No known allergies.',
        references: [],
        auditLogId: undefined,
        answerValidation: { status: 'checking' as const, label: 'Checking answer' },
        phase: 'checking' as const,
        error: null,
      };
      mockUseChartSearchAi.mockReturnValue({
        messages: [streaming],
        isAwaitingAnswer: true,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });
      const { rerender } = render(<AiChatContent mode="workspace" patientUuid="p1" />);
      const answerBubble = screen.getByTestId('latest-answer');
      const scrollIntoView = vi.fn();
      Object.defineProperty(answerBubble, 'scrollIntoView', { configurable: true, value: scrollIntoView });

      mockUseChartSearchAi.mockReturnValue({
        messages: [
          {
            ...streaming,
            answerValidation: {
              status: 'needs_review' as const,
              label: 'Needs review',
              summary: 'The answer could not be confirmed against the chart.',
            },
            references: [{ index: 1, resourceType: 'obs', resourceUuid: 'uuid-1', date: '2026-01-01' }],
            phase: 'complete',
          },
        ],
        isAwaitingAnswer: false,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });
      rerender(<AiChatContent mode="workspace" patientUuid="p1" />);

      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    });
  });

  describe('safety-warning forwarding', () => {
    it('forwards a message safetyWarnings to the response panel', () => {
      // The message-to-panel boundary must preserve warnings produced by the safety check.
      mockUseChartSearchAi.mockReturnValue({
        messages: [
          {
            id: 'm-sw',
            question: 'Is ibuprofen safe?',
            answer: 'Ibuprofen is an option [1].',
            references: [],
            safetyWarnings: [
              {
                type: 'contraindication',
                drug: 'Ibuprofen',
                detail: 'the patient has a recorded allergy to Ibuprofen',
              },
            ],
            auditLogId: 42,
            phase: 'complete',
            error: null,
          },
        ],
        isAwaitingAnswer: false,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });

      render(<AiChatContent mode="workspace" patientUuid="p1" />);

      expect(screen.getByTestId('ai-response-safety')).toHaveTextContent('contraindication:Ibuprofen');
    });

    it('forwards a message safetyStatus to the response panel even with no warnings', () => {
      // The message-to-panel boundary must preserve limited and unavailable safety states.
      mockUseChartSearchAi.mockReturnValue({
        messages: [
          {
            id: 'm-status',
            question: 'What medications is the patient on?',
            answer: 'Lisinopril 10 mg [1].',
            references: [],
            safetyWarnings: [],
            safetyStatus: 'unavailable',
            auditLogId: 42,
            phase: 'complete',
            error: null,
          },
        ],
        isAwaitingAnswer: false,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });

      render(<AiChatContent mode="workspace" patientUuid="p1" />);

      expect(screen.getByTestId('ai-response-safety-status')).toHaveTextContent('unavailable');
    });
  });
  describe('header controls (new chat / maximize)', () => {
    // New chat must be available even on an empty chat, before any conversation
    // has started.
    it('renders the New chat button even with no messages and calls startNewChatSession on click', async () => {
      const user = userEvent.setup();
      render(<AiChatContent mode="floating" patientUuid="p1" onClose={vi.fn()} />);
      const newChat = screen.getByRole('button', { name: /new chat/i });
      await user.click(newChat);
      expect(mockStartNewChatSession).toHaveBeenCalledWith('p1');
    });

    it('shows the maximize control only when onToggleExpand is provided, and toggles it', async () => {
      const onToggleExpand = vi.fn();
      const user = userEvent.setup();
      const { rerender } = render(<AiChatContent mode="floating" patientUuid="p1" onClose={vi.fn()} />);
      // No handler → no maximize control.
      expect(screen.queryByRole('button', { name: /maximize/i })).not.toBeInTheDocument();
      rerender(<AiChatContent mode="floating" patientUuid="p1" onClose={vi.fn()} onToggleExpand={onToggleExpand} />);
      await user.click(screen.getByRole('button', { name: /maximize/i }));
      expect(onToggleExpand).toHaveBeenCalled();
    });
  });
  describe('floating mode keyboard handling', () => {
    it('calls onClose when Escape is pressed', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<AiChatContent mode="floating" patientUuid="p1" onClose={onClose} />);
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalled();
    });

    it('does not call onClose on Escape in workspace mode', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<AiChatContent mode="workspace" patientUuid="p1" onClose={onClose} />);
      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
