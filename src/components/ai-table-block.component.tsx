import React from 'react';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';
import { type AiCell, type AiReference, type AiTableBlock } from '../api/chartsearchai';
import { CitationChip, renderTextWithCitations } from './citation-chip.component';
import styles from './ai-table-block.scss';

interface AiTableBlockProps {
  block: AiTableBlock;
  references: AiReference[];
  patientUuid: string;
}

function renderCellContent(
  cell: AiCell | undefined,
  references: AiReference[],
  patientUuid: string,
  keyPrefix: string,
): React.ReactNode {
  if (!cell) {
    return null;
  }
  const text = cell.text ?? '';
  const refByIndex = new Map(references.map((r) => [r.index, r]));
  const inTextRefs = new Set<number>();
  for (const match of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of match[1].split(/\s*,\s*/).map(Number)) {
      inTextRefs.add(n);
    }
  }
  const extraRefs = (cell.refs ?? []).filter((idx) => !inTextRefs.has(idx));
  const rendered = renderTextWithCitations(text, references, patientUuid, keyPrefix);

  if (extraRefs.length === 0) {
    return <>{rendered}</>;
  }

  return (
    <>
      {rendered}
      {text.length > 0 ? ' ' : null}
      <span className={styles.cellRefs}>
        {'['}
        {extraRefs.map((idx, i) => (
          <React.Fragment key={`${keyPrefix}-extra-${idx}-${i}`}>
            <CitationChip index={idx} reference={refByIndex.get(idx)} patientUuid={patientUuid} />
            {i < extraRefs.length - 1 ? ', ' : null}
          </React.Fragment>
        ))}
        {']'}
      </span>
    </>
  );
}

const AiTableBlockView: React.FC<AiTableBlockProps> = ({ block, references, patientUuid }) => {
  const { t } = useTranslation();
  const columns = block.columns ?? [];
  const rows = block.rows ?? [];

  if (columns.length === 0 || rows.length === 0) {
    return null;
  }

  return (
    <div className={styles.tableContainer}>
      {block.title ? <div className={styles.tableTitle}>{block.title}</div> : null}
      <Table size="sm" useZebraStyles={false} aria-label={block.title ?? t('aiTable', 'AI result table')}>
        <TableHead>
          <TableRow>
            {columns.map((col) => (
              <TableHeader key={col.key} id={`col-${col.key}`}>
                {col.label}
              </TableHeader>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row, rowIdx) => (
            <TableRow key={`row-${rowIdx}`}>
              {columns.map((col) => (
                <TableCell key={`cell-${rowIdx}-${col.key}`}>
                  {renderCellContent(row.cells?.[col.key], references, patientUuid, `c-${rowIdx}-${col.key}`)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export default AiTableBlockView;
