import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InlineNotification, InlineLoading } from '@carbon/react';
import { ChevronDown, Checkmark } from '@carbon/react/icons';
import { useConfig } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig } from '../config-schema';
import {
  fetchAvailableModels,
  loadModel,
  setCurrentModel,
  type ModelEntry,
  type ModelListResponse,
} from '../api/chartsearchai';
import styles from './model-picker.scss';

interface ModelPickerProps {
  /** Called after a successful switch — lets the parent show a toast or refresh state. */
  onSwitched?: (modelName: string) => void;
}

/**
 * Inline model picker for the chat panel footer. Custom button + absolute-
 * positioned popover list (NOT Carbon Dropdown / OverflowMenu) to keep the
 * bundle weight steady and match the AI-IDE convention of a text-with-chevron
 * trigger.
 *
 * Hides itself when:
 *   - config.showModelPicker is false
 *   - the backend reports engine=local (no model-switching applicable)
 *   - the available list has fewer than 2 entries (nothing to switch to)
 *   - the /models fetch fails (503 from local-engine backend is the common case)
 */
const ModelPicker: React.FC<ModelPickerProps> = ({ onSwitched }) => {
  const { t } = useTranslation();
  const { showModelPicker } = useConfig<ChartSearchAiConfig>();
  const [snapshot, setSnapshot] = useState<ModelListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Load on mount + whenever the popover opens — picks up changes that
  // happened out-of-band (operator ran chartsearch-configure, etc.).
  const loadModels = useCallback((signal?: AbortSignal) => {
    const ctrl = new AbortController();
    if (signal) {
      signal.addEventListener('abort', () => ctrl.abort());
    }
    fetchAvailableModels(ctrl)
      .then((data) => {
        setSnapshot(data);
        setLoadError(null);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setLoadError(err?.message ?? 'Failed to load model list');
        setSnapshot(null);
      });
    return ctrl;
  }, []);

  useEffect(() => {
    const ctrl = loadModels();
    return () => ctrl.abort();
  }, [loadModels]);

  useEffect(() => {
    if (!isOpen) return;
    const ctrl = loadModels();
    return () => ctrl.abort();
  }, [isOpen, loadModels]);

  // Outside-click closes the popover. Cheap to install when open, no listener when closed.
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

  const handleSelect = useCallback(
    async (modelName: string) => {
      if (!snapshot || modelName === snapshot.current || pendingModel) return;
      setPendingModel(modelName);
      setSwitchError(null);
      // Optimistic flip — popover reflects new selection immediately.
      setSnapshot((prev) => (prev ? { ...prev, current: modelName } : prev));
      try {
        // Pre-load on select: when the target model isn't loaded yet and the
        // backend probed an LM Studio v1 provider, ask LM Studio to load it
        // BEFORE flipping the GP — the user pays the load latency at
        // pick-time (with a visible spinner) rather than on first chat turn.
        const targetEntry = snapshot.entries?.find((e) => e.id === modelName);
        const isLmStudio = snapshot.provider === 'lm-studio';
        if (isLmStudio && targetEntry && targetEntry.loaded === false) {
          await loadModel(modelName);
        }
        const result = await setCurrentModel(modelName);
        setSnapshot((prev) => (prev ? { ...prev, current: result.current } : prev));
        onSwitched?.(result.current);
        setIsOpen(false);
      } catch (err) {
        // Roll back optimistic flip on failure.
        setSnapshot((prev) => (prev ? { ...prev, current: snapshot.current } : prev));
        const message = err instanceof Error ? err.message : t('modelSwitchFailed', 'Failed to switch model');
        setSwitchError(message);
      } finally {
        setPendingModel(null);
      }
    },
    [snapshot, pendingModel, onSwitched, t],
  );

  // Hide conditions — order matters for cheapest-first.
  if (showModelPicker === false) {
    return null;
  }
  if (loadError) {
    // Treat fetch failure (incl. 503 local-engine) as hidden; the chat panel
    // still works without a picker. We surface the error only if we already
    // had a snapshot at some point — otherwise it's just a not-applicable case.
    return null;
  }
  if (!snapshot) {
    // Initial load — render nothing rather than a layout-shifting spinner.
    return null;
  }
  if (snapshot.engine !== 'remote') {
    return null;
  }
  if (!snapshot.available || snapshot.available.length < 2) {
    return null;
  }

  const current = snapshot.current ?? '';

  // Build a unified list of {entry, isCurrent} so the same render handles
  // both legacy (no entries, just available: string[]) and enriched (entries
  // with loaded state, displayName) backend response shapes.
  const renderEntries: ModelEntry[] =
    snapshot.entries && snapshot.entries.length > 0
      ? snapshot.entries
      : snapshot.available.map((id) => ({ id, displayName: id, type: 'llm', loaded: false }));

  const showLmStudioHeader = snapshot.provider === 'lm-studio';

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
        <span className={styles.triggerLabel}>{current || t('noModel', 'No model')}</span>
        {pendingModel ? <InlineLoading className={styles.triggerLoading} description="" /> : <ChevronDown size={16} />}
      </button>
      {isOpen && (
        <ul className={styles.menu} role="listbox" aria-label={t('selectModel', 'Select model')}>
          {showLmStudioHeader ? (
            <li className={styles.groupHeader} role="presentation">
              {t('lmStudioGroup', 'LM Studio')}
            </li>
          ) : null}
          {renderEntries.map((entry) => {
            const selected = entry.id === current;
            const notLoadedAffix = showLmStudioHeader && entry.loaded === false ? t('notLoaded', '(not loaded)') : null;
            return (
              <li key={entry.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={`${styles.menuItem} ${selected ? styles.menuItemSelected : ''}`}
                  onClick={() => handleSelect(entry.id)}
                  disabled={!!pendingModel}
                  // aria-label drives screen reader announcement AND
                  // testing-library's getByRole({ name: ... }) match. Include
                  // the affix text so tests asserting "(not loaded)" can find
                  // the option by display name + state in one query.
                  aria-label={notLoadedAffix ? `${entry.displayName} ${notLoadedAffix}` : entry.displayName}
                >
                  <span className={styles.menuItemMain}>
                    <span className={styles.menuItemLabel}>{entry.displayName}</span>
                    {notLoadedAffix ? <span className={styles.menuItemAffix}>{notLoadedAffix}</span> : null}
                  </span>
                  {selected ? <Checkmark size={16} /> : null}
                </button>
              </li>
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
