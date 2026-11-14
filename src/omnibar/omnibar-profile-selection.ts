import { showSnackbar } from '@openmrs/esm-framework';
import { selectHubProfile } from '../hooks/hub-profile-discovery';
import { OMNIBAR_SELECTED_EVENT, type OmnibarSelectedDetail } from '../omnibar-contract/types';
import { chatSessionStore } from '../store/chat-session.store';

export const CHARTSEARCH_MODEL_PROVIDER_ID = 'chartsearch-model-provider';
export const PROFILE_RESULT_PREFIX = 'profile:';

interface ProfileNotificationCopy {
  title: string;
  subtitle?: string;
}

const notificationCopyByProfileId = new Map<string, ProfileNotificationCopy>();
let activeListener: ((event: Event) => void) | null = null;

/** Cache translated snackbar copy for a profile before Omnibar unmounts the provider on select. */
export function registerOmnibarProfileNotification(profileId: string, copy: ProfileNotificationCopy): void {
  notificationCopyByProfileId.set(profileId, copy);
}

/** Clear cached notification copy (primarily for unit tests). */
export function resetOmnibarProfileNotifications(): void {
  notificationCopyByProfileId.clear();
}

function matchesModelProvider(providerId: unknown): boolean {
  return (
    typeof providerId === 'string' &&
    (providerId === CHARTSEARCH_MODEL_PROVIDER_ID || providerId.endsWith(`#${CHARTSEARCH_MODEL_PROVIDER_ID}`))
  );
}

/**
 * Listen for Omnibar `/model` selections, persist the chosen Hub preset in {@link chatSessionStore},
 * and display a non-intrusive confirmation snackbar. Safe to call repeatedly across remounts.
 */
export function setupOmnibarProfileSelectionListener(): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  if (activeListener) {
    window.removeEventListener(OMNIBAR_SELECTED_EVENT, activeListener);
    activeListener = null;
  }

  const onSelected = (event: Event) => {
    const detail = (event as CustomEvent<OmnibarSelectedDetail>).detail;
    if (!detail || !matchesModelProvider(detail.providerId)) {
      return;
    }
    if (typeof detail.resultId !== 'string' || !detail.resultId.startsWith(PROFILE_RESULT_PREFIX)) {
      return;
    }
    const profileId = detail.resultId.slice(PROFILE_RESULT_PREFIX.length);
    if (!profileId) {
      return;
    }

    selectHubProfile(profileId);

    const profile = chatSessionStore.getState().hubProfiles?.find((candidate) => candidate.id === profileId);
    const copy = notificationCopyByProfileId.get(profileId);
    showSnackbar({
      kind: 'success',
      isLowContrast: true,
      title: copy?.title ?? `Default model set to ${profile?.label ?? profileId}`,
      subtitle: copy?.subtitle,
    });
  };

  activeListener = onSelected;
  window.addEventListener(OMNIBAR_SELECTED_EVENT, onSelected);

  return () => {
    window.removeEventListener(OMNIBAR_SELECTED_EVENT, onSelected);
    if (activeListener === onSelected) {
      activeListener = null;
    }
  };
}
