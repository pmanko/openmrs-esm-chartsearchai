import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { getDefaultsFromConfigSchema, openmrsFetch, showSnackbar, useConfig } from '@openmrs/esm-framework';
import { configSchema } from '../config-schema';
import { stopHubProfileDiscovery } from '../hooks/hub-profile-discovery';
import { stopSystemProviderDiscovery } from '../hooks/system-provider-discovery';
import { OMNIBAR_SELECTED_EVENT, type OmnibarContext } from '../omnibar-contract/types';
import { chatSessionStore, initialChatSessionState } from '../store/chat-session.store';
import ChartSearchModelProvider from './model-profile.provider';
import {
  CHARTSEARCH_MODEL_PROVIDER_ID,
  PROFILE_RESULT_PREFIX,
  resetOmnibarProfileNotifications,
  setupOmnibarProfileSelectionListener,
} from './omnibar-profile-selection';
import { withProviderBoundary } from './provider-boundary';

const mockOpenmrsFetch = openmrsFetch as Mock;
const mockShowSnackbar = showSnackbar as Mock;
const mockUseConfig = useConfig as Mock;

const DEFAULT_CONFIG = {
  ...getDefaultsFromConfigSchema(configSchema),
  showModelPicker: true,
};

const HUB_MODELS = [
  {
    id: 'gemma-4-12b',
    label: 'Gemma 4 12B',
    description: 'Single-call clinical answer on Gemma 4 12B',
    visibility: 'product',
    available: true,
    default: true,
    selection_priority: 10,
  },
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B (Fast)',
    description: 'Single-call clinical answer on Gemma 4 E4B',
    visibility: 'product',
    available: true,
    default: false,
    selection_priority: 20,
  },
  {
    id: 'qwen-3.5-9b',
    label: 'Qwen 3.5 9B',
    description: 'Single-call clinical answer on Qwen 3.5 9B',
    visibility: 'product',
    available: true,
    default: false,
    selection_priority: 30,
  },
];

function mockHubDiscovery(models = HUB_MODELS) {
  mockOpenmrsFetch.mockImplementation((url: string) => {
    if (url.includes('/ws/rest/v1/chartsearchai/providers')) {
      return Promise.resolve({
        data: {
          providers: [{ id: 'hub', name: 'Med-Agent Hub', enabled: true, ready: true }],
          defaultProvider: 'hub',
          pickerVisible: false,
        },
      });
    }
    if (url.includes('/ws/rest/v1/chartsearchai/models')) {
      return Promise.resolve({ data: { object: 'list', data: models } });
    }
    return Promise.resolve({ data: {} });
  });
}

