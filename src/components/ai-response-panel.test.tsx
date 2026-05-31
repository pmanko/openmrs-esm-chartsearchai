import React from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AiResponsePanel from './ai-response-panel.component';

const patientUuid = 'test-patient-uuid';

beforeAll(() => {
  window.spaBase = '/openmrs/spa';
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).spaBase;
});

describe('AiResponsePanel reference links', () => {
  const references = [
    { index: 1, resourceType: 'obs', resourceId: 101, date: '2025-01-15' },
    { index: 2, resourceType: 'order', resourceId: 202, date: '2025-02-20' },
    { index: 3, resourceType: 'allergy', resourceId: 303, date: '2025-03-10' },
    { index: 4, resourceType: 'condition', resourceId: 404, date: '2025-04-05' },
    { index: 5, resourceType: 'diagnosis', resourceId: 505, date: '2025-05-12' },
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
        isLoading={false}
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

  it('renders inline citations as clickable <a> elements', () => {
    render(
      <AiResponsePanel
        answer={answer}
        references={references}
        questionId="test-question-id"
        error={null}
        isLoading={false}
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
      { index: 1, resourceType: 'obs', resourceId: 101, date: '2025-01-15' },
      { index: 2, resourceType: 'order', resourceId: 202, date: '2025-02-20' },
    ];

    render(
      <AiResponsePanel
        answer="The patient has findings [1, 2]."
        references={refs}
        questionId="test-question-id"
        error={null}
        isLoading={false}
        patientUuid={patientUuid}
      />,
    );

    // Numbers are individually linked; brackets and comma are plain text
    const link1 = screen.getByRole('link', { name: '1' });
    expect(link1).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Results`);

    const link2 = screen.getByRole('link', { name: '2' });
    expect(link2).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Orders`);
  });

  it('renders unknown resource types as links to Patient Summary', () => {
    const unknownRef = [{ index: 1, resourceType: 'UnknownType', resourceId: 999, date: '2025-06-01' }];

    render(
      <AiResponsePanel
        answer="Some answer [1]."
        references={unknownRef}
        questionId="test-question-id"
        error={null}
        isLoading={false}
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
        isLoading={false}
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('Server error: 500')).toBeInTheDocument();
    expect(screen.queryByText(/Response interrupted/)).not.toBeInTheDocument();
  });

  it('renders a Carbon DataTable below the prose when blocks are present', () => {
    const refs = [
      { index: 1, resourceType: 'order', resourceId: 100, date: '2024-01-01' },
      { index: 2, resourceType: 'order', resourceId: 200, date: '2024-02-01' },
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
        isLoading={false}
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
        isLoading={true}
        patientUuid={patientUuid}
      />,
    );
    // The streaming-time render only shows prose; blocks land atomically once done.
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(screen.queryByText('should-not-show')).not.toBeInTheDocument();
  });

  it('shows partial answer with error banner when stream fails mid-response', () => {
    render(
      <AiResponsePanel
        answer="The patient has been taking"
        references={[]}
        questionId="test-question-id"
        error="Connection lost"
        isLoading={false}
        patientUuid={patientUuid}
      />,
    );

    expect(screen.getByText('The patient has been taking')).toBeInTheDocument();
    expect(screen.getByText(/Response interrupted:/)).toBeInTheDocument();
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument();
  });
});

describe('AiResponsePanel copy-to-clipboard', () => {
  const references = [
    { index: 1, resourceType: 'obs', resourceId: 101, date: '2025-01-15' },
    { index: 2, resourceType: 'order', resourceId: 202, date: '2025-02-20' },
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
        isLoading={true}
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
        isLoading={false}
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
        isLoading={false}
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
        isLoading={false}
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
        isLoading={false}
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
        isLoading={true}
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
        isLoading={false}
        patientUuid={patientUuid}
      />,
    );

    expect(screen.queryByText('med-agent-team')).not.toBeInTheDocument();
  });
});
