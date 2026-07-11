import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AiFeedback from './ai-feedback.component';
import { submitFeedback } from '../api/chartsearchai';

vi.mock('../api/chartsearchai', () => ({
  submitFeedback: vi.fn(() => Promise.resolve()),
}));

const mockSubmitFeedback = submitFeedback as Mock;

const defaultProps = {
  auditLogId: 42,
};

beforeEach(() => {
  mockSubmitFeedback.mockClear();
});

describe('AiFeedback', () => {
  it('renders the "Was this helpful?" prompt with thumbs up and down buttons', () => {
    render(<AiFeedback {...defaultProps} />);

    expect(screen.getByText('Was this helpful?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not helpful' })).toBeInTheDocument();
  });

  it('submits positive feedback immediately and shows thanks message', async () => {
    const user = userEvent.setup();
    render(<AiFeedback {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /^helpful$/i }));

    await waitFor(() => {
      expect(screen.getByText('Thanks for your feedback')).toBeInTheDocument();
    });

    expect(mockSubmitFeedback).toHaveBeenCalledWith({
      auditLogId: 42,
      rating: 'positive',
    });
  });

  it('shows comment textarea when thumbs down is clicked', async () => {
    const user = userEvent.setup();
    render(<AiFeedback {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /not helpful/i }));

    expect(screen.getByPlaceholderText('What was wrong? (optional)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument();
    // Rating buttons should be gone
    expect(screen.queryByText('Was this helpful?')).not.toBeInTheDocument();
  });

  it('submits negative feedback with comment and shows thanks', async () => {
    const user = userEvent.setup();
    render(<AiFeedback {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /not helpful/i }));
    await user.type(screen.getByPlaceholderText('What was wrong? (optional)'), 'Answer was inaccurate');
    await user.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => {
      expect(screen.getByText('Thanks for your feedback')).toBeInTheDocument();
    });

    expect(mockSubmitFeedback).toHaveBeenCalledWith({
      auditLogId: 42,
      rating: 'negative',
      comment: 'Answer was inaccurate',
    });
  });

  it('submits negative feedback without comment when textarea is empty', async () => {
    const user = userEvent.setup();
    render(<AiFeedback {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /not helpful/i }));
    await user.click(screen.getByRole('button', { name: /submit/i }));

    await waitFor(() => {
      expect(screen.getByText('Thanks for your feedback')).toBeInTheDocument();
    });

    expect(mockSubmitFeedback).toHaveBeenCalledWith({
      auditLogId: 42,
      rating: 'negative',
      comment: undefined,
    });
  });

  it('shows an error and does not claim success if the API call fails', async () => {
    mockSubmitFeedback.mockRejectedValueOnce(new Error('Network error'));
    const user = userEvent.setup();
    render(<AiFeedback {...defaultProps} />);

    await user.click(screen.getByRole('button', { name: /^helpful$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Feedback could not be saved. Please try again.');
    });
    expect(screen.queryByText('Thanks for your feedback')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Helpful' })).toBeInTheDocument();
  });
});
