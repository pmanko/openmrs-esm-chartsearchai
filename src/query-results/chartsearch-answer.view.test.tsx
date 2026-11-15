import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getDefaultsFromConfigSchema, openmrsFetch, useConfig } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig, configSchema } from '../config-schema';
import { type OmnibarViewProps, type OmnibarViewState } from '../omnibar-contract/types';
import { chatSessionStore, initialChatSessionState } from '../store/chat-session.store';
import { maxAnswerCharacters, maxStreamBytes } from '../api/chartsearchai';
import ChartSearchAnswerView from './chartsearch-answer.view';

vi.mock('@openmrs/esm-framework', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmrs/esm-framework')>()),
  makeUrl: (path: string) => `/openmrs${path}`,
}));

const defaults = () => getDefaultsFromConfigSchema(configSchema) as ChartSearchAiConfig;

const humprey = '8673ee4f-e2ab-4077-ba55-4980f408773e';
const question = 'when did he start ART?';

const frame = (event: string, data: unknown) =>
  `event: ${event}\n${String(typeof data === 'string' ? data : JSON.stringify(data))
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')}\n\n`;

/** A response whose body is written by the test, a chunk at a time, then ended. */
function streamingResponse(init: { status?: number; contentType?: string; bodyText?: string } = {}) {
  const encoder = new TextEncoder();
  const queue: Array<Uint8Array | null> = [];
  let wake: () => void = () => {};
  let signal: AbortSignal | undefined;
  const next = () =>
    new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
      const take = () => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const chunk = queue.shift();
        if (chunk === undefined) {
          wake = take;
          return;
        }
        resolve(chunk === null ? { done: true, value: undefined } : { done: false, value: chunk });
      };
      take();
    });
  const response = {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': init.contentType ?? 'text/event-stream;charset=UTF-8' }),
    body: { getReader: () => ({ read: next, cancel: vi.fn().mockResolvedValue(undefined), releaseLock: () => {} }) },
    json: init.bodyText
      ? async () => JSON.parse(init.bodyText as string)
      : async () => Promise.reject(new Error('non-JSON body')),
  };
  return {
    response,
    fetch: (_url: string, requestInit: { signal?: AbortSignal }) => {
      signal = requestInit.signal;
      signal?.addEventListener('abort', () => wake());
      return Promise.resolve(response);
    },
    write: (text: string) => {
      queue.push(encoder.encode(text));
      wake();
    },
    end: () => {
      queue.push(null);
      wake();
    },
  };
}

const sessionResponse = (authenticated: boolean) => ({ ok: true, status: 200, json: async () => ({ authenticated }) });
const isSessionCheck = (url: string) => url.includes('/session?');

const turnEnvelope = (overrides: Record<string, unknown> = {}) => ({
  answer: 'ART started on 3 March 2024 [1].',
  references: [
    {
      index: 1,
      resourceType: 'DrugOrder',
      date: '2024-03-03',
      grounded: null,
      group: 'chart',
      text: 'Tenofovir / Lamivudine / Dolutegravir',
    },
  ],
  safetyWarnings: [],
  safetyStatus: 'ok',
  session: null,
  messageId: 'omnibar-msg-1',
  ...overrides,
});

const renderView = (query = question, submitted = false, extra: Partial<OmnibarViewProps> = {}) => {
  const states: Array<OmnibarViewState> = [];
  const props: OmnibarViewProps = {
    query,
    context: { scope: 'patient', patientUuid: humprey, locale: 'en' },
    contractVersion: 1,
    reportState: (state) => {
      states.push(state);
    },
    submitted,
    ...extra,
  };
  const view = render(<ChartSearchAnswerView {...props} />);
  return { states, ...view };
};

