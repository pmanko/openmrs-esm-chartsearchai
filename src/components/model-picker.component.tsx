import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MenuButton, MenuItem, MenuItemDivider, MenuItemRadioGroup } from '@carbon/react';
import { useConfig, useStore } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig } from '../config-schema';
import { fetchEndpoints, type EndpointListResponse } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import styles from './model-picker.scss';

interface ModelPickerProps {
  /** Called when the selection changes — lets the parent react if needed. */
  onSwitched?: (modelName: string) => void;
}

/**
 * Inline endpoint+model picker for the chat panel footer. A Carbon MenuButton
 * whose menu has one MenuItemRadioGroup per configured endpoint (LM Studio, Med
 * Agent Hub, ...). Selecting a model picks the backend for THIS browser session
 * only: it is sent as a per-request override on each chat post and does NOT mutate
 * chartsearchai's config-controlled global default (which is shown with a faded
 * "(default)" tag). Carbon portals the menu to document.body so it is never clipped
 * by the panel's overflow.
 *
 * Hides itself when: config.showModelPicker is false; the /endpoints fetch fails;
 * or there are fewer than 2 selectable models across all reachable endpoints.
 */
const ModelPicker: React.FC<ModelPickerProps> = ({ onSwitched }) => {
  const { t } = useTranslation();
  const { showModelPicker } = useConfig<ChartSearchAiConfig>();
  const [data, setData] = useState<EndpointListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The per-session selection (sent as the per-request override). null = use the
  // config-controlled global default. Consume the whole store state (matching the
  // chat hook) rather than a selector — the selection re-renders this in place.
  const { selectedBackend } = useStore(chatSessionStore);

  // Load once on mount. The chat panel unmounts/remounts this component each time
  // it opens, so an out-of-band change (operator ran chartsearch-configure,
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

  // The config-controlled global default (immutable here — gets the "(default)" tag).
  const defaultBackend = data?.current;
  // What the chat will actually use: the per-session selection, else the default.
  // Memoised so it's referentially stable across renders (it feeds the `sections`
  // useMemo deps); the whole-store subscription re-renders this on every store change.
  const effective = useMemo(
    () =>
      selectedBackend ??
      (defaultBackend && defaultBackend.endpointUrl && defaultBackend.modelName
        ? { endpointUrl: defaultBackend.endpointUrl, modelName: defaultBackend.modelName }
        : null),
    [selectedBackend, defaultBackend],
  );

  // Selecting a model writes the per-session selection — it does NOT call the
  // global-switch endpoint, so the config default is never mutated.
  const handleSelect = useCallback(
    (url: string, modelId: string) => {
      chatSessionStore.setState({ selectedBackend: { endpointUrl: url, modelName: modelId } });
      onSwitched?.(modelId);
    },
    [onSwitched],
  );

  // One radio group per reachable endpoint. Memoised so the groups' items /
  // itemToString stay referentially stable between renders.
  const sections = useMemo(() => {
    const endpoints = data?.endpoints ?? [];
    return endpoints
      .filter((ep) => ep.reachable && ep.models.length > 0)
      .map((ep) => {
        // "(not loaded)" is only meaningful where the backend probes load state.
        const showLoaded = ep.provider === 'lm-studio';
        const byId = new Map(ep.models.map((m) => [m.id, m]));
        return {
          url: ep.url,
          label: ep.label,
          itemIds: ep.models.map((m) => m.id),
          // Only the effective selection's group carries a checked radio.
          selectedItem: effective && effective.endpointUrl === ep.url ? effective.modelName : '',
          itemToString: (item: unknown) => {
            const id = item as string;
            const m = byId.get(id);
            if (!m) return id;
            let label = m.displayName;
            if (showLoaded && m.loaded === false) {
              label = `${label} ${t('notLoaded', '(not loaded)')}`;
            }
            // Faded tag on the config-controlled global default.
            if (defaultBackend && defaultBackend.endpointUrl === ep.url && defaultBackend.modelName === id) {
              label = `${label} ${t('defaultTag', '(default)')}`;
            }
            return label;
          },
        };
      });
  }, [data, effective, defaultBackend, t]);

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
  const totalModels = sections.reduce((n, s) => n + s.itemIds.length, 0);
  if (totalModels < 2) {
    return null;
  }

  // Trigger label: "<endpoint> · <model>" for the effective selection.
  let triggerLabel = t('noModel', 'No model');
  if (effective) {
    const ep = (data.endpoints ?? []).find((e) => e.url === effective.endpointUrl);
    const m = ep?.models.find((x) => x.id === effective.modelName);
    triggerLabel = ep && m ? `${ep.label} · ${m.displayName}` : effective.modelName;
  }

  return (
    <div className={styles.root}>
      <div className={styles.triggerRow}>
        <MenuButton label={triggerLabel} kind="ghost" size="sm" menuAlignment="top-end">
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
      </div>
    </div>
  );
};

export default ModelPicker;
