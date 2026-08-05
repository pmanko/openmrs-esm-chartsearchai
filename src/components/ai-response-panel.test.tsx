import React from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AiResponsePanel from './ai-response-panel.component';
import { highlightReference } from '../utils/highlight-reference';
import { SESSION_EXPIRED_ERROR_CODE } from '../api/chartsearchai';

vi.mock('../utils/highlight-reference', () => ({ highlightReference: vi.fn() }));
const mockHighlightReference = highlightReference as Mock;

const patientUuid = 'test-patient-uuid';

beforeAll(() => {
  window.spaBase = '/openmrs/spa';
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).spaBase;
});

describe('AiResponsePanel reference links', () => {
  const references = [
    { index: 1, resourceType: 'obs', resourceUuid: 'uuid-101', date: '2025-01-15' },
    { index: 2, resourceType: 'order', resourceUuid: 'uuid-202', date: '2025-02-20' },
    { index: 3, resourceType: 'allergy', resourceUuid: 'uuid-303', date: '2025-03-10' },
    { index: 4, resourceType: 'condition', resourceUuid: 'uuid-404', date: '2025-04-05' },
    { index: 5, resourceType: 'diagnosis', resourceUuid: 'uuid-505', date: '2025-05-12' },
  ];

  const answer =
    'The patient has lab results [1] and an active order [2]. They have an allergy [3], a condition [4], and a diagnosis [5].';

  it('keeps raw reference tags in a collapsed detail while inline links stay available', () => {
    render(
      <AiResponsePanel
        answer={answer}
        references={references}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    const details = screen.getByText('Citation details').closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Citation details'));
    expect(details).toHaveAttribute('open');
    expect(screen.getAllByRole('link')).toHaveLength(10);

    // Check reference tag links (the ones with label text like "[1] obs — 2025-01-15")
    const obsLink = screen.getByText('[1] obs — 2025-01-15');
    expect(obsLink.tagName).toBe('A');
    expect(obsLink).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Results`);

    const orderLink = screen.getByText('[2] order — 2025-02-20');
    expect(orderLink.tagName).toBe('A');
    expect(orderLink).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Orders`);

    const allergyLink = screen.getByText('[3] allergy — 2025-03-10');
    expect(allergyLink.tagName).toBe('A');
    expect(allergyLink).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Allergies`);

    const conditionLink = screen.getByText('[4] condition — 2025-04-05');
    expect(conditionLink.tagName).toBe('A');
    expect(conditionLink).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Conditions`);

    const diagnosisLink = screen.getByText('[5] diagnosis — 2025-05-12');
    expect(diagnosisLink.tagName).toBe('A');
    expect(diagnosisLink).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Visits`);
  });

  it('renders resolved hub references as evidence tiles with source text', () => {
    render(
      <AiResponsePanel
        answer="The last visit was documented on 2026-01-26 [4]."
        references={[
          {
            index: 4,
            sourceId: 'querystore:encounter:enc-4',
            resourceType: 'encounter',
            resourceUuid: 'enc-4',
            date: '2026-01-26',
            title: 'Adult visit on 2026-01-26',
            sourceText: 'Encounter: Adult Visit at Unknown Location. Provider: Horatio L Hornblower',
            resolutionStatus: 'resolved',
            groundingStatus: 'verified',
            usage: [{ location: 'answer', text: 'The last visit was documented.' }],
          },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Evidence Used')).toBeInTheDocument();
    expect(screen.getByText('[4] · encounter · 2026-01-26')).toBeInTheDocument();
    expect(screen.getByText('Adult visit on 2026-01-26')).toBeInTheDocument();
    expect(
      screen.getByText('Encounter: Adult Visit at Unknown Location. Provider: Horatio L Hornblower'),
    ).toBeInTheDocument();
    expect(screen.getByText(/UUID: enc-4/)).toBeInTheDocument();
    expect(screen.getByText('Source found')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Used in: answer')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Citation details'));
    expect(screen.getByText('[4] · querystore:encounter:enc-4 · resolved · verified')).toBeInTheDocument();
  });

  it('shows an unresolved citation as a missing-source evidence tile', () => {
    render(
      <AiResponsePanel
        answer="Unsupported citation [99]."
        references={[
          {
            index: 99,
            sourceId: 'unresolved:99',
            resourceType: 'unknown',
            resourceUuid: '',
            date: '',
            resolutionStatus: 'unresolved',
            groundingStatus: 'unchecked',
            usage: [{ location: 'answer', text: 'Unsupported citation [99].' }],
          },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Evidence Used')).toBeInTheDocument();
    expect(screen.getByText('Source missing')).toBeInTheDocument();
    expect(screen.getByText('unknown 99')).toBeInTheDocument();
  });

  it('shows title-only resolved evidence without duplicating source-derived titles', () => {
    const { rerender } = render(
      <AiResponsePanel
        answer="A supported answer [7]."
        references={[
          {
            index: 7,
            title: 'Medication order',
            sourceText: '',
            resourceType: 'order',
            resourceUuid: 'order-7',
            date: '2026-07-10',
            resolutionStatus: 'resolved',
            groundingStatus: 'verified',
          },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Medication order')).toBeInTheDocument();

    rerender(
      <AiResponsePanel
        answer="A supported answer [7]."
        references={[
          {
            index: 7,
            sourceText: '(2026-07-10) Medication order',
            resourceType: 'order',
            resourceUuid: 'order-7',
            date: '2026-07-10',
            resolutionStatus: 'resolved',
            groundingStatus: 'verified',
          },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
    expect(screen.getAllByText('Medication order')).toHaveLength(1);
    expect(screen.queryByText('(2026-07-10) Medication order')).not.toBeInTheDocument();
  });

  it('passes the resource UUID (not a numeric id) to highlightReference when a citation is clicked', () => {
    render(
      <AiResponsePanel
        answer={answer}
        references={references}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    fireEvent.click(screen.getByText('Citation details'));
    fireEvent.click(screen.getByText('[1] obs — 2025-01-15'));

    // The cited record's UUID must reach highlightReference so it can locate the chart row.
    // Before the fix the panel read `ref.resourceId` (undefined, since the backend sends
    // `resourceUuid`), so id-based row matching silently never fired.
    expect(mockHighlightReference).toHaveBeenCalledWith('uuid-101', '2025-01-15');
  });

  it('renders inline citations as clickable <a> elements', () => {
    render(
      <AiResponsePanel
        answer={answer}
        references={references}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // Inline citations render as plain numbers inside brackets: [ <a>1</a> ]
    const allLinks = screen.getAllByRole('link');
    const inlineCitations = allLinks.filter((link) => /^\d+$/.test(link.textContent ?? ''));
    expect(inlineCitations.length).toBe(5);

    // Each inline citation should have a valid href
    const expectedHrefs = [
      `/openmrs/spa/patient/${patientUuid}/chart/Results`,
      `/openmrs/spa/patient/${patientUuid}/chart/Orders`,
      `/openmrs/spa/patient/${patientUuid}/chart/Allergies`,
      `/openmrs/spa/patient/${patientUuid}/chart/Conditions`,
      `/openmrs/spa/patient/${patientUuid}/chart/Visits`,
    ];
    inlineCitations.forEach((citation) => {
      expect(expectedHrefs).toContain(citation.getAttribute('href'));
    });
  });

  it('renders comma-separated inline citations as individual clickable links', () => {
    const refs = [
      { index: 1, resourceType: 'obs', resourceUuid: 'uuid-101', date: '2025-01-15' },
      { index: 2, resourceType: 'order', resourceUuid: 'uuid-202', date: '2025-02-20' },
    ];

    render(
      <AiResponsePanel
        answer="The patient has findings [1, 2]."
        references={refs}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // Numbers are individually linked; brackets and comma are plain text
    const link1 = screen.getByRole('link', { name: '1' });
    expect(link1).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Results`);

    const link2 = screen.getByRole('link', { name: '2' });
    expect(link2).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Orders`);
  });

  it('renders a duplicated citation index ([n, n]) without a React key collision', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refs = [{ index: 3, resourceType: 'obs', resourceUuid: 'uuid-303', date: '2025-03-10' }];

    render(
      <AiResponsePanel
        answer="The same finding is cited twice [3, 3]."
        references={refs}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // Both inline citations render (one per position in the bracket group)...
    expect(screen.getAllByRole('link', { name: '3' })).toHaveLength(2);
    // ...and React logs no duplicate-key warning, because the key includes the group position.
    const dupKeyWarning = errorSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('same key'),
    );
    expect(dupKeyWarning).toBe(false);
    errorSpy.mockRestore();
  });

  it('renders unknown resource types as links to Patient Summary', () => {
    const unknownRef = [{ index: 1, resourceType: 'UnknownType', resourceUuid: 'uuid-999', date: '2025-06-01' }];

    render(
      <AiResponsePanel
        answer="Some answer [1]."
        references={unknownRef}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    const tag = screen.getByText('[1] UnknownType — 2025-06-01');
    expect(tag.tagName).toBe('A');
    expect(tag).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Patient%20Summary`);
  });

  it('shows only the error when there is no partial answer', () => {
    render(
      <AiResponsePanel
        answer=""
        references={[]}
        auditLogId={42}
        error="Server error: 500"
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Server error: 500')).toBeInTheDocument();
    expect(screen.queryByText(/Response interrupted/)).not.toBeInTheDocument();
  });

  it('renders a Carbon DataTable below the prose when blocks are present', () => {
    const refs = [
      { index: 1, resourceType: 'order', resourceUuid: 'uuid-100', date: '2024-01-01' },
      { index: 2, resourceType: 'order', resourceUuid: 'uuid-200', date: '2024-02-01' },
    ];
    const blocks = [
      {
        kind: 'table' as const,
        title: 'Medications',
        columns: [
          { key: 'name', label: 'Medication' },
          { key: 'dose', label: 'Dose' },
        ],
        rows: [
          { cells: { name: { text: 'Lisinopril', refs: [1] }, dose: { text: '10 mg' } } },
          { cells: { name: { text: 'Metformin', refs: [2] }, dose: { text: '500 mg' } } },
        ],
      },
    ];

    render(
      <AiResponsePanel
        answer="See table for medications."
        references={refs}
        blocks={blocks}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // Prose answer still renders
    expect(screen.getByText(/See table for medications/)).toBeInTheDocument();
    // Table title + headers + rows render
    expect(screen.getByText('Medications')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Medication' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Dose' })).toBeInTheDocument();
    expect(screen.getByText('Lisinopril')).toBeInTheDocument();
    expect(screen.getByText('Metformin')).toBeInTheDocument();
    expect(screen.getByText('10 mg')).toBeInTheDocument();
    expect(screen.getByText('500 mg')).toBeInTheDocument();
  });

  it('does NOT render table blocks while answer is still streaming', () => {
    const blocks = [
      {
        kind: 'table' as const,
        title: 'Stale',
        columns: [{ key: 'a', label: 'A' }],
        rows: [{ cells: { a: { text: 'should-not-show' } } }],
      },
    ];
    render(
      <AiResponsePanel
        answer="Still typing"
        references={[]}
        blocks={blocks}
        auditLogId={42}
        error={null}
        phase="answering"
        patientUuid={patientUuid}
      />,
    );
    // The streaming-time render only shows prose; blocks land atomically once done.
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.queryByText('should-not-show')).not.toBeInTheDocument();
  });

  it('localizes the session-expired error code (does not render the raw code)', () => {
    render(
      <AiResponsePanel
        answer=""
        references={[]}
        auditLogId={42}
        error={SESSION_EXPIRED_ERROR_CODE}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // The API emits a code; the panel must render the (localizable) message, never the raw code.
    expect(screen.getByText('Your session has expired. Please log in again.')).toBeInTheDocument();
    expect(screen.queryByText(SESSION_EXPIRED_ERROR_CODE)).not.toBeInTheDocument();
  });

  it('shows partial answer with error banner when stream fails mid-response', () => {
    render(
      <AiResponsePanel
        answer="The patient has been taking"
        references={[]}
        auditLogId={42}
        error="Connection lost"
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('The patient has been taking')).toBeInTheDocument();
    expect(screen.getByText(/Response interrupted:/)).toBeInTheDocument();
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument();
  });
});

