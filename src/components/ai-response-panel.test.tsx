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

  it('renders reference tags as clickable <a> elements with correct href', () => {
    render(
      <AiResponsePanel
        answer={answer}
        references={references}
        questionId="test-question-id"
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    const refLinks = screen.getAllByRole('link');
    // 5 inline citations + 5 reference tags = 10 links
    expect(refLinks.length).toBe(10);

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
            resourceType: 'encounter',
            resourceUuid: 'enc-4',
            date: '2026-01-26',
            sourceText: 'Encounter: Adult Visit at Unknown Location. Provider: Horatio L Hornblower',
          },
        ]}
        questionId="test-question-id"
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Evidence Used')).toBeInTheDocument();
    expect(screen.getByText('[4] · encounter · 2026-01-26')).toBeInTheDocument();
    expect(
      screen.getAllByText('Encounter: Adult Visit at Unknown Location. Provider: Horatio L Hornblower').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/UUID: enc-4/)).toBeInTheDocument();
  });

  it('passes the resource UUID (not a numeric id) to highlightReference when a citation is clicked', () => {
    render(
      <AiResponsePanel
        answer={answer}
        references={references}
        questionId="test-question-id"
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

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
        questionId="test-question-id"
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
        questionId="test-question-id"
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
        questionId="q"
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
        questionId="test-question-id"
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
        questionId="test-question-id"
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
        questionId="q-blocks"
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
        questionId=""
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
        questionId="test-question-id"
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
        questionId="test-question-id"
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
    groundingStatus?: 'checking' | 'verified' | 'unsupported' | 'unchecked',
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
          },
        ]}
        questionId="q"
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
        questionId="q"
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
        questionId="q"
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
        questionId="q"
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Safety checks:')).toBeInTheDocument();
    expect(screen.getByText('Dose')).toBeInTheDocument();
    expect(screen.getByText('Interaction')).toBeInTheDocument();
    expect(screen.getByText(/exceeds the 1200 mg\/day maximum/)).toBeInTheDocument();
    expect(screen.getByText(/interacts with active order warfarin/)).toBeInTheDocument();
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
        questionId="q"
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
        questionId="q"
        error={null}
        phase="complete"
        patientUuid={patientUuid}
      />,
    );

    expect(screen.queryByText('Safety checks:')).not.toBeInTheDocument();
  });

  it('surfaces an unrecognised warning type with the fallback label (never drops a warning)', () => {
    render(
      <AiResponsePanel
        answer="Some answer."
        references={[]}
        safetyWarnings={[{ type: 'future-unknown-type', drug: 'Ibuprofen', detail: 'a new advisory kind' }]}
        questionId="q"
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
        questionId="q"
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
        questionId="q1"
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
        questionId="q1"
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
        questionId="q1"
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
        questionId="q1"
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
        questionId="q1"
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
        questionId="q1"
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
        questionId="q1"
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
    questionId: 'q1',
    error: null,
    patientUuid,
    answerValidation: { status: 'checked' as const, label: 'Checked' },
  };

  it('exposes phase="in-depth" and data-indepth-status="pending" while the in-depth streams', () => {
    const { container } = render(
      <AiResponsePanel {...stagedBase} phase="in-depth" inDepth={{ status: 'pending', answer: 'streaming…' }} />,
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

  it('exposes phase="settled" (composer already unlocked) before the first in-depth token', () => {
    const { container } = render(
      <AiResponsePanel {...stagedBase} phase="settled" inDepth={{ status: 'pending', answer: '' }} />,
    );
    expect(container.querySelector('[data-turn-phase="settled"]')).toBeInTheDocument();
    expect(container.querySelector('[data-indepth-status="pending"]')).toBeInTheDocument();
  });
});

describe('AiResponsePanel per-section confidence', () => {
  const baseProps = {
    answer: '**Answer**\nHgb is 14.0 [1].\n\n**In Depth**\n- within range [1]',
    references: [{ index: 1, resourceType: 'obs', resourceUuid: 'uuid-101', date: '2025-11-24' }],
    questionId: 'q1',
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

  it('RED (low): shows the caveat note, WITHHOLDS the message behind "show <section>"', () => {
    render(
      <AiResponsePanel
        {...baseProps}
        confidence={{ answer: { level: 'green' }, in_depth: { level: 'red', note: 'supporting context unresolved' } }}
      />,
    );
    const inDepth = screen.getByTestId('section-in-depth');
    expect(inDepth).toHaveTextContent('Low confidence');
    expect(inDepth).toHaveTextContent('supporting context unresolved'); // the caveat note is shown
    const details = inDepth.querySelector('details');
    expect(details).toBeTruthy();
    expect(details).toHaveTextContent(/show in depth/i); // message collapsed behind the reveal
    expect(details).not.toHaveAttribute('open');
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
