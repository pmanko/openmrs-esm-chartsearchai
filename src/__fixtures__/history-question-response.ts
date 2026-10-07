/**
 * A live answer to a question whether the patient has ever taken a drug she is on: the module
 * lists her one metoclopramide order as active (backend ADR Decision 155), and the one chip
 * beside it is the Major interaction of that order with her lidocaine — about a medication she
 * is taking, which backend ADR Decision 151 keeps on such a question.
 * `asksWhetherSheHasTakenADrug` is `true` (backend ADR Decision 156).
 *
 * Patient `763e6e5f-c489-4bab-8a55-c379f085dd1c`, asked *"Has she ever taken Metoclopramide?"*.
 * Measured 2026-10-06 on an OpenMRS 3.7.1 standalone, through `POST /chartsearchai/search`
 * (question id 16111). Verbatim as the wire carried it, every key included.
 */
export const METOCLOPRAMIDE_HISTORY_QUESTION = {
  unstatedFindingSeverities: null,
  questionId: '16111',
  references: [
    {
      index: 8,
      resourceType: 'drug_order',
      resourceUuid: 'i1520000-0000-0000-0000-0000000000c4',
      date: '2026-08-03',
      grounded: null,
      group: 'chart',
      source: null,
      withheldInteractions: 0,
      attachedByTheModule: false,
      attachedFor: [],
    },
  ],
  asksWhetherSheHasTakenADrug: true,
  activeOrderClaims: null,
  unresolvedDrugClass: null,
  unfoundedFindingSeverities: null,
  misattributedOrderCitations: null,
  unsupportedEndedOrderClaims: null,
  cautionLedOverWithholding: null,
  chartReadForSafety: true,
  findingCitations: null,
  interactionPairs: {
    found: 1,
    reported: 1,
    belowFloor: [
      {
        drug: 'Metoclopramide',
        partner: 'neomycin',
        severity: 'Unknown',
      },
      {
        drug: 'Metoclopramide',
        partner: 'tiotropium',
        severity: 'Unknown',
      },
    ],
  },
  findingsStatedByTheModule: null,
  orderStopDates: [],
  disclaimer:
    "This response is AI-generated and may not be accurate. It is not a substitute for clinical judgment. Always verify against the patient's medical records.",
  doseCeilingCoverage: 'absent',
  findingPartners: null,
  interactionClaimPairs: null,
  answeredByTheModule: true,
  unfaithfullyRenderedCitations: null,
  answer: "This patient's chart records 1 Metoclopramide order:\nMetoclopramide — active, ordered 2026-08-03. [8]",
  unstatedSignificanceQualifiers: null,
  conditionRuleCoverage: 'absent',
  safetyWarnings: [
    {
      type: 'interaction',
      drug: 'Metoclopramide',
      detail:
        'Metoclopramide interacts with active order Lidocaine — Major. Coadministration of local anesthetics with other oxidizing agents that can also induce methemoglobinemia such as antimalarials (e.g., chloroquine, primaquine, quinine, tafenoquine), nitrates and nitrites, sulfonamides, aminosalicylic acid, dapsone, dimethyl sulfoxide, flutamide, metoclopramide, nitrofurantoin, phenazopyridine, phenobarbital, phenytoin, and rasburicase may increase the risk.',
      severity: 'Major',
      chartOrderBridges: [],
      namedPartners: ['Lidocaine'],
      restsOnAnUncorroboratedChartMatch: false,
      aboutAnEndedOrder: false,
      endedOrderStopDate: null,
      aboutACurrentMedication: true,
      currentMedicationOrders: [],
      statedInTheAnswer: false,
      aboutAnotherOfHerMedications: false,
      aboutADrugOtherThanTheOneProposed: false,
      findingCitation: 46,
    },
  ],
  unstatedDosingCeilings: null,
};
