import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import MarkdownAnswer from './ai-markdown-answer.component';

const patientUuid = 'test-patient-uuid';

beforeAll(() => {
  window.spaBase = '/openmrs/spa';
});

afterAll(() => {
  delete (window as unknown as Record<string, unknown>).spaBase;
});

describe('MarkdownAnswer', () => {
  const references = [{ index: 4, resourceType: 'order', resourceUuid: 'uuid-404', date: '2006-01-01' }];

  it('renders **bold** as a <strong> element, not literal asterisks', () => {
    const { container } = render(<MarkdownAnswer answer="**Answer**" references={[]} patientUuid={patientUuid} />);
    expect(container.querySelector('strong')?.textContent).toBe('Answer');
    expect(container.textContent).not.toContain('**');
  });

  it('renders a markdown bullet list as <li> items', () => {
    const { container } = render(
      <MarkdownAnswer answer={'- lamivudine\n- nevirapine\n- stavudine'} references={[]} patientUuid={patientUuid} />,
    );
    const items = container.querySelectorAll('li');
    expect(Array.from(items).map((li) => li.textContent)).toEqual(['lamivudine', 'nevirapine', 'stavudine']);
  });

  it('keeps an inline [N] citation as a clickable chip inside rendered markdown', () => {
    render(<MarkdownAnswer answer="The regimen is outdated [4]." references={references} patientUuid={patientUuid} />);
    const chip = screen.getByRole('link', { name: '4' });
    expect(chip).toHaveAttribute('href', `/openmrs/spa/patient/${patientUuid}/chart/Orders`);
  });

  it('keeps a [N] citation that sits inside a bold span', () => {
    render(<MarkdownAnswer answer="**Key finding: outdated [4]**" references={references} patientUuid={patientUuid} />);
    const chip = screen.getByRole('link', { name: '4' });
    expect(chip.closest('strong')).not.toBeNull();
  });
});
