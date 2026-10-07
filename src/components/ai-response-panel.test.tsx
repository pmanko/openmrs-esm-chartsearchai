/* eslint-disable testing-library/no-container */
/* eslint-disable testing-library/no-node-access */
/* eslint-disable testing-library/prefer-presence-queries */
import React from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import AiResponsePanel from './ai-response-panel.component';
import { highlightReference } from '../utils/highlight-reference';
import { SESSION_EXPIRED_ERROR_CODE, type AiReference, type AiSafetyWarning } from '../api/chartsearchai';
import { ASPIRIN_CHIP_THE_ANSWER_CITES } from '../__fixtures__/aspirin-response';
import { SCREEN_WITH_ATTACHED_ALLERGY_RECORDS } from '../__fixtures__/attached-records-response';
import { IBUPROFEN_BESIDE_HER_OWN_ALLERGIES } from '../__fixtures__/other-medication-response';
import { LIDOCAINE_QUESTION_ABOUT_HER_OWN_ORDER } from '../__fixtures__/own-medication-question-response';
import { RIFAMPICIN_ANSWER_CLAIMING_AN_ENDED_ORDER } from '../__fixtures__/ended-order-claim-response';
import { ASPIRIN_ANSWER_DROPPING_THE_SIGNIFICANCE_CAVEAT } from '../__fixtures__/significance-qualifier-response';
import { FLUCONAZOLE_BESIDE_A_LISTED_NEVIRAPINE_FINDING } from '../__fixtures__/not-about-proposed-response';
import {
  FLUCONAZOLE_CHIPS_NAMING_THEIR_RECORDS,
  RIFAMPICIN_CHIPS_NAMING_THEIR_RECORDS,
} from '../__fixtures__/finding-citation-responses';
import { MODULE_CAUTION_ANSWER } from '../__fixtures__/module-caution-answer-response';
import { NAMED_CHECKS_RESPONSE } from '../__fixtures__/named-checks-response';
import { MODULE_STATED_FINDING_RESPONSE } from '../__fixtures__/module-stated-finding-response';
import { LISTED_DRUG_NOT_IN_ANSWER_RESPONSE } from '../__fixtures__/listed-drug-not-in-answer-response';
import { METOCLOPRAMIDE_HISTORY_QUESTION } from '../__fixtures__/history-question-response';
import {
  ALLERGY_TO_A_CURRENT_MEDICATION,
  ALLERGY_TO_A_PROPOSED_DRUG,
} from '../__fixtures__/current-medication-responses';
import {
  ENDED_ORDER_DRUG_PROPOSED,
  ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION,
} from '../__fixtures__/ended-order-responses';
import {
  ANSWER_BARE_LIST,
  ANSWER_BY_ORDER_DISPLAY,
  ANSWER_BY_SUBSTANCE,
  interaction,
  MISATTRIBUTED,
  REFERENCES as FIXTURE_REFERENCES,
  SAFETY_WARNINGS,
  safetyFindingRef,
  UNSTATED,
} from '../__fixtures__/clarithromycin-response';

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
    const card = screen.getByText('Adult visit on 2026-01-26').closest('.evidenceCard')!;
    expect(within(card as HTMLElement).getByText('Verified')).toBeVisible();
    expect(screen.getByText('Used in: answer')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Citation details'));
    expect(screen.getByText('[4] · querystore:encounter:enc-4 · resolved · verified')).toBeInTheDocument();
  });

  it('uses the server evidence group and discloses source subset metadata', () => {
    render(
      <AiResponsePanel
        answer="A medication-safety finding was generated [8]."
        references={[
          {
            index: 8,
            group: 'reference',
            source: 'WHO-ATC research package',
            withheldInteractions: 4,
            resourceType: 'safety_finding',
            resourceUuid: 'finding-8',
            date: '',
            sourceText: 'Potential class interaction.',
            resolutionStatus: 'resolved',
            groundingStatus: 'unchecked',
          },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Source: WHO-ATC research package')).toBeInTheDocument();
    expect(screen.getByText(/4 additional interactions are not shown/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Potential class interaction.' })).not.toBeInTheDocument();
    expect(
      screen.getAllByTitle(
        'The module’s own safety finding, computed from this patient’s chart — not a chart record to open.',
      ),
    ).toHaveLength(4);
  });

  it('keeps legacy safety findings off patient-chart links when group metadata is absent', () => {
    render(
      <AiResponsePanel
        answer="A medication-safety finding was generated [8]."
        references={[
          {
            index: 8,
            resourceType: 'safety_finding',
            resourceUuid: 'finding-8',
            date: '',
            sourceText: 'Potential class interaction.',
            resolutionStatus: 'resolved',
            groundingStatus: 'unchecked',
          },
        ]}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(
      screen.getAllByTitle(
        'The module’s own safety finding, computed from this patient’s chart — not a chart record to open.',
      ),
    ).toHaveLength(4);
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

    expect(screen.getByText('Answer safety check:')).toBeInTheDocument();
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

    expect(screen.getByText('Answer safety check:')).toBeInTheDocument();
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

    expect(screen.queryByText('Answer safety check:')).not.toBeInTheDocument();
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

    expect(screen.queryByText('Answer safety check:')).not.toBeInTheDocument();
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

    expect(screen.getByText('Answer safety check:')).toBeInTheDocument();
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

    expect(screen.getByText('Answer safety check:')).toBeInTheDocument();
    expect(screen.getByText('Limited safety check')).toBeInTheDocument();
  });

  it('explains a limited check with readable package and coverage details', () => {
    render(
      <AiResponsePanel
        answer="Ibuprofen could be considered [1]."
        references={[]}
        safetyWarnings={[]}
        safetyStatus="limited"
        safetyCheck={{
          schema_version: 'drug_safety.v1',
          status: 'limited',
          package: {
            id: 'chartsearchai-research-seed-v1',
            version: '1',
            review_state: 'proposed',
            cross_reactivity: {
              id: 'chartsearchai-cross-reactivity-research-v1',
              version: '2',
              review_state: 'evidence_curated',
            },
          },
          coverage: {
            mapping_complete: false,
            exposure_complete: true,
            execution_complete: true,
          },
          identity_confidence: 'limited',
          issues: [
            'source_not_clinically_approved',
            'cross_reactivity_not_clinically_approved',
            'mapping_incomplete',
            'named_drug_unresolved:frovatriptan',
          ],
        }}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    const summary = screen.getByTestId('safety-check-summary');
    expect(summary).toHaveTextContent('Medication safety details');
    expect(summary).toHaveTextContent('research source is not clinically approved');
    expect(summary).toHaveTextContent('cross-reactivity rules are not clinically approved');
    expect(summary).toHaveTextContent('Not every active medication could be mapped');
    expect(summary).toHaveTextContent(
      'The medication “frovatriptan” could not be matched to the configured reference source.',
    );
    expect(summary).toHaveTextContent('Medication rules');
    expect(summary).toHaveTextContent('chartsearchai-research-seed-v1 (1) - proposed');
    expect(summary).toHaveTextContent('Cross-reactivity rules');
    expect(summary).toHaveTextContent('chartsearchai-cross-reactivity-research-v1 (2) - evidence curated');
  });

  it('explains malformed primary and relationship reference data in plain language', () => {
    render(
      <AiResponsePanel
        answer="Ibuprofen could be considered [1]."
        references={[]}
        safetyWarnings={[]}
        safetyStatus="limited"
        safetyCheck={{
          status: 'limited',
          issues: [
            'source_data_partially_invalid',
            'source_package_identity_incomplete',
            'cross_reactivity_data_invalid',
            'cross_reactivity_package_identity_incomplete',
            'cross_reactivity_source_retired',
          ],
        }}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    const summary = screen.getByTestId('safety-check-summary');
    expect(summary).toHaveTextContent('Some medication-safety reference records were invalid and ignored.');
    expect(summary).toHaveTextContent(
      'The medication-safety rule package is missing required source identity information.',
    );
    expect(summary).toHaveTextContent('The cross-reactivity reference data could not be read safely.');
    expect(summary).toHaveTextContent(
      'The cross-reactivity rule package is missing required source identity information.',
    );
    expect(summary).toHaveTextContent('The configured cross-reactivity source has been retired.');
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
        safetyCheck={{
          status: 'checked',
          package: {
            id: 'approved-medication-rules',
            version: '3',
            provenance: { source: 'Local clinical formulary', origin: 'configured package' },
            review_state: 'clinically_approved',
            cross_reactivity: {
              id: 'approved-relationships',
              version: '2',
              provenance: { source: 'Medication review board' },
              review_state: 'clinically_approved',
            },
          },
          issues: [],
        }}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Answer safety check:')).toBeInTheDocument();
    expect(screen.getByText('Dose')).toBeInTheDocument();
    expect(screen.queryByText('Safety check unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Limited safety check')).not.toBeInTheDocument();
    expect(screen.getByTestId('safety-check-summary')).toHaveTextContent(
      'approved-medication-rules (3) - clinically approved',
    );
    expect(screen.getByTestId('safety-check-summary')).toHaveTextContent(
      'approved-relationships (2) - clinically approved',
    );
    expect(screen.getByTestId('safety-check-summary')).toHaveTextContent(
      'Source: Local clinical formulary / configured package',
    );
    expect(screen.getByTestId('safety-check-summary')).toHaveTextContent('Source: Medication review board');
  });

  it('shows a clean checked result and its source packages without requiring a warning', () => {
    render(
      <AiResponsePanel
        answer="No medication issue was found."
        references={[]}
        safetyWarnings={[]}
        safetyStatus="checked"
        safetyCheck={{
          status: 'checked',
          package: {
            id: 'approved-medication-rules',
            version: '3',
            provenance: { source: 'Local clinical formulary' },
            review_state: 'clinically_approved',
            cross_reactivity: {
              id: 'approved-relationships',
              version: '2',
              provenance: { source: 'Medication review board' },
              review_state: 'clinically_approved',
            },
          },
          issues: [],
        }}
        auditLogId={42}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Checked')).toBeInTheDocument();
    const summary = screen.getByTestId('safety-check-summary');
    expect(summary).toHaveTextContent('Medication safety details');
    expect(summary).toHaveTextContent('approved-medication-rules (3) - clinically approved');
    expect(summary).toHaveTextContent('approved-relationships (2) - clinically approved');
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
    expect(screen.getByText('Answer safety check:')).toBeInTheDocument();
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
    expect(screen.getByText('Answer safety check:')).toBeInTheDocument();
  });
});

describe('AiResponsePanel current-medication chips', () => {
  // A backend that predates currentMedicationOrders names no order, so the mark says only this.
  const MARK = 'Already prescribed';
  const MARK_TITLE =
    'The patient has an active order for this drug, so this finding is about a medication already ' +
    'prescribed, not one being proposed. The drug shown is the substance the module matched that order ' +
    'to, which the order itself may name differently — a brand name, for example.';

  function renderResponse(response: { answer: string; references: AiReference[]; safetyWarnings: AiSafetyWarning[] }) {
    return render(
      <AiResponsePanel
        answer={response.answer}
        references={response.references}
        safetyWarnings={response.safetyWarnings}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  /**
   * Each chip's row in list order, found by class rather than by text: an assertion that names a
   * heading goes dead the moment the heading is reworded, passing while examining nothing.
   */
  const chipRows = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('safetyWarningItem')));

  const TAKEN = ALLERGY_TO_A_CURRENT_MEDICATION.safetyWarnings[1];
  const PROPOSED = ALLERGY_TO_A_PROPOSED_DRUG.safetyWarnings[0];

  it('marks every chip the backend raised from one of the patient’s own active orders', () => {
    renderResponse(ALLERGY_TO_A_CURRENT_MEDICATION);
    const rows = chipRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getByText(MARK)).toBeInTheDocument();
  });

  it('leaves the same words unmarked where the question proposes the drug', () => {
    // The premise, pinned: the two chips are one sentence, so nothing but the key tells them apart.
    expect({ ...PROPOSED, aboutACurrentMedication: true }).toEqual(TAKEN);
    renderResponse(ALLERGY_TO_A_PROPOSED_DRUG);
    expect(chipRows()).toHaveLength(2);
    expect(screen.queryByText(MARK)).not.toBeInTheDocument();
  });

  it('marks a chip by its own key, not by its words, when both are listed together', () => {
    renderResponse({ ...ALLERGY_TO_A_PROPOSED_DRUG, safetyWarnings: [PROPOSED, TAKEN] });
    const [proposedRow, takenRow] = chipRows();
    expect(proposedRow).toHaveTextContent(PROPOSED.detail);
    expect(takenRow).toHaveTextContent(TAKEN.detail);
    expect(within(proposedRow).queryByText(MARK)).not.toBeInTheDocument();
    expect(within(takenRow).getByText(MARK)).toBeInTheDocument();
  });

  it('draws no chip the answer already states, and every chip it does not', () => {
    // openmrs-module-chartsearchai ADR Decision 124: on a question asking only for her allergies
    // the answer names her conflicting order and quotes the chip's finding, and marks the chip
    // `statedInTheAnswer`. TAKEN and PROPOSED carry one sentence, so the row left is told apart by
    // the mark.
    renderResponse({
      answer: ANSWER_BY_SUBSTANCE,
      references: FIXTURE_REFERENCES,
      safetyWarnings: [{ ...TAKEN, statedInTheAnswer: true }, PROPOSED],
    });
    expect(chipRows()).toHaveLength(1);
    expect(within(chipRows()[0]).queryByText(MARK)).not.toBeInTheDocument();
  });

  it('draws no safety box at all when the answer states every chip', () => {
    renderResponse({
      answer: ANSWER_BY_SUBSTANCE,
      references: FIXTURE_REFERENCES,
      safetyWarnings: [{ ...TAKEN, statedInTheAnswer: true }],
    });
    expect(chipRows()).toHaveLength(0);
    expect(screen.queryByText('Safety checks:')).not.toBeInTheDocument();
  });

  it('marks nothing on a chip from a backend that predates the key', () => {
    // Measured before openmrs-module-chartsearchai#535, so no chip carries the key at all.
    expect(SAFETY_WARNINGS.some((warning) => 'aboutACurrentMedication' in warning)).toBe(false);
    renderResponse({
      answer: ANSWER_BY_SUBSTANCE,
      references: FIXTURE_REFERENCES,
      safetyWarnings: SAFETY_WARNINGS,
    });
    expect(chipRows()).toHaveLength(SAFETY_WARNINGS.length);
    expect(screen.queryByText(MARK)).not.toBeInTheDocument();
  });

  it('says what the finding is about without naming the drug, and why on hover', () => {
    // The backend README asks for exactly this: `drug` is the substance the module matched the
    // patient's order to, which the order need not spell. This patient's ibuprofen order is Advil
    // 400mg.
    renderResponse(ALLERGY_TO_A_CURRENT_MEDICATION);
    chipRows().forEach((row, i) => {
      const mark = within(row).getByText(MARK);
      const said = `${mark.textContent} ${mark.getAttribute('title')}`.toLowerCase();
      const drugWords = ALLERGY_TO_A_CURRENT_MEDICATION.safetyWarnings[i].drug.toLowerCase().match(/[a-z]{5,}/g);
      expect(drugWords?.length).toBeGreaterThan(0);
      for (const word of drugWords ?? []) expect(said).not.toContain(word);
      expect(mark).toHaveAttribute('title', MARK_TITLE);
    });
  });
});

/** The UTC caveat both ended-order renderings share, because the backend's dates are UTC days. */
const UTC_CALENDAR_DAY = 'The date is a calendar day in UTC, so it can be a day off the local date.';

type LiveResponse = typeof ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION | typeof ENDED_ORDER_DRUG_PROPOSED;

/** Renders a captured response the way the chat renders a finished message: every measurement passed. */
function renderLiveResponse(
  response: LiveResponse,
  overrides: Partial<React.ComponentProps<typeof AiResponsePanel>> = {},
) {
  return render(
    <AiResponsePanel
      answer={response.answer}
      references={response.references}
      safetyWarnings={response.safetyWarnings}
      misattributedOrderCitations={response.misattributedOrderCitations}
      unstatedFindingSeverities={response.unstatedFindingSeverities}
      conditionRuleCoverage={response.conditionRuleCoverage}
      interactionPairs={response.interactionPairs}
      activeOrderClaims={response.activeOrderClaims}
      orderStopDates={response.orderStopDates}
      error={null}
      phase="complete"
      patientUuid={patientUuid}
      {...overrides}
    />,
  );
}

describe('AiResponsePanel ended-order chips', () => {
  const MARK = 'About an order no longer in force';
  const MARK_DATED = 'About an order no longer in force, ended 2026-09-23';
  const MARK_TITLE =
    'The chart records this drug only as an order no longer in force, so the finding is about what giving it ' +
    'again would mean — not about a medication the patient is taking now.';
  const CURRENT_MARK = /^Already prescribed/;

  const chipRows = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('safetyWarningItem')));
  /** Every ended-order mark inside one chip row, found by its text whether or not it is dated. */
  const endedMarks = (row: HTMLElement) => within(row).queryAllByText(/^About an order no longer in force/);

  const ENDED = ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION.safetyWarnings[0];
  const PROPOSED = ENDED_ORDER_DRUG_PROPOSED.safetyWarnings[0];

  it('marks the chip about a drug the chart holds only as an ended order, with the day it ended', () => {
    renderLiveResponse(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION);
    const rows = chipRows();
    expect(rows).toHaveLength(1);
    const marks = endedMarks(rows[0]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent(new RegExp(`^${MARK_DATED}$`));
    expect(marks[0]).toHaveAttribute('title', `${MARK_TITLE} ${UTC_CALENDAR_DAY}`);
    // A distinct mark from the current-medication tag: the backend keeps the two referents apart.
    expect(within(rows[0]).queryByText(CURRENT_MARK)).not.toBeInTheDocument();
    expect(marks[0].className).not.toContain('currentMedicationTag');
  });

  it('leaves the same words unmarked where the question proposes the drug', () => {
    // The premise, pinned: the two chips are one finding, and only these two keys tell them apart.
    expect({ ...PROPOSED, aboutAnEndedOrder: true, endedOrderStopDate: '2026-09-23' }).toEqual(ENDED);
    renderLiveResponse(ENDED_ORDER_DRUG_PROPOSED);
    const rows = chipRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(PROPOSED.detail);
    expect(endedMarks(rows[0])).toHaveLength(0);
    expect(screen.queryByText(/no longer in force/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2026-09-23/)).not.toBeInTheDocument();
  });

  it('marks a chip by its own key, not by its words, when both are listed together', () => {
    renderLiveResponse(ENDED_ORDER_DRUG_PROPOSED, { safetyWarnings: [PROPOSED, ENDED] });
    const [proposedRow, endedRow] = chipRows();
    expect(endedMarks(proposedRow)).toHaveLength(0);
    expect(endedMarks(endedRow)).toHaveLength(1);
  });

  it('marks the chip without a date where the ended order has none to state', () => {
    renderLiveResponse(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION, {
      safetyWarnings: [{ ...ENDED, endedOrderStopDate: null }],
      orderStopDates: [],
    });
    const marks = endedMarks(chipRows()[0]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent(new RegExp(`^${MARK}$`));
    expect(marks[0]).toHaveAttribute('title', MARK_TITLE);
  });

  it('never states the end more exactly than a calendar day', () => {
    // Not a shape the backend sends: a date the panel cannot read as one day is withheld, not
    // trimmed.
    renderLiveResponse(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION, {
      safetyWarnings: [{ ...ENDED, endedOrderStopDate: '2026-09-23T08:32:31Z' }],
      orderStopDates: [],
    });
    const row = chipRows()[0];
    const marks = endedMarks(row);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent(new RegExp(`^${MARK}$`));
    expect(row).not.toHaveTextContent('2026-09-23');
    expect(row).not.toHaveTextContent('08:32');
  });

  it('marks nothing on a chip whose key is false, or from a backend that predates the key', () => {
    expect(SAFETY_WARNINGS.some((warning) => 'aboutAnEndedOrder' in warning)).toBe(false);
    render(
      <AiResponsePanel
        answer={ANSWER_BY_SUBSTANCE}
        references={FIXTURE_REFERENCES}
        safetyWarnings={[...SAFETY_WARNINGS, ...ALLERGY_TO_A_CURRENT_MEDICATION.safetyWarnings]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
    const rows = chipRows();
    expect(rows).toHaveLength(SAFETY_WARNINGS.length + ALLERGY_TO_A_CURRENT_MEDICATION.safetyWarnings.length);
    for (const row of rows) expect(endedMarks(row)).toHaveLength(0);
  });
});

describe('AiResponsePanel order stop dates', () => {
  const STOPPED = 'Stopped 2026-09-23';
  const STOPPED_TITLE =
    'The date this prescription stopped being in force — not the record’s own date shown beside it. ' +
    UTC_CALENDAR_DAY;

  /** Each reference chip, found by class for the reason `chipRows` is. */
  const referenceItems = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('referenceItem')));
  const itemFor = (index: number) => {
    const item = referenceItems().find((el) => el.textContent?.startsWith(`[${index}]`));
    expect(item).toBeDefined();
    return item as HTMLElement;
  };

  it('shows when the cited prescription stopped beside that citation, apart from the record’s own date', () => {
    renderLiveResponse(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION);
    const item = itemFor(6);
    const stopped = within(item).getByText(STOPPED);
    expect(stopped).toHaveAttribute('title', STOPPED_TITLE);
    // The record's own date is a different fact and stays where it was, never replaced by this one.
    expect(within(item).getByRole('link')).toHaveTextContent(/^\[6\] drug_order — 2026-06-01$/);
    // Beside the link, not inside the navigation target.
    expect(within(item).getByRole('link')).not.toContainElement(stopped);
    // Only the citation the entry names carries it.
    expect(itemFor(11)).not.toHaveTextContent(/Stopped/);
    expect(screen.getAllByText(/^Stopped /)).toHaveLength(1);
  });

  it('draws nothing for an empty list, which is not a certificate that any order is current', () => {
    renderLiveResponse(ENDED_ORDER_DRUG_PROPOSED);
    expect(referenceItems()).toHaveLength(ENDED_ORDER_DRUG_PROPOSED.references.length);
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
    expect(screen.queryByText(/in force/)).not.toBeInTheDocument();
  });

  it.each([
    ['null', null],
    ['missing', undefined],
  ])('draws nothing where no measurement was stated (%s)', (_label, orderStopDates) => {
    renderLiveResponse(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION, { orderStopDates });
    expect(referenceItems()).toHaveLength(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION.references.length);
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
  });

  it('draws nothing for an entry naming a citation the answer does not carry', () => {
    renderLiveResponse(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION, {
      orderStopDates: [{ citation: 7, stopDate: '2026-09-23' }],
    });
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
  });

  it('never states the stop more exactly than a calendar day, nor a value it cannot read as one', () => {
    renderLiveResponse(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION, {
      orderStopDates: [
        { citation: 6, stopDate: '2026-09-23T08:32:31Z' },
        { citation: 11, stopDate: 20260923 as unknown as string },
      ],
    });
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
    expect(screen.queryByText(/08:32/)).not.toBeInTheDocument();
  });

  it('survives a value that is not a list at all', () => {
    renderLiveResponse(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION, {
      orderStopDates: '2026-09-23' as unknown as [],
    });
    expect(referenceItems()).toHaveLength(ENDED_ORDER_NAMED_IN_A_HISTORY_QUESTION.references.length);
    expect(screen.queryByText(/Stopped/)).not.toBeInTheDocument();
  });
});

describe('AiResponsePanel safety-check coverage', () => {
  it('draws no "What the safety checks covered" block, whatever the response measured', () => {
    // Removed from the panel: on a live clarithromycin answer listing four of the patient's own
    // active orders as interactions, its "related no drug pairs" line read as "no interactions
    // with her medications", because the screen skips the source's unrated pairs before relating
    // any. So nothing of it is drawn, even where every measurement it rendered is on the response.
    const response = {
      ...ENDED_ORDER_DRUG_PROPOSED,
      interactionPairs: { found: 18, reported: 10 },
      activeOrderClaims: { stated: 4, uncited: 3 },
      conditionRuleCoverage: 'absent',
    };
    render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer}
        references={response.references}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
    // The answer itself still renders, so the absences below are not of an empty panel.
    expect(
      screen.getByText((_content, element) => Boolean(element?.className?.includes?.('markdownAnswer'))),
    ).toHaveTextContent('Rifampicin');
    expect(screen.queryByText(/What the safety checks covered/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /Interaction pairs shown|related no drug pairs|severe pairs can be among them|Conditions were not screened|Medications were not checked against|active orders cites|citing no chart record|cannot be checked against the chart/,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText((_content, element) => Boolean(element?.className?.includes?.('limit'))),
    ).not.toBeInTheDocument();
    // Nor the note that replaced the block's conditions line for a release: its coverage keys are
    // on the response and it is not drawn either.
    expect(screen.queryByText(/^Not checked against/)).not.toBeInTheDocument();
  });

  it('draws nothing for the pairs the screen related only below the warning threshold', () => {
    // Removed from the panel: every such pair is a DDInter row rated Unknown with no mechanism
    // text, so the line told a clinician only that a pair is listed, beside an answer that already
    // names her orders, and "rates these below the warning threshold" read as a low rating the
    // source never gave. The live shape, verbatim: "Is aspirin safe for her?" on a chart with
    // lidocaine and tiotropium orders, whose belowFloor names exactly those two partners and whose
    // answer names neither — so a partner's name anywhere on the panel can only have come from that
    // line.
    const response = ASPIRIN_CHIP_THE_ANSWER_CITES;
    expect(response.interactionPairs.belowFloor.map((pair) => pair.partner)).toEqual(['lidocaine', 'tiotropium']);
    render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={response.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
    expect(
      screen.getByText((_content, element) => Boolean(element?.className?.includes?.('markdownAnswer'))),
    ).toHaveTextContent('Acetylsalicylic acid (aspirin) can be given');
    // The chip collapses the box on this answer; open everything, so an absence is not of a folded
    // box.
    fireEvent.click(screen.getByRole('button', { name: 'Show safety checks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.queryByText(/Not raised as a warning|below the warning threshold/)).not.toBeInTheDocument();
    expect(screen.queryByText(/lidocaine|tiotropium/i)).not.toBeInTheDocument();
  });
});

describe('AiResponsePanel reference citation metadata', () => {
  const DDINTER = 'DDInter 2.0 (via openmrs-ddi-knowledge-base)';

  /** The rendered item for one citation — its chip and every tag beside it. */
  const referenceItem = (index: number) =>
    screen.getByText((_content, element) =>
      Boolean(element?.className?.includes?.('referenceItem') && element.textContent?.startsWith(`[${index}] `)),
    );

  it('names the dataset a drug-reference citation came from on hover, and draws no subset count', () => {
    // The captured response: [10] is Rifampicin's DDInter entry, 648 of whose interaction partners
    // the record does not show, [11] the module's own finding, computed rather than quoted, and [5]
    // her chart's drug order.
    renderLiveResponse(ENDED_ORDER_DRUG_PROPOSED);
    const drugReference = referenceItem(10);
    expect(within(drugReference).getByText('[10] Drug reference')).toHaveAttribute('title', `Source: ${DDINTER}`);
    // On hover only: the source is no longer a line of its own under the citation.
    expect(drugReference).not.toHaveTextContent(DDINTER);
    // 648 of its partners are withheld, and the count is not drawn: they are mostly drugs she is
    // not on, and the safety check reads every one of them regardless.
    expect(ENDED_ORDER_DRUG_PROPOSED.references.find((ref) => ref.index === 10)?.withheldInteractions).toBe(648);
    expect(drugReference).not.toHaveTextContent(/subset|not shown|648/);

    for (const index of [11, 5]) {
      expect(referenceItem(index)).not.toHaveTextContent(DDINTER);
      expect(referenceItem(index)).not.toHaveTextContent(/subset|not shown/);
      expect(within(referenceItem(index)).getByText(new RegExp(`^\\[${index}\\] `))).not.toHaveAttribute('title');
    }
  });

  it('branches on the source value, not the group', () => {
    // The backend: a reference-group entry may carry no attribution, so key on the value.
    const references = ENDED_ORDER_DRUG_PROPOSED.references.map((ref) =>
      ref.index === 10 ? { ...ref, source: null } : ref,
    ) as typeof ENDED_ORDER_DRUG_PROPOSED.references;
    renderLiveResponse(ENDED_ORDER_DRUG_PROPOSED, { references });
    expect(referenceItem(10)).not.toHaveTextContent(DDINTER);
    expect(within(referenceItem(10)).getByText('[10] Drug reference')).not.toHaveAttribute('title');
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
          validation: {
            status: 'needs_review',
            summary: 'The appointment claim used a date that is not in the patient record.',
          },
          reviewDraft: 'The model draft claimed a future appointment [1].',
          reviewReferences: stagedBase.references,
        }}
      />,
    );

    expect(container.querySelector('[data-indepth-status="needs_review"]')).toBeInTheDocument();
    expect(screen.getByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('Why review is needed')).toBeVisible();
    expect(screen.getByText(/appointment claim used a date that is not in the patient record/i)).toBeVisible();
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

/**
 * The backend fields that state a bounded safety answer's limits (issue #26), rendered
 * against the measured response in `src/__fixtures__/clarithromycin-response.ts` — shared with
 * the resolver's own tests, because the ratings asserted here are that resolver's OUTPUT over
 * the fixture's prose and warnings and so depend on dataset-format details only the fixture
 * states.
 */
describe('AiResponsePanel answer-limit disclosure', () => {
  function renderPanel(overrides: Record<string, unknown> = {}) {
    return render(
      <AiResponsePanel
        answer={ANSWER_BY_SUBSTANCE}
        references={FIXTURE_REFERENCES}
        safetyWarnings={SAFETY_WARNINGS}
        misattributedOrderCitations={MISATTRIBUTED}
        unstatedFindingSeverities={UNSTATED}
        conditionRuleCoverage="absent"
        interactionPairs={{ found: 5, reported: 5 }}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
        {...overrides}
      />,
    );
  }

  /**
   * The rendered sentence text, markers and severity badges included, with whitespace collapsed.
   * Found by class rather than by a text fragment so it works across the fixture's two answer
   * shapes; `identity-obj-proxy` maps the CSS-module class to its own name in tests.
   */
  const answerText = () =>
    (
      screen.getByText((_content, element) => Boolean(element?.className?.includes?.('markdownAnswer'))).textContent ??
      ''
    ).replace(/\s+/g, ' ');

  it('renders each unstated rating immediately after the marker of the finding it rates', () => {
    renderPanel();
    // Adjacency, not merely sequence: an earlier version of this test asserted the list of
    // badge texts, which would have passed with every badge appended at the end of the answer.
    const text = answerText();
    expect(text).toContain('active order Methylprednisolone [177] [350] Major');
    expect(text).toContain('active order Budesonide [166] [351] Major');
    expect(text).toContain('active order Prednisone [155] [352] Moderate');
    expect(text).toContain('active order Dexamethasone [12] [353] Moderate');
    expect(text).toContain('active order Hydrocortisone [14] [354] Moderate');
  });

  it('pairs each rating with its own finding rather than the right multiset of ratings', () => {
    // Two Majors then three Moderates cannot see a permutation within either run, so give the
    // five findings five distinct ratings and assert each lands on its own sentence.
    const distinct = [
      SAFETY_WARNINGS[0],
      interaction('Methylprednisolone', 'Major', 'Solu-Medrol 125mg/5ml'),
      interaction('Budesonide', 'Minor', 'Pulmicort 90mcg'),
      interaction('Prednisone', 'Moderate'),
      interaction('Dexamethasone', 'Unknown'),
      interaction('Hydrocortisone', 'Catastrophic'),
    ];
    renderPanel({ safetyWarnings: distinct });
    const text = answerText();
    expect(text).toContain('Methylprednisolone [177] [350] Major');
    expect(text).toContain('Budesonide [166] [351] Minor');
    expect(text).toContain('Prednisone [155] [352] Moderate');
    expect(text).toContain('Dexamethasone [12] [353] Unknown');
    expect(text).toContain('Hydrocortisone [14] [354] Catastrophic');
  });

  it('resolves ratings on an answer that names the chart’s order display', () => {
    // The other live answer shape: the answer says "Solu-Medrol 125mg/5ml" where the chip says
    // "Methylprednisolone", and repeats every marker inside its own statement.
    renderPanel({ answer: ANSWER_BY_ORDER_DISPLAY, misattributedOrderCitations: [] });
    const text = answerText();
    expect(text).toContain('active order Solu-Medrol 125mg/5ml [350] Major');
    expect(text).toContain('active order Pulmicort 90mcg [351] Major');
    expect(text).toContain('active order Prednisone Co 5mg [352] Moderate');
  });

  it('badges every finding of a bare list the model wrote without the module’s phrasing', () => {
    // Shape C, live: "list them one line each, name the order only". The symptom this fixture
    // documents is a RENDERING one — the list came back half-badged, two Majors beside three
    // bare items — so it has to be asserted here and not only as a resolver map.
    renderPanel({ answer: ANSWER_BARE_LIST, misattributedOrderCitations: [] });
    const text = answerText();
    expect(text).toContain('Solu-Medrol 125mg/5ml [350] Major');
    expect(text).toContain('Pulmicort 90mcg [351] Major');
    expect(text).toContain('Prednisone Co 5mg [352] Moderate');
    expect(text).toContain('Dexamethasone Injection vial 8mg [353] Moderate');
    expect(text).toContain('Hydrocortisone Injection vial 100mg [354] Moderate');
  });

  it('badges a repeated marker once, not once per occurrence', () => {
    renderPanel({ answer: ANSWER_BY_ORDER_DISPLAY, misattributedOrderCitations: [] });
    // [350] is cited twice in its own statement; the rating belongs to the finding, not the marker.
    expect(answerText().match(/Major/g) ?? []).toHaveLength(2);
  });

  it('states nothing where two citations of one set would take the same finding', () => {
    // 350 and 351 are two different findings, and only one rated warning exists — so attributing
    // it to both is wrong, and there is no way to tell which citation it belongs to. Refusing is
    // the whole point of the injectivity rule.
    renderPanel({
      answer: 'Clarithromycin interacts with active order Methylprednisolone [350, 351].',
      misattributedOrderCitations: [],
      unstatedFindingSeverities: [350, 351],
      safetyWarnings: [SAFETY_WARNINGS[0], interaction('Methylprednisolone', 'Major', 'Solu-Medrol 125mg/5ml')],
    });
    expect(answerText().match(/Major/g) ?? []).toHaveLength(0);
  });

  it('badges two findings of one group separately even when their ratings match', () => {
    // Two citations from DIFFERENT candidate sets can both resolve, and then two badges are two
    // real findings — collapsing equal ratings would hide the second. (Two citations of the SAME
    // set can never both resolve; the resolver refuses that outright.)
    renderPanel({
      answer: 'Clarithromycin interacts with Methylprednisolone; Ibuprofen interacts with Warfarin [350, 360].',
      references: [...FIXTURE_REFERENCES, safetyFindingRef(360, 'interaction', 'Ibuprofen')],
      misattributedOrderCitations: [],
      unstatedFindingSeverities: [350, 360],
      safetyWarnings: [
        interaction('Methylprednisolone', 'Major', 'Solu-Medrol 125mg/5ml'),
        interaction('Warfarin', 'Major', undefined, 'Ibuprofen'),
      ],
    });
    expect(answerText().match(/Major/g) ?? []).toHaveLength(2);
  });

  it('gives an unrecognised rating a treatment distinct from the module’s lowest tier', () => {
    // `Unknown` is the lowest of the four recognised ratings; unrated sorts ABOVE all four, so
    // one grey for both would tell a clinician they rank equally.
    renderPanel({
      unstatedFindingSeverities: [350, 351],
      safetyWarnings: [
        SAFETY_WARNINGS[0],
        interaction('Methylprednisolone', 'Unknown', 'Solu-Medrol 125mg/5ml'),
        interaction('Budesonide', 'Catastrophic', 'Pulmicort 90mcg'),
      ],
    });
    const unknown = screen.getByText('Unknown').className;
    const unrated = screen.getByText('Catastrophic').className;
    expect(unknown).not.toEqual(unrated);
  });

  it('states no rating where the answer already states them', () => {
    renderPanel({ unstatedFindingSeverities: [] });
    expect(screen.queryAllByTitle(/may not state the rating/i)).toHaveLength(0);
    expect(answerText()).not.toContain('Major');
  });

  it('renders the rating as a caveat, not a verdict', () => {
    // The backend documents three measured cells where this key over-reports — a rating stated
    // by synonym among them — so the wording must not assert that the answer omitted it.
    renderPanel();
    expect(screen.getAllByTitle(/may not state the rating/i).length).toBeGreaterThan(0);
  });

  it('does not make a misattributed citation navigate, in the prose or on its chip', () => {
    renderPanel();
    // The record is real but is not the order the sentence names, so following either the
    // inline marker or the chip would land the clinician on an unrelated row.
    for (const index of ['177', '166', '155']) {
      const marker = screen.getByText(index, { selector: 'span' });
      expect(marker.tagName).toBe('SPAN');
      expect(marker).toHaveAttribute('title', expect.stringContaining('may not be the medication order'));
    }
    const chip = screen.getByText('[177] condition — 2024-05-13');
    expect(chip.tagName).toBe('SPAN');
  });

  it('marks a misattributed citation as bad evidence, never as an unsupported claim', () => {
    renderPanel();
    // A red "Unsupported" badge here is the miscarriage the backend field exists to prevent:
    // the finding is deterministic and correct; only the chart evidence attached to it is wrong.
    expect(screen.queryByText('Unsupported')).not.toBeInTheDocument();
    expect(screen.getAllByText('Not the order named')).toHaveLength(3);
  });

  it('leaves correctly-cited chart citations navigable', () => {
    renderPanel();
    const stillLinked = screen.getByText('12', { selector: 'a' });
    expect(stillLinked.tagName).toBe('A');
  });

  it('renders nothing extra when the check named no misattributed citation', () => {
    // An empty array says the check ran and named none — it is NOT a certificate that the
    // remaining citations are sound, so nothing here may read as a clean bill of health.
    renderPanel({ misattributedOrderCitations: [] });
    // The positive control is the sibling test above, which shows all three tags appear with
    // this same fixture when the check does name citations.
    expect(screen.queryByText('Not the order named')).not.toBeInTheDocument();
    // ...and no marker is struck through or made inert, which is the whole of what `[]` licenses.
    expect(screen.getByText('177', { selector: 'a' })).toBeInTheDocument();
  });

  it('gives a module-attached citation somewhere to appear, and tags nothing it cannot name', () => {
    renderPanel();
    // The trap: this citation has NO [N] marker in the prose, so a reference list built by
    // scanning the answer text drops it silently — here it is the recorded-allergy record
    // behind the answer's load-bearing claim.
    expect(ANSWER_BY_SUBSTANCE).not.toContain('[3]');
    expect(screen.getByText('[3] allergy')).toBeInTheDocument();
    // This fixture predates `attachedFor`, so nothing says which finding the record backs, and the
    // chip says nothing rather than "Added by the module", which a clinician could not act on.
    expect(screen.queryByText('Added by the module')).not.toBeInTheDocument();
    expect(screen.queryByText(/^source of /)).not.toBeInTheDocument();
  });

  it('omits the date separator for a record that carries no date', () => {
    renderPanel();
    expect(screen.queryByText(/— null/)).not.toBeInTheDocument();
    expect(screen.getByText('[349] Safety finding')).toBeInTheDocument();
  });

  it('does not navigate a reference-group citation to a chart page', () => {
    renderPanel();
    // A safety finding's resourceUuid is synthetic (`interaction:Clarithromycin`); a link to
    // Patient Summary could never land anywhere.
    expect(screen.getByText('[350] Safety finding').tagName).toBe('SPAN');
  });

  it('keeps the ungrounded warning on a citation that is also misattributed', () => {
    // The two checks are independent and both can fire on one citation. The backend is explicit
    // that this key must render BESIDE the other statements about a citation, never over them:
    // a marker that hid the verdict would disagree with the chip below, which shows the red
    // "Unsupported" badge either way.
    const refs = FIXTURE_REFERENCES.map((ref) => (ref.index === 177 ? { ...ref, grounded: false } : ref));
    renderPanel({ references: refs });
    const marker = screen.getByText('177 ⚠', { selector: 'span' });
    expect(marker).toHaveAttribute('title', expect.stringContaining('may not be the medication order'));
    expect(marker).toHaveAttribute('title', expect.stringContaining('may not support this statement'));
    // ...and the chip's own verdict is still published.
    expect(screen.getByText('Unsupported')).toBeInTheDocument();
  });

  it('does not call the module’s own computed finding “reference data”', () => {
    // [349] is `contraindication:Clarithromycin` — the module's deterministic finding about THIS
    // patient's allergy record, not a dataset entry. One wording served every reference-group
    // kind when the predicate matched `drug_reference` alone; widening it carried that sentence
    // onto findings computed from the chart.
    renderPanel();
    const marker = screen.getByText('349');
    expect(marker).toHaveAttribute('title', expect.stringMatching(/computed from this patient’s chart/i));
    expect(marker.getAttribute('title')).not.toMatch(/clinical reference data/i);
  });

  it('labels each kind of reference material, and never guesses at one it does not know', () => {
    renderPanel({
      references: [
        { index: 8, resourceType: 'drug_class_note', resourceUuid: 'class:H02AB', date: null, group: 'reference' },
        { index: 9, resourceType: 'some_future_type', resourceUuid: 'x', date: null, group: 'reference' },
      ],
      misattributedOrderCitations: [],
      unstatedFindingSeverities: [],
    });
    // Calling a class note a "Drug reference" would tell a clinician it came from a drug's
    // reference entry when it came from an ATC-class or cross-reactivity join.
    expect(screen.getByText('[8] Drug class note')).toBeInTheDocument();
    expect(screen.getByText('[9] Reference material')).toBeInTheDocument();
  });

  it('navigates a drug order to Orders rather than the default tab', () => {
    renderPanel();
    expect(screen.getByText('[12] drug_order — 2026-08-05')).toHaveAttribute(
      'href',
      `/openmrs/spa/patient/${patientUuid}/chart/Orders`,
    );
  });

  it('routes a visit and an encounter to the same tab as a diagnosis', () => {
    // `diagnosis` was mapped and its own encounter was not, so a citation of an encounter and a
    // citation of a diagnosis FROM that encounter landed on two different tabs. Measured on the
    // live server: one question returned 113 chart citations, of which encounter x45 and
    // visit x6 fell through to the default tab.
    renderPanel({
      references: [
        { index: 20, resourceType: 'visit', resourceUuid: 'v-1', date: '2024-09-09', group: 'chart' },
        { index: 21, resourceType: 'encounter', resourceUuid: 'e-1', date: '2024-09-09', group: 'chart' },
        { index: 22, resourceType: 'diagnosis', resourceUuid: 'd-1', date: '2024-09-09', group: 'chart' },
      ],
      misattributedOrderCitations: [],
      unstatedFindingSeverities: [],
    });
    const visits = `/openmrs/spa/patient/${patientUuid}/chart/Visits`;
    expect(screen.getByText('[20] visit — 2024-09-09')).toHaveAttribute('href', visits);
    expect(screen.getByText('[21] encounter — 2024-09-09')).toHaveAttribute('href', visits);
    expect(screen.getByText('[22] diagnosis — 2024-09-09')).toHaveAttribute('href', visits);
  });

  it('navigates a module-injected active order like any other chart citation', () => {
    // It is injected but is the patient's own order with a real Order uuid, so it groups as
    // chart and must not land on the default tab under its raw wire type.
    renderPanel({
      references: [
        { index: 20, resourceType: 'active_drug_order', resourceUuid: 'o-1', date: '2026-01-01', group: 'chart' },
      ],
      misattributedOrderCitations: [],
      unstatedFindingSeverities: [],
    });
    expect(screen.getByText('[20] active_drug_order — 2026-01-01')).toHaveAttribute(
      'href',
      `/openmrs/spa/patient/${patientUuid}/chart/Orders`,
    );
  });

  it('renders rather than blanking when a measurement arrives in the wrong shape', () => {
    // The panel has no error boundary above it, so a throw in a render memo costs the whole
    // answer. A string is iterable and would silently match nothing; an object throws.
    for (const misattributedOrderCitations of ['177', {} as unknown as number[], 5 as unknown as number[]]) {
      const { unmount } = renderPanel({ misattributedOrderCitations });
      expect(answerText()).toContain('Clarithromycin');
      expect(screen.queryByText('Not the order named')).not.toBeInTheDocument();
      unmount();
    }
  });
});

/**
 * A chip the answer cites and every fidelity check clears is drawn on one line, its detail behind a
 * toggle: on the live aspirin answer the full chip repeated the answer's paragraph beside it. Any
 * doubt draws the full chip, because the full chip is the backstop for an answer that dropped or
 * softened a finding.
 */
describe('AiResponsePanel chip the answer already cites', () => {
  const DROPPED_SENTENCE = 'The clinical significance of this interaction is unknown.';

  function renderAspirin(overrides: Record<string, unknown> = {}) {
    const response = { ...ASPIRIN_CHIP_THE_ANSWER_CITES, ...overrides };
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer as string}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={response.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  const chipItems = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('safetyWarningItem')));

  /** Every chip here qualifies, so the box itself starts collapsed; these cases are about the chip. */
  const openSafetyChecks = () => fireEvent.click(screen.getByRole('button', { name: 'Show safety checks' }));

  it('draws the chip on one line naming the drug, its partner and the rating, with the detail collapsed', () => {
    renderAspirin();
    openSafetyChecks();
    expect(chipItems()).toHaveLength(1);
    const chip = chipItems()[0];
    expect(chip).toHaveTextContent('Acetylsalicylic acid (aspirin) — Metoclopramide (Minor)');
    // The marker the answer cites the finding at, so a clinician can find the sentence to check.
    expect(ASPIRIN_CHIP_THE_ANSWER_CITES.answer).toContain('[46]');
    expect(chip).toHaveTextContent('See [46] in the answer');
    expect(chip).not.toHaveTextContent('Cited in the answer');
    expect(chip).not.toHaveTextContent(DROPPED_SENTENCE);
    expect(within(chip).getByRole('button', { name: 'Show details' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('names every marker the answer cites the finding at, in order', () => {
    const finding = ASPIRIN_CHIP_THE_ANSWER_CITES.references.find((ref) => ref.resourceType === 'safety_finding');
    expect(finding?.index).toBe(46);
    renderAspirin({
      answer: `${ASPIRIN_CHIP_THE_ANSWER_CITES.answer} Restated at [47].`,
      references: [...ASPIRIN_CHIP_THE_ANSWER_CITES.references, { ...finding, index: 47 }],
    });
    openSafetyChecks();
    expect(chipItems()[0]).toHaveTextContent('See [46], [47] in the answer');
  });

  it('names no marker the answer does not carry', () => {
    // A second record of the finding the answer never cites is not somewhere to look.
    const finding = ASPIRIN_CHIP_THE_ANSWER_CITES.references.find((ref) => ref.resourceType === 'safety_finding');
    renderAspirin({ references: [...ASPIRIN_CHIP_THE_ANSWER_CITES.references, { ...finding, index: 47 }] });
    openSafetyChecks();
    expect(chipItems()[0]).toHaveTextContent('See [46] in the answer');
  });

  it('shows the full detail, including what the answer left out, when expanded', () => {
    renderAspirin();
    openSafetyChecks();
    fireEvent.click(within(chipItems()[0]).getByRole('button', { name: 'Show details' }));
    const chip = chipItems()[0];
    expect(chip).toHaveTextContent(DROPPED_SENTENCE);
    expect(within(chip).getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('draws the full chip where the answer does not cite the finding', () => {
    renderAspirin({ answer: (ASPIRIN_CHIP_THE_ANSWER_CITES.answer as string).replace(' [46]', '') });
    expect(chipItems()[0]).toHaveTextContent(DROPPED_SENTENCE);
    expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument();
  });

  it.each([
    ['misattributedOrderCitations', [46]],
    ['unfoundedFindingSeverities', [{ citation: 46, rating: 'Major' }]],
    ['unfaithfullyRenderedCitations', [46]],
    ['cautionLedOverWithholding', [{ citation: 46, rating: 'Major' }]],
    ['interactionClaimPairs', { judged: 1, misattributedCitations: [], unfounded: 1 }],
    ['interactionClaimPairs', { judged: 1, misattributedCitations: [46], unfounded: 0 }],
  ])('draws the full chip where %s reports something', (key, value) => {
    renderAspirin({ [key]: value });
    expect(chipItems()[0]).toHaveTextContent(DROPPED_SENTENCE);
    expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument();
  });

  // A rating the answer left unstated does not keep its chip open: the one-line chip states it.
  it('folds the chip where unstatedFindingSeverities names it, the line stating the rating', () => {
    renderAspirin({ unstatedFindingSeverities: [{ citation: 46, rating: 'Minor' }] });
    openSafetyChecks();
    expect(chipItems()[0]).toHaveTextContent('Acetylsalicylic acid (aspirin) — Metoclopramide (Minor)');
    expect(chipItems()[0]).toHaveTextContent('See [46] in the answer');
  });

  it.each([
    'misattributedOrderCitations',
    'unstatedFindingSeverities',
    'unfoundedFindingSeverities',
    'unfaithfullyRenderedCitations',
    'cautionLedOverWithholding',
    'interactionClaimPairs',
  ])('draws the full chip where %s states no measurement', (key) => {
    renderAspirin({ [key]: null });
    expect(chipItems()[0]).toHaveTextContent(DROPPED_SENTENCE);
    expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument();
  });

  it('draws every chip in full where two chips share the key one citation names', () => {
    // Several findings of one type about one drug share one resourceUuid, so a citation cannot say
    // which of them the answer stated.
    const [chip] = ASPIRIN_CHIP_THE_ANSWER_CITES.safetyWarnings;
    renderAspirin({
      safetyWarnings: [
        chip,
        { ...chip, detail: 'Acetylsalicylic acid (aspirin) interacts with active order Lidocaine.' },
      ],
    });
    expect(chipItems()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument();
  });

  it('draws the full chip while the answer is still streaming', () => {
    const response = ASPIRIN_CHIP_THE_ANSWER_CITES;
    render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer as string}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={response.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase="answering"
        patientUuid={patientUuid}
      />,
    );
    expect(chipItems()[0]).toHaveTextContent(DROPPED_SENTENCE);
  });
});

/**
 * Where EVERY chip in the safety box qualifies for the one-line form, the box itself collapses to a
 * summary line; one chip that does not keeps the whole box open, since that chip is the one a
 * clinician must not have to go looking for.
 */
describe('AiResponsePanel safety box every chip of which the answer cites', () => {
  const [ASPIRIN_CHIP] = ASPIRIN_CHIP_THE_ANSWER_CITES.safetyWarnings as AiSafetyWarning[];

  function renderAspirin(overrides: Record<string, unknown> = {}) {
    const response = { ...ASPIRIN_CHIP_THE_ANSWER_CITES, ...overrides };
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer as string}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={response.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  const chipItems = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('safetyWarningItem')));

  it('collapses the box to a summary line where every chip qualifies', () => {
    renderAspirin();
    expect(screen.getByText(/1 finding, cited in the answer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show safety checks' })).toHaveAttribute('aria-expanded', 'false');
    expect(chipItems()).toHaveLength(0);
  });

  it('opens to the one-line chips, and closes again', () => {
    renderAspirin();
    fireEvent.click(screen.getByRole('button', { name: 'Show safety checks' }));
    expect(chipItems()).toHaveLength(1);
    expect(chipItems()[0]).toHaveTextContent('Acetylsalicylic acid (aspirin) — Metoclopramide (Minor)');
    const hide = screen.getByRole('button', { name: 'Hide safety checks' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(hide);
    expect(chipItems()).toHaveLength(0);
  });

  it('keeps the box open where one chip does not qualify, drawing that chip in full', () => {
    const allergy: AiSafetyWarning = {
      type: 'contraindication',
      drug: 'Acetylsalicylic acid (aspirin)',
      detail: 'The patient has a recorded allergy to Acetylsalicylic acid (aspirin).',
      severity: null,
    };
    renderAspirin({ safetyWarnings: [ASPIRIN_CHIP, allergy] });
    expect(screen.queryByRole('button', { name: 'Show safety checks' })).not.toBeInTheDocument();
    expect(chipItems()).toHaveLength(2);
    expect(chipItems()[0]).toHaveTextContent('See [46] in the answer');
    expect(chipItems()[1]).toHaveTextContent('The patient has a recorded allergy to Acetylsalicylic acid (aspirin).');
    expect(chipItems()[1]).not.toHaveTextContent(/See \[\d+\] in the answer/);
  });

  it('summarises two qualifying chips in the plural', () => {
    const allergy: AiSafetyWarning = {
      type: 'contraindication',
      drug: 'Acetylsalicylic acid (aspirin)',
      detail: 'The patient has a recorded allergy to Acetylsalicylic acid (aspirin).',
      severity: null,
    };
    renderAspirin({
      answer: `${ASPIRIN_CHIP_THE_ANSWER_CITES.answer as string} She also has a recorded aspirin allergy [47].`,
      references: [
        ...(ASPIRIN_CHIP_THE_ANSWER_CITES.references as unknown as AiReference[]),
        {
          index: 47,
          resourceType: 'safety_finding',
          resourceUuid: 'contraindication:Acetylsalicylic acid (aspirin)',
          date: null as unknown as string,
          group: 'reference',
        },
      ],
      safetyWarnings: [ASPIRIN_CHIP, allergy],
    });
    expect(screen.getByText(/2 findings, each cited in the answer/)).toBeInTheDocument();
    expect(chipItems()).toHaveLength(0);
  });

  it('keeps the box open where no chip qualifies', () => {
    renderAspirin({ unfaithfullyRenderedCitations: [46] });
    expect(screen.queryByRole('button', { name: 'Show safety checks' })).not.toBeInTheDocument();
    expect(chipItems()).toHaveLength(1);
  });
});

/**
 * A chart record the module attached says what it is to the answer: the source of the cited finding
 * it backs, from `attachedFor`, rather than who attached it.
 */
describe('AiResponsePanel record the module attached', () => {
  function renderScreen(overrides: Record<string, unknown> = {}) {
    const response = { ...SCREEN_WITH_ATTACHED_ALLERGY_RECORDS, ...overrides };
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer as string}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={response.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  /** The reference chip for index `n`, found by its own label. */
  const chipFor = (label: string) =>
    screen.getByText((_content, element) =>
      Boolean(element?.className?.includes?.('referenceItem') && element.textContent?.startsWith(label)),
    );

  it('names the finding each attached record is the source of', () => {
    renderScreen();
    expect(within(chipFor('[3] allergy')).getByText('source of [45]')).toBeInTheDocument();
    expect(within(chipFor('[1] allergy')).getByText('source of [46]')).toBeInTheDocument();
    expect(screen.queryByText('Added by the module')).not.toBeInTheDocument();
  });

  it('tags no citation the model made itself', () => {
    renderScreen();
    for (const label of [
      '[47] Safety finding',
      '[48] Safety finding',
      '[49] Safety finding',
      '[45] Safety finding',
      '[46] Safety finding',
    ]) {
      expect(within(chipFor(label)).queryByText(/^source of /)).not.toBeInTheDocument();
    }
  });

  it('lists every finding one record backs', () => {
    const references = (SCREEN_WITH_ATTACHED_ALLERGY_RECORDS.references as unknown as AiReference[]).map((ref) =>
      ref.index === 1 ? { ...ref, attachedFor: [45, 46] } : ref,
    );
    renderScreen({ references });
    expect(within(chipFor('[1] allergy')).getByText('source of [45], [46]')).toBeInTheDocument();
  });

  it.each([
    ['an index no citation carries', [999]],
    ['a citation that is not a finding', [3]],
  ])('tags nothing where attachedFor names %s', (_label, value) => {
    const references = (SCREEN_WITH_ATTACHED_ALLERGY_RECORDS.references as unknown as AiReference[]).map((ref) =>
      ref.index === 1 ? { ...ref, attachedFor: value } : ref,
    );
    renderScreen({ references });
    expect(within(chipFor('[1] allergy')).queryByText(/^source of /)).not.toBeInTheDocument();
    expect(within(chipFor('[3] allergy')).getByText('source of [45]')).toBeInTheDocument();
  });

  it('names only the cited findings where attachedFor also names an index no citation carries', () => {
    const references = (SCREEN_WITH_ATTACHED_ALLERGY_RECORDS.references as unknown as AiReference[]).map((ref) =>
      ref.index === 1 ? { ...ref, attachedFor: [999, 46] } : ref,
    );
    renderScreen({ references });
    expect(within(chipFor('[1] allergy')).getByText('source of [46]')).toBeInTheDocument();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', []],
    ['not an array', '46'],
    ['holding a non-number', ['46']],
  ])('tags nothing where attachedFor is %s', (_label, value) => {
    const references = (SCREEN_WITH_ATTACHED_ALLERGY_RECORDS.references as unknown as AiReference[]).map((ref) =>
      ref.index === 1 ? { ...ref, attachedFor: value } : ref,
    );
    renderScreen({ references });
    expect(within(chipFor('[1] allergy')).queryByText(/^source of /)).not.toBeInTheDocument();
    expect(within(chipFor('[3] allergy')).getByText('source of [45]')).toBeInTheDocument();
  });
});

/**
 * A chip about another of the patient's medications than the drug the answer is about is drawn
 * apart from the findings about that drug: the live ibuprofen answer, beside which her lidocaine
 * and tiotropium allergies were raised because the answer named those orders as interaction
 * partners.
 */
describe('AiResponsePanel chips about her other medications', () => {
  const LIDOCAINE = 'Lidocaine: The patient has a recorded allergy to Lidocaine.';
  const LINE = /^2 findings about other medications this patient takes/;

  function renderIbuprofen(overrides: Record<string, unknown> = {}) {
    const response = { ...IBUPROFEN_BESIDE_HER_OWN_ALLERGIES, ...overrides };
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer as string}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={response.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  it('keeps them behind a line of their own, closed', () => {
    renderIbuprofen();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(LIDOCAINE)).not.toBeInTheDocument();
    expect(screen.queryByText('Tiotropium: The patient has a recorded allergy to Tiotropium.')).not.toBeInTheDocument();
  });

  it('opens them in full on a click', () => {
    renderIbuprofen();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(LIDOCAINE)).toBeInTheDocument();
    expect(screen.getByText('Tiotropium: The patient has a recorded allergy to Tiotropium.')).toBeInTheDocument();
  });

  it('draws a chip in full where the key is false, absent, or not the boolean true', () => {
    for (const value of [false, undefined, 'true']) {
      const safetyWarnings = IBUPROFEN_BESIDE_HER_OWN_ALLERGIES.safetyWarnings.map((warning) => ({
        ...warning,
        aboutAnotherOfHerMedications: value,
      }));
      const { unmount } = renderIbuprofen({ safetyWarnings });
      expect(screen.getByText(LIDOCAINE)).toBeInTheDocument();
      expect(screen.queryByText(LINE)).not.toBeInTheDocument();
      unmount();
    }
  });

  const safetySection = () =>
    screen.getByText((_content, element) =>
      Boolean(element?.className?.includes?.('safetyWarningsSection') && element?.tagName === 'DIV'),
    );

  it('draws the box neutral where it holds nothing but findings about her other medications', () => {
    renderIbuprofen();
    expect(safetySection().className).toContain('safetyWarningsSectionNeutral');
  });

  it('leaves a finding about the drug in question open beside them', () => {
    const aboutTheDrug = {
      ...IBUPROFEN_BESIDE_HER_OWN_ALLERGIES.safetyWarnings[0],
      drug: 'Ibuprofen',
      detail: 'The patient has a recorded allergy to Ibuprofen.',
      aboutACurrentMedication: false,
      currentMedicationOrders: [],
      aboutAnotherOfHerMedications: false,
    };
    renderIbuprofen({ safetyWarnings: [aboutTheDrug, ...IBUPROFEN_BESIDE_HER_OWN_ALLERGIES.safetyWarnings] });
    expect(screen.getByText('Ibuprofen: The patient has a recorded allergy to Ibuprofen.')).toBeInTheDocument();
    expect(safetySection().className).not.toContain('safetyWarningsSectionNeutral');
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(LIDOCAINE)).not.toBeInTheDocument();
  });
});

/**
 * The mark on a contraindication about a drug the patient already takes names her own order, from
 * `currentMedicationOrders`, and is drawn only where the chip's words cannot say it: not on an
 * interaction chip ("interacts with active order …"), and not behind the other-medications line.
 */
describe('AiResponsePanel already-prescribed mark', () => {
  const response = LIDOCAINE_QUESTION_ABOUT_HER_OWN_ORDER;
  const chipRows = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('safetyWarningItem')));

  function renderLidocaine(safetyWarnings: AiSafetyWarning[] = response.safetyWarnings as AiSafetyWarning[]) {
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={safetyWarnings}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  it('names her order on the contraindication, and marks no interaction chip', () => {
    renderLidocaine();
    const marks = screen.getAllByText(/^Already prescribed/);
    expect(marks.map((mark) => mark.textContent)).toEqual(['Already prescribed: Lidocaine']);
    const interactionRows = chipRows().filter((row) => row.textContent?.includes('interacts with active order'));
    expect(interactionRows).toHaveLength(2);
    for (const row of interactionRows) expect(within(row).queryByText(/^Already prescribed/)).not.toBeInTheDocument();
  });

  it('draws no mark on a chip behind the other-medications line', () => {
    renderLidocaine();
    fireEvent.click(
      within(screen.getByText(/finding about another of this patient/)).getByRole('button', { name: 'Show details' }),
    );
    const tiotropium = chipRows().find((row) => row.textContent?.includes('allergy to Tiotropium'));
    expect(tiotropium).toBeDefined();
    expect(within(tiotropium as HTMLElement).queryByText(/^Already prescribed/)).not.toBeInTheDocument();
  });

  it('names the order as her chart displays it, not the substance the chip is about', () => {
    // Her Advil 400mg order raises a chip about the substance Ibuprofen (backend #552's own case).
    const [contraindication, ...rest] = response.safetyWarnings;
    renderLidocaine([
      {
        ...contraindication,
        drug: 'Ibuprofen',
        currentMedicationOrders: [
          { orderDisplay: 'Advil 400mg', orderUuid: 'uuid-advil' },
          { orderDisplay: 'Nurofen 200mg', orderUuid: 'uuid-nurofen' },
        ],
      },
      ...rest,
    ]);
    expect(screen.getByText('Already prescribed: Advil 400mg, Nurofen 200mg')).toBeInTheDocument();
  });
});

/**
 * An answer saying an order has ended where no record it was built from says so (backend ADR
 * Decision 135) gets one line under it naming the drug: the rifampicin answer that said
 * nevirapine's order was no longer in force, of a chart holding no nevirapine order.
 */
describe('AiResponsePanel an ended order no record states', () => {
  const response = RIFAMPICIN_ANSWER_CLAIMING_AN_ENDED_ORDER;
  const LINE = 'No record says the Nevirapine order has ended — the answer states it without one.';

  function renderRifampicin(overrides: Record<string, unknown> = {}, isLoading = false) {
    const merged = { ...response, ...overrides };
    return render(
      <AiResponsePanel
        {...(merged as object)}
        answer={merged.answer as string}
        references={merged.references as unknown as AiReference[]}
        safetyWarnings={merged.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase={isLoading ? 'answering' : 'complete'}
        patientUuid={patientUuid}
      />,
    );
  }

  it('says under the answer that no record states the ended order, and why on hover', () => {
    renderRifampicin();
    const line = screen.getByText(LINE);
    expect(line).toHaveAttribute(
      'title',
      'The answer says this order is no longer in force, but none of the records the answer was built from marks it that way. Check the patient’s medication list before relying on it.',
    );
    // Under the answer, not in the safety box: it is about the answer's wording.
    expect(
      screen.getByText(
        (_content, element) =>
          Boolean(element?.className?.includes?.('answerSection')) && Boolean(element?.textContent?.includes(LINE)),
      ),
    ).toBeInTheDocument();
  });

  it('names every drug, in the plural', () => {
    renderRifampicin({ unsupportedEndedOrderClaims: ['Nevirapine', 'Stavudine'] });
    expect(
      screen.getByText(
        'No record says the Nevirapine, Stavudine orders have ended — the answer states it without one.',
      ),
    ).toBeInTheDocument();
  });

  it('says nothing where the list is empty, absent, or not a list of names', () => {
    for (const value of [[], null, undefined, 'Nevirapine', [''], [7]]) {
      const { unmount } = renderRifampicin({ unsupportedEndedOrderClaims: value });
      expect(screen.queryByText(/^No record says the/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('says nothing while the answer is still streaming', () => {
    renderRifampicin({}, true);
    expect(screen.queryByText(/^No record says the/)).not.toBeInTheDocument();
  });
});

/**
 * A cited finding whose own caveat the answer left out — "The clinical significance of this
 * interaction is unknown." — is tagged beside its citation (backend ADR Decision 136): the live
 * aspirin answer, which cites the aspirin/metoclopramide finding [46] and does not say so.
 */
describe('AiResponsePanel a cited finding the answer leaves unqualified', () => {
  const response = ASPIRIN_ANSWER_DROPPING_THE_SIGNIFICANCE_CAVEAT;
  const TAG = 'Clinical significance unknown';
  const answerText = () =>
    screen.getByText((_content, element) => Boolean(element?.className?.includes?.('markdownAnswer')));

  function renderAspirin(overrides: Record<string, unknown> = {}) {
    const merged = { ...response, ...overrides };
    return render(
      <AiResponsePanel
        {...(merged as object)}
        answer={merged.answer as string}
        references={merged.references as unknown as AiReference[]}
        safetyWarnings={merged.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  it('tags the citation, in the answer, right after it, with the reason on hover', () => {
    renderAspirin();
    expect(response.answer).toContain('[46]');
    expect(answerText()).toHaveTextContent('[46] ' + TAG);
    expect(within(answerText()).getByText(TAG)).toHaveAttribute(
      'title',
      'The finding this cites says the clinical significance of the interaction is unknown. The answer leaves that out.',
    );
  });

  it('tags a finding once however often the answer cites it', () => {
    renderAspirin({ answer: `${response.answer} Monitor for it [46].` });
    expect(within(answerText()).getAllByText(TAG)).toHaveLength(1);
  });

  it('tags nothing where the list is empty, absent, malformed, or names a citation the answer does not carry', () => {
    for (const value of [[], null, undefined, '46', [46.5], [99]]) {
      const { unmount } = renderAspirin({ unstatedSignificanceQualifiers: value });
      expect(screen.queryByText(TAG)).not.toBeInTheDocument();
      unmount();
    }
  });
});

/**
 * A chip about a drug other than the one the question proposes is drawn apart, as one about her
 * other medications is (backend ADR Decision 137): the live fluconazole answer, whose third chip is
 * the listed nevirapine against her lidocaine order.
 */
describe('AiResponsePanel chips about a drug other than the one proposed', () => {
  const response = FLUCONAZOLE_BESIDE_A_LISTED_NEVIRAPINE_FINDING;
  const LINE = /^1 finding not about the drug asked about/;
  const NEVIRAPINE = /^Nevirapine interacts with active order Lidocaine/;
  const chipRows = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('safetyWarningItem')));

  function renderFluconazole(safetyWarnings: AiSafetyWarning[] = response.safetyWarnings as AiSafetyWarning[]) {
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={safetyWarnings}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  it('keeps the nevirapine finding behind a line naming it as not about the drug asked about', () => {
    renderFluconazole();
    // The answer cites both fluconazole findings, so the box starts folded; open it to read them.
    fireEvent.click(screen.getByRole('button', { name: 'Show safety checks' }));
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(NEVIRAPINE)).not.toBeInTheDocument();
    expect(chipRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Fluconazole — Lidocaine (Moderate)'),
      expect.stringContaining('Fluconazole interacts with Nevirapine, also named in the question (Moderate)'),
    ]);
    fireEvent.click(within(screen.getByText(LINE)).getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(NEVIRAPINE)).toBeInTheDocument();
  });

  it('draws every chip together where the key is false, absent, or not the boolean true', () => {
    for (const value of [false, undefined, 'true']) {
      const safetyWarnings = (response.safetyWarnings as AiSafetyWarning[]).map((warning) => ({
        ...warning,
        aboutADrugOtherThanTheOneProposed: value as unknown as boolean,
      }));
      const { unmount } = renderFluconazole(safetyWarnings);
      expect(chipRows()).toHaveLength(3);
      expect(screen.queryByText(/not about the drug asked about/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('says the patient takes them only where every chip behind the line is her own prescription', () => {
    const [nevirapine, ...rest] = response.safetyWarnings as AiSafetyWarning[];
    renderFluconazole([{ ...nevirapine, aboutAnotherOfHerMedications: true }, ...rest]);
    expect(screen.getByText(/^1 finding about another of this patient’s medications/)).toBeInTheDocument();
  });
});

/**
 * Chips sharing one finding key fold where the answer cites as many distinct findings of the key
 * as there are chips carrying it — then none of them is uncited. The live fluconazole answer cites
 * both fluconazole findings, [50] and [51], which share the key `interaction:Fluconazole`.
 */
describe('AiResponsePanel chips sharing a finding key', () => {
  const response = FLUCONAZOLE_BESIDE_A_LISTED_NEVIRAPINE_FINDING;
  const chipRows = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('safetyWarningItem')));

  function renderFluconazole(answer: string = response.answer) {
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={answer}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={response.safetyWarnings as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  it('folds both where the answer cites both, each tagged with every marker of the key', () => {
    expect(response.answer).toContain('[50]');
    expect(response.answer).toContain('[51]');
    renderFluconazole();
    expect(screen.getByText(/2 findings, each cited in the answer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show safety checks' }));
    const rows = chipRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toHaveTextContent('See [50], [51] in the answer');
  });

  it('folds neither where the answer cites only one of them', () => {
    renderFluconazole(response.answer.split('[51]').join(''));
    expect(screen.queryByRole('button', { name: 'Show safety checks' })).not.toBeInTheDocument();
    expect(screen.queryByText(/See \[\d+\]/)).not.toBeInTheDocument();
    expect(chipRows()).toHaveLength(2);
  });
});

/**
 * Where a chip names its own finding's record (`findingCitation`, backend ADR Decision 138), that
 * is the join: it folds exactly where the answer cites that record, tagged with that one marker.
 */
describe('AiResponsePanel chips naming their own record', () => {
  const chipRows = () =>
    screen.queryAllByText((_content, element) => Boolean(element?.className?.includes?.('safetyWarningItem')));

  function renderResponse(response: Record<string, unknown>, safetyWarnings?: AiSafetyWarning[]) {
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer as string}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={(safetyWarnings ?? response.safetyWarnings) as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  it('tags each fluconazole chip with its own marker, not both', () => {
    renderResponse(FLUCONAZOLE_CHIPS_NAMING_THEIR_RECORDS);
    fireEvent.click(screen.getByRole('button', { name: 'Show safety checks' }));
    const [lidocaine, nevirapine] = chipRows();
    expect(lidocaine).toHaveTextContent('Fluconazole — Lidocaine (Moderate) See [50] in the answer');
    expect(nevirapine).toHaveTextContent('See [51] in the answer');
    expect(screen.queryByText(/See \[50\], \[51\]/)).not.toBeInTheDocument();
  });

  it('folds the cited rifampicin Major and leaves the uncited Minor sharing its key in full', () => {
    renderResponse(RIFAMPICIN_CHIPS_NAMING_THEIR_RECORDS);
    expect(screen.queryByRole('button', { name: 'Show safety checks' })).not.toBeInTheDocument();
    const rows = chipRows();
    const major = rows.find((row) => row.textContent?.includes('Major'));
    const minor = rows.find((row) => row.textContent?.includes('Lidocaine'));
    expect(major).toHaveTextContent('See [51] in the answer');
    expect(minor).toHaveTextContent('interacts with active order Lidocaine — Minor. Coadministration');
    expect(minor).not.toHaveTextContent(/See \[/);
  });

  // An answer the module wrote states each finding briefly from the chip itself, so the checks of
  // a model's prose have nothing to judge and state null; the citation is still the join (backend
  // ADR Decision 140).
  it('folds the cited finding of an answer the module wrote, though no check of prose ran', () => {
    renderResponse(MODULE_CAUTION_ANSWER);
    fireEvent.click(screen.getByRole('button', { name: 'Show safety checks' }));
    const interaction = chipRows().find((row) => row.textContent?.includes('Fluconazole —'));
    expect(interaction).toHaveTextContent('Fluconazole — Lidocaine (Moderate) See [46] in the answer');
    expect(interaction).not.toHaveTextContent('Coadministration');
    expect(screen.getByText('See [46] in the answer')).toHaveAttribute(
      'title',
      'The answer states this finding briefly at that marker; open the detail to read it in full.',
    );
  });

  it('still draws in full a chip beside a model answer whose prose checks stated nothing', () => {
    renderResponse({ ...MODULE_CAUTION_ANSWER, answeredByTheModule: false });
    expect(screen.queryByRole('button', { name: 'Show safety checks' })).not.toBeInTheDocument();
    expect(screen.queryByText(/See \[46\]/)).not.toBeInTheDocument();
  });

  // A rating the answer left unstated does not keep a chip open, the one-line chip stating it; a
  // finding the answer reworded is on one line that says so; a chip the answer does not cite, about
  // her own order, stays in full whatever the checks say.
  it('folds a cited chip no check named, keeping the named and the uncited ones in full', () => {
    renderResponse(NAMED_CHECKS_RESPONSE);
    const rows = chipRows();
    const row = (finding: string) => rows.find((r) => r.textContent?.includes(finding));
    expect(row('Ritonavir')).toHaveTextContent(
      'Fluconazole interacts with Ritonavir, also named in the question (Minor) See [62] in the answer',
    );
    expect(row('Sulfamethoxazole')).toHaveTextContent('(Minor) See [63] in the answer');
    expect(row('Lopinavir')).toHaveTextContent('(Moderate) Reworded in the answer, compare');
    expect(row('Lopinavir')).not.toHaveTextContent('prolongation');
    expect(row('Lidocaine')).toHaveTextContent(
      'Coadministration with fluconazole may increase the plasma concentrations',
    );
    expect(row('Lidocaine')).not.toHaveTextContent(/See \[/);
  });

  // The module's own sentence after the answer states [55] and cites no marker; the response names
  // it, so its chip is drawn as already stated rather than in full beside the sentence (backend ADR
  // Decision 147).
  it('folds a chip the module states after the answer, tagged as stated above', () => {
    renderResponse(MODULE_STATED_FINDING_RESPONSE);
    const lidocaine = chipRows().find((row) => row.textContent?.includes('Lidocaine'));
    expect(lidocaine).toHaveTextContent('Fluconazole — Lidocaine (Moderate) Stated above');
    expect(lidocaine).not.toHaveTextContent('Coadministration with fluconazole');
    expect(screen.getByText('Stated above')).toHaveAttribute(
      'title',
      'The module states this finding after the answer; open the detail to read it in full.',
    );
  });

  // A finding about the drug proposed against a drug the question only LISTS, which the answer does
  // not cite, is drawn on one line: it rests on the question's word, not her chart. One against her
  // own order is not.
  it('folds an unmentioned finding against a listed drug, tagged not in the answer', () => {
    renderResponse(LISTED_DRUG_NOT_IN_ANSWER_RESPONSE);
    const rows = chipRows();
    const ritonavir = rows.find((row) => row.textContent?.includes('Ritonavir'));
    expect(ritonavir).toHaveTextContent(
      'Fluconazole interacts with Ritonavir, also named in the question (Minor) Not in the answer',
    );
    expect(ritonavir).not.toHaveTextContent('The coadministration with fluconazole');
  });

  it('still draws in full an unmentioned finding against one of her own orders', () => {
    renderResponse({ ...LISTED_DRUG_NOT_IN_ANSWER_RESPONSE, findingsStatedByTheModule: [] });
    expect(chipRows().find((row) => row.textContent?.includes('Lidocaine'))).toHaveTextContent(
      'Coadministration with fluconazole may increase the plasma concentrations',
    );
  });

  // A cited finding the answer reworded is drawn on one line that says so, rather than in full; the
  // record's own words are one click away, and the box stays open so the tag is seen.
  it('folds a cited finding the answer reworded, tagged to compare', () => {
    renderResponse(LISTED_DRUG_NOT_IN_ANSWER_RESPONSE);
    const lopinavir = chipRows().find((row) => row.textContent?.includes('Lopinavir'));
    expect(lopinavir).toHaveTextContent(
      'Fluconazole interacts with Lopinavir, also named in the question (Moderate) Reworded in the answer, compare',
    );
    expect(lopinavir).not.toHaveTextContent('prolongation of the QT interval');
    expect(screen.queryByRole('button', { name: 'Show safety checks' })).not.toBeInTheDocument();
  });

  it('still draws in full a reworded finding another check also names', () => {
    renderResponse({
      ...LISTED_DRUG_NOT_IN_ANSWER_RESPONSE,
      unfoundedFindingSeverities: [{ citation: 57, rating: 'Major' }],
    });
    expect(chipRows().find((row) => row.textContent?.includes('Lopinavir'))).toHaveTextContent(
      'prolongation of the QT interval',
    );
  });

  it('still draws every chip in full where a per-finding check stated no measurement', () => {
    renderResponse({ ...NAMED_CHECKS_RESPONSE, unstatedFindingSeverities: null });
    expect(screen.queryByText(/See \[\d+\]/)).not.toBeInTheDocument();
  });

  it('draws a chip in full whose record the answer does not cite', () => {
    const safetyWarnings = (FLUCONAZOLE_CHIPS_NAMING_THEIR_RECORDS.safetyWarnings as AiSafetyWarning[]).map(
      (warning) => ({ ...warning, findingCitation: 99 }),
    );
    renderResponse(FLUCONAZOLE_CHIPS_NAMING_THEIR_RECORDS, safetyWarnings);
    expect(screen.queryByRole('button', { name: 'Show safety checks' })).not.toBeInTheDocument();
    expect(screen.queryByText(/See \[\d+\]/)).not.toBeInTheDocument();
  });
});

describe('upstream clinical disclosures in staged presentation', () => {
  it('withholds a misattributed record link in both the staged answer and evidence card', () => {
    render(
      <AiResponsePanel
        answer="Recorded medication [1]."
        references={[
          {
            index: 1,
            resourceType: 'order',
            resourceUuid: 'order-1',
            date: '2026-01-01',
            title: 'Medication chart source',
            sourceText: 'Recorded medication.',
            resolutionStatus: 'resolved',
          },
        ]}
        misattributedOrderCitations={[1]}
        answerValidation={{ status: 'checked', label: 'Checked' }}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
    const section = screen.getByTestId('section-answer');
    expect(within(section).queryByRole('link')).not.toBeInTheDocument();
    expect(within(section).getByText('1')).toHaveAttribute(
      'title',
      'The module reports that this citation may not be the medication order this sentence names, so it is not offered as a link. This is a report about the citation, not a verdict on the safety finding.',
    );
    const card = screen.getByText('Medication chart source').closest('.evidenceCard')!;
    expect(within(card as HTMLElement).queryByRole('link')).not.toBeInTheDocument();
    expect(within(card as HTMLElement).getByText('1')).toHaveAttribute(
      'title',
      'The module reports that this citation may not be the medication order this sentence names, so it is not offered as a link. This is a report about the citation, not a verdict on the safety finding.',
    );
  });

  it('retains the unsupported ended-order warning beneath a checked staged answer', () => {
    const response = RIFAMPICIN_ANSWER_CLAIMING_AN_ENDED_ORDER;
    render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer}
        references={response.references as unknown as AiReference[]}
        unsupportedEndedOrderClaims={response.unsupportedEndedOrderClaims}
        answerValidation={{ status: 'checked', label: 'Checked' }}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
    expect(screen.getByTestId('section-answer')).toBeInTheDocument();
    expect(
      screen.getByText('No record says the Nevirapine order has ended — the answer states it without one.'),
    ).toBeInTheDocument();
  });
});

describe('reviewed evidence and safety presentation', () => {
  it.each(['checked', 'limited', 'unavailable'] as const)(
    'keeps a clinical warning red with safety status %s',
    (safetyStatus) => {
      render(
        <AiResponsePanel
          answer="Clinical answer"
          references={[]}
          safetyWarnings={[SAFETY_WARNINGS[0]]}
          safetyStatus={safetyStatus}
          error={null}
          phase="complete"
          patientUuid={patientUuid}
        />,
      );
      expect(screen.getByTestId('ai-response-safety')).toHaveClass('safetyWarnings_flagged');
    },
  );

  it('offers no navigation for unresolved citations in the answer, details or evidence card', () => {
    const { container } = render(
      <AiResponsePanel
        answer="Claim [1]."
        references={[
          {
            index: 1,
            resourceType: 'obs',
            resourceUuid: 'missing-record',
            date: '',
            title: 'Missing source record',
            resolutionStatus: 'unresolved',
          },
        ]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
    expect(screen.getByText('Source missing')).toBeInTheDocument();
    expect(screen.getByText('Missing source record')).toBeInTheDocument();
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('carries citation warnings into a structured table through the real answer panel', () => {
    render(
      <AiResponsePanel
        answer={ANSWER_BY_SUBSTANCE}
        references={FIXTURE_REFERENCES}
        safetyWarnings={SAFETY_WARNINGS}
        misattributedOrderCitations={MISATTRIBUTED}
        unstatedFindingSeverities={UNSTATED}
        blocks={[
          {
            kind: 'table',
            title: 'Clinical findings',
            columns: [{ key: 'finding', label: 'Finding' }],
            rows: [
              {
                cells: {
                  finding: { text: 'Clarithromycin interacts with active order Methylprednisolone [177] [350].' },
                },
              },
            ],
          },
        ]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
    const table = screen.getByRole('table', { name: 'Clinical findings' });
    expect(within(table).queryByRole('link', { name: '177' })).not.toBeInTheDocument();
    expect(within(table).getByText('177')).toHaveAttribute(
      'title',
      expect.stringContaining('may not be the medication order'),
    );
    expect(within(table).getByText('Major')).toBeInTheDocument();
  });
});

describe('AiResponsePanel chips beside a question whether she has ever taken a drug', () => {
  // Backend ADR Decision 156: the chip is about the drug asked, a medication she takes, so
  // without the key it is drawn red and open among the findings about that drug.
  const CHIP = /Metoclopramide interacts with active order Lidocaine — Major/;
  const LINE = /^1 finding about this patient’s medications/;

  function renderHistory(overrides: Record<string, unknown> = {}) {
    const response = { ...METOCLOPRAMIDE_HISTORY_QUESTION, ...overrides };
    return render(
      <AiResponsePanel
        {...(response as object)}
        answer={response.answer as string}
        references={response.references as unknown as AiReference[]}
        safetyWarnings={response.safetyWarnings as unknown as AiSafetyWarning[]}
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );
  }

  const safetySection = () =>
    screen.getByText((_content, element) =>
      Boolean(element?.className?.includes?.('safetyWarningsSection') && element?.tagName === 'DIV'),
    );

  it('draws every chip neutral and collapsed behind a line of its own', () => {
    renderHistory();
    expect(screen.getByText(LINE)).toBeInTheDocument();
    expect(screen.queryByText(CHIP)).not.toBeInTheDocument();
    expect(safetySection().className).toContain('safetyWarningsSectionNeutral');
  });

  it('opens them on a click', () => {
    renderHistory();
    fireEvent.click(within(screen.getByText(LINE)).getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(CHIP)).toBeInTheDocument();
  });

  it('draws the chip as before where the key is false, absent, or not the boolean true', () => {
    for (const value of [false, undefined, 'true']) {
      const { unmount } = renderHistory({ asksWhetherSheHasTakenADrug: value });
      expect(screen.queryByText(LINE)).not.toBeInTheDocument();
      expect(safetySection().className).not.toContain('safetyWarningsSectionNeutral');
      unmount();
    }
  });
});
