import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelPicker from './model-picker.component';
import { fetchEndpoints } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import { useConfig } from '@openmrs/esm-framework';

// NB: do NOT vi.mock('@openmrs/esm-framework') here — the picker now reads the
// shared chatSessionStore via useStore, and the store module itself depends on
// createGlobalStore/getSessionStore. The vitest config already aliases the whole
// framework to its mock (real useStore/createGlobalStore, jest.fn useConfig), so
// we only stub the api layer and drive useConfig through its mock return value.
vi.mock('../api/chartsearchai', () => ({
  fetchEndpoints: vi.fn(),
}));

const mockFetch = fetchEndpoints as Mock;
const mockUseConfig = useConfig as unknown as Mock;

const LM = 'http://lm/v1/chat/completions';
const HUB = 'http://hub/v1/chat/completions';

// LM Studio (the config default) with two models + Med Agent Hub with the single team choice.
const TWO_SECTIONS = {
  endpoints: [
    {
      label: 'LM Studio',
      url: LM,
      provider: 'lm-studio',
      reachable: true,
      current: true,
      models: [
        { id: 'gemma-4-e2b-it', displayName: 'Gemma 4 e2b', loaded: true },
        { id: 'medgemma-1.5-4b-it', displayName: 'MedGemma', loaded: false },
      ],
    },
    {
      label: 'Med Agent Hub',
      url: HUB,
      provider: 'generic-openai-compat',
      reachable: true,
      current: false,
      models: [{ id: 'med-agent-team', displayName: 'Med Agent Team', loaded: false }],
    },
  ],
  // The config-controlled global default — gets the faded "(default)" tag.
  current: { endpointUrl: LM, modelName: 'gemma-4-e2b-it' },
};

// The picker is a Carbon MenuButton: the trigger is labelled "<endpoint> · <model>",
// and opening it portals a role="menu" to document.body whose models carry
// role="menuitemradio", grouped under a role="group" per endpoint.
const openMenu = async (triggerNeedle: RegExp) => {
  const trigger = await screen.findByRole('button', { name: triggerNeedle });
  fireEvent.click(trigger);
  return screen.findByRole('menu');
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseConfig.mockReturnValue({ showModelPicker: true });
  // Real store; reset to a clean slate (no per-session selection) each test.
  chatSessionStore.setState({ messagesByPatient: {}, sessionUuidByPatient: {}, selectedBackend: null });
  mockFetch.mockReturnValue(new Promise(() => {})); // hang by default
});

describe('ModelPicker visibility gates', () => {
  it('renders nothing during the initial load (no layout shift)', () => {
    const { container } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides when config.showModelPicker is false', () => {
    mockUseConfig.mockReturnValueOnce({ showModelPicker: false });
    const { container } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides when there are fewer than 2 selectable models across endpoints', async () => {
    mockFetch.mockResolvedValueOnce({
      endpoints: [
        {
          label: 'LM Studio',
          url: LM,
          provider: 'lm-studio',
          reachable: true,
          current: true,
          models: [{ id: 'only', displayName: 'Only', loaded: true }],
        },
      ],
      current: { endpointUrl: LM, modelName: 'only' },
    });
    const { container } = render(<ModelPicker />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('hides when /endpoints fetch fails (treats 503 / network errors as not-applicable)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Service unavailable'));
    const { container } = render(<ModelPicker />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ModelPicker endpoint sections', () => {
  it('renders a VISIBLE section header + an accessible group per endpoint', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    // Visible headers (disabled MenuItem, role=menuitem) — the thing the user sees.
    expect(screen.getByRole('menuitem', { name: /LM Studio/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Med Agent Hub/i })).toBeInTheDocument();
    // ...plus the accessible radio groups grouping each endpoint's models.
    expect(screen.getByRole('group', { name: /LM Studio/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Med Agent Hub/i })).toBeInTheDocument();
  });

  it('lists each endpoint\'s own models as radio options', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    expect(screen.getByRole('menuitemradio', { name: /Gemma 4 e2b/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /MedGemma/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Med Agent Team/i })).toBeInTheDocument();
  });

  it('falls back to the config default selection when nothing is picked yet', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    const checked = screen.getByRole('menuitemradio', { checked: true });
    expect(checked).toHaveTextContent('Gemma 4 e2b');
  });

  it('marks the config default with a faded "(default)" tag, and only that one', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    expect(screen.getByRole('menuitemradio', { name: /Gemma 4 e2b/i })).toHaveTextContent(/default/i);
    expect(screen.getByRole('menuitemradio', { name: /MedGemma/i })).not.toHaveTextContent(/default/i);
    expect(screen.getByRole('menuitemradio', { name: /Med Agent Team/i })).not.toHaveTextContent(/default/i);
  });

  it('shows "(not loaded)" only for an LM Studio model, not the generic team', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    expect(screen.getByRole('menuitemradio', { name: /MedGemma/i })).toHaveTextContent(/not loaded/i);
    expect(screen.getByRole('menuitemradio', { name: /Med Agent Team/i })).not.toHaveTextContent(/not loaded/i);
  });

  it('portals the menu outside the picker subtree so the chat panel cannot clip it', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    const { container } = render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it('selecting a model writes the per-session selectedBackend (no global default mutation)', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    const onSwitched = vi.fn();
    render(<ModelPicker onSwitched={onSwitched} />);
    await openMenu(/Gemma 4 e2b/i);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Med Agent Team/i }));

    // The selection is held client-side as a per-request override...
    await waitFor(() =>
      expect(chatSessionStore.getState().selectedBackend).toEqual({ endpointUrl: HUB, modelName: 'med-agent-team' }),
    );
    expect(onSwitched).toHaveBeenCalledWith('med-agent-team');
    // ...and the trigger reflects the new effective backend.
    expect(await screen.findByRole('button', { name: /Med Agent Team/i })).toBeInTheDocument();
  });

  it('selecting the config default model records it as the per-session selection', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Gemma 4 e2b/i }));
    await waitFor(() =>
      expect(chatSessionStore.getState().selectedBackend).toEqual({ endpointUrl: LM, modelName: 'gemma-4-e2b-it' }),
    );
  });
});
