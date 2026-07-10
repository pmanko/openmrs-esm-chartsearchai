import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import AiTableBlockView from './ai-table-block.component';
import { type AiReference, type AiTableBlock } from '../api/chartsearchai';

const patientUuid = 'test-patient-uuid';

beforeAll(() => {
  window.spaBase = '/openmrs/spa';
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).spaBase;
});

describe('AiTableBlockView', () => {
  const references: AiReference[] = [
    { index: 1, resourceType: 'order', resourceUuid: 'uuid-100', date: '2024-01-01' },
    { index: 2, resourceType: 'order', resourceUuid: 'uuid-200', date: '2024-02-01' },
    { index: 3, resourceType: 'order', resourceUuid: 'uuid-300', date: '2024-03-01' },
  ];

  const block: AiTableBlock = {
    kind: 'table',
    title: 'Medications',
    columns: [
      { key: 'name', label: 'Medication' },
      { key: 'dose', label: 'Dose' },
    ],
    rows: [
      {
        cells: {
          name: { text: 'Lisinopril', refs: [1] },
          dose: { text: '10 mg' },
        },
      },
      {
        cells: {
          name: { text: 'Metformin', refs: [2, 3] },
          dose: { text: '500 mg' },
        },
      },
    ],
  };

  it('renders the table title, column headers, and one row per data row', () => {
    render(<AiTableBlockView block={block} references={references} patientUuid={patientUuid} />);

    expect(screen.getByText('Medications')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Medication' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Dose' })).toBeInTheDocument();
    expect(screen.getByText('Lisinopril')).toBeInTheDocument();
    expect(screen.getByText('10 mg')).toBeInTheDocument();
    expect(screen.getByText('Metformin')).toBeInTheDocument();
    expect(screen.getByText('500 mg')).toBeInTheDocument();
  });

  it('renders cell.refs that are not already in the cell text as appended CitationChip links', () => {
    render(<AiTableBlockView block={block} references={references} patientUuid={patientUuid} />);

    // Lisinopril row has refs [1] not in text → should append a clickable [1]
    const link1 = screen.getByRole('link', { name: '1' });
    expect(link1).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Orders`);

    // Metformin row has refs [2, 3] → should append [2, 3]
    expect(screen.getByRole('link', { name: '2' })).toHaveAttribute(
      'href',
      `/openmrs/spa/patient/${patientUuid}/chart/Orders`,
    );
    expect(screen.getByRole('link', { name: '3' })).toHaveAttribute(
      'href',
      `/openmrs/spa/patient/${patientUuid}/chart/Orders`,
    );
  });

  it('renders inline [N] markers in cell text as CitationChip links (no duplicate appended chip)', () => {
    const inlineBlock: AiTableBlock = {
      kind: 'table',
      title: 'Inline',
      columns: [{ key: 'note', label: 'Note' }],
      rows: [
        {
          cells: {
            // text already contains [1]; refs duplicates that index — shouldn't render twice
            note: { text: 'Order placed [1].', refs: [1] },
          },
        },
      ],
    };

    render(<AiTableBlockView block={inlineBlock} references={references} patientUuid={patientUuid} />);

    const link1s = screen.getAllByRole('link', { name: '1' });
    expect(link1s).toHaveLength(1);
  });

  it('returns null when the block has no rows', () => {
    const empty: AiTableBlock = {
      kind: 'table',
      title: 'Empty',
      columns: [{ key: 'a', label: 'A' }],
      rows: [],
    };
    const { container } = render(<AiTableBlockView block={empty} references={references} patientUuid={patientUuid} />);
    expect(container.firstChild).toBeNull();
  });

  it('handles cells missing from row.cells (renders empty cell, not crash)', () => {
    const partial: AiTableBlock = {
      kind: 'table',
      title: 'Partial',
      columns: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
      ],
      rows: [{ cells: { a: { text: 'present' } } }],
    };
    render(<AiTableBlockView block={partial} references={references} patientUuid={patientUuid} />);
    expect(screen.getByText('present')).toBeInTheDocument();
    // Column B's cell exists but is empty — assert by counting role=cell instead of looking for text
    expect(screen.getAllByRole('cell')).toHaveLength(2);
  });
});
