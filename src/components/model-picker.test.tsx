import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelPicker from './model-picker.component';
import { fetchAvailableModels, setCurrentModel, loadModel } from '../api/chartsearchai';
import { useConfig } from '@openmrs/esm-framework';

vi.mock('@openmrs/esm-framework', () => ({
  useConfig: vi.fn(() => ({ showModelPicker: true })),
}));
vi.mock('../api/chartsearchai', () => ({
  fetchAvailableModels: vi.fn(),
  setCurrentModel: vi.fn(),
  loadModel: vi.fn(),
}));

const mockFetch = fetchAvailableModels as Mock;
const mockSet = setCurrentModel as Mock;
const mockLoad = loadModel as Mock;
const mockUseConfig = useConfig as unknown as Mock;

// The picker is a Carbon MenuButton: the trigger button is labelled with the
// current model, and opening it portals a `role="menu"` to document.body whose
// model options carry `role="menuitemradio"`.
const openMenu = async (currentModel: string) => {
  const trigger = await screen.findByRole('button', { name: new RegExp(currentModel.replace('/', '\\/'), 'i') });
  fireEvent.click(trigger);
  return screen.findByRole('menu');
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseConfig.mockReturnValue({ showModelPicker: true });
  // Default: fetch hangs. Individual tests can override before render().
  mockFetch.mockReturnValue(new Promise(() => {}));
});

describe('ModelPicker visibility gates', () => {
  it('renders nothing during the initial load (no layout shift)', () => {
    // beforeEach already mocked fetch to hang — verifies the no-snapshot path.
    const { container } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides when config.showModelPicker is false', () => {
    mockUseConfig.mockReturnValueOnce({ showModelPicker: false });
    // Even with a valid snapshot waiting, false config wins immediately.
    const { container } = render(<ModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides when engine is local', async () => {
    mockFetch.mockResolvedValueOnce({ engine: 'local', current: null, available: [] });
    const { container } = render(<ModelPicker />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('hides when fewer than 2 models are available', async () => {
    mockFetch.mockResolvedValueOnce({ engine: 'remote', current: 'only-one', available: ['only-one'] });
    const { container } = render(<ModelPicker />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('hides when /models fetch fails (treats 503 / network errors as not-applicable)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Service unavailable'));
    const { container } = render(<ModelPicker />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ModelPicker interaction', () => {
  const snapshot = {
    engine: 'remote' as const,
    current: 'gemma-4-e2b-it',
    available: ['gemma-4-e2b-it', 'google/gemma-4-31b', 'meta-llama-3.1-8b-instruct'],
    endpointUrl: 'http://host:1234/v1/chat/completions',
  };

  it('renders a trigger button showing the current model', async () => {
    mockFetch.mockResolvedValueOnce(snapshot);
    render(<ModelPicker />);
    const trigger = await screen.findByRole('button', { name: /gemma-4-e2b-it/i });
    expect(trigger).toHaveTextContent('gemma-4-e2b-it');
  });

  it('opens the menu and lists all available models with the current one checked', async () => {
    mockFetch.mockResolvedValue(snapshot);
    render(<ModelPicker />);
    await openMenu('gemma-4-e2b-it');
    // 3 radio options (one per available)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
    // The current model option carries aria-checked=true
    const selected = screen.getByRole('menuitemradio', { checked: true });
    expect(selected).toHaveTextContent('gemma-4-e2b-it');
  });

  it('portals the menu outside the picker subtree so the chat panel cannot clip it', async () => {
    // The clipping bug was the old absolute-positioned popover getting cut by the
    // chat panel's overflow:hidden. Carbon portals the menu to document.body — this
    // asserts the *mechanism* of the fix (jsdom can't compute the visual clip, but
    // it can prove the menu is rendered outside the clipping subtree).
    mockFetch.mockResolvedValue(snapshot);
    const { container } = render(<ModelPicker />);
    await openMenu('gemma-4-e2b-it');
    const menu = screen.getByRole('menu');
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it('calls setCurrentModel on select and surfaces the new selection optimistically', async () => {
    mockFetch.mockResolvedValue(snapshot);
    mockSet.mockResolvedValueOnce({ current: 'google/gemma-4-31b' });
    const onSwitched = vi.fn();
    render(<ModelPicker onSwitched={onSwitched} />);
    await openMenu('gemma-4-e2b-it');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /google\/gemma-4-31b/i }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('google/gemma-4-31b'));
    expect(onSwitched).toHaveBeenCalledWith('google/gemma-4-31b');
  });

  it('rolls back the optimistic flip and surfaces an error when setCurrentModel fails', async () => {
    mockFetch.mockResolvedValue(snapshot);
    mockSet.mockRejectedValueOnce(new Error("Model 'bogus' is not in the active endpoint's /v1/models list."));
    render(<ModelPicker />);
    await openMenu('gemma-4-e2b-it');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /google\/gemma-4-31b/i }));
    // After rollback, the trigger goes back to the original selection
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /gemma-4-e2b-it/i })).toBeInTheDocument();
    });
    // Error notification visible
    expect(screen.getByText(/Failed to switch model/i)).toBeInTheDocument();
  });

  it('does NOT call setCurrentModel when the user picks the currently-selected model', async () => {
    mockFetch.mockResolvedValue(snapshot);
    render(<ModelPicker />);
    await openMenu('gemma-4-e2b-it');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /gemma-4-e2b-it/i }));
    expect(mockSet).not.toHaveBeenCalled();
  });
});

