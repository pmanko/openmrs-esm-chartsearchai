/* eslint-disable testing-library/no-container */
import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useConfig } from '@openmrs/esm-framework';
import { fetchProfiles, type HubProfileMetadata } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import { PROFILE_DISCOVERY_RETRY_MS, stopHubProfileDiscovery } from '../hooks/hub-profile-discovery';
import ModelPicker from './model-picker.component';

vi.mock('../api/chartsearchai', () => ({ fetchProfiles: vi.fn() }));

const mockFetch = fetchProfiles as Mock;
const mockUseConfig = useConfig as unknown as Mock;

const profile = (overrides: Partial<HubProfileMetadata>): HubProfileMetadata => ({
  id: 'standard',
  label: 'Standard answer',
  staged: true,
  validation: true,
  temporal_enforcement: 'enforce',
  available: true,
  default: false,
  selection_priority: 20,
  topology: 'single',
  visibility: 'product',
  stages: ['answer', 'indepth'],
  required_models: ['gemma-4-12b'],
  context_window: 16384,
  exact_tokenizer: false,
  unavailable_reasons: [],
  ...overrides,
});

const PROFILE_DATA = {
  object: 'list',
  data: [
    profile({ id: 'quick', label: 'Quick answer', selection_priority: 10, staged: false, validation: false }),
    profile({ id: 'standard', label: 'Standard answer', default: true, selection_priority: 20 }),
    profile({
      id: 'verified',
      label: 'Cross-checked answer',
      selection_priority: 30,
      required_models: ['gemma-4-12b', 'qwen3.5-9b'],
    }),
    profile({
      id: 'verified-unavailable',
      label: 'Heavy cross-checked answer',
      selection_priority: 40,
      available: false,
      unavailable_reasons: ['model_unavailable:gemma-26b'],
    }),
    profile({ id: 'answer:gemma-4-12b', label: 'Raw answer leg', visibility: 'internal' }),
  ],
};

const openMenu = async () => {
  const trigger = await screen.findByRole('button', { name: /^AI profile: Standard answer$/i });
  fireEvent.click(trigger);
  return screen.findByRole('menu');
};

beforeEach(() => {
  stopHubProfileDiscovery();
  vi.clearAllMocks();
  mockUseConfig.mockReturnValue({ showModelPicker: true });
  chatSessionStore.setState({
    messagesByPatient: {},
    sessionUuidByPatient: {},
    selectedProfileId: null,
    profileExplicitlySelected: false,
    profileDiscoveryStatus: 'loading',
    hubProfiles: null,
    selectedProviderId: 'hub',
  });
  mockFetch.mockReturnValue(new Promise(() => {}));
});

