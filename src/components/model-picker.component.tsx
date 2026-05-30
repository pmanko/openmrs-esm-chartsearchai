import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InlineNotification, InlineLoading } from '@carbon/react';
import { ChevronDown, Checkmark } from '@carbon/react/icons';
import { useConfig } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig } from '../config-schema';
import { fetchEndpoints, setEndpointModel, type EndpointListResponse } from '../api/chartsearchai';
import { extractApiError } from '../utils/api-error';
import styles from './model-picker.scss';

interface ModelPickerProps {
  /** Called after a successful switch — lets the parent show a toast or refresh state. */
  onSwitched?: (modelName: string) => void;
}

/**
 * Inline endpoint+model picker for the chat panel footer. Renders one section
 * per configured endpoint (e.g. LM Studio, Med Agent Hub), each listing the
 * models that endpoint serves. Selecting a model under a section switches
 * chartsearchai to that endpoint AND model in one step (the backend writes both
 * the endpointUrl + modelName global properties).
 *
 * Hides itself when:
 *   - config.showModelPicker is false
 *   - the /endpoints fetch fails (503 from a local-engine backend is the common case)
 *   - there are fewer than 2 selectable models across all reachable endpoints
 */
const ModelPicker: React.FC<ModelPickerProps> = ({ onSwitched }) => {
  const { t } = useTranslation();
  const { showModelPicker } = useConfig<ChartSearchAiConfig>();
  const [data, setData] = useState<EndpointListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Load on mount + whenever the popover opens — picks up out-of-band changes
  // (operator ran chartsearch-configure, another endpoint came up, etc.).
  const load = useCallback((signal?: AbortSignal) => {
    const ctrl = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => ctrl.abort());
    }
    fetchEndpoints(ctrl)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setLoadError(err?.message ?? 'Failed to load endpoints');
        setData(null);
      });
    return ctrl;
  }, []);

  useEffect(() => {
    const ctrl = load();
    return () => ctrl.abort();
  }, [load]);

  useEffect(() => {
    if (!isOpen) return;
    const ctrl = load();
    return () => ctrl.abort();
  }, [isOpen, load]);

  // Outside-click closes the popover.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const current = data?.current;

  const handleSelect = useCallback(
    async (url: string, modelId: string) => {
      if (pending) return;
      if (current && current.endpointUrl === url && current.modelName === modelId) {
        setIsOpen(false);
        return;
      }
      setPending(`${url}::${modelId}`);
      setSwitchError(null);
      // Optimistic flip — reflects the new selection immediately.
      setData((prev) => (prev ? { ...prev, current: { endpointUrl: url, modelName: modelId } } : prev));
      try {
        const result = await setEndpointModel(url, modelId);
        setData((prev) =>
          prev ? { ...prev, current: { endpointUrl: result.endpointUrl, modelName: result.current } } : prev,
        );
        onSwitched?.(result.current);
        setIsOpen(false);
      } catch (err) {
        // Roll back the optimistic flip.
        setData((prev) => (prev ? { ...prev, current } : prev));
        // Surface the backend's real reason (it lives on responseBody.error).
        const { message, isResourceError } = extractApiError(err);
        const display = isResourceError
          ? t(
              'modelResourceError',
              'Not enough memory to load "{{model}}". Unload a model in LM Studio (or pick one already loaded), then try again.',
              { model: modelId },
            )
          : message || t('modelSwitchFailed', 'Failed to switch model');
        setSwitchError(display);
      } finally {
        setPending(null);
      }
    },
    [pending, current, onSwitched, t],
  );

  // Hide conditions — cheapest first.
  if (showModelPicker === false) {
    return null;
  }
  if (loadError) {
    return null;
  }
  if (!data) {
    return null;
  }
  const endpoints = data.endpoints ?? [];
  const totalModels = endpoints.reduce((n, e) => n + (e.reachable ? e.models.length : 0), 0);
  if (totalModels < 2) {
    return null;
  }

  // Trigger label: "<endpoint> · <model>" for the current selection.
  let triggerLabel = t('noModel', 'No model');
  if (current) {
    const sec = endpoints.find((e) => e.url === current.endpointUrl);
    const mod = sec?.models.find((m) => m.id === current.modelName);
    if (sec && mod) {
      triggerLabel = `${sec.label} · ${mod.displayName}`;
    } else if (current.modelName) {
      triggerLabel = current.modelName;
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={t('selectModel', 'Select model')}
        title={t('selectModel', 'Select model')}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className={styles.triggerLabel}>{triggerLabel}</span>
        {pending ? <InlineLoading className={styles.triggerLoading} description="" /> : <ChevronDown size={16} />}
      </button>
      {isOpen && (
        <ul className={styles.menu} role="listbox" aria-label={t('selectModel', 'Select model')}>
          {endpoints.map((ep) => {
            // "(not loaded)" is only meaningful where the backend probes load
            // state (LM Studio). Generic endpoints (the agent team) don't have it.
            const showLoaded = ep.provider === 'lm-studio';
            return (
              <React.Fragment key={ep.url}>
                <li className={styles.groupHeader} role="presentation">
                  {ep.label}
                  {!ep.reachable ? ` ${t('endpointUnreachable', '(unreachable)')}` : null}
                </li>
                {ep.reachable
                  ? ep.models.map((m) => {
                      const selected =
                        !!current && current.endpointUrl === ep.url && current.modelName === m.id;
                      const notLoadedAffix =
                        showLoaded && m.loaded === false ? t('notLoaded', '(not loaded)') : null;
                      return (
                        <li key={`${ep.url}::${m.id}`} role="option" aria-selected={selected}>
                          <button
                            type="button"
                            className={`${styles.menuItem} ${selected ? styles.menuItemSelected : ''}`}
                            onClick={() => handleSelect(ep.url, m.id)}
                            disabled={!!pending}
                            aria-label={notLoadedAffix ? `${m.displayName} ${notLoadedAffix}` : m.displayName}
                          >
                            <span className={styles.menuItemMain}>
                              <span className={styles.menuItemLabel}>{m.displayName}</span>
                              {notLoadedAffix ? <span className={styles.menuItemAffix}>{notLoadedAffix}</span> : null}
                            </span>
                            {selected ? <Checkmark size={16} /> : null}
                          </button>
                        </li>
                      );
                    })
                  : null}
              </React.Fragment>
            );
          })}
        </ul>
      )}
      {switchError ? (
        <InlineNotification
          kind="error"
          lowContrast
          className={styles.switchError}
          title={t('modelSwitchFailed', 'Failed to switch model')}
          subtitle={switchError}
          onCloseButtonClick={() => setSwitchError(null)}
        />
      ) : null}
    </div>
  );
};

export default ModelPicker;
