import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  InlineLoading,
  InlineNotification,
  MenuButton,
  MenuItem,
  MenuItemDivider,
  MenuItemRadioGroup,
} from '@carbon/react';
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
 * Inline endpoint+model picker for the chat panel footer. A Carbon MenuButton
 * whose menu has one MenuItemRadioGroup per configured endpoint (LM Studio,
 * Med Agent Hub, ...). Carbon portals the menu to document.body and clamps it to
 * the viewport, so it is never clipped by the chat panel's overflow regardless
 * of panel height. Selecting a model under a section switches chartsearchai to
 * that endpoint AND model in one step.
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
  const [pending, setPending] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Load once on mount. The chat panel unmounts/remounts this component each
  // time it opens, so an out-of-band change (operator ran chartsearch-configure,
  // another endpoint came up) is picked up the next time the panel is opened.
  useEffect(() => {
    const ctrl = new AbortController();
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
    return () => ctrl.abort();
  }, []);

  const current = data?.current;

  const handleSelect = useCallback(
    async (url: string, modelId: string) => {
      if (pending) return;
      if (current && current.endpointUrl === url && current.modelName === modelId) return;
      setPending(`${url}::${modelId}`);
      setSwitchError(null);
      // Optimistic flip — trigger label reflects the new selection immediately.
      setData((prev) => (prev ? { ...prev, current: { endpointUrl: url, modelName: modelId } } : prev));
      try {
        const result = await setEndpointModel(url, modelId);
        setData((prev) =>
          prev ? { ...prev, current: { endpointUrl: result.endpointUrl, modelName: result.current } } : prev,
        );
        onSwitched?.(result.current);
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

  // One radio group per reachable endpoint. Memoised so the groups' items /
  // itemToString stay referentially stable between renders.
  const sections = useMemo(() => {
    const endpoints = data?.endpoints ?? [];
    return endpoints
      .filter((ep) => ep.reachable && ep.models.length > 0)
      .map((ep) => {
        // "(not loaded)" is only meaningful where the backend probes load state
        // (LM Studio); generic endpoints (the agent team) don't have it.
        const showLoaded = ep.provider === 'lm-studio';
        const byId = new Map(ep.models.map((m) => [m.id, m]));
        return {
          url: ep.url,
          label: ep.label,
          itemIds: ep.models.map((m) => m.id),
          // Only the active endpoint's group carries a selected radio.
          selectedItem: current && current.endpointUrl === ep.url ? current.modelName ?? '' : '',
          // MenuItem renders its label as plain text, so the affix is folded into
          // the string. Carbon types the radio item as `unknown`, so widen+narrow.
          itemToString: (item: unknown) => {
            const id = item as string;
            const m = byId.get(id);
            if (!m) return id;
            return showLoaded && m.loaded === false
              ? `${m.displayName} ${t('notLoaded', '(not loaded)')}`
              : m.displayName;
          },
        };
      });
  }, [data, current, t]);

  // Hide conditions — cheapest first.
  if (showModelPicker === false) {
    return null;
  }
  if (loadError) {
    // Treat fetch failure (incl. 503 local-engine) as hidden; the chat panel
    // still works without a picker.
    return null;
  }
  if (!data) {
    // Initial load — render nothing rather than a layout-shifting spinner.
    return null;
  }
  const totalModels = sections.reduce((n, s) => n + s.itemIds.length, 0);
  if (totalModels < 2) {
    return null;
  }

  // Trigger label: "<endpoint> · <model>" for the current selection.
  let triggerLabel = t('noModel', 'No model');
  if (current) {
    const ep = (data.endpoints ?? []).find((e) => e.url === current.endpointUrl);
    const m = ep?.models.find((x) => x.id === current.modelName);
    if (ep && m) {
      triggerLabel = `${ep.label} · ${m.displayName}`;
    } else if (current.modelName) {
      triggerLabel = current.modelName;
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.triggerRow}>
        <MenuButton label={triggerLabel} kind="ghost" size="sm" menuAlignment="top-end" disabled={!!pending}>
          {sections.map((s, i) => (
            <React.Fragment key={s.url}>
              {i > 0 ? <MenuItemDivider /> : null}
              {/* Carbon group labels are aria-only; a disabled MenuItem gives a
                  VISIBLE section header above the endpoint's models. */}
              <MenuItem label={s.label} disabled className={styles.sectionHeader} />
              <MenuItemRadioGroup
                label={s.label}
                items={s.itemIds}
                itemToString={s.itemToString}
                selectedItem={s.selectedItem}
                onChange={(id) => handleSelect(s.url, id as string)}
              />
            </React.Fragment>
          ))}
        </MenuButton>
        {pending ? <InlineLoading className={styles.loading} description="" /> : null}
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
