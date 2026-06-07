import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MenuButton, MenuItem, MenuItemDivider, MenuItemRadioGroup } from '@carbon/react';
import { useConfig, useStore } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig } from '../config-schema';
import { fetchEndpoints, type EndpointListResponse, type EndpointSection } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import styles from './model-picker.scss';

/**
 * Curated picker contents — the published validation arms only, in two plain-language groups.
 * Models are matched by id (env-agnostic) against whatever endpoint /endpoints reports serving
 * them, so this works locally and on the cloud regardless of the registered endpoint URLs.
 * Anything not listed (team-internal component models like qwen/medgemma/gemma-31b, quant
 * variants, the LM Studio MLX line) is intentionally hidden from the chat picker.
 */
const CURATED_GROUPS: Array<{ label: string; items: Array<{ id: string; label: string }> }> = [
  {
    label: 'AI Team',
    items: [
      { id: 'med-agent-team-high-validated', label: 'High (validated)' },
      { id: 'med-agent-team-med-validated', label: 'Med (validated)' },
      { id: 'med-agent-team-low-validated-12b', label: 'Low (validated)' },
      { id: 'med-agent-team-parity', label: 'Parity' },
    ],
  },
  {
    label: 'Single models',
    items: [
      { id: 'gemma-e2b', label: 'Gemma 2B' },
      { id: 'gemma-e4b', label: 'Gemma 4B' },
      { id: 'gemma-4-12b', label: 'Gemma 12B' },
      { id: 'gemma-26b', label: 'Gemma 26B' },
      { id: 'medgemma-1.5-4b', label: 'MedGemma 1.5 (4B)' },
      { id: 'medgemma-27b', label: 'MedGemma 27B' },
      { id: 'qwen2.5-14b', label: 'Qwen 2.5 14B' },
      { id: 'qwen2.5-32b', label: 'Qwen 2.5 32B' },
    ],
  },
];

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

  // One radio group per CURATED category (AI Team / Single models), listing only the
  // validation-arm models — located by id across whatever endpoints /endpoints reports, so
  // unlisted team-internal/quant/LM-Studio models never appear. Memoised for referential
  // stability across renders.
  const sections = useMemo(() => {
    const endpoints = (data?.endpoints ?? []).filter((ep) => ep.reachable);
    const locate = (id: string): EndpointSection | undefined =>
      endpoints.find((ep) => ep.models.some((m) => m.id === id));
    return CURATED_GROUPS.map((group) => {
      const found = group.items
        .map((it) => ({ it, ep: locate(it.id) }))
        .filter((x): x is { it: { id: string; label: string }; ep: EndpointSection } => Boolean(x.ep));
      if (found.length === 0) {
        return null;
      }
      const urlById = new Map(found.map((x) => [x.it.id, x.ep.url]));
      const labelById = new Map(found.map((x) => [x.it.id, x.it.label]));
      // Only the effective selection's group carries a checked radio.
      const selectedItem =
        effective &&
        found.some((x) => x.ep.url === effective.endpointUrl && x.it.id === effective.modelName)
          ? effective.modelName
          : '';
      return {
        label: group.label,
        itemIds: found.map((x) => x.it.id),
        urlById,
        selectedItem,
        itemToString: (item: unknown) => {
          const id = item as string;
          let label = labelById.get(id) ?? id;
          // Faded tag on the config-controlled global default.
          if (defaultBackend && defaultBackend.endpointUrl === urlById.get(id) && defaultBackend.modelName === id) {
            label = `${label} ${t('defaultTag', '(default)')}`;
          }
          return label;
        },
      };
    }).filter((s): s is NonNullable<typeof s> => s !== null);
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
    const group = CURATED_GROUPS.find((g) => g.items.some((it) => it.id === effective.modelName));
    const item = group?.items.find((it) => it.id === effective.modelName);
    triggerLabel = group && item ? `${group.label} · ${item.label}` : effective.modelName;
  }

  return (
    <div className={styles.root}>
      <div className={styles.triggerRow}>
        <MenuButton label={triggerLabel} kind="ghost" size="sm" menuAlignment="top-end">
          {sections.map((s, i) => (
            <React.Fragment key={s.label}>
              {i > 0 ? <MenuItemDivider /> : null}
              {/* Carbon group labels are aria-only; a disabled MenuItem gives a
                  VISIBLE section header above the endpoint's models. */}
              <MenuItem label={s.label} disabled className={styles.sectionHeader} />
              <MenuItemRadioGroup
                label={s.label}
                items={s.itemIds}
                itemToString={s.itemToString}
                selectedItem={s.selectedItem}
                onChange={(id) => handleSelect(s.urlById.get(id as string) ?? '', id as string)}
              />
            </React.Fragment>
          ))}
        </MenuButton>
      </div>
    </div>
  );
};

export default ModelPicker;