describe('ChartSearchModelProvider (/model Omnibar command)', () => {
  let teardownListener: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    stopHubProfileDiscovery();
    stopSystemProviderDiscovery();
    chatSessionStore.setState(initialChatSessionState());
    mockUseConfig.mockReturnValue(DEFAULT_CONFIG);
    resetOmnibarProfileNotifications();
    teardownListener?.();
    teardownListener = null;
  });

  it('reports empty results without fetching /models for plain-text omnibar queries', async () => {
    mockHubDiscovery();
    const report = vi.fn();
    const context: OmnibarContext = { scope: 'patient', patientUuid: 'patient-1', locale: 'en' };

    render(<ChartSearchModelProvider query="hiv" context={context} report={report} />);

    await waitFor(() =>
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'hiv',
          status: 'ready',
          results: [],
        }),
      ),
    );
    expect(mockOpenmrsFetch).not.toHaveBeenCalledWith('/ws/rest/v1/chartsearchai/models', expect.anything());
  });

  it('lists all 3 model-named Hub presets under /model, filters by query, and applies selection with snackbar', async () => {
    mockHubDiscovery();
    teardownListener = setupOmnibarProfileSelectionListener();
    const report = vi.fn();
    const context: OmnibarContext = {
      scope: 'patient',
      patientUuid: 'patient-1',
      locale: 'en',
      command: { id: 'model' },
    };

    const { rerender } = render(<ChartSearchModelProvider query="" context={context} report={report} />);

    await waitFor(() => {
      const latest = report.mock.calls.at(-1)?.[0];
      expect(latest?.status).toBe('ready');
      expect(latest?.results).toHaveLength(3);
    });

    const initialResults = report.mock.calls.at(-1)![0].results!;
    expect(initialResults.map((result: { id: string }) => result.id)).toEqual([
      `${PROFILE_RESULT_PREFIX}gemma-4-12b`,
      `${PROFILE_RESULT_PREFIX}gemma-4-e4b`,
      `${PROFILE_RESULT_PREFIX}qwen-3.5-9b`,
    ]);
    expect(initialResults[0].title).toBe('Gemma 4 12B (default)');
    expect(initialResults[0].subtitle).toBe('Active · Single-call clinical answer on Gemma 4 12B');
    expect(initialResults[0].target).toEqual({ type: 'navigate', to: '/' });

    rerender(<ChartSearchModelProvider query="qwen" context={context} report={report} />);
    await waitFor(() => {
      const latest = report.mock.calls.at(-1)?.[0];
      expect(latest?.query).toBe('qwen');
      expect(latest?.results).toHaveLength(1);
      expect(latest?.results[0].id).toBe(`${PROFILE_RESULT_PREFIX}qwen-3.5-9b`);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(OMNIBAR_SELECTED_EVENT, {
          detail: {
            providerId: CHARTSEARCH_MODEL_PROVIDER_ID,
            resultId: `${PROFILE_RESULT_PREFIX}qwen-3.5-9b`,
          },
        }),
      );
    });

    expect(chatSessionStore.getState().selectedProfileId).toBe('qwen-3.5-9b');
    expect(chatSessionStore.getState().profileExplicitlySelected).toBe(true);
    expect(mockShowSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'success',
        title: 'Default model set to Qwen 3.5 9B',
      }),
    );

    await waitFor(() => {
      const latest = report.mock.calls.at(-1)?.[0];
      expect(latest?.results[0].subtitle).toBe('Active · Single-call clinical answer on Qwen 3.5 9B');
    });

    teardownListener();
    teardownListener = null;
  });

  it('wraps ChartSearchModelProvider in withProviderBoundary and catches provider render errors without propagating', async () => {
    mockHubDiscovery();
    const report = vi.fn();
    const context: OmnibarContext = {
      scope: 'patient',
      patientUuid: 'patient-1',
      locale: 'en',
      command: { id: 'model' },
    };
    const BoundedProvider = withProviderBoundary(ChartSearchModelProvider, 'chartsearch-model-provider');

    render(<BoundedProvider query="" context={context} report={report} />);

    await waitFor(() => {
      const latest = report.mock.calls.at(-1)?.[0];
      expect(latest?.status).toBe('ready');
      expect(latest?.results).toHaveLength(3);
    });

    const ThrowingProvider: React.FC = () => {
      throw new Error('boom');
    };
    const BoundedThrower = withProviderBoundary(ThrowingProvider, 'throwing-provider');
    const errorReport = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<BoundedThrower query="e4b" context={context} report={errorReport} />);
    } finally {
      errorSpy.mockRestore();
    }

    expect(errorReport).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'e4b',
        status: 'error',
        title: 'Results',
      }),
    );
  });

  it('imports default React in every JSX-bearing .tsx module in src/omnibar for Rspack classic JSX', () => {
    const jsxFiles = fs
      .readdirSync(__dirname)
      .filter((name) => /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name))
      .map((name) => ({ name, source: fs.readFileSync(path.join(__dirname, name), 'utf8') }))
      .filter(({ source }) => /(?:^|[\s(?:])<\/?[A-Za-z][A-Za-z0-9]*(?=[\s/>])/m.test(source));

    expect(jsxFiles.length).toBeGreaterThan(0);

    const offenders = jsxFiles.filter(({ source }) => !/^import\s+React\b/m.test(source)).map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
