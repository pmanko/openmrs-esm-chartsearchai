import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MenuButton, MenuItem, MenuItemDivider, MenuItemRadioGroup } from '@carbon/react';
import { useConfig, useStore } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig } from '../config-schema';
import { fetchProfiles, type HubProfileListResponse, type HubProfileMetadata } from '../api/chartsearchai';
import { chatSessionStore } from '../store/chat-session.store';
import styles from './model-picker.scss';

interface ModelPickerProps {
  onSwitched?: (profileId: string) => void;
}

interface ProfileSection {
  key: string;
  label: string;
  profiles: HubProfileMetadata[];
}

/** Product-profile picker backed entirely by med-agent-hub metadata. */
const ModelPicker: React.FC<ModelPickerProps> = ({ onSwitched }) => {
  const { t } = useTranslation();
  const { showModelPicker } = useConfig<ChartSearchAiConfig>();
  const { selectedProfileId } = useStore(chatSessionStore);
  const [data, setData] = useState<HubProfileListResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    chatSessionStore.setState({ profileDiscoveryStatus: 'loading' });
    fetchProfiles(controller)
      .then((result) => {
        setData(result);
        setLoadFailed(false);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          setData(null);
          setLoadFailed(true);
          chatSessionStore.setState({ selectedProfileId: null, profileDiscoveryStatus: 'unavailable' });
        }
      });
    return () => controller.abort();
  }, []);

  const productProfiles = useMemo(
    () => (Array.isArray(data?.data) ? data.data : []).filter((profile) => profile.visibility === 'product'),
    [data],
  );
  const availableProfiles = useMemo(() => productProfiles.filter((profile) => profile.available), [productProfiles]);
  const defaultProfile = useMemo(
    () => availableProfiles.find((profile) => profile.default) ?? null,
    [availableProfiles],
  );
  const effectiveProfile = useMemo(
    () => availableProfiles.find((profile) => profile.id === selectedProfileId) ?? defaultProfile,
    [availableProfiles, defaultProfile, selectedProfileId],
  );

  useEffect(() => {
    if (!data) {
      return;
    }
    const nextId = effectiveProfile?.id ?? null;
    const profileDiscoveryStatus = nextId ? 'ready' : 'unavailable';
    if (nextId !== selectedProfileId || chatSessionStore.getState().profileDiscoveryStatus !== profileDiscoveryStatus) {
      chatSessionStore.setState({ selectedProfileId: nextId, profileDiscoveryStatus });
    }
  }, [data, effectiveProfile, selectedProfileId]);

  // Every profile advertised here comes from the hub (see the component docstring above), so
  // having ANY effective profile — whether the user explicitly picked one or this picker simply
  // auto-selected the hub's advertised default on load — must route turns through the hub
  // provider. Otherwise the bundled provider silently ignores the chosen profile (it has no
  // concept of profiles and no In-Depth capability). This has to be its own effect rather than
  // living only in the click handler: Carbon's MenuItemRadioGroup does not fire onChange for a
  // click that reselects the already-checked item, so a caller who accepts the visible default
  // without ever picking a *different* item never goes through a click handler at all.
  //
  // This only updates the store value — it deliberately does NOT reset the conversation the way
  // ProviderPicker's explicit switch does. The backend's own resolveConversation already opens a
  // fresh provider-matched conversation the next time a turn is submitted with a mismatched
  // provider (it only reuses a conversation when providerId matches), so nothing here is required
  // for correctness; a reset fired from this effect would instead race the picker's own initial
  // render and can close its menu mid-interaction.
  useEffect(() => {
    if (!effectiveProfile) {
      return;
    }
    if (chatSessionStore.getState().selectedProviderId !== 'hub') {
      chatSessionStore.setState({ selectedProviderId: 'hub' });
    }
  }, [effectiveProfile]);

  const sections = useMemo<ProfileSection[]>(() => {
    const definitions = [
      { key: 'single', label: t('singleProfiles', 'Single profiles') },
      { key: 'team', label: t('teamProfiles', 'Team profiles') },
    ];
    const known = definitions
      .map(({ key, label }) => ({
        key,
        label,
        profiles: availableProfiles.filter((profile) => profile.topology === key),
      }))
      .filter((section) => section.profiles.length > 0);
    const other = availableProfiles.filter((profile) => !definitions.some(({ key }) => key === profile.topology));
    return other.length > 0
      ? [...known, { key: 'other', label: t('otherProfiles', 'Other profiles'), profiles: other }]
      : known;
  }, [availableProfiles, t]);

  const handleSelect = useCallback(
    (profileId: string) => {
      chatSessionStore.setState({ selectedProfileId: profileId });
      onSwitched?.(profileId);
    },
    [onSwitched],
  );

  if (showModelPicker === false) {
    return null;
  }

  if (!data) {
    if (loadFailed) {
      return (
        <div className={styles.root} role="status">
          {t('profilesUnavailable', 'AI profiles unavailable')}
        </div>
      );
    }
    return null;
  }

  if (productProfiles.length === 0 || !effectiveProfile) {
    return (
      <div className={styles.root} role="status">
        {t('profilesUnavailable', 'AI profiles unavailable')}
      </div>
    );
  }

  const unavailableProfiles = productProfiles.filter((profile) => !profile.available);
  const triggerLabel = effectiveProfile.label;

  return (
    <div className={styles.root}>
      <div className={styles.triggerRow}>
        <MenuButton
          data-testid="chartsearchai-profile-picker"
          label={triggerLabel}
          kind="ghost"
          size="sm"
          menuAlignment="top-end"
        >
          {sections.map((section, index) => (
            <React.Fragment key={section.key}>
              {index > 0 ? <MenuItemDivider /> : null}
              <MenuItem label={section.label} disabled className={styles.sectionHeader} />
              <MenuItemRadioGroup
                label={section.label}
                items={section.profiles.map((profile) => profile.id)}
                itemToString={(item) => {
                  const profile = section.profiles.find((candidate) => candidate.id === item);
                  if (!profile) return String(item ?? '');
                  return profile.default ? `${profile.label} ${t('defaultTag', '(default)')}` : profile.label;
                }}
                selectedItem={
                  section.profiles.some((profile) => profile.id === effectiveProfile?.id) ? effectiveProfile?.id : ''
                }
                onChange={(profileId) => handleSelect(profileId as string)}
              />
            </React.Fragment>
          ))}
          {unavailableProfiles.length > 0 ? <MenuItemDivider /> : null}
          {unavailableProfiles.length > 0 ? (
            <MenuItem label={t('unavailableProfiles', 'Unavailable')} disabled className={styles.sectionHeader} />
          ) : null}
          {unavailableProfiles.map((profile) => (
            <MenuItem key={profile.id} label={`${profile.label} (${t('unavailable', 'unavailable')})`} disabled />
          ))}
        </MenuButton>
      </div>
    </div>
  );
};

export default ModelPicker;
