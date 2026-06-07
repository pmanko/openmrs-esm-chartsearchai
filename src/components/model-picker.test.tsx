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
const LLAMA = 'http://llama/v1/chat/completions';
const HUB = 'http://hub/v1/chat/completions';

// A realistic /endpoints payload: LM Studio + llama-server carry team-internal component
// models (qwen/medgemma/gemma-31b), quant/non-validated variants, and the GGUF single models;
// Med Agent Hub carries all 9 tiers. The curated picker must surface ONLY the validation arms
// (4 AI-team + 3 single), located by id across endpoints, and hide everything else.
const CURATED_DATA = {
  endpoints: [
    {
      label: 'LM Studio',
      url: LM,
      provider: 'lm-studio',
      reachable: true,
      current: false,
      models: [
        { id: 'qwen2.5-32b-instruct', displayName: 'Qwen 32B', loaded: true },
        { id: 'medgemma-27b-text-it-mlx', displayName: 'MedGemma 27B', loaded: true },
      ],
    },
    {
      label: 'llama-server',
      url: LLAMA,
      provider: 'generic-openai-compat',
      reachable: true,
      current: false,
      models: [
        { id: 'gemma-e4b', displayName: 'gemma-e4b', loaded: true },
        { id: 'gemma-4-12b', displayName: 'gemma-4-12b', loaded: true },
        { id: 'gemma-26b', displayName: 'gemma-26b', loaded: true },
        { id: 'gemma-31b', displayName: 'gemma-31b', loaded: true },
        { id: 'qwen3.6-35b', displayName: 'qwen3.6-35b', loaded: true },
      ],
    },
    {
      label: 'Med Agent Hub',
      url: HUB,
      provider: 'generic-openai-compat',
      reachable: true,
      current: false,
      models: [
        { id: 'med-agent-team-high-validated', displayName: 'high-validated', loaded: false },
        { id: 'med-agent-team-med-validated', displayName: 'med-validated', loaded: false },
        { id: 'med-agent-team-low-validated-12b', displayName: 'low-validated-12b', loaded: false },
        { id: 'med-agent-team-parity', displayName: 'parity', loaded: false },
        { id: 'med-agent-team-low', displayName: 'low', loaded: false },
        { id: 'med-agent-team-high', displayName: 'high', loaded: false },
      ],
    },
  ],
  // The config-controlled global default — gets the faded "(default)" tag.
  current: { endpointUrl: HUB, modelName: 'med-agent-team-med-validated' },
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

describe('ModelPicker curated sections', () => {
  it('renders the two curated group headers (AI Team / Single models), not raw endpoints', async () => {
    mockFetch.mockResolvedValue(CURATED_DATA);
    render(<ModelPicker />);
    await openMenu(/Med \(validated\)/i);
    expect(screen.getByRole('menuitem', { name: /AI Team/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Single models/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /AI Team/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Single models/i })).toBeInTheDocument();
    // Raw endpoint labels are no longer used as group headers.
    expect(screen.queryByRole('menuitem', { name: /^LM Studio$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /llama-server/i })).not.toBeInTheDocument();
  });

  it('lists exactly the 7 validation arms with human labels', async () => {
    mockFetch.mockResolvedValue(CURATED_DATA);
    render(<ModelPicker />);
    await openMenu(/Med \(validated\)/i);
    for (const name of [
      /High \(validated\)/i,
      /Med \(validated\)/i,
      /Low \(validated\)/i,
      /Parity/i,
      /Gemma 4B/i,
      /Gemma 12B/i,
      /Gemma 26B/i,
    ]) {
      expect(screen.getByRole('menuitemradio', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(7);
  });

  it('hides team-internal components, non-validated tiers, and the LM Studio line', async () => {
    mockFetch.mockResolvedValue(CURATED_DATA);
    render(<ModelPicker />);
    await openMenu(/Med \(validated\)/i);
    expect(screen.queryByRole('menuitemradio', { name: /qwen/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /medgemma/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /31b/i })).not.toBeInTheDocument();
  });

  it('checks + tags the config default tier ("Med (validated)"), and only that one', async () => {
    mockFetch.mockResolvedValue(CURATED_DATA);
    render(<ModelPicker />);
    await openMenu(/Med \(validated\)/i);
    const checked = screen.getByRole('menuitemradio', { checked: true });
    expect(checked).toHaveTextContent(/Med \(validated\)/i);
    expect(checked).toHaveTextContent(/default/i);
    expect(screen.getByRole('menuitemradio', { name: /High \(validated\)/i })).not.toHaveTextContent(/default/i);
  });

  it('selecting an AI-team tier writes the hub url + tier id as the per-session override', async () => {
    mockFetch.mockResolvedValue(CURATED_DATA);
    const onSwitched = vi.fn();
    render(<ModelPicker onSwitched={onSwitched} />);
    await openMenu(/Med \(validated\)/i);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /High \(validated\)/i }));
    await waitFor(() =>
      expect(chatSessionStore.getState().selectedBackend).toEqual({
        endpointUrl: HUB,
        modelName: 'med-agent-team-high-validated',
      }),
    );
    expect(onSwitched).toHaveBeenCalledWith('med-agent-team-high-validated');
  });

  it('selecting a single model resolves its serving endpoint (llama-server) by id', async () => {
    mockFetch.mockResolvedValue(CURATED_DATA);
    render(<ModelPicker />);
    await openMenu(/Med \(validated\)/i);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Gemma 12B/i }));
    await waitFor(() =>
      expect(chatSessionStore.getState().selectedBackend).toEqual({ endpointUrl: LLAMA, modelName: 'gemma-4-12b' }),
    );
  });

  it('portals the menu outside the picker subtree so the chat panel cannot clip it', async () => {
    mockFetch.mockResolvedValue(CURATED_DATA);
    const { container } = render(<ModelPicker />);
    await openMenu(/Med \(validated\)/i);
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });
});
