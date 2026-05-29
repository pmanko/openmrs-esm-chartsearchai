import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InlineLoading, InlineNotification, MenuButton, MenuItemRadioGroup } from '@carbon/react';
import { useConfig } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig } from '../config-schema';
import {
  fetchAvailableModels,
  loadModel,
  setCurrentModel,
  type ModelEntry,
  type ModelListResponse,
} from '../api/chartsearchai';
import { extractApiError } from '../utils/api-error';
import styles from './model-picker.scss';

interface ModelPickerProps {
  /** Called after a successful switch — lets the parent show a toast or refresh state. */
  onSwitched?: (modelName: string) => void;
}

/**
 * Inline model picker for the chat panel footer. A Carbon MenuButton whose menu
 * is a MenuItemRadioGroup — single-select radio semantics with a group header.
 * Carbon renders the menu in a portal on document.body and clamps it to the
 * viewport, so it is never clipped by the chat panel's overflow regardless of
 * panel height.
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
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Load once on mount. The chat panel unmounts/remounts this component each
  // time it opens, so an out-of-band model change (operator ran
  // chartsearch-configure) is picked up the next time the panel is opened.
  useEffect(() => {
    const ctrl = new AbortController();
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
    return () => ctrl.abort();
  }, []);

  const handleSelect = useCallback(
    async (modelName: string) => {
      if (!snapshot || modelName === snapshot.current || pendingModel) return;
      setPendingModel(modelName);
      setSwitchError(null);
      // Optimistic flip — trigger label reflects the new selection immediately.
      setSnapshot((prev) => (prev ? { ...prev, current: modelName } : prev));
      try {
        // Pre-load on select: when the target model isn't loaded yet and the
        // backend probed an LM Studio v1 provider, ask LM Studio to load it
        // BEFORE flipping the GP — the user pays the load latency at pick-time
        // (with a visible spinner) rather than on first chat turn.
        const targetEntry = snapshot.entries?.find((e) => e.id === modelName);
        const isLmStudio = snapshot.provider === 'lm-studio';
        if (isLmStudio && targetEntry && targetEntry.loaded === false) {
          await loadModel(modelName);
        }
        const result = await setCurrentModel(modelName);
        setSnapshot((prev) => (prev ? { ...prev, current: result.current } : prev));
        onSwitched?.(result.current);
      } catch (err) {
        // Roll back optimistic flip on failure.
        setSnapshot((prev) => (prev ? { ...prev, current: snapshot.current } : prev));
        // Surface the backend's real reason (it lives on responseBody.error, not
        // err.message). A model-load resource failure — LM Studio refusing to
        // load because memory is full and it won't evict explicitly-loaded
        // models — gets an actionable message instead of an opaque one.
        const { message, isResourceError } = extractApiError(err);
        const display = isResourceError
          ? t(
              'modelResourceError',
              'Not enough memory to load "{{model}}". Unload a model in LM Studio (or pick one already loaded), then try again.',
              { model: modelName },
            )
          : message || t('modelSwitchFailed', 'Failed to switch model');
        setSwitchError(display);
      } finally {
        setPendingModel(null);
      }
    },
    [snapshot, pendingModel, onSwitched, t],
  );

  // Build a unified entry list so the same render handles both legacy
  // (available: string[]) and enriched (entries with loaded state, displayName)
  // backend response shapes. Memoised so the radio group's items/itemToString
  // stay referentially stable between renders.
  const { itemIds, itemToString, groupLabel } = useMemo(() => {
    const isLmStudio = snapshot?.provider === 'lm-studio';
    const entries: ModelEntry[] =
      snapshot?.entries && snapshot.entries.length > 0
        ? snapshot.entries
        : (snapshot?.available ?? []).map((id) => ({ id, displayName: id, type: 'llm', loaded: false }));
    const byId = new Map(entries.map((e) => [e.id, e]));
    return {
      itemIds: entries.map((e) => e.id),
      // MenuItem renders its label as plain text, so the "(not loaded)" affix is
      // folded into the string rather than carried as a styled node. Carbon types
      // the radio group's item as `unknown` (the generic is erased by forwardRef),
      // so the param is widened and narrowed back to the id string here.
      itemToString: (item: unknown) => {
        const id = item as string;
        const e = byId.get(id);
        if (!e) return id;
        return isLmStudio && e.loaded === false ? `${e.displayName} ${t('notLoaded', '(not loaded)')}` : e.displayName;
      },
      groupLabel: isLmStudio ? t('lmStudioGroup', 'LM Studio') : t('models', 'Models'),
    };
  }, [snapshot, t]);

  // Hide conditions — order matters for cheapest-first.
  if (showModelPicker === false) {
    return null;
  }
  if (loadError) {
    // Treat fetch failure (incl. 503 local-engine) as hidden; the chat panel
    // still works without a picker.
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

  return (
    <div className={styles.root}>
      <div className={styles.triggerRow}>
        <MenuButton
          label={current || t('noModel', 'No model')}
          kind="ghost"
          size="sm"
          menuAlignment="top-end"
          disabled={!!pendingModel}
        >
          <MenuItemRadioGroup
            label={groupLabel}
            items={itemIds}
            itemToString={itemToString}
            selectedItem={current}
            onChange={(id) => handleSelect(id as string)}
          />
        </MenuButton>
        {pendingModel ? <InlineLoading className={styles.loading} description="" /> : null}
      </div>
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