describe('AiResponsePanel citation grounding', () => {
  const answer = 'The patient has a finding [1].';

  function renderWithGrounded(
    grounded: boolean | null,
    groundingStatus?: 'checking' | 'verified' | 'unsupported' | 'unchecked' | 'mixed',
    groundingScope?: 'record' | 'source_set',
  ) {
    render(
      <AiResponsePanel
        answer={answer}
        references={[
          {
            index: 1,
            resourceType: 'obs',
            resourceUuid: 'uuid-101',
            date: '2025-01-15',
            grounded,
            groundingStatus,
            groundingScope,
          },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  it('flags an unsupported citation (grounded=false) in the list and inline', () => {
    renderWithGrounded(false);
    expect(screen.getByText('Unsupported')).toBeInTheDocument();
    // inline citation carries the warning glyph
    expect(screen.getByRole('link', { name: /1\s*⚠/ })).toBeInTheDocument();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
  });

  it('marks a supported citation (grounded=true) verified with no inline warning', () => {
    renderWithGrounded(true);
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1' })).toBeInTheDocument();
    expect(screen.queryByText('Unsupported')).not.toBeInTheDocument();
  });

  it('labels a collective verdict as source-set support rather than individual-record support', () => {
    renderWithGrounded(true, 'verified', 'source_set');
    expect(screen.getByTitle('Supports this claim together with the other cited records.')).toBeInTheDocument();
  });

  it('labels a negative collective verdict as a source-set result', () => {
    renderWithGrounded(false, 'unsupported', 'source_set');
    expect(
      screen.getByTitle('This cited source set may not support the associated claim — verify against the chart.'),
    ).toBeInTheDocument();
  });

  it('does not collapse mixed claim-level support into a verified or unsupported record', () => {
    renderWithGrounded(null, 'mixed', 'source_set');
    expect(screen.getByText('Mixed support')).toBeInTheDocument();
    expect(
      screen.getByTitle('This record supports some associated claims but not others — inspect the evidence details.'),
    ).toBeInTheDocument();
  });

  it('shows no grounding badge when the verdict is null (unverified)', () => {
    renderWithGrounded(null);
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    expect(screen.queryByText('Unsupported')).not.toBeInTheDocument();
    // plain inline citation, no warning glyph
    expect(screen.getByRole('link', { name: '1' })).toBeInTheDocument();
  });

  it('shows a checking badge while citation grounding is pending', () => {
    renderWithGrounded(null, 'checking');
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    expect(screen.queryByText('Unsupported')).not.toBeInTheDocument();
  });
});

describe('AiResponsePanel drug-reference citations', () => {
  const references = [{ index: 6, resourceType: 'drug_reference', resourceUuid: 'ibuprofen', date: '' }];

  it('renders a drug-reference citation as non-navigating, visually distinct', () => {
    render(
      <AiResponsePanel
        answer="Reference dosing for ibuprofen [6]."
        references={references}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // The reference chip reads "Drug reference" (not the raw resourceType + date).
    const chip = screen.getByText('[6] Drug reference');
    expect(chip.tagName).not.toBe('A');
    // A distinct "Reference" badge is shown.
    expect(screen.getByText('Reference')).toBeInTheDocument();
    // The inline citation does not navigate (it is a span, not a link).
    expect(screen.queryByRole('link', { name: '6' })).not.toBeInTheDocument();
  });

  it('renders a mixed [drug_reference, chart-record] citation: reference non-navigating, record linked', () => {
    const refs = [
      { index: 3, resourceType: 'drug_reference', resourceUuid: 'ibuprofen', date: '' },
      { index: 5, resourceType: 'obs', resourceUuid: 'uuid-505', date: '2025-05-12' },
    ];
    render(
      <AiResponsePanel
        answer="Per the reference and the patient's labs [3, 5]."
        references={refs}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // The chart-record index stays a navigable inline link...
    expect(screen.getByRole('link', { name: '5' })).toHaveAttribute(
      'href',
      `/openmrs/spa/patient/${patientUuid}/chart/Results`,
    );
    // ...while the drug_reference index in the same bracket does NOT navigate (rendered as a span).
    expect(screen.queryByRole('link', { name: '3' })).not.toBeInTheDocument();
  });
});

describe('AiResponsePanel safety warnings', () => {
  it('renders safety warnings as chips below the answer', () => {
    render(
      <AiResponsePanel
        answer="Ibuprofen 600 mg every 6 hours [6]."
        references={[]}
        safetyWarnings={[
          { type: 'overdose', drug: 'Ibuprofen', detail: 'stated dose ~2400 mg/day exceeds the 1200 mg/day maximum' },
          { type: 'interaction', drug: 'Ibuprofen', detail: 'interacts with active order warfarin' },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Safety checks:')).toBeInTheDocument();
    expect(screen.getByText('Dose')).toBeInTheDocument();
    expect(screen.getByText('Interaction')).toBeInTheDocument();
    expect(screen.getByText(/Ibuprofen: stated dose/)).toBeInTheDocument();
    expect(screen.getByText(/exceeds the 1200 mg\/day maximum/)).toBeInTheDocument();
    expect(screen.getByText(/interacts with active order warfarin/)).toBeInTheDocument();
    expect(screen.queryByText(/overdose:Ibuprofen/)).not.toBeInTheDocument();
  });

  it('renders a contraindication warning with the Contraindication label', () => {
    // Contraindication is the highest-stakes warning type (and the one the backend's
    // question-driven validator most often produces); its switch case must render, not fall
    // through to the generic fallback.
    render(
      <AiResponsePanel
        answer="Ibuprofen is an option [1]."
        references={[]}
        safetyWarnings={[
          { type: 'contraindication', drug: 'Ibuprofen', detail: 'the patient has a recorded allergy to Ibuprofen' },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Safety checks:')).toBeInTheDocument();
    expect(screen.getByText('Contraindication')).toBeInTheDocument();
    expect(screen.getByText(/recorded allergy to Ibuprofen/)).toBeInTheDocument();
  });

  it('renders no safety section when there are no warnings', () => {
    render(
      <AiResponsePanel
        answer="The blood pressure is 120/80 [1]."
        references={[]}
        safetyWarnings={[]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.queryByText('Safety checks:')).not.toBeInTheDocument();
  });

  it('stays silent for a checked status with nothing flagged (the clean, good case)', () => {
    render(
      <AiResponsePanel
        answer="The blood pressure is 120/80 [1]."
        references={[]}
        safetyWarnings={[]}
        safetyStatus="checked"
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.queryByText('Safety checks:')).not.toBeInTheDocument();
  });

  it('surfaces an unavailable safety status even with no warnings, so it is never mistaken for checked-clean', () => {
    render(
      <AiResponsePanel
        answer="Ibuprofen could be considered [1]."
        references={[]}
        safetyWarnings={[]}
        safetyStatus="unavailable"
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Safety checks:')).toBeInTheDocument();
    expect(screen.getByText('Safety check unavailable')).toBeInTheDocument();
  });

  it('surfaces a limited safety status even with no warnings', () => {
    render(
      <AiResponsePanel
        answer="Ibuprofen could be considered [1]."
        references={[]}
        safetyWarnings={[]}
        safetyStatus="limited"
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Safety checks:')).toBeInTheDocument();
    expect(screen.getByText('Limited safety check')).toBeInTheDocument();
  });

  it('surfaces both the status tag and the individual warnings together', () => {
    render(
      <AiResponsePanel
        answer="Ibuprofen 600 mg every 6 hours [6]."
        references={[]}
        safetyWarnings={[
          { type: 'overdose', drug: 'Ibuprofen', detail: 'stated dose ~2400 mg/day exceeds the 1200 mg/day maximum' },
        ]}
        safetyStatus="checked"
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Safety checks:')).toBeInTheDocument();
    expect(screen.getByText('Dose')).toBeInTheDocument();
    expect(screen.queryByText('Safety check unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Limited safety check')).not.toBeInTheDocument();
  });

  it('does not repeat a drug name already present in a warning detail', () => {
    render(
      <AiResponsePanel
        answer="Ibuprofen should be avoided."
        references={[]}
        safetyWarnings={[
          { type: 'contraindication', drug: 'Ibuprofen', detail: 'Ibuprofen is contraindicated for this patient.' },
        ]}
        safetyStatus="checked"
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Ibuprofen is contraindicated for this patient.')).toBeInTheDocument();
    expect(screen.queryByText(/Ibuprofen: Ibuprofen/)).not.toBeInTheDocument();
  });

  it('surfaces an unrecognised warning type with the fallback label (never drops a warning)', () => {
    render(
      <AiResponsePanel
        answer="Some answer."
        references={[]}
        safetyWarnings={[{ type: 'future-unknown-type', drug: 'Ibuprofen', detail: 'a new advisory kind' }]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // A future/unknown warning type must still surface — not silently vanish.
    expect(screen.getByText('Safety checks:')).toBeInTheDocument();
    expect(screen.getByText('Safety')).toBeInTheDocument();
    expect(screen.getByText(/a new advisory kind/)).toBeInTheDocument();
  });

  it('does not mark the safety section as an assertive alert (it sits inside a polite live region)', () => {
    render(
      <AiResponsePanel
        answer="Ibuprofen 600 mg [1]."
        references={[]}
        safetyWarnings={[{ type: 'overdose', drug: 'Ibuprofen', detail: 'exceeds the maximum' }]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    // A role="alert" here would preempt the answer announcement in the enclosing role="log".
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // ...but the warning still renders.
    expect(screen.getByText('Safety checks:')).toBeInTheDocument();
  });
});

describe('AiResponsePanel copy-to-clipboard', () => {
  const references = [
    { index: 1, resourceType: 'obs', resourceUuid: 'uuid-101', date: '2025-01-15' },
    { index: 2, resourceType: 'order', resourceUuid: 'uuid-202', date: '2025-02-20' },
  ];

  let writeText: Mock;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  it('does not render copy button while answer is streaming', () => {
    render(
      <AiResponsePanel
        answer="The patient has lab results [1]"
        references={references}
        auditLogId={42}
        error={null}
        phase="answering"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
  });

  it('renders a copy button once the answer is fully received', () => {
    render(
      <AiResponsePanel
        answer="The patient has lab results [1] and an active order [2]."
        references={references}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('copies the answer text without citation markers when clicked', async () => {
    render(
      <AiResponsePanel
        answer="The patient has lab results [1] and an active order [2]."
        references={references}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('The patient has lab results and an active order.');
  });

  it('strips comma-separated citation groups when copying', async () => {
    render(
      <AiResponsePanel
        answer="Findings [1, 2] are notable."
        references={references}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /copy/i }));

    expect(writeText).toHaveBeenCalledWith('Findings are notable.');
  });
});

describe('AiResponsePanel model tag', () => {
  it('renders a subtle tag with the resolved model once the answer is complete', () => {
    render(
      <AiResponsePanel
        answer="Done."
        references={[]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
        resolvedModel="med-agent-team"
      />,
    );

    expect(screen.getByText('med-agent-team')).toBeInTheDocument();
  });

  it('does not render the model tag while the answer is still streaming', () => {
    render(
      <AiResponsePanel
        answer="Partial"
        references={[]}
        auditLogId={42}
        error={null}
        phase="answering"
        patientUuid={patientUuid}
        resolvedModel="med-agent-team"
      />,
    );

    expect(screen.queryByText('med-agent-team')).not.toBeInTheDocument();
  });

  it('omits the model tag when no resolved model is provided', () => {
    render(
      <AiResponsePanel
        answer="Done."
        references={[]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.queryByText('med-agent-team')).not.toBeInTheDocument();
  });
});

describe('AiResponsePanel staged in-depth status', () => {
  // Two complementary DOM signals: data-turn-phase (the whole turn's coarse lifecycle) and
  // data-indepth-status (the in-depth outcome). The three in-depth renderings otherwise share one
  // testid, so these attributes are what makes the streaming/complete states distinguishable.
  const stagedBase = {
    answer: 'The patient is on metformin [1].',
    references: [{ index: 1, resourceType: 'order', resourceUuid: 'u-1', date: '2025-01-01' }],
    auditLogId: 42,
    error: null,
    patientUuid,
    answerValidation: { status: 'checked' as const, label: 'Checked' },
  };

  it('exposes phase="in-depth" and data-indepth-status="pending" while the in-depth generates', () => {
    const { container } = render(
      <AiResponsePanel {...stagedBase} phase="in-depth" inDepth={{ status: 'pending', answer: 'generating…' }} />,
    );
    expect(container.querySelector('[data-turn-phase="in-depth"]')).toBeInTheDocument();
    expect(container.querySelector('[data-indepth-status="pending"]')).toBeInTheDocument();
    expect(container.querySelector('[data-indepth-status="complete"]')).not.toBeInTheDocument();
  });

  it('exposes phase="complete" and data-indepth-status="complete" once the in-depth finishes', () => {
    const { container } = render(
      <AiResponsePanel {...stagedBase} phase="complete" inDepth={{ status: 'complete', answer: 'Full detail [1].' }} />,
    );
    expect(container.querySelector('[data-turn-phase="complete"]')).toBeInTheDocument();
    expect(container.querySelector('[data-indepth-status="complete"]')).toBeInTheDocument();
    expect(container.querySelector('[data-indepth-status="pending"]')).not.toBeInTheDocument();
  });

  it('shows when a completed in-depth was updated by its checks', () => {
    render(
      <AiResponsePanel
        {...stagedBase}
        phase="complete"
        inDepth={{
          status: 'complete',
          answer: 'Checked detail [1].',
          validation: { status: 'edited' },
        }}
      />,
    );

    expect(screen.getByTestId('section-in-depth')).toHaveTextContent('Updated after check');
  });

  it('keeps a withheld in-depth visible as needs review', () => {
    const { container } = render(
      <AiResponsePanel
        {...stagedBase}
        phase="complete"
        inDepth={{
          status: 'needs_review',
          answer: '',
          error: 'All claims were withheld.',
          reviewDraft: 'The model draft claimed a future appointment [1].',
          reviewReferences: stagedBase.references,
        }}
      />,
    );

    expect(container.querySelector('[data-indepth-status="needs_review"]')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('All claims were withheld.')).toBeInTheDocument();
    const removedClaimsSummary = screen.getByText('Removed In-Depth claims');
    const removedClaims = removedClaimsSummary.closest('details');
    expect(removedClaims).not.toHaveAttribute('open');
    expect(screen.getByText(/not part of the final clinical response/i)).toBeInTheDocument();
    fireEvent.click(removedClaimsSummary);
    expect(removedClaims).toHaveAttribute('open');
    expect(screen.getByText(/model draft claimed a future appointment/i)).toBeVisible();
    expect(
      screen
        .getAllByRole('link', { name: '1' })
        .some((link) => link.getAttribute('href') === `/openmrs/spa/patient/${patientUuid}/chart/Orders`),
    ).toBe(true);
  });

  it('exposes phase="settled" (composer already unlocked) after validation, before in-depth begins', () => {
    const { container } = render(
      <AiResponsePanel {...stagedBase} phase="settled" inDepth={{ status: 'pending', answer: '' }} />,
    );
    expect(container.querySelector('[data-turn-phase="settled"]')).toBeInTheDocument();
    expect(container.querySelector('[data-indepth-status="pending"]')).toBeInTheDocument();
  });
});

describe('AiResponsePanel answer-validation lifecycle', () => {
  const baseProps = {
    answer: 'The checked answer.',
    references: [],
    auditLogId: 42,
    error: null,
    phase: 'settled' as const,
    patientUuid,
  };

  it.each([
    ['checking', 'Checking answer'],
    ['checked', 'Checked'],
    ['edited', 'Updated after check'],
    ['needs_review', 'Needs review'],
    ['unavailable', 'Check unavailable'],
  ] as const)('renders the %s lifecycle label', (status, label) => {
    render(<AiResponsePanel {...baseProps} answerValidation={{ status, label }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders the answer-check summary as visible content instead of a badge tooltip', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        answerValidation={{
          status: 'edited',
          label: 'Updated after check',
          summary: 'One unsupported date was removed from the answer.',
        }}
      />,
    );

    expect(screen.getByTestId('answer-validation-summary')).toHaveTextContent(
      'One unsupported date was removed from the answer.',
    );
    expect(screen.getByTestId('answer-validation-summary')).toHaveTextContent('What changed');
    expect(screen.getByTestId('answer-validation-summary')).toHaveAttribute('role', 'note');
    expect(screen.getByText('Updated after check')).not.toHaveAttribute('title');
  });

  it.each([
    ['checked', 'Check summary'],
    ['needs_review', 'Why review is needed'],
    ['unavailable', 'Check status'],
  ] as const)('labels the %s summary for scanning', (status, heading) => {
    render(
      <AiResponsePanel
        {...baseProps}
        answerValidation={{
          status,
          label: 'Answer check',
          summary: 'Visible review detail.',
        }}
      />,
    );

    expect(screen.getByTestId('answer-validation-summary')).toHaveTextContent(heading);
    expect(screen.getByText('Visible review detail.')).toBeVisible();
  });

  it('discloses the original answer after a validation edit', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        answer="The corrected answer."
        answerValidation={{
          status: 'edited',
          label: 'Updated after check',
          originalAnswer: 'The original answer.',
        }}
      />,
    );

    const disclosure = screen.getByText('Original model answer').closest('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure).toHaveTextContent('The original answer.');
    expect(disclosure).toHaveAttribute('open');
    expect(disclosure).toHaveTextContent(/changed by the answer check/i);
  });

  it('links an original answer only through its own references', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        answer="The corrected answer [2]."
        references={[{ index: 2, resourceType: 'obs', resourceUuid: 'final-ref', date: '2026-02-02' }]}
        answerValidation={{
          status: 'edited',
          label: 'Updated after check',
          originalAnswer: 'The original answer [1].',
          originalReferences: [{ index: 1, resourceType: 'order', resourceUuid: 'draft-ref', date: '2026-01-01' }],
        }}
      />,
    );

    const disclosure = screen.getByText('Original model answer').closest('details');
    const originalLink = disclosure?.querySelector('a');
    expect(originalLink).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Orders`);
    expect(originalLink).not.toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Vitals`);
  });

  it('shows citation-only edits even when the answer prose is unchanged', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        answer="The documented result is unchanged [1]."
        references={[{ index: 1, resourceType: 'obs', resourceUuid: 'final-ref', date: '2026-02-02' }]}
        answerValidation={{
          status: 'edited',
          label: 'Updated after check',
          originalAnswer: 'The documented result is unchanged [1].',
          originalReferences: [{ index: 1, resourceType: 'order', resourceUuid: 'draft-ref', date: '2026-01-01' }],
        }}
      />,
    );

    const disclosure = screen.getByText('Original model answer').closest('details');
    expect(disclosure).toHaveAttribute('open');
    expect(disclosure).toHaveTextContent(/answer or its supporting citations was changed/i);
    expect(disclosure?.querySelector('a')).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Orders`);
  });

  it('keeps pre-check table blocks visible only inside the original-answer review panel', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        answer="The documented weight is shown below [1]."
        answerValidation={{
          status: 'needs_review',
          label: 'Needs review',
          originalAnswer: 'The documented weight is shown below [1].',
          originalReferences: [{ index: 1, resourceType: 'obs', resourceUuid: 'draft-ref', date: '2026-01-01' }],
          originalBlocks: [
            {
              kind: 'table',
              title: 'Pre-check weight table',
              columns: [{ key: 'weight', label: 'Weight' }],
              rows: [{ cells: { weight: { text: '6.2 kg', refs: [1] } } }],
            },
          ],
        }}
      />,
    );

    const disclosure = screen.getByText('Original model answer').closest('details');
    expect(disclosure).toHaveAttribute('open');
    expect(disclosure).toHaveTextContent('Pre-check weight table');
    expect(disclosure).toHaveTextContent('6.2 kg');
    expect(screen.getAllByText('Pre-check weight table')).toHaveLength(1);
  });

  it('discloses a changed original answer when the final result still needs review', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        answer="The current flagged answer."
        answerValidation={{
          status: 'needs_review',
          label: 'Needs review',
          originalAnswer: 'The model answer before checking.',
        }}
      />,
    );

    const disclosure = screen.getByText('Original model answer').closest('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure).toHaveAttribute('open');
    expect(disclosure).toHaveTextContent('The model answer before checking.');
    expect(disclosure).toHaveTextContent(/current answer above remains flagged for review/i);
  });
});

describe('AiResponsePanel per-section confidence', () => {
  const baseProps = {
    answer: '**Answer**\nHgb is 14.0 [1].\n\n**In Depth**\n- within range [1]',
    references: [{ index: 1, resourceType: 'obs', resourceUuid: 'uuid-101', date: '2025-11-24' }],
    auditLogId: 42,
    error: null,
    phase: 'complete' as const,
    patientUuid,
  };

  it('heads each section (Answer / In-Depth) with its confidence chip', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        confidence={{
          answer: { level: 'green', note: '' },
          in_depth: { level: 'yellow', note: 'one claim regenerated' },
        }}
      />,
    );
    expect(screen.getByTestId('section-answer')).toHaveTextContent('High confidence');
    expect(screen.getByTestId('section-in-depth')).toHaveTextContent('Medium confidence');
  });

  it('YELLOW (med): shows the message, collapses the review note behind a reveal', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        confidence={{ answer: { level: 'green' }, in_depth: { level: 'yellow', note: 'one claim regenerated' } }}
      />,
    );
    const inDepth = screen.getByTestId('section-in-depth');
    expect(inDepth).toHaveTextContent('within range'); // the message is shown
    const details = inDepth.querySelector('details');
    expect(details).toBeTruthy();
    expect(details).toHaveTextContent(/show review note/i);
    expect(details).toHaveTextContent('one claim regenerated'); // note is inside the collapse
    expect(details).not.toHaveAttribute('open'); // collapsed by default
  });

  it('RED (low): shows both the caveat and the flagged message for manual review', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        confidence={{ answer: { level: 'green' }, in_depth: { level: 'red', note: 'supporting context unresolved' } }}
      />,
    );
    const inDepth = screen.getByTestId('section-in-depth');
    expect(inDepth).toHaveTextContent('Low confidence');
    expect(inDepth).toHaveTextContent('supporting context unresolved'); // the caveat note is shown
    expect(inDepth).toHaveTextContent('within range');
    expect(inDepth.querySelector('details')).toBeNull();
    // the green Answer section is shown with no collapse
    expect(screen.getByTestId('section-answer').querySelector('details')).toBeNull();
  });

  it('renders no sections / chips when the backend sends no confidence (single model / parity)', () => {
    render(<AiResponsePanel {...baseProps} />);
    expect(screen.queryByTestId('section-answer')).not.toBeInTheDocument();
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  });

  it('does not split into sections while the answer is still streaming', () => {
    render(<AiResponsePanel {...baseProps} phase="answering" confidence={{ answer: { level: 'red', note: 'x' } }} />);
    expect(screen.queryByTestId('section-answer')).not.toBeInTheDocument();
  });
});
