import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MenuButton, MenuItem, MenuItemDivider, MenuItemRadioGroup } from '@carbon/react';
import { useStore } from '@openmrs/esm-framework';
import { fetchProviders, type ProviderListResponse } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import styles from './provider-picker.scss';

interface ProviderPickerProps {
  /** Called with the newly selected provider id when the user switches provider. */
  onSwitched?: (providerId: string) => void;
}

/**
 * Clinical-answer provider picker (bundled local inference vs. the med-agent-hub
 * relay). It appears only when ChartSearchAI advertises more than one provider
 * (`pickerVisible`). Switching starts a fresh conversation because the backend
 * attributes each conversation to a single provider, and it never silently falls
 * back to another provider.
 */
const ProviderPicker: React.FC<ProviderPickerProps> = ({ onSwitched }) => {
  const { t } = useTranslation();
  const { selectedProviderId } = useStore(chatSessionStore);
  const [data, setData] = useState<ProviderListResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchProviders(controller)
      .then((result) => setData(result))
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          setData(null);
        }
      });
    return () => controller.abort();
  }, []);

  const providers = useMemo(() => (Array.isArray(data?.providers) ? data.providers : []), [data]);
  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.enabled && provider.ready),
    [providers],
  );
  const unavailableProviders = useMemo(
    () => providers.filter((provider) => !(provider.enabled && provider.ready)),
    [providers],
  );

  // The picker reflects an explicit selection when it is still available;
  // otherwise it shows the backend's advertised default. It never writes a
  // selection on load, so an untouched picker leaves the request provider-less
  // and the backend applies its own default.
  const effectiveProviderId = useMemo(() => {
    if (selectedProviderId && availableProviders.some((provider) => provider.id === selectedProviderId)) {
      return selectedProviderId;
    }
    return data?.defaultProvider ?? null;
  }, [availableProviders, data, selectedProviderId]);

  const effectiveProvider = useMemo(
    () => availableProviders.find((provider) => provider.id === effectiveProviderId) ?? null,
    [availableProviders, effectiveProviderId],
  );

  // Make the backend-advertised default explicit in shared state so provider-specific controls
  // know which contract applies. This does not start a new conversation: it records the provider
  // the backend would select anyway.
  useEffect(() => {
    if (effectiveProviderId && effectiveProviderId !== selectedProviderId) {
      chatSessionStore.setState({ selectedProviderId: effectiveProviderId });
    }
  }, [effectiveProviderId, selectedProviderId]);

  const handleSelect = useCallback(
    (providerId: string) => {
      if (providerId === effectiveProviderId) {
        return;
      }
      chatSessionStore.setState({ selectedProviderId: providerId });
      onSwitched?.(providerId);
    },
    [effectiveProviderId, onSwitched],
  );

  if (!data || !data.pickerVisible || !effectiveProvider) {
    return null;
  }

  return (
    <div className={styles.root}>
      <div className={styles.triggerRow}>
        <MenuButton
          data-testid="chartsearchai-provider-picker"
          label={effectiveProvider.label}
          kind="ghost"
          size="sm"
          menuAlignment="top-end"
        >
          <MenuItemRadioGroup
            label={t('providers', 'Providers')}
            items={availableProviders.map((provider) => provider.id)}
            itemToString={(item) => {
              const provider = availableProviders.find((candidate) => candidate.id === item);
              if (!provider) return String(item ?? '');
              return provider.default ? `${provider.label} ${t('defaultTag', '(default)')}` : provider.label;
            }}
            selectedItem={
              availableProviders.some((provider) => provider.id === effectiveProviderId) ? effectiveProviderId : ''
            }
            onChange={(providerId) => handleSelect(providerId as string)}
          />
          {unavailableProviders.length > 0 ? <MenuItemDivider /> : null}
          {unavailableProviders.map((provider) => (
            <MenuItem key={provider.id} label={`${provider.label} (${t('unavailable', 'unavailable')})`} disabled />
          ))}
        </MenuButton>
      </div>
    </div>
  );
};

export default ProviderPicker;
