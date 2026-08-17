import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionMenuButton2, useConfig, userHasAccess } from '@openmrs/esm-framework';
import AiChatActionButton from './ai-chat-action-button.component';

vi.mock('@openmrs/esm-framework', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmrs/esm-framework')>();
  return {
    ...actual,
    useSession: vi.fn(() => ({ user: { uuid: 'user-uuid', privileges: [{ name: 'AI Query Patient Data' }] } })),
    userHasAccess: vi.fn(() => true),
  };
});

const mockUseConfig = useConfig as Mock;
const mockActionMenuButton2 = ActionMenuButton2 as Mock;
const mockUserHasAccess = userHasAccess as Mock;

describe('AiChatActionButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConfig.mockReturnValue({ chatLaunchMode: 'workspace' });
  });

  it('renders nothing when chatLaunchMode is "floating"', () => {
    mockUseConfig.mockReturnValue({ chatLaunchMode: 'floating' });
    const { container } = render(<AiChatActionButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the user lacks the AI Query Patient Data privilege', () => {
    mockUserHasAccess.mockReturnValueOnce(false);
    const { container } = render(<AiChatActionButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the action menu button when chatLaunchMode is "workspace"', () => {
    render(<AiChatActionButton />);
    expect(screen.getByText('Ask AI')).toBeInTheDocument();
  });

  it('renders the action menu button when chatLaunchMode is "both"', () => {
    mockUseConfig.mockReturnValue({ chatLaunchMode: 'both' });
    render(<AiChatActionButton />);
    expect(screen.getByText('Ask AI')).toBeInTheDocument();
  });

  it('passes the correct workspaceName to ActionMenuButton2', () => {
    render(<AiChatActionButton />);
    expect(mockActionMenuButton2).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceToLaunch: { workspaceName: 'ai-chat-workspace' },
      }),
      expect.anything(),
    );
  });
});
