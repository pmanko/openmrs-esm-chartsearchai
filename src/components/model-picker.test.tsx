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
    const trigger = await screen.findByRole('button', { name: /select model/i });
    expect(trigger).toHaveTextContent('gemma-4-e2b-it');
  });

  it('opens the popover on click and lists all available models with the current one checked', async () => {
    mockFetch.mockResolvedValue(snapshot); // resolves on mount AND on open
    render(<ModelPicker />);
    const trigger = await screen.findByRole('button', { name: /select model/i });
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    // 3 option entries (one per available)
    expect(screen.getAllByRole('option')).toHaveLength(3);
    // The current model option carries aria-selected=true
    const selected = screen.getByRole('option', { selected: true });
    expect(selected).toHaveTextContent('gemma-4-e2b-it');
  });

  it('calls setCurrentModel on click and surfaces the new selection optimistically', async () => {
    mockFetch.mockResolvedValue(snapshot);
    mockSet.mockResolvedValueOnce({ current: 'google/gemma-4-31b' });
    const onSwitched = vi.fn();
    render(<ModelPicker onSwitched={onSwitched} />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    // The clickable target is the menu-item button inside the <li role=option>.
    fireEvent.click(screen.getByRole('button', { name: /google\/gemma-4-31b/i }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('google/gemma-4-31b'));
    expect(onSwitched).toHaveBeenCalledWith('google/gemma-4-31b');
  });

  it('rolls back the optimistic flip and surfaces an error when setCurrentModel fails', async () => {
    mockFetch.mockResolvedValue(snapshot);
    mockSet.mockRejectedValueOnce(new Error("Model 'bogus' is not in the active endpoint's /v1/models list."));
    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    fireEvent.click(screen.getByRole('button', { name: /google\/gemma-4-31b/i }));
    // After rollback, trigger goes back to original selection
    await waitFor(() => {
      const trigger = screen.getByRole('button', { name: /select model/i });
      expect(trigger).toHaveTextContent('gemma-4-e2b-it');
    });
    // Error notification visible
    expect(screen.getByText(/Failed to switch model/i)).toBeInTheDocument();
  });

  it('does NOT call setCurrentModel when the user clicks the currently-selected model', async () => {
    mockFetch.mockResolvedValue(snapshot);
    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    fireEvent.click(screen.getByRole('button', { name: /gemma-4-e2b-it/i }));
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

  it('renders an "LM Studio" section header above the model list', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    // The group header lives inside the listbox, NOT outside, so screen readers
    // announce it alongside the option list. Implementation MAY use a <li role="presentation"> with
    // aria-label, a section heading, or a plain <header> — the test just asserts
    // the visible "LM Studio" string lives within the open popover.
    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveTextContent(/LM Studio/i);
  });

  it('shows a "(not loaded)" affix on entries whose loaded flag is false', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    // Loaded entry: no affix
    const gemma = screen.getByRole('option', { name: /Gemma 3 12B/i });
    expect(gemma).not.toHaveTextContent(/not loaded/i);
    // Not-loaded entries: affix present
    const llama = screen.getByRole('option', { name: /Llama 3.1 8B Instruct/i });
    expect(llama).toHaveTextContent(/not loaded/i);
    const mistral = screen.getByRole('option', { name: /Mistral 7B Instruct/i });
    expect(mistral).toHaveTextContent(/not loaded/i);
  });

  it('uses displayName instead of raw id when an entry provides one', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    // Display name shown; raw id should NOT appear duplicated as visible text.
    expect(screen.getByRole('option', { name: /Gemma 3 12B/i })).toBeInTheDocument();
  });

  it('pre-loads via loadModel before calling setCurrentModel when target is not loaded', async () => {
    mockFetch.mockResolvedValue(lmStudioSnapshot);
    mockLoad.mockResolvedValueOnce({ loaded: 'meta-llama-3.1-8b-instruct' });
    mockSet.mockResolvedValueOnce({ current: 'meta-llama-3.1-8b-instruct' });

    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    // Click the menu-item button inside the option <li> — matches the older
    // interaction tests' pattern. The button aria-label includes "(not loaded)"
    // for affix-tagged entries, so the partial-match regex still finds it.
    fireEvent.click(screen.getByRole('button', { name: /Llama 3.1 8B Instruct/i }));

    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith('meta-llama-3.1-8b-instruct'));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('meta-llama-3.1-8b-instruct'));
    // Ordering: load happened before set
    expect(mockLoad.mock.invocationCallOrder[0]).toBeLessThan(mockSet.mock.invocationCallOrder[0]);
  });

  it('does NOT pre-load when the selected model is already loaded', async () => {
    // Switching from current (Llama, loaded) to another loaded model should
    // skip the load call — it's already in memory, just flip the GP.
    const altSnapshot = {
      ...lmStudioSnapshot,
      current: 'meta-llama-3.1-8b-instruct',
      entries: lmStudioSnapshot.entries.map((e) =>
        e.id === 'google/gemma-3-12b'
          ? { ...e, loaded: true }
          : e.id === 'meta-llama-3.1-8b-instruct'
            ? { ...e, loaded: true }
            : e,
      ),
    };
    mockFetch.mockResolvedValue(altSnapshot);
    mockSet.mockResolvedValueOnce({ current: 'google/gemma-3-12b' });

    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    fireEvent.click(screen.getByRole('button', { name: /Gemma 3 12B/i }));

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith('google/gemma-3-12b'));
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('does NOT render the LM Studio header when provider is generic-openai-compat', async () => {
    // Backward compat: when the backend probe falls back to /v1/models (e.g.
    // an Anthropic endpoint), no provider grouping should appear.
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
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    const listbox = screen.getByRole('listbox');
    expect(listbox).not.toHaveTextContent(/LM Studio/i);
  });

  it('still works against the legacy response shape (no provider, no entries)', async () => {
    // Older backend builds (PR #15 baseline) returned only {available: string[]}.
    // The picker must keep rendering correctly without the enriched fields.
    mockFetch.mockResolvedValue({
      engine: 'remote',
      current: 'one',
      available: ['one', 'two'],
      endpointUrl: 'http://host:1234/v1/chat/completions',
    });
    render(<ModelPicker />);
    fireEvent.click(await screen.findByRole('button', { name: /select model/i }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: /one/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /two/i })).toBeInTheDocument();
  });
});
