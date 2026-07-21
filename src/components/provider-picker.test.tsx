import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchProviders, type ClinicalProviderDescriptor } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import ProviderPicker from './provider-picker.component';

vi.mock('../api/chartsearchai', () => ({ fetchProviders: vi.fn() }));

const mockFetch = fetchProviders as Mock;

const provider = (overrides: Partial<ClinicalProviderDescriptor>): ClinicalProviderDescriptor => ({
  id: 'bundled',
  label: 'Bundled (local)',
  enabled: true,
  ready: true,
  default: true,
  modes: ['query_scoped'],
  capabilities: [],
  unavailableReason: null,
  ...overrides,
});

const SINGLE = {
  defaultProvider: 'bundled',
  pickerVisible: false,
  providers: [provider({ default: true })],
};

const DUAL = {
  defaultProvider: 'bundled',
  pickerVisible: true,
  providers: [provider({ default: true }), provider({ id: 'hub', label: 'Med-Agent Hub', default: false })],
};

const openMenu = async () => {
  const trigger = await screen.findByRole('button', { name: /Bundled \(local\)/i });
  fireEvent.click(trigger);
  return screen.findByRole('menu');
};

beforeEach(() => {
  vi.clearAllMocks();
  chatSessionStore.setState({
    messagesByPatient: {},
    sessionUuidByPatient: {},
    selectedProfileId: null,
    profileDiscoveryStatus: 'loading',
    selectedProviderId: null,
  });
  mockFetch.mockReturnValue(new Promise(() => {}));
});

describe('ProviderPicker', () => {
  it('renders nothing while providers are loading', () => {
    const { container } = render(<ProviderPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when only one provider is configured', async () => {
    mockFetch.mockResolvedValueOnce(SINGLE);
    const { container } = render(<ProviderPicker />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
    // No implicit selection is written; the backend applies its default.
    expect(chatSessionStore.getState().selectedProviderId).toBeNull();
  });

  it('shows the provider menu with the default marked when multiple providers exist', async () => {
    mockFetch.mockResolvedValueOnce(DUAL);
    render(<ProviderPicker />);
    await openMenu();

    expect(screen.getByRole('menuitemradio', { name: /Bundled \(local\).*default/i })).toBeChecked();
    expect(screen.getByRole('menuitemradio', { name: /Med-Agent Hub/i })).toBeInTheDocument();
  });

  it('stores the selected provider and starts a new conversation on switch', async () => {
    mockFetch.mockResolvedValueOnce(DUAL);
    const onSwitched = vi.fn();
    render(<ProviderPicker onSwitched={onSwitched} />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Med-Agent Hub/i }));

    await waitFor(() => expect(chatSessionStore.getState().selectedProviderId).toBe('hub'));
    expect(onSwitched).toHaveBeenCalledWith('hub');
  });

  it('shows an unavailable provider as disabled, never a silent fallback', async () => {
    mockFetch.mockResolvedValueOnce({
      defaultProvider: 'bundled',
      pickerVisible: true,
      providers: [
        provider({ default: true }),
        provider({
          id: 'hub',
          label: 'Med-Agent Hub',
          default: false,
          ready: false,
          unavailableReason: 'hub_not_configured',
        }),
      ],
    });
    render(<ProviderPicker />);
    await openMenu();

    expect(screen.getByRole('menuitem', { name: /Med-Agent Hub.*unavailable/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.queryByRole('menuitemradio', { name: /Med-Agent Hub/i })).not.toBeInTheDocument();
  });

  it('does not start a new conversation when re-selecting the current provider', async () => {
    mockFetch.mockResolvedValueOnce(DUAL);
    const onSwitched = vi.fn();
    render(<ProviderPicker onSwitched={onSwitched} />);
    await openMenu();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Bundled \(local\).*default/i }));

    expect(onSwitched).not.toHaveBeenCalled();
  });
});
