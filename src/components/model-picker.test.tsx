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
      models: [{ id: 'med-agent-team', displayName: 'med-agent-team', loaded: false }],
    },
  ],
  current: { endpointUrl: LM, modelName: 'gemma-4-e2b-it' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseConfig.mockReturnValue({ showModelPicker: true });
  mockFetch.mockReturnValue(new Promise(() => {})); // hang by default
});

async function openMenu() {
  await waitFor(() => screen.getByRole('button', { name: /select model/i }));
  fireEvent.click(screen.getByRole('button', { name: /select model/i }));
}

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
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('ModelPicker sections', () => {
  it('renders a section header per endpoint with its own models beneath', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu();
    expect(screen.getByText('LM Studio')).toBeInTheDocument();
    expect(screen.getByText('Med Agent Hub')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Gemma 4 e2b/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^med-agent-team$/i })).toBeInTheDocument();
  });

  it('marks the current endpoint+model as the selected option', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu();
    const selected = screen.getByRole('option', { selected: true });
    expect(selected).toHaveTextContent('Gemma 4 e2b');
  });

  it('shows "(not loaded)" only for an LM Studio model, not the generic team', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    render(<ModelPicker />);
    await openMenu();
    // MedGemma (lm-studio, loaded:false) -> affix; med-agent-team (generic) -> none.
    expect(screen.getByRole('button', { name: /MedGemma \(not loaded\)/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /med-agent-team \(not loaded\)/i })).toBeNull();
  });

  it('switching: selecting the team calls setEndpointModel(hubUrl, "med-agent-team")', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    mockSet.mockResolvedValue({ endpointUrl: HUB, current: 'med-agent-team' });
    render(<ModelPicker />);
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /^med-agent-team$/i }));
    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(HUB, 'med-agent-team'));
  });

  it('surfaces the backend reason when a switch fails', async () => {
    mockFetch.mockResolvedValue(TWO_SECTIONS);
    mockSet.mockRejectedValueOnce(
      Object.assign(new Error('Server responded with 400'), {
        responseBody: { error: "Model 'x' is not served by endpoint 'y'." },
      }),
    );
    render(<ModelPicker />);
    await openMenu();
    fireEvent.click(screen.getByRole('button', { name: /^med-agent-team$/i }));
    await waitFor(() => expect(screen.getByText(/not served by endpoint/i)).toBeInTheDocument());
  });
});