// --- LM Studio sub-category + load-state + pre-load -------------------
// These tests pin the picker's behavior when the backend returned the
// LM Studio v1 enriched shape (provider='lm-studio' + per-entry state).

describe('ModelPicker with LM Studio provider grouping', () => {
  const lmStudioSnapshot = {
    engine: 'remote' as const,
    current: 'google/gemma-3-12b',
    available: ['google/gemma-3-12b', 'meta-llama-3.1-8b-instruct', 'mistral-7b-instruct'],
    endpointUrl: 'http://host.docker.internal:1234/v1/chat/completions',
    provider: 'lm-studio' as const,
    entries: [
      {
        id: 'google/gemma-3-12b',
        displayName: 'Gemma 3 12B',
        type: 'llm' as const,
        loaded: true,
        maxContextLength: 131072,
      },
      { id: 'meta-llama-3.1-8b-instruct', displayName: 'Llama 3.1 8B Instruct', type: 'llm' as const, loaded: false },
      { id: 'mistral-7b-instruct', displayName: 'Mistral 7B Instruct', type: 'llm' as const, loaded: false },
    ],
  };

  it('labels the radio group "LM Studio" (Carbon accessible group name)', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    render(<ModelPicker />);
    await openMenu('google/gemma-3-12b');
    // Carbon MenuItemRadioGroup exposes its label as the accessible name of the
    // `role="group"` element (aria-label), grouping the options for AT.
    expect(screen.getByRole('group', { name: /LM Studio/i })).toBeInTheDocument();
  });

  it('shows a "(not loaded)" affix on entries whose loaded flag is false', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    render(<ModelPicker />);
    await openMenu('google/gemma-3-12b');
    // Loaded entry: no affix
    const gemma = screen.getByRole('menuitemradio', { name: /Gemma 3 12B/i });
    expect(gemma).not.toHaveTextContent(/not loaded/i);
    // Not-loaded entries: affix present
    const llama = screen.getByRole('menuitemradio', { name: /Llama 3.1 8B Instruct/i });
    expect(llama).toHaveTextContent(/not loaded/i);
    const mistral = screen.getByRole('menuitemradio', { name: /Mistral 7B Instruct/i });
    expect(mistral).toHaveTextContent(/not loaded/i);
  });

  it('uses displayName instead of raw id when an entry provides one', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    render(<ModelPicker />);
    await openMenu('google/gemma-3-12b');
    expect(screen.getByRole('menuitemradio', { name: /Gemma 3 12B/i })).toBeInTheDocument();
  });

  it('pre-loads via loadModel before calling setCurrentModel when target is not loaded', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    mockLoad.mockResolvedValueOnce({ loaded: 'meta-llama-3.1-8b-instruct' });
    mockSet.mockResolvedValueOnce({ current: 'meta-llama-3.1-8b-instruct' });

    render(<ModelPicker />);
    await openMenu('google/gemma-3-12b');
    // The aria-label includes "(not loaded)" for affix-tagged entries, so the
    // partial-match regex still finds the option.
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Llama 3.1 8B Instruct/i }));

    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith('meta-llama-3.1-8b-instruct'));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('meta-llama-3.1-8b-instruct'));
    // Ordering: load happened before set
    expect(mockLoad.mock.invocationCallOrder[0]).toBeLessThan(mockSet.mock.invocationCallOrder[0]);
  });

  it('surfaces an actionable memory message and rolls back when pre-load fails on resources', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    // LM Studio refuses to load (RAM full, won't evict explicitly-loaded models).
    // The backend bubbles the real reason on responseBody.error (HTTP 503) — the
    // picker must show THAT, not the generic openmrsFetch "Service unavailable".
    mockLoad.mockRejectedValueOnce(
      Object.assign(new Error('Service unavailable'), {
        responseBody: {
          error: "Failed to pre-load model 'meta-llama-3.1-8b-instruct': HTTP 500: insufficient system resources",
        },
      }),
    );

    render(<ModelPicker />);
    await openMenu('google/gemma-3-12b');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Llama 3.1 8B Instruct/i }));

    // Actionable, resource-specific message — not the opaque generic error.
    expect(await screen.findByText(/not enough memory/i)).toBeInTheDocument();
    // Switch must NOT proceed to the GP flip when the model can't be loaded.
    expect(mockSet).not.toHaveBeenCalled();
    // Optimistic selection rolled back to the original current model.
    expect(screen.getByRole('button', { name: /google\/gemma-3-12b/i })).toBeInTheDocument();
  });

  it('does NOT pre-load when the selected model is already loaded', async () => {
    // Switching from current (Llama, loaded) to another loaded model should
    // skip the load call — it's already in memory, just flip the GP.
    const altSnapshot = {
      ...lmStudioSnapshot,
      current: 'meta-llama-3.1-8b-instruct',
      entries: lmStudioSnapshot.entries.map((e) =>
        e.id === 'meta-llama-3.1-8b-instruct' ? { ...e, loaded: true } : e,
      ),
    };
    mockFetch.mockResolvedValue(altSnapshot);
    mockSet.mockResolvedValueOnce({ current: 'google/gemma-3-12b' });

    render(<ModelPicker />);
    await openMenu('meta-llama-3.1-8b-instruct');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Gemma 3 12B/i }));

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('google/gemma-3-12b'));
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('does NOT label the group "LM Studio" when provider is generic-openai-compat', async () => {
    // Backward compat: when the backend probe falls back to /v1/models (e.g.
    // an Anthropic endpoint), no LM Studio grouping should appear.
    mockFetch.mockResolvedValue({
      engine: 'remote',
      current: 'claude-opus-4-7',
      available: ['claude-opus-4-7', 'claude-haiku-4-5'],
      endpointUrl: 'https://api.anthropic.com/v1/chat/completions',
      provider: 'generic-openai-compat',
      entries: [
        { id: 'claude-opus-4-7', displayName: 'claude-opus-4-7', type: 'llm', loaded: false },
        { id: 'claude-haiku-4-5', displayName: 'claude-haiku-4-5', type: 'llm', loaded: false },
      ],
    });
    render(<ModelPicker />);
    await openMenu('claude-opus-4-7');
    expect(screen.queryByRole('group', { name: /LM Studio/i })).not.toBeInTheDocument();
  });

  it('still works against the legacy response shape (no provider, no entries)', async () => {
    // Older backend builds returned only {available: string[]}. The picker must
    // keep rendering correctly without the enriched fields.
    mockFetch.mockResolvedValue({
      engine: 'remote',
      current: 'one',
      available: ['one', 'two'],
      endpointUrl: 'http://host:1234/v1/chat/completions',
    });
    render(<ModelPicker />);
    await openMenu('one');
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    expect(screen.getByRole('menuitemradio', { name: /one/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /two/i })).toBeInTheDocument();
  });
});
