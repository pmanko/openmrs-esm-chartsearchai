import React from 'react';
import { useTranslation } from 'react-i18next';
import { navigate } from '@openmrs/esm-framework';
import { type AiReference } from '../api/chartsearchai';
import { highlightReference } from '../utils/highlight-reference';
import styles from './ai-response-panel.scss';

/** Reference data, not patient data — has no chart tab to navigate to. */
const RESOURCE_TYPE_DRUG_REFERENCE = 'drug_reference';

const RESOURCE_TYPE_TO_CHART_PAGE: Record<string, string> = {
  obs: 'Results',
  order: 'Orders',
  allergy: 'Allergies',
  condition: 'Conditions',
  diagnosis: 'Visits',
  program: 'Programs',
  medication_dispense: 'Medications',
};

export function isDrugReference(ref: AiReference): boolean {
  return ref.resourceType.toLowerCase() === RESOURCE_TYPE_DRUG_REFERENCE;
}

export function buildReferenceUrl(ref: AiReference, patientUuid: string): string | null {
  if (!patientUuid || isDrugReference(ref)) {
    // Drug-reference citations are clinical reference data with no patient chart tab —
    // they render as a non-navigating chip. Navigation to a detail panel is a follow-up.
    return null;
  }
  const chartPage = RESOURCE_TYPE_TO_CHART_PAGE[ref.resourceType.toLowerCase()];
  return `${window.spaBase}/patient/${patientUuid}/chart/${encodeURIComponent(chartPage ?? 'Patient Summary')}`;
}

export function handleReferenceNavigate(e: React.MouseEvent, url: string, ref: AiReference) {
  e.preventDefault();
  navigate({ to: url });
  highlightReference(ref.resourceUuid, ref.date);
}

interface CitationChipProps {
  index: number;
  reference?: AiReference;
  patientUuid: string;
}

/**
 * Inline citation chip. Navigating chips link to the patient chart page for the cited
 * record. Drug-reference citations are rendered as a non-navigating span with a tooltip
 * indicating they are clinical reference data, not this patient's records.
 * Ungrounded citations (grounded=false) render with a ⚠ glyph and a warning title.
 */
export const CitationChip: React.FC<CitationChipProps> = ({ index, reference, patientUuid }) => {
  const { t } = useTranslation();
  if (!reference) {
    return <>{index}</>;
  }
  if (isDrugReference(reference)) {
    return (
      <span
        className={styles.inlineCitationReference}
        title={t('drugReferenceCitation', 'Clinical reference data — not this patient\u2019s record.')}
      >
        {index}
      </span>
    );
  }
  const url = buildReferenceUrl(reference, patientUuid);
  if (!url) {
    return <>{index}</>;
  }
  const ungrounded = reference.grounded === false;
  return (
    <a
      className={ungrounded ? `${styles.inlineCitation} ${styles.inlineCitationUngrounded}` : styles.inlineCitation}
      href={url}
      title={
        ungrounded
          ? t('notGroundedTitle', 'The cited record may not support this statement \u2014 verify against the chart.')
          : undefined
      }
      onClick={(e) => handleReferenceNavigate(e, url, reference)}
    >
      {ungrounded ? `${index} \u26a0` : index}
    </a>
  );
};

const CITATION_PATTERN = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/**
 * Render text with inline `[N]` or `[N, M]` citation markers replaced by
 * clickable CitationChip elements. Used by both prose answers and table cells.
 */
export function renderTextWithCitations(
  text: string,
  references: AiReference[],
  patientUuid: string,
  keyPrefix = 'cit',
): React.ReactNode[] {
  const refByIndex = new Map(references.map((r) => [r.index, r]));
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(CITATION_PATTERN.source, CITATION_PATTERN.flags);

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const matchIndex = match.index;
    const citIndices = match[1].split(/\s*,\s*/).map(Number);
    parts.push('[');
    citIndices.forEach((citIndex, i) => {
      parts.push(
        <CitationChip
          key={`${keyPrefix}-${matchIndex}-${citIndex}-${i}`}
          index={citIndex}
          reference={refByIndex.get(citIndex)}
          patientUuid={patientUuid}
        />,
      );
      if (i < citIndices.length - 1) {
        parts.push(', ');
      }
    });
    parts.push(']');
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}