describe('ModelPicker', () => {
  it('renders nothing while metadata is loading', () => {
    const { container } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows for a patient whose conversation runs on the Hub while the session selection is bundled', async () => {
    chatSessionStore.setState({
      selectedProviderId: 'bundled',
      sessionUuidByPatient: { 'hub-patient': 'session-1' },
      providerByPatient: { 'hub-patient': 'hub' },
    });
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker patientUuid="hub-patient" />);

    expect(await screen.findByTestId('chartsearchai-profile-picker')).toBeInTheDocument();
  });

  it('still discovers and selects the hub default when the picker is hidden', async () => {
    mockUseConfig.mockReturnValue({ showModelPicker: false });
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    const { container } = render(<ModelPicker />);

    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('standard'));
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an unavailable state and preserves selection when profile discovery fails', async () => {
    chatSessionStore.setState({ selectedProfileId: 'verified', profileExplicitlySelected: true });
    mockFetch.mockRejectedValueOnce(new Error('unavailable'));
    render(<ModelPicker />);

    expect(await screen.findByRole('status')).toHaveTextContent(/AI profiles unavailable/i);
    expect(chatSessionStore.getState().selectedProfileId).toBe('verified');
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('unavailable');
  });

  it('renders a flat list of configured presets using the default and authoritative labels', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);

    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('standard'));
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
    await openMenu();
    expect(screen.getByRole('group', { name: 'AI profile' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Single profiles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Team profiles' })).not.toBeInTheDocument();
    expect(screen.queryByText('Single profiles')).not.toBeInTheDocument();
    expect(screen.queryByText('Team profiles')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /^Quick answer$/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Standard answer.*default/i })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: /^Cross-checked answer$/i })).toBeInTheDocument();
    expect(screen.queryByText(/Raw answer leg/i)).not.toBeInTheDocument();
  });

  it('stores only the selected product profile id', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Cross-checked answer$/i }));
    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('verified'));
    expect(chatSessionStore.getState().profileExplicitlySelected).toBe(true);
  });

  it('never discovers profiles or changes provider for bundled inference', async () => {
    chatSessionStore.setState({ selectedProviderId: 'bundled' });
    const { container } = render(<ModelPicker />);

    await Promise.resolve();

    expect(container).toBeEmptyDOMElement();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(chatSessionStore.getState().selectedProviderId).toBe('bundled');
  });

  it('leaves the explicit hub provider selected when its profile changes', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Quick answer$/i }));

    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('quick'));
    expect(chatSessionStore.getState().selectedProviderId).toBe('hub');
  });

  it('lists only the presets currently advertised as available', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);
    const menu = await openMenu();

    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
    expect(menu).not.toHaveTextContent(/Heavy cross-checked answer/i);
    expect(menu).not.toHaveTextContent(/unavailable/i);
  });

  it('replaces a non-explicit unavailable selection with the advertised default', async () => {
    chatSessionStore.setState({ selectedProfileId: 'verified-unavailable', profileExplicitlySelected: false });
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);

    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('standard'));
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
  });

  it('keeps an explicit menu pick when a later discovery reports it unavailable and restores ready on recovery', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    const { unmount } = render(<ModelPicker />);
    await openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Cross-checked answer$/i }));
    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('verified'));
    unmount();

    mockFetch.mockResolvedValueOnce({
      object: 'list',
      data: [profile({ default: true }), profile({ id: 'verified', label: 'Cross-checked answer', available: false })],
    });
    const { unmount: unmountUnavailable } = render(<ModelPicker />);
    expect(
      await screen.findByRole('button', { name: /^AI profile: Cross-checked answer \(unavailable\)$/i }),
    ).toBeInTheDocument();
    expect(chatSessionStore.getState().selectedProfileId).toBe('verified');
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('selection-unavailable');
    unmountUnavailable();

    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);
    expect(await screen.findByRole('button', { name: /^AI profile: Cross-checked answer$/i })).toBeInTheDocument();
    expect(chatSessionStore.getState().selectedProfileId).toBe('verified');
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
  });

  it('requires manual selection when the hub advertises no available default', async () => {
    mockFetch.mockResolvedValueOnce({
      object: 'list',
      data: [
        profile({ available: false, default: true }),
        profile({ id: 'quick', label: 'Quick answer', default: false }),
      ],
    });
    render(<ModelPicker />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(chatSessionStore.getState().selectedProfileId).toBeNull();
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('unavailable');
    fireEvent.click(await screen.findByRole('button', { name: /^AI profile: Choose AI profile$/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Quick answer$/i }));
    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('quick'));
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
    expect(chatSessionStore.getState().selectedProviderId).toBe('hub');
  });

  it('portals the Carbon menu outside the picker subtree', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    const { container } = render(<ModelPicker />);
    const menu = await openMenu();
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });
  it('ignores a failed obsolete discovery after switching away from and back to Hub', async () => {
    let rejectOld: (error: Error) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
    );
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);
    act(() => chatSessionStore.setState({ selectedProviderId: 'bundled' }));
    act(() => chatSessionStore.setState({ selectedProviderId: 'hub' }));
    await waitFor(() => expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready'));
    await act(async () => rejectOld(new Error('obsolete request failed')));
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
    expect(chatSessionStore.getState().selectedProfileId).toBe('standard');
    expect(screen.getByRole('button', { name: /Standard answer/ })).toBeInTheDocument();
  });
  it('ignores a successful obsolete discovery after switching away from and back to Hub', async () => {
    let resolveOld: (data: typeof PROFILE_DATA) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    render(<ModelPicker />);
    act(() => chatSessionStore.setState({ selectedProviderId: 'bundled' }));
    act(() => chatSessionStore.setState({ selectedProviderId: 'hub' }));
    await waitFor(() => expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready'));
    const current = chatSessionStore.getState().hubProfiles;
    await act(async () =>
      resolveOld({
        object: 'list',
        data: [profile({ id: 'quick', label: 'Quick answer', default: true })],
      }),
    );
    expect(chatSessionStore.getState().hubProfiles).toBe(current);
    expect(chatSessionStore.getState().selectedProfileId).toBe('standard');
  });
  it('replaces an explicit pick that became unavailable with the default when the picker is hidden', async () => {
    mockUseConfig.mockReturnValue({ showModelPicker: false });
    chatSessionStore.setState({ selectedProfileId: 'verified-unavailable', profileExplicitlySelected: true });
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    const { unmount } = render(<ModelPicker />);

    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('standard'));
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
    expect(chatSessionStore.getState().profileExplicitlySelected).toBe(false);
    unmount();

    // Shown again, the automatic default is not held as the user's pick when it drops out.
    mockUseConfig.mockReturnValue({ showModelPicker: true });
    mockFetch.mockResolvedValueOnce({
      object: 'list',
      data: [
        profile({ available: false, default: true }),
        profile({ id: 'quick', label: 'Quick answer', default: true }),
      ],
    });
    render(<ModelPicker />);
    await waitFor(() => expect(chatSessionStore.getState().selectedProfileId).toBe('quick'));
    expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
  });
  it('retries discovery after a failed fetch and recovers while the panel stays open', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockRejectedValueOnce(new Error('hub down'));
      mockFetch.mockResolvedValueOnce(PROFILE_DATA);
      render(<ModelPicker />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('unavailable');
      expect(screen.getByRole('status')).toHaveTextContent(/AI profiles unavailable/i);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROFILE_DISCOVERY_RETRY_MS);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
      expect(chatSessionStore.getState().selectedProfileId).toBe('standard');
    } finally {
      vi.useRealTimers();
    }
  });
  it('reads profiles again when only the explicit pick dropped out, and restores ready on recovery', async () => {
    vi.useFakeTimers();
    try {
      chatSessionStore.setState({ selectedProfileId: 'verified', profileExplicitlySelected: true });
      mockFetch.mockResolvedValueOnce({
        object: 'list',
        data: [
          profile({ default: true }),
          profile({ id: 'verified', label: 'Cross-checked answer', available: false }),
        ],
      });
      mockFetch.mockResolvedValueOnce(PROFILE_DATA);
      render(<ModelPicker />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('selection-unavailable');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROFILE_DISCOVERY_RETRY_MS);
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(chatSessionStore.getState().selectedProfileId).toBe('verified');
      expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying once the picker is gone', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockRejectedValueOnce(new Error('hub down'));
      const { unmount } = render(<ModelPicker />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(chatSessionStore.getState().profileDiscoveryStatus).toBe('unavailable');
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROFILE_DISCOVERY_RETRY_MS * 3);
      });
      expect(mockFetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps the unavailable state when no product profile can be selected', async () => {
    mockFetch.mockResolvedValueOnce({ object: 'list', data: [profile({ available: false, default: true })] });
    render(<ModelPicker />);
    expect(await screen.findByRole('status')).toHaveTextContent(/AI profiles unavailable/i);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(chatSessionStore.getState().selectedProfileId).toBeNull();
  });

  it('shows a live In depth toggle when the active provider advertises indepth capability', async () => {
    mockFetch.mockResolvedValueOnce(PROFILE_DATA);
    chatSessionStore.setState({
      providerCapabilities: { hub: ['answer', 'indepth'], bundled: ['answer'] },
    });
    render(<ModelPicker />);
    const toggle = await screen.findByRole('switch', { name: /In depth/i });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(chatSessionStore.getState().inDepthEnabled).toBe(true);
    expect(toggle).toBeChecked();
  });

  it('omits the In depth toggle when the active provider lacks indepth capability', async () => {
    chatSessionStore.setState({
      selectedProviderId: 'bundled',
      providerCapabilities: { bundled: ['answer', 'token_streaming'] },
    });
    render(<ModelPicker />);
    expect(screen.queryByRole('switch', { name: /In depth/i })).not.toBeInTheDocument();
  });
});