describe('the Ask ChartSearch view', () => {
  const mockOpenmrsFetch = openmrsFetch as Mock;
  let previousOpenmrsFetchImpl: ((...args: unknown[]) => unknown) | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(useConfig).mockReturnValue(defaults());
    chatSessionStore.setState(initialChatSessionState());
    previousOpenmrsFetchImpl = mockOpenmrsFetch.getMockImplementation();
    mockOpenmrsFetch.mockImplementation((url: string) => {
      if (url.includes('/ws/rest/v1/chartsearchai/providers')) {
        return Promise.resolve({
          data: {
            providers: [
              { id: 'bundled', name: 'Bundled', enabled: true, ready: true, capabilities: ['token_streaming'] },
            ],
            defaultProvider: 'bundled',
            pickerVisible: false,
          },
        });
      }
      return Promise.resolve({ data: {} });
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    chatSessionStore.setState(initialChatSessionState());
    if (previousOpenmrsFetchImpl) {
      mockOpenmrsFetch.mockImplementation(previousOpenmrsFetchImpl);
    }
  });

  it('asks at once about a submitted question via ephemeral /chat/stream, without touching chat store history', async () => {
    const stream = streamingResponse();
    fetchMock.mockResolvedValue(stream.response);
    const { states, rerender } = renderView(question, true);

    expect(await screen.findByRole('heading', { name: 'ChartSearch' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask ChartSearch' })).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/ws/rest/v1/chartsearchai/chat/stream');
    expect(url).not.toContain('/search/stream');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(init.body)).toMatchObject({ patient: humprey, question, ephemeral: true });
    expect(JSON.parse(init.body)).not.toHaveProperty('session');
    await waitFor(() => expect(states.at(-1)).toBe('ready'));

    rerender(
      <ChartSearchAnswerView
        query={question}
        context={{ scope: 'patient', patientUuid: humprey, locale: 'en' }}
        contractVersion={1}
        reportState={() => {}}
        submitted
      />,
    );
    await act(async () => stream.write(frame('turn_done', turnEnvelope())));
    await act(async () => stream.end());

    expect(await screen.findByText(/ART started on 3 March 2024/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chatSessionStore.getState().messagesByPatient).toEqual({});
    expect(chatSessionStore.getState().sessionUuidByPatient).toEqual({});
  });

  it('on a page nobody just asked for, such as a reload, sends nothing until Ask is pressed', async () => {
    const { states } = renderView();

    expect(await screen.findByRole('heading', { name: 'ChartSearch' })).toBeInTheDocument();
    expect(screen.getByText(question)).toBeInTheDocument();
    expect(screen.getByText(/isn’t asked again when this page is reopened/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask ChartSearch' })).toBeInTheDocument();
    await waitFor(() => expect(states.at(-1)).toBe('ready'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks once its answer can stream, even under StrictMode’s remount', async () => {
    const stream = streamingResponse();
    fetchMock.mockImplementation(stream.fetch);
    render(
      <React.StrictMode>
        <ChartSearchAnswerView
          query={question}
          context={{ scope: 'patient', patientUuid: humprey, locale: 'en' }}
          contractVersion={1}
          reportState={() => {}}
          submitted
        />
      </React.StrictMode>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => stream.write(frame('turn_done', turnEnvelope())));
    await act(async () => stream.end());
    expect(await screen.findByText(/ART started on 3 March 2024/)).toBeInTheDocument();
  });

  it('never asks past the site’s own question limit', async () => {
    vi.mocked(useConfig).mockReturnValue({ ...defaults(), maxQuestionLength: 10 });
    const { states, container } = renderView(question, true);
    await waitFor(() => expect(states.at(-1)).toBe('empty'));
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no `submitted` from the host, shows the Ask button and sends nothing', async () => {
    const states: Array<OmnibarViewState> = [];
    const props: OmnibarViewProps = {
      query: question,
      context: { scope: 'patient', patientUuid: humprey, locale: 'en' },
      contractVersion: 1,
      reportState: (state) => {
        states.push(state);
      },
    };
    render(<ChartSearchAnswerView {...props} />);
    await waitFor(() => expect(states.at(-1)).toBe('ready'));
    expect(screen.getByRole('button', { name: 'Ask ChartSearch' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes the host’s word on whether the query is a question', async () => {
    const stream = streamingResponse();
    fetchMock.mockResolvedValue(stream.response);
    const { states, container } = renderView('cd4', true, {
      hints: { looksLikeQuestion: true, looksLikeIdentifier: false },
    });
    expect(await screen.findByRole('heading', { name: 'ChartSearch' })).toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
    await waitFor(() => expect(states.at(-1)).toBe('ready'));
  });

  it('with the section switched off, reports empty and never asks', async () => {
    vi.mocked(useConfig).mockReturnValue({ ...defaults(), queryResultsAnswer: { enabled: false } });
    const { states, container } = renderView(question, true);
    await waitFor(() => expect(states.at(-1)).toBe('empty'));
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never asks about a submitted query that isn’t a question outside /ask', async () => {
    const { states } = renderView('cd4', true);
    await waitFor(() => expect(states.at(-1)).toBe('empty'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('under /ask, asks about any submitted text, question or not, once', async () => {
    const stream = streamingResponse();
    fetchMock.mockResolvedValue(stream.response);
    renderView('pancytopenia', true, {
      context: { scope: 'patient', patientUuid: humprey, locale: 'en', command: { id: 'ask' } },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      patient: humprey,
      question: 'pancytopenia',
      ephemeral: true,
    });
  });

  it.each([
    ['a clinical code even under /ask', '100GEJ', true],
    ['text under /ask nobody just asked for', 'cd4', false],
  ])('doesn’t ask about %s', async (_, query, submitted) => {
    const { states } = renderView(query, submitted, {
      context: { scope: 'patient', patientUuid: humprey, locale: 'en', command: { id: 'ask' } },
    });
    await waitFor(() => expect(states.at(-1)).toBe(query === '100GEJ' ? 'empty' : 'ready'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('system provider & Hub profile integration', () => {
    it('forwards Chat selectedProfileId when Hub is active and profileDiscoveryStatus is ready', async () => {
      mockOpenmrsFetch.mockImplementation((url: string) => {
        if (url.includes('/ws/rest/v1/chartsearchai/providers')) {
          return Promise.resolve({
            data: {
              providers: [{ id: 'hub', name: 'AI Hub', enabled: true, ready: true }],
              defaultProvider: 'hub',
              pickerVisible: false,
            },
          });
        }
        if (url.includes('/ws/rest/v1/chartsearchai/models')) {
          return Promise.resolve({
            data: {
              object: 'list',
              data: [
                {
                  id: 'hiv-care',
                  label: 'HIV care',
                  visibility: 'product',
                  available: true,
                  default: true,
                },
              ],
            },
          });
        }
        return Promise.resolve({ data: {} });
      });
      chatSessionStore.setState({
        selectedProviderId: 'hub',
        profileDiscoveryStatus: 'ready',
        selectedProfileId: 'hiv-care',
      });
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);

      const user = userEvent.setup();
      renderView();
      await waitFor(() => expect(chatSessionStore.getState().selectedProviderId).toBe('hub'));
      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        patient: humprey,
        question,
        provider: 'hub',
        profile: 'hiv-care',
        ephemeral: true,
      });
    });

    it('renders ModelPicker when Hub presets load and re-runs the active turn on explicit preset change', async () => {
      mockOpenmrsFetch.mockImplementation((url: string) => {
        if (url.includes('/ws/rest/v1/chartsearchai/providers')) {
          return Promise.resolve({
            data: {
              providers: [{ id: 'hub', name: 'AI Hub', enabled: true, ready: true }],
              defaultProvider: 'hub',
              pickerVisible: false,
            },
          });
        }
        if (url.includes('/ws/rest/v1/chartsearchai/models')) {
          return Promise.resolve({
            data: {
              object: 'list',
              data: [
                {
                  id: 'gemma-4-12b',
                  label: 'Gemma 4 12B',
                  visibility: 'product',
                  available: true,
                  default: true,
                  selection_priority: 10,
                },
                {
                  id: 'gemma-4-e4b',
                  label: 'Gemma 4 E4B (Fast)',
                  visibility: 'product',
                  available: true,
                  default: false,
                  selection_priority: 20,
                },
                {
                  id: 'qwen-3.5-9b',
                  label: 'Qwen 3.5 9B',
                  visibility: 'product',
                  available: true,
                  default: false,
                  selection_priority: 30,
                },
              ],
            },
          });
        }
        return Promise.resolve({ data: {} });
      });
      fetchMock.mockImplementation(() => {
        const stream = streamingResponse();
        stream.write(frame('turn_done', turnEnvelope({ answer: 'On TDF/3TC/DTG.', references: [] })));
        stream.end();
        return Promise.resolve(stream.response);
      });

      const user = userEvent.setup();
      renderView('Current medications?', true);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const pickerButton = await screen.findByRole('button', { name: /AI profile: Gemma 4 12B/i });
      expect(pickerButton).toHaveTextContent('Gemma 4 12B');

      await user.click(pickerButton);
      await user.click(await screen.findByText('Qwen 3.5 9B'));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1].body));
      expect(secondBody.profile).toBe('qwen-3.5-9b');
    });

    it('omits profile when Hub profile discovery is not ready so the backend resolves its default', async () => {
      mockOpenmrsFetch.mockImplementation((url: string) => {
        if (url.includes('/ws/rest/v1/chartsearchai/providers')) {
          return Promise.resolve({
            data: {
              providers: [{ id: 'hub', name: 'AI Hub', enabled: true, ready: true }],
              defaultProvider: 'hub',
              pickerVisible: false,
            },
          });
        }
        if (url.includes('/ws/rest/v1/chartsearchai/models')) {
          return new Promise(() => {});
        }
        return Promise.resolve({ data: {} });
      });
      chatSessionStore.setState({
        selectedProviderId: 'hub',
        profileDiscoveryStatus: 'loading',
        selectedProfileId: 'stale-profile',
      });
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);

      const user = userEvent.setup();
      renderView();
      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toEqual({
        patient: humprey,
        question,
        provider: 'hub',
        ephemeral: true,
      });
      expect(body).not.toHaveProperty('profile');
    });

    it('reports unavailable and displays the system provider unavailable reason without posting /chat/stream', async () => {
      mockOpenmrsFetch.mockImplementation((url: string) => {
        if (url.includes('/ws/rest/v1/chartsearchai/providers')) {
          return Promise.resolve({
            data: {
              providers: [
                {
                  id: 'hub',
                  name: 'AI Hub',
                  enabled: true,
                  ready: false,
                  unavailableReason: 'med-agent-hub offline',
                },
              ],
              defaultProvider: 'hub',
              pickerVisible: false,
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      const { states } = renderView(question, true);
      expect(await screen.findByText('Unavailable right now')).toBeInTheDocument();
      expect(screen.getByText('med-agent-hub offline')).toBeInTheDocument();
      await waitFor(() => expect(states.at(-1)).toBe('unavailable'));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('streaming via shared AiResponsePanel & AiReasoningDisclosure', () => {
    it('streams preliminary reasoning, committed reasoning, answer tokens, evidence updates, and feedback auditLogId', async () => {
      const user = userEvent.setup();
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);
      renderView();

      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
      expect(await screen.findByText('Reviewing the most relevant records…')).toBeInTheDocument();

      await act(async () => stream.write(frame('preliminary_delta', 'Checking orders [99]...')));
      expect(await screen.findByText(/Checking orders/)).toBeInTheDocument();
      expect(screen.queryByText(/\[99\]/)).not.toBeInTheDocument();

      await act(async () => stream.write(frame('reasoning_delta', 'Reviewing active ART regimens')));
      expect(await screen.findByText('Reviewing active ART regimens')).toBeInTheDocument();

      await act(async () => stream.write(frame('answer_delta', 'ART started')));
      expect(await screen.findByText(/ART started/)).toBeInTheDocument();
      expect(screen.getByText('Model reasoning')).toBeInTheDocument();
      expect(screen.getByText('Reviewing active ART regimens')).not.toBeVisible();

      await act(async () => stream.write(frame('answer_done', turnEnvelope())));
      expect(await screen.findByText(/ART started on 3 March 2024/)).toBeInTheDocument();
      expect(screen.getByText('This answer is AI-generated and may not be accurate.')).toBeInTheDocument();

      await act(async () =>
        stream.write(
          frame(
            'evidence_updated',
            turnEnvelope({
              references: [
                {
                  index: 1,
                  resourceType: 'DrugOrder',
                  date: '2024-03-03',
                  grounded: false,
                  group: 'chart',
                },
              ],
              safetyStatus: 'limited',
              safetyWarnings: [
                { type: 'drug_interaction', drug: 'Ibuprofen', interactingDrug: 'Warfarin', detail: 'Bleeding risk' },
              ],
            }),
          ),
        ),
      );
      expect(await screen.findByText('Unsupported')).toBeInTheDocument();
      const safetyBox = screen.getByTestId('ai-response-safety');
      expect(safetyBox).toHaveTextContent('Limited safety check');
      expect(safetyBox).toHaveTextContent('Ibuprofen: Bleeding risk');

      await act(async () => stream.write(frame('turn_done', turnEnvelope({ auditLogId: 42 }))));
      await act(async () => stream.end());
      expect(await screen.findByRole('button', { name: 'Helpful' })).toBeInTheDocument();
    });

    it('hides reasoning when showReasoning config is false', async () => {
      vi.mocked(useConfig).mockReturnValue({ ...defaults(), showReasoning: false });
      const user = userEvent.setup();
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);
      renderView();

      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
      await act(async () => stream.write(frame('preliminary_delta', 'Secret preview')));
      expect(screen.queryByText('Secret preview')).not.toBeInTheDocument();
      expect(screen.getByText('Reviewing the most relevant records…')).toBeInTheDocument();

      await act(async () =>
        stream.write(frame('reasoning_delta', 'Secret reasoning chain') + frame('answer_delta', 'ART started')),
      );
      expect(await screen.findByText('ART started')).toBeInTheDocument();
      expect(screen.queryByText('Secret preview')).not.toBeInTheDocument();
      expect(screen.queryByText('Secret reasoning chain')).not.toBeInTheDocument();
    });
  });

  describe('error sanitization, session handling, abort, and logging', () => {
    it('sanitizes free-text turn_error prose so chart or query text never leaks', async () => {
      const user = userEvent.setup();
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);
      renderView();

      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
      await act(async () =>
        stream.write(frame('turn_error', { error: "This patient's chart is too large to process." })),
      );
      await act(async () => stream.end());

      expect(
        await screen.findByText('Chart search failed. Please try again or contact your administrator.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/too large/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('treats a stream that ends before turn_done as incomplete', async () => {
      const user = userEvent.setup();
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);
      renderView();

      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
      await act(async () => stream.write(frame('answer_delta', 'ART')));
      await act(async () => stream.end());

      expect(await screen.findByText(/The response ended before it finished\. Please try again\./)).toBeInTheDocument();
    });

    it.each([
      [
        409,
        JSON.stringify({ error: 'provider_not_enabled' }),
        'The selected AI provider is not available. Contact your administrator.',
      ],
      [
        503,
        JSON.stringify({ error: 'provider_not_ready' }),
        'The selected AI provider is not available. Contact your administrator.',
      ],
      [
        429,
        JSON.stringify({ error: 'rate_limited' }),
        'Chart search failed. Please try again or contact your administrator.',
      ],
    ])('renders structured HTTP %s problem errors cleanly', async (status, bodyText, expectedMessage) => {
      const user = userEvent.setup();
      fetchMock.mockResolvedValue(streamingResponse({ status, contentType: 'application/json', bodyText }).response);
      renderView();

      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
      expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    });

    it.each([
      ['a bare HTML 500', { status: 500, contentType: 'text/html' }],
      ['the login page it was redirected to', { contentType: 'text/html' }],
      ['a bare 401 response', { status: 401, contentType: 'text/html' }],
    ])('says the session has ended when ChartSearch answers %s and /session confirms logout', async (_, init) => {
      const user = userEvent.setup();
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(isSessionCheck(url) ? sessionResponse(false) : streamingResponse(init).response),
      );
      renderView();

      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
      expect(await screen.findByText('Your session has expired. Please log in again.')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/ws/rest/v1/session?'), expect.anything());
    });

    it('refuses a non-SSE HTTP 200 HTML response when session is still active', async () => {
      const user = userEvent.setup();
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          isSessionCheck(url) ? sessionResponse(true) : streamingResponse({ contentType: 'text/html' }).response,
        ),
      );
      renderView();

      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
      expect(
        await screen.findByText(
          'The server could not process the request. Please try again or contact your administrator.',
        ),
      ).toBeInTheDocument();
    });

    it('stops an answer that is no longer offered', async () => {
      const stream = streamingResponse();
      fetchMock.mockImplementation(stream.fetch);
      const { rerender } = renderView(question, true);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const { signal } = fetchMock.mock.calls[0][1];

      vi.mocked(useConfig).mockReturnValue({ ...defaults(), queryResultsAnswer: { enabled: false } });
      rerender(
        <ChartSearchAnswerView
          query={question}
          context={{ scope: 'patient', patientUuid: humprey, locale: 'en' }}
          contractVersion={1}
          reportState={() => {}}
          submitted
        />,
      );
      expect(signal.aborted).toBe(true);
    });

    it('stops reading when the host aborts its signal, and never asks under a signal already aborted', async () => {
      const user = userEvent.setup();
      const stream = streamingResponse();
      fetchMock.mockImplementation(stream.fetch);
      const host = new AbortController();
      renderView(question, true, { signal: host.signal });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const { signal } = fetchMock.mock.calls[0][1];

      await act(async () => stream.write(frame('answer_delta', 'ART started')));
      expect(await screen.findByText('ART started')).toBeInTheDocument();
      await act(async () => host.abort());
      expect(signal.aborted).toBe(true);
      await act(async () => stream.write(frame('answer_delta', ' on 3 March')));
      expect(screen.queryByText(/on 3 March/)).not.toBeInTheDocument();

      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      renderView(question, false, { signal: host.signal });
      await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops an automatic request on unmount even when the host’s signal is still live', async () => {
      const stream = streamingResponse();
      fetchMock.mockImplementation(stream.fetch);
      const host = new AbortController();
      const { unmount } = renderView(question, true, { signal: host.signal });
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const { signal } = fetchMock.mock.calls[0][1];

      unmount();
      expect(host.signal.aborted).toBe(false);
      expect(signal.aborted).toBe(true);
    });

    it('logs nothing when ChartSearch fails, whatever the failure', async () => {
      const consoleSpies = (['log', 'info', 'debug', 'warn', 'error'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation(() => {}),
      );
      try {
        const user = userEvent.setup();
        const stream = streamingResponse();
        const asks = vi
          .fn()
          .mockResolvedValueOnce(stream.response)
          .mockResolvedValueOnce(streamingResponse({ status: 500 }).response)
          .mockRejectedValueOnce(new TypeError('Failed to fetch'));
        fetchMock.mockImplementation((url: string) => (isSessionCheck(url) ? sessionResponse(true) : asks()));
        renderView();

        await user.click(await screen.findByRole('button', { name: 'Ask ChartSearch' }));
        await act(async () =>
          stream.write(frame('turn_error', { error: "This patient's chart is too large to process." })),
        );
        await act(async () => stream.end());
        expect(
          await screen.findByText('Chart search failed. Please try again or contact your administrator.'),
        ).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(asks).toHaveBeenCalledTimes(2));
        expect(
          await screen.findByText(
            'The server could not process the request. Please try again or contact your administrator.',
          ),
        ).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(
          await screen.findByText('Could not reach the server. Check the connection and try again.'),
        ).toBeInTheDocument();

        consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
      } finally {
        consoleSpies.forEach((spy) => spy.mockRestore());
      }
    });

    it('hides preliminary reasoning text and committed reasoning when showReasoning is false', async () => {
      vi.mocked(useConfig).mockReturnValue({ ...defaults(), showReasoning: false });
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);
      renderView(question, true);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await act(async () => stream.write(frame('preliminary_delta', 'Secret clinical chart snippet')));
      expect(screen.getByText('Reviewing the most relevant records…')).toBeInTheDocument();
      expect(screen.queryByText(/Secret clinical chart snippet/)).not.toBeInTheDocument();

      await act(async () => stream.write(frame('reasoning_delta', 'Secret chain of thought')));
      expect(screen.queryByText(/Secret chain of thought/)).not.toBeInTheDocument();

      await act(async () => stream.write(frame('turn_done', turnEnvelope())));
      await act(async () => stream.end());
      expect(await screen.findByText(/ART started on 3 March 2024/)).toBeInTheDocument();
    });

    it('aborts /chat/stream responses that exceed maxStreamBytes', async () => {
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);
      renderView(question, true);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await act(async () => stream.write('a'.repeat(maxStreamBytes + 1)));
      expect(
        await screen.findByText(
          'The AI service sent a response this panel could not read. Please try again or contact your administrator.',
        ),
      ).toBeInTheDocument();
    });

    it('caps streamed and settled answer text at maxAnswerCharacters', async () => {
      const stream = streamingResponse();
      fetchMock.mockResolvedValue(stream.response);
      renderView(question, true);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const oversized = 'A'.repeat(maxAnswerCharacters + 500);
      await act(async () => stream.write(frame('answer_delta', oversized)));
      await act(async () => stream.write(frame('turn_done', turnEnvelope({ answer: oversized, references: [] }))));
      await act(async () => stream.end());

      expect(await screen.findByText(new RegExp(`^A{${maxAnswerCharacters}}$`))).toBeInTheDocument();
    });
  });
});
