/**
 * A live answer the module wrote itself (`answeredByTheModule: true`): a caution-only proposal, in
 * the brief form openmrs-module-chartsearchai ADR Decision 140 gives it — the lead, then the
 * finding's first sentence, cited by the finding [46] and her lidocaine order [6]. The checks of a
 * model's prose did not run, so they state `null`.
 *
 * Patient `763e6e5f-c489-4bab-8a55-c379f085dd1c`, *"Can I give her fluconazole?"*. Measured
 * 2026-10-01 on an OpenMRS 3.7.1 standalone through `POST /chartsearchai/search`, verbatim as the
 * wire carried it.
 */
export const MODULE_CAUTION_ANSWER = {
  unstatedFindingSeverities: null,
  questionId: '13559',
  references: [
    {
      index: 6,
      resourceType: 'drug_order',
      resourceUuid: 'i1520000-0000-0000-0000-0000000000c2',
      date: '2026-08-03',
      grounded: null,
      group: 'chart',
      source: null,
      withheldInteractions: 0,
      attachedByTheModule: false,
      attachedFor: [],
    },
    {
      index: 46,
      resourceType: 'safety_finding',
      resourceUuid: 'interaction:Fluconazole',
      date: null,
      grounded: null,
      group: 'reference',
      source: null,
      withheldInteractions: 0,
      attachedByTheModule: false,
      attachedFor: [],
    },
  ],
  activeOrderClaims: null,
  doseCeilingCoverage: 'absent',
  unresolvedDrugClass: null,
  findingPartners: null,
  unfoundedFindingSeverities: null,
  misattributedOrderCitations: null,
  interactionClaimPairs: null,
  answeredByTheModule: true,
  unfaithfullyRenderedCitations: null,
  unsupportedEndedOrderClaims: null,
  cautionLedOverWithholding: null,
  chartReadForSafety: true,
  answer:
    '1 interaction caution for Fluconazole:\nFluconazole interacts with active order Lidocaine — Moderate. [46] [6]',
  unstatedSignificanceQualifiers: null,
  findingCitations: null,
  interactionPairs: {
    found: 1,
    reported: 1,
    belowFloor: [
      {
        drug: 'Fluconazole',
        partner: 'metoclopramide',
        severity: 'Unknown',
      },
      {
        drug: 'Fluconazole',
        partner: 'tiotropium',
        severity: 'Unknown',
      },
    ],
  },
  conditionRuleCoverage: 'absent',
  orderStopDates: [],
  safetyWarnings: [
    {
      type: 'interaction',
      drug: 'Fluconazole',
      detail:
        'Fluconazole interacts with active order Lidocaine — Moderate. Coadministration with fluconazole may increase the plasma concentrations of drugs that are substrates of CYP450 3A4. The mechanism is decreased clearance due to inhibition of CYP450 3A4-mediated metabolism by fluconazole, a moderate inhibitor of the isoenzyme.',
      severity: 'Moderate',
      chartOrderBridges: [],
      namedPartners: ['Lidocaine'],
      restsOnAnUncorroboratedChartMatch: false,
      aboutAnEndedOrder: false,
      endedOrderStopDate: null,
      aboutACurrentMedication: false,
      currentMedicationOrders: [],
      statedInTheAnswer: false,
      aboutAnotherOfHerMedications: false,
      aboutADrugOtherThanTheOneProposed: false,
      findingCitation: 46,
    },
    {
      type: 'contraindication',
      drug: 'Lidocaine',
      detail: 'The patient has a recorded allergy to Lidocaine.',
      severity: null,
      chartOrderBridges: [],
      namedPartners: [],
      restsOnAnUncorroboratedChartMatch: false,
      aboutAnEndedOrder: false,
      endedOrderStopDate: null,
      aboutACurrentMedication: true,
      currentMedicationOrders: [
        {
          orderDisplay: 'Lidocaine',
          orderUuid: 'i1520000-0000-0000-0000-0000000000c2',
        },
      ],
      statedInTheAnswer: false,
      aboutAnotherOfHerMedications: true,
      aboutADrugOtherThanTheOneProposed: true,
      findingCitation: null,
    },
  ],
  unstatedDosingCeilings: null,
  disclaimer:
    "This response is AI-generated and may not be accurate. It is not a substitute for clinical judgment. Always verify against the patient's medical records.",
};
