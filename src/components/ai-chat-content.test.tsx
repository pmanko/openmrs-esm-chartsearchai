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
  default: ({ answer, error }: { answer: string; error: string | null }) => (
    <div data-testid="ai-response">{error ?? answer}</div>
  ),
}));

const mockUseConfig = useConfig as Mock;
const mockUsePatient = usePatient as Mock;
const mockUseChartSearchAi = useChartSearchAi as Mock;
const mockUseSpeechRecognition = useSpeechRecognition as Mock;

let mockSubmitQuestion: Mock;
let mockStopCurrent: Mock;
let mockStartNewChatSession: Mock;
let mockRefreshClinicalContext: Mock;
let speechCallback: ((transcript: string) => void) | null;

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmitQuestion = vi.fn();
  mockStopCurrent = vi.fn();
  mockStartNewChatSession = vi.fn();
  mockRefreshClinicalContext = vi.fn().mockResolvedValue(undefined);
  speechCallback = null;
  mockUseConfig.mockReturnValue({ aiSearchPlaceholder: 'Ask AI...', maxQuestionLength: 1000 });
  mockUsePatient.mockReturnValue({ patient: { id: 'p1' }, isLoading: false });
  mockUseChartSearchAi.mockReturnValue({
    messages: [],
    isAnyLoading: false,
    submitQuestion: mockSubmitQuestion,
    stopCurrent: mockStopCurrent,
    clearMessages: vi.fn(),
    startNewChatSession: mockStartNewChatSession,
    refreshClinicalContext: mockRefreshClinicalContext,
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

describe('AiChatContent', () => {
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

    it('does not submit while a request is in flight', async () => {
      mockUseChartSearchAi.mockReturnValue({
        messages: [],
        isAnyLoading: true,
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

    it('does not submit speech result when a request is in flight', () => {
      mockUseChartSearchAi.mockReturnValue({
        messages: [],
        isAnyLoading: true,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      act(() => speechCallback!('hello'));
      expect(mockSubmitQuestion).not.toHaveBeenCalled();
    });
  });

  describe('auto-scroll', () => {
    // Regression: when streaming ends, the AiResponsePanel mounts the references list
    // and feedback widget in the same React commit that flips isAnyLoading to false,
    // growing the message past the history-area viewport. The scroll effect must fire
    // on this transition so those new elements stay visible.
    it('scrolls history area to bottom when isAnyLoading transitions to false', () => {
      const streaming = {
        id: 'm1',
        question: 'Any allergies?',
        answer: 'partial',
        references: [],
        questionId: '',
        isLoading: true,
        error: null,
      };
      mockUseChartSearchAi.mockReturnValue({
        messages: [streaming],
        isAnyLoading: true,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });
      const { rerender } = render(<AiChatContent mode="workspace" patientUuid="p1" />);

      const log = screen.getByRole('log');
      Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
      log.scrollTop = 0;

      mockUseChartSearchAi.mockReturnValue({
        messages: [
          {
            ...streaming,
            answer: 'No known allergies.',
            references: [{ index: 1, resourceType: 'obs', resourceId: 1, date: '2026-01-01' }],
            isLoading: false,
          },
        ],
        isAnyLoading: false,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
      });
      rerender(<AiChatContent mode="workspace" patientUuid="p1" />);

      expect(log.scrollTop).toBe(1000);
    });
  });

  describe('header controls (reset / refresh / maximize)', () => {
    // Regression guard: New chat must be available even on an empty chat — it was
    // previously gated behind messages.length > 0, so you couldn't reset until
    // you'd already started a conversation.
    it('renders the New chat button even with no messages and calls startNewChatSession on click', async () => {
      const user = userEvent.setup();
      render(<AiChatContent mode="floating" patientUuid="p1" onClose={vi.fn()} />);
      const newChat = screen.getByRole('button', { name: /new chat/i });
      await user.click(newChat);
      expect(mockStartNewChatSession).toHaveBeenCalledWith('p1');
    });

    it('renders the Refresh clinical context button and refreshes on click', async () => {
      const user = userEvent.setup();
      render(<AiChatContent mode="floating" patientUuid="p1" onClose={vi.fn()} />);
      const refresh = screen.getByRole('button', { name: /refresh clinical context/i });
      await user.click(refresh);
      // Success feedback is an in-thread system notice the hook appends (see the
      // hook test); the component raises a banner only on failure. So on success
      // we assert the refresh fired but NO error banner is shown.
      expect(mockRefreshClinicalContext).toHaveBeenCalledWith('p1');
      expect(screen.queryByText(/could not refresh clinical context/i)).not.toBeInTheDocument();
    });

    it('renders an in-thread system notice (not a chat bubble) for a system message', () => {
      mockUseChartSearchAi.mockReturnValue({
        messages: [
          {
            id: 'sys-1',
            question: '',
            answer: 'Clinical context refreshed — the latest chart data is now available to the assistant.',
            references: [],
            questionId: '',
            isLoading: false,
            error: null,
            kind: 'system',
          },
        ],
        isAnyLoading: false,
        submitQuestion: mockSubmitQuestion,
        stopCurrent: mockStopCurrent,
        clearMessages: vi.fn(),
        startNewChatSession: mockStartNewChatSession,
        refreshClinicalContext: mockRefreshClinicalContext,
      });
      render(<AiChatContent mode="workspace" patientUuid="p1" />);
      expect(screen.getByRole('status')).toHaveTextContent(/clinical context refreshed/i);
      // A system notice is not a Q+A turn, so it must not mount an answer panel.
      expect(screen.queryByTestId('ai-response')).not.toBeInTheDocument();
    });

    it('surfaces an error notice when the refresh fails', async () => {
      mockRefreshClinicalContext.mockRejectedValueOnce(new Error('boom'));
      const user = userEvent.setup();
      render(<AiChatContent mode="floating" patientUuid="p1" onClose={vi.fn()} />);
      await user.click(screen.getByRole('button', { name: /refresh clinical context/i }));
      expect(await screen.findByText(/could not refresh clinical context/i)).toBeInTheDocument();
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
