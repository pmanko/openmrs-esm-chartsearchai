import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useConfig } from '@openmrs/esm-framework';
import { fetchProfiles, type HubProfileMetadata } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import ModelPicker from './model-picker.component';

vi.mock('../api/chartsearchai', () => ({ fetchProfiles: vi.fn() }));

const mockFetch = fetchProfiles as Mock;
const mockUseConfig = useConfig as unknown as Mock;

const profile = (overrides: Partial<HubProfileMetadata>): HubProfileMetadata => ({
  id: 'single-e4b-checked',
  label: 'Fast checked answer (E4B)',
  staged: true,
  validation: true,
  temporal_enforcement: 'enforce',
  available: true,
  default: false,
  selection_priority: 10,
  topology: 'single',
  visibility: 'product',
  stages: ['context', 'answer', 'gate', 'review', 'indepth'],
  required_models: ['gemma-e4b'],
  context_window: 24576,
  exact_tokenizer: true,
  unavailable_reasons: [],
  ...overrides,
});

const PROFILE_DATA = {
  object: 'list',
  data: [
    profile({ default: true }),
    profile({ id: 'single-12b-checked', label: 'Checked answer (12B)', required_models: ['gemma-4-12b'] }),
    profile({ id: 'team-med-checked', label: 'Checked medical team', topology: 'team' }),
    profile({
      id: 'team-high-unavailable',
      label: 'High checked team',
      topology: 'team',
      available: false,
      unavailable_reasons: ['model_not_loaded:gemma-31b'],
    }),
    profile({ id: 'answer:gemma-e4b', label: 'Raw answer leg', visibility: 'internal' }),
  ],
};

const openMenu = async () => {
  const trigger = await screen.findByRole('button', { name: /Fast checked answer \(E4B\)/i });
  fireEvent.click(trigger);
  return screen.findByRole('menu');
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseConfig.mockReturnValue({ showModelPicker: true });
  chatSessionStore.setState({
    messagesByPatient: {},
    sessionUuidByPatient: {},
    selectedProfileId: null,
    profileDiscoveryStatus: 'loading',
  });
  mockFetch.mockReturnValue(new Promise(() => {}));
});

describe('ModelPicker', () => {
  it('renders nothing while metadata is loading or when disabled', () => {
    const { container, rerender } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();

    mockUseConfig.mockReturnValue({ showModelPicker: false });
    rerender(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an unavailable state and clears selection when profile discovery fails', async () => {
    chatSessionStore.setState({ selectedProfileId: 'stale-profile' });
    mockFetch.mockRejectedValueOnce(new Error('unavailable'));
    render(<ModelPicker />);

    expect(await screen.findByRole('status')).toHaveTextContent(/AI profiles unavailable/i);
    expect(chatSessionStore.getState().selectedProfileId).toBeNull();
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('unavailable');
  });

  it('uses the available hub-advertised default and authoritative labels', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);

    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('single-e4b-checked'));
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /Single profiles/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Team profiles/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Fast checked answer \(E4B\).*default/i })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: /Checked answer \(12B\)/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Checked medical team/i })).toBeInTheDocument();
    expect(screen.queryByText(/Raw answer leg/i)).not.toBeInTheDocument();
  });

  it('stores only the selected product profile id', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    const onSwitched = vi.fn();
    render(<ModelPicker onSwitched={onSwitched} />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Checked medical team/i }));
    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('team-med-checked'));
    expect(onSwitched).toHaveBeenCalledWith('team-med-checked');
  });

  it('shows unavailable product profiles as disabled metadata, not selectable models', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);
    await openMenu();

    expect(screen.getByRole('menuitem', { name: /High checked team.*unavailable/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByRole('menuitemradio', { name: /High checked team/i })).not.toBeInTheDocument();
  });

  it('replaces a stale or unavailable saved selection with the advertised default', async () => {
    chatSessionStore.setState({ selectedProfileId: 'team-high-unavailable' });
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);

    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('single-e4b-checked'));
  });

  it('does not invent a fallback when the hub advertises no available default', async () => {
    mockFetch.mockResolvedValueOnce({
      object: 'list',
      data: [
        profile({ available: false, default: false }),
        profile({ id: 'single-12b-checked', label: 'Checked answer (12B)', default: false }),
      ],
    });
    render(<ModelPicker />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(chatSessionStore.getState().selectedProfileId).toBeNull();
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('unavailable');
    expect(await screen.findByRole('status')).toHaveTextContent(/AI profiles unavailable/i);
  });

  it('portals the Carbon menu outside the picker subtree', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    const { container } = render(<ModelPicker />);
    const menu = await openMenu();
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });
});
