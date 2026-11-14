import { type FC, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfig, useStore } from '@openmrs/esm-framework';
import { type ChartSearchAiConfig } from '../config-schema';
import { useHubProfileDiscovery } from '../hooks/hub-profile-discovery';
import { useSystemProviderDiscovery } from '../hooks/system-provider-discovery';
import { type OmnibarProviderProps, type OmnibarResult } from '../omnibar-contract/types';
import { chatSessionStore } from '../store/chat-session.store';
import { PROFILE_RESULT_PREFIX, registerOmnibarProfileNotification } from './omnibar-profile-selection';

function currentLocationTarget(): string {
  if (typeof window !== 'undefined' && window.location?.pathname) {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }
  return '/';
}

/**
 * Omnibar `/model` command provider that lists available Hub clinical-answer presets and emits
 * same-location navigate targets handled by {@link setupOmnibarProfileSelectionListener}.
 */
const ChartSearchModelProvider: FC<OmnibarProviderProps> = ({ query, context, report }) => {
  const { t } = useTranslation();
  const { showModelPicker } = useConfig<ChartSearchAiConfig>();
  const systemProvider = useSystemProviderDiscovery();
  const sessionState = useStore(chatSessionStore);
  const { hubProfiles, profileDiscoveryStatus, selectedProfileId } = sessionState;
  const isModelCommand = context.command?.id === 'model';

  // Avoid fetching /models for plain omnibar typing when the /model command is not active.
  useHubProfileDiscovery(isModelCommand ? systemProvider.providerId : null);

  useEffect(() => {
    const heading = t('aiProfile', 'AI profile');

    if (!isModelCommand) {
      report({ query, status: 'ready', title: heading, results: [] });
      return;
    }

    if (showModelPicker === false) {
      report({
        query,
        status: 'error',
        title: heading,
        detail: {
          state: 'unavailable',
          note: t('profilesUnavailable', 'AI profiles unavailable'),
        },
      });
      return;
    }

    if (
      systemProvider.status === 'loading' ||
      (systemProvider.providerId === 'hub' && profileDiscoveryStatus === 'loading')
    ) {
      report({ query, status: 'loading', title: heading, results: [] });
      return;
    }

    if (
      systemProvider.providerId !== 'hub' ||
      systemProvider.status === 'unavailable' ||
      systemProvider.status === 'error' ||
      profileDiscoveryStatus === 'unavailable'
    ) {
      report({
        query,
        status: 'error',
        title: heading,
        detail: {
          state: 'unavailable',
          note: t('profilesUnavailable', 'AI profiles unavailable'),
        },
      });
      return;
    }

    const availableProfiles = (hubProfiles ?? []).filter(
      (profile) => profile.visibility !== 'internal' && profile.available,
    );

    availableProfiles.forEach((profile) => {
      registerOmnibarProfileNotification(profile.id, {
        title: t('omnibarModelSelectedTitle', 'Default model set to {{model}}', {
          model: profile.label,
          interpolation: { escapeValue: false },
        }),
      });
    });

    const trimmedQuery = query.trim().toLowerCase();
    const targetTo = currentLocationTarget();
    const results: OmnibarResult[] = availableProfiles
      .filter((profile) => {
        if (!trimmedQuery) {
          return true;
        }
        return (
          profile.label.toLowerCase().includes(trimmedQuery) ||
          profile.id.toLowerCase().includes(trimmedQuery) ||
          (profile.description ?? '').toLowerCase().includes(trimmedQuery)
        );
      })
      .map((profile) => {
        const isActive = profile.id === selectedProfileId;
        const title = profile.default ? `${profile.label} ${t('defaultTag', '(default)')}` : profile.label;
        let subtitle = profile.description || undefined;
        if (isActive) {
          subtitle = profile.description
            ? t('omnibarModelActiveWithDescription', 'Active · {{description}}', {
                description: profile.description,
                interpolation: { escapeValue: false },
              })
            : t('omnibarModelActive', 'Active');
        }
        return {
          id: `${PROFILE_RESULT_PREFIX}${profile.id}`,
          title,
          subtitle,
          target: { type: 'navigate', to: targetTo },
        };
      });

    report({
      query,
      status: 'ready',
      title: heading,
      results,
    });
  }, [
    hubProfiles,
    isModelCommand,
    profileDiscoveryStatus,
    query,
    report,
    selectedProfileId,
    showModelPicker,
    systemProvider.providerId,
    systemProvider.status,
    t,
  ]);

  return null;
};

export default ChartSearchModelProvider;
