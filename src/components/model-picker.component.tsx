import React, { useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MenuButton, MenuItemRadioGroup, Toggle } from '@carbon/react';
import { useConfig, useStore } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig } from '../config-schema';
import { selectHubProfile, useHubProfileDiscovery } from '../hooks/hub-profile-discovery';
import {
  chatSessionStore,
  providerSupportsInDepth,
  requestProviderFor,
  setInDepthEnabled,
} from '../store/chat-session.store';
import { useMenuTriggerName } from './menu-trigger-name';
import styles from './model-picker.scss';

interface ModelPickerProps {
  /** The panel's patient: the picker shows only while that patient's requests go to the Hub. */
  patientUuid?: string;
}

/**
 * Preset picker backed by ChartSearchAI's Hub preset discovery endpoint. It lists only presets whose
 * backing models and execution mode are currently available; discovery and the decision whether a
 * question may be sent live in {@link useHubProfileDiscovery}, which the conversation hook also runs.
 */
const ModelPicker: React.FC<ModelPickerProps> = ({ patientUuid }) => {
  const { t } = useTranslation();
  const inDepthToggleId = useId();
  const { showModelPicker } = useConfig<ChartSearchAiConfig>();
  const sessionState = useStore(chatSessionStore);
  const { selectedProfileId, hubProfiles, profileDiscoveryStatus, inDepthEnabled } = sessionState;
  const providerId = requestProviderFor(sessionState, patientUuid);
  const supportsInDepth = providerSupportsInDepth(sessionState, providerId);
  const triggerRef = useRef<HTMLDivElement>(null);
  useHubProfileDiscovery(providerId);

  const availableProfiles = useMemo(() => (hubProfiles ?? []).filter((profile) => profile.available), [hubProfiles]);
  const selectedProfile = useMemo(
    () => (hubProfiles ?? []).find((profile) => profile.id === selectedProfileId) ?? null,
    [hubProfiles, selectedProfileId],
  );
  const effectiveProfile = profileDiscoveryStatus === 'ready' && selectedProfile?.available ? selectedProfile : null;

  const unavailableSelectionLabel =
    profileDiscoveryStatus === 'selection-unavailable'
      ? `${selectedProfile?.label ?? selectedProfileId} (${t('unavailable', 'unavailable')})`
      : null;
  const triggerLabel =
    effectiveProfile?.label ?? unavailableSelectionLabel ?? t('chooseAiProfile', 'Choose AI profile');
  useMenuTriggerName(triggerRef, `${t('aiProfile', 'AI profile')}: ${triggerLabel}`);

  const showPicker = showModelPicker !== false && providerId === 'hub' && profileDiscoveryStatus !== 'loading';
  if (!showPicker && !supportsInDepth) {
    return null;
  }

  const inDepthToggle = supportsInDepth ? (
    <div className={styles.inDepthControl}>
      <Toggle
        id={inDepthToggleId}
        size="sm"
        hideLabel
        labelText={t('inDepthToggleLabel', 'In depth')}
        toggled={Boolean(inDepthEnabled)}
        onToggle={(checked) => setInDepthEnabled(checked)}
      />
    </div>
  ) : null;

  if (showPicker && (!hubProfiles || availableProfiles.length === 0)) {
    return (
      <div className={styles.root} role="status">
        <div className={styles.triggerRow}>
          {t('profilesUnavailable', 'AI profiles unavailable')}
          {inDepthToggle}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.triggerRow}>
        {showPicker && (
          <MenuButton
            ref={triggerRef}
            data-testid="chartsearchai-profile-picker"
            label={triggerLabel}
            kind="ghost"
            size="sm"
            menuAlignment="top-end"
          >
            <MenuItemRadioGroup
              label={t('aiProfile', 'AI profile')}
              items={availableProfiles.map((profile) => profile.id)}
              itemToString={(item) => {
                const profile = availableProfiles.find((candidate) => candidate.id === item);
                if (!profile) return String(item ?? '');
                return profile.default ? `${profile.label} ${t('defaultTag', '(default)')}` : profile.label;
              }}
              selectedItem={
                availableProfiles.some((profile) => profile.id === effectiveProfile?.id) ? effectiveProfile?.id : ''
              }
              onChange={(profileId) => selectHubProfile(profileId as string)}
            />
          </MenuButton>
        )}
        {inDepthToggle}
      </div>
    </div>
  );
};

export default ModelPicker;
