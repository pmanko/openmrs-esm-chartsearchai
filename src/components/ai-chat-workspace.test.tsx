import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AiChatWorkspace from './ai-chat-workspace.component';

vi.mock('./ai-chat-content.component', () => ({
  __esModule: true,
  default: ({ mode, patientUuid }: { mode: string; patientUuid: string }) => (
    <div data-testid="ai-chat-content" data-mode={mode} data-patient-uuid={patientUuid} />
  ),
}));

vi.mock('@openmrs/esm-framework', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmrs/esm-framework')>();
  return {
    ...actual,
    Workspace2: vi.fn(({ title, children }: { title: string; children: React.ReactNode }) => (
      <div data-testid="workspace2" data-title={title}>
        {children}
      </div>
    )),
  };
});

const baseProps = {
  groupProps: {
    patientUuid: 'test-patient-uuid',
    patient: {} as fhir.Patient,
    visitContext: undefined,
    mutateVisitContext: vi.fn(),
  },
};

describe('AiChatWorkspace', () => {
  it('renders Workspace2 with the correct title', () => {
    render(<AiChatWorkspace {...baseProps} />);
    expect(screen.getByTestId('workspace2')).toHaveAttribute('data-title', 'AI Chart Search');
  });

  it('renders AiChatContent with mode="workspace"', () => {
    render(<AiChatWorkspace {...baseProps} />);
    expect(screen.getByTestId('ai-chat-content')).toHaveAttribute('data-mode', 'workspace');
  });

  it('passes patientUuid from groupProps to AiChatContent', () => {
    render(<AiChatWorkspace {...baseProps} />);
    expect(screen.getByTestId('ai-chat-content')).toHaveAttribute('data-patient-uuid', 'test-patient-uuid');
  });
});
