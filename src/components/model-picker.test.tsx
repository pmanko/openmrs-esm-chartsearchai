import React from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelPicker from './model-picker.component';
import { fetchEndpoints, setEndpointModel } from '../api/chartsearchai';
import { useConfig } from '@openmrs/esm-framework';

vi.mock('@openmrs/esm-framework', () => ({
  useConfig: vi.fn(() => ({ showModelPicker: true })),
}));
vi.mock('../api/chartsearchai', () => ({
  fetchEndpoints: vi.fn(),
  setEndpointModel: vi.fn(),
}));

const mockFetch = fetchEndpoints as Mock;
const mockSet = setEndpointModel as Mock;
const mockUseConfig = useConfig as unknown as Mock;

const LM = 'http://lm/v1/chat/completions';
const HUB = 'http://hub/v1/chat/completions';

// LM Studio (current) with two models + Med Agent Hub with the single team choice.
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
  it('renders one accessible group per endpoint (LM Studio + Med Agent Hub)', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
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

  it('checks the current endpoint+model option', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    const checked = screen.getByRole('menuitemradio', { checked: true });
    expect(checked).toHaveTextContent('Gemma 4 e2b');
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

  it('switching: selecting the team calls setEndpointModel(hubUrl, "med-agent-team")', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    mockSet.mockResolvedValueOnce({ endpointUrl: HUB, current: 'med-agent-team' });
    const onSwitched = vi.fn();
    render(<ModelPicker onSwitched={onSwitched} />);
    await openMenu(/Gemma 4 e2b/i);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Med Agent Team/i }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(HUB, 'med-agent-team'));
    expect(onSwitched).toHaveBeenCalledWith('med-agent-team');
  });

  it('does NOT switch when the user picks the already-current model', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Gemma 4 e2b/i }));
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('surfaces the backend reason when a switch fails', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    mockSet.mockRejectedValueOnce(
      Object.assign(new Error('Server responded with 400'), {
        responseBody: { error: "Model 'x' is not served by endpoint 'y'." },
      }),
    );
    render(<ModelPicker />);
    await openMenu(/Gemma 4 e2b/i);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Med Agent Team/i }));
    await waitFor(() => expect(screen.getByText(/not served by endpoint/i)).toBeInTheDocument());
  });
});
