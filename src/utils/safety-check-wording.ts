import { type Translate } from '../components/citation-chip.component';

export const SUPPRESSED_SAFETY_ISSUES = new Set([
  'check_disabled',
  'no_applicable_check',
  'condition_rules_unavailable',
  'no_actionable_dose_reference',
]);

export function safetyIssueText(issue: string, t: Translate): string {
  if (issue.startsWith('named_drug_unresolved:')) {
    const medication = issue.slice('named_drug_unresolved:'.length).trim();
    if (medication && medication !== 'resolution_failed') {
      return t(
        'safetyNamedDrugUnresolved',
        'The medication “{{medication}}” could not be matched to the configured reference source.',
        { medication, interpolation: { escapeValue: false } },
      );
    }
    return t(
      'safetyDrugResolutionFailed',
      'A named medication could not be matched to the configured reference source.',
    );
  }
  switch (issue) {
    case 'source_not_clinically_approved':
      return t(
        'safetySourceNotApproved',
        'The configured research source is not clinically approved for deterministic warnings.',
      );
    case 'cross_reactivity_not_clinically_approved':
      return t('safetyCrossReactivityNotApproved', 'The cross-reactivity rules are not clinically approved.');
    case 'source_unavailable':
      return t('safetySourceUnavailable', 'No medication-safety reference source was available.');
    case 'source_data_invalid':
      return t('safetySourceDataInvalid', 'The medication-safety reference data could not be read safely.');
    case 'source_data_partially_invalid':
      return t(
        'safetySourceDataPartiallyInvalid',
        'Some medication-safety reference records were invalid and ignored.',
      );
    case 'source_package_identity_incomplete':
      return t(
        'safetySourcePackageIdentityIncomplete',
        'The medication-safety rule package is missing required source identity information.',
      );
    case 'source_retired':
      return t('safetySourceRetired', 'The configured medication-safety source has been retired.');
    case 'cross_reactivity_source_unavailable':
      return t('safetyCrossReactivitySourceUnavailable', 'No cross-reactivity reference source was available.');
    case 'cross_reactivity_data_invalid':
      return t('safetyCrossReactivityDataInvalid', 'The cross-reactivity reference data could not be read safely.');
    case 'cross_reactivity_data_partially_invalid':
      return t(
        'safetyCrossReactivityDataPartiallyInvalid',
        'Some cross-reactivity reference records were invalid and ignored.',
      );
    case 'cross_reactivity_package_identity_incomplete':
      return t(
        'safetyCrossReactivityPackageIdentityIncomplete',
        'The cross-reactivity rule package is missing required source identity information.',
      );
    case 'cross_reactivity_source_retired':
      return t('safetyCrossReactivitySourceRetired', 'The configured cross-reactivity source has been retired.');
    case 'patient_context_unavailable':
      return t('safetyPatientContextUnavailable', 'The patient context needed for this check was unavailable.');
    case 'mapping_incomplete':
      return t('safetyMappingIncomplete', 'Not every active medication could be mapped to the reference source.');
    case 'exposure_incomplete':
      return t(
        'safetyExposureIncomplete',
        'Medication, allergy, or condition context may be incomplete for this check.',
      );
    case 'checks_partially_disabled':
      return t('safetyChecksPartiallyDisabled', 'Some medication-safety checks are disabled.');
    case 'interaction_reference_unavailable':
      return t(
        'safetyInteractionReferenceUnavailable',
        'A medication in this check has no usable interaction reference data.',
      );
    case 'dose_not_assessable':
      return t(
        'safetyDoseNotAssessable',
        'The answer did not supply a dose and schedule that this check could assess.',
      );
    case 'weight_unavailable':
      return t(
        'safetyWeightUnavailable',
        'A weight-based dose check could not run because the patient weight was unavailable.',
      );
    case 'check_scope_limited':
      return t('safetyScopeLimited', 'Only part of the configured medication-safety check ran.');
    case 'execution_failed':
      return t('safetyExecutionFailed', 'The medication-safety check did not complete.');
    default:
      return issue.replaceAll('_', ' ');
  }
}
