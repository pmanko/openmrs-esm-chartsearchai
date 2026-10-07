# openmrs-esm-chartsearchai

An [OpenMRS 3.x](https://openmrs.org/) microfrontend that lets clinicians ask natural-language questions about a patient's chart and receive AI-generated answers with source citations.

![OpenMRS](https://img.shields.io/badge/OpenMRS-3.x-green)
[![OpenMRS CI](https://github.com/openmrs/openmrs-esm-chartsearchai/actions/workflows/ci.yml/badge.svg)](https://github.com/openmrs/openmrs-esm-chartsearchai/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-blue.svg)](https://opensource.org/licenses/MPL-2.0)

## What it does

A floating AI button appears on the patient chart page. Clicking it opens a search panel where clinicians can type questions like:

- "What medications is this patient on?"
- "Has she ever had a bad reaction to penicillin?"
- "Is her diabetes getting better or worse?"

The conversation panel returns an answer with numbered citations (e.g. `[1]`, `[2]`) that link to chart records. Bundled inference can show tokens as they arrive; providers that supply only completed answers use the same conversation flow. The selected provider and Hub profile stay explicit.

### Answer formatting

Completed answers render Markdown headings, emphasis, lists and tables while keeping
numbered citations linked to chart records. Citation warnings, omitted severity
ratings and clinical-significance caveats retain the same meaning in formatted text.
Streaming answers remain plain text until they finish.

Provider-supplied structured tables, source details and grounding results render with
the answer. When a provider supplies asynchronous review or In-Depth, their status
and output remain separate. Original, edited or withheld output stays inspectable
for manual review. Missing optional sections do not prevent plain-answer display.

### Model reasoning

When the selected provider supplies model reasoning, the conversation displays it as it arrives if streaming is enabled. After the answer arrives, the reasoning remains in a collapsed `Model reasoning` disclosure below the answer. The reader's choice to expand it is remembered for the session. With streaming disabled, supplied reasoning appears only after the complete answer arrives. Providers that supply no reasoning still return their supported answer.

It is the model's scratchpad, not a finding: none of it goes through the grounding pass that verifies the answer's citations, and it can state things the answer does not. That caveat is the `Model reasoning` row's tooltip — a native `title`, so it is the summary's accessible description for a screen reader, but it appears on hover only. A touch user, or a reader who never hovers, sees no caveat on the transcript itself and has only the panel's own "AI-generated … verify against the records" disclaimer. The transcript is never copied by the answer's Copy button, never written to browser storage, and is dropped with the chat history at logout. `showReasoning: false` switches it off entirely — nothing is shown, and nothing is retained.

The optional progressive-reasoning preview (backend GP `chartsearchai.progressiveReasoning.enabled`) gets no disclosure of its own: it is superseded within the same answer, so there would be nothing behind the row by the time a reader could open it.

When the backend's optional [drug-reference feature](https://github.com/openmrs/openmrs-module-chartsearchai#drug-reference-injection--safety-validation) is enabled, the panel also shows non-blocking **safety-check** chips below the answer (overdose / interaction / contraindication), renders module-supplied reference citations (drug references, safety findings, drug-class notes) as distinct non-navigating reference chips, and states what the safety check did and did not cover — see [Fields that state the answer's limits](#fields-that-state-the-answers-limits). A chip about a medication the patient already takes is marked as such — see [API endpoints used](#api-endpoints-used).

## Backend

This frontend requires the [Chart Search AI backend module](https://github.com/openmrs/openmrs-module-chartsearchai). The backend uses QueryStore to retrieve patient-chart evidence and routes the conversation to the explicitly selected provider. Bundled inference supports its configured local or remote model; Med-Agent Hub exposes configured product profiles. The frontend uses the same conversation interface for both and displays the capabilities and output they actually provide.

See the [backend README](https://github.com/openmrs/openmrs-module-chartsearchai#readme) for full setup instructions, model downloads, and global property configuration.

## Prerequisites

- OpenMRS 3.x with the [Chart Search AI module](https://github.com/openmrs/openmrs-module-chartsearchai) installed and configured
- Node.js 18+
- Yarn 4.x

## Getting started

```sh
# Install dependencies
yarn install

# Start the dev server (proxies to a running OpenMRS instance)
yarn start
```

## Configuration

The following options can be set via the OpenMRS 3.x config system:

| Property              | Type      | Default                          | Description                                                          |
| --------------------- | --------- | -------------------------------- | -------------------------------------------------------------------- |
| `aiSearchPlaceholder` | `string`  | `"Ask AI about this patient..."` | Placeholder text for the search input                                |
| `maxQuestionLength`   | `number`  | `1000`                           | Maximum characters allowed in a question                             |
| `useStreaming`        | `boolean` | `true`                           | Show incremental answer/reasoning output; false shows the complete answer on the same conversation path |
| `showReasoning`       | `boolean` | `true`                           | Show the model's reasoning — see [Model reasoning](#model-reasoning) |

### Provider and profile selection components

The provider selector reads `/providers`, uses the backend's advertised
default, and keeps an unavailable explicit selection until the user chooses a
replacement. The Hub profile selector reads `/models`, shows product profiles and
their availability, and selects the Hub-advertised default. It does not query Hub
profiles for bundled inference. `showModelPicker` defaults to `true`; hiding the
control still permits discovery of the required default profile.

The conversation panel mounts these controls. Restored history adopts its recorded
provider; switching providers starts a fresh conversation. An unavailable explicit
selection remains visible until the user chooses a supported replacement.

## API endpoints used

All endpoints are served by the backend module under `/ws/rest/v1/chartsearchai/`:

| Method | Path             | Description                                         |
| ------ | ---------------- | --------------------------------------------------- |
| POST | `/chat/stream` | Conversation answer, optional review/evidence/In-Depth and terminal result |
| GET | `/chat?patient=<uuid>` | Active conversation history for the current user |
| POST | `/chat/new` | New conversation for a patient and optional explicit provider |
| GET | `/providers` | Configured provider capabilities and availability |
| GET | `/models` | Hub product profiles and availability |
| POST | `/feedback` | Audit feedback under `questionId`, with rating and optional comment |

Chat request: `{ "patient": "<uuid>", "question": "<text>", "session": "<optional uuid>", "provider": "<optional id>", "profile": "<Hub profile>" }`. Hub requests require a profile.
The existing `/search` and `/search/stream` clients remain available for their backend contracts; the visible conversation panel uses `/chat/stream`.

Response:

```json
{
  "answer": "The patient is currently on metformin [1] and lisinopril [2]...",
  "disclaimer": "AI-generated summary. Verify with the full chart.",
  "references": [
    {
      "index": 1,
      "resourceType": "order",
      "resourceUuid": "5946f880-b197-400b-9caa-a3c661d71165",
      "date": "2025-12-01"
    },
    {
      "index": 2,
      "resourceType": "order",
      "resourceUuid": "a8f5f167-4ee2-4d2a-94f9-3f3f86d2e9b6",
      "date": "2025-11-15"
    }
  ],
  "safetyWarnings": [],
  "misattributedOrderCitations": [],
  "unstatedFindingSeverities": [],
  "conditionRuleCoverage": "unloaded",
  "interactionPairs": null,
  "orderStopDates": []
}
```

`references[].resourceUuid` is the cited record's UUID (used to locate and highlight the chart row). `safetyWarnings` (each `{ type, drug, detail, severity, chartOrderBridges, aboutACurrentMedication, currentMedicationOrders, aboutAnEndedOrder, endedOrderStopDate, aboutAnotherOfHerMedications, aboutADrugOtherThanTheOneProposed }`, among the keys this panel reads) is always present and empty unless the backend's optional drug-reference feature is enabled; the panel renders any entries as chips below the answer. A **contraindication** chip whose `aboutACurrentMedication` is `true` is marked _Already prescribed: Advil 400mg_, naming her order from `currentMedicationOrders` (or _Already prescribed_ where a backend sends none), because its `detail` is the same words whether the patient takes the drug or a question proposed it. It never names the order from `drug`, the substance the module matched the order to. The mark is not drawn on an interaction chip, whose `detail` already says _interacts with active order …_, nor behind the other-medications line below, which already says it. `false`, and a backend that predates the key, render nothing: `false` is not a statement that the patient is off the drug.

A chip whose `aboutAnEndedOrder` is `true` is marked _About an order no longer in force_, with _ended yyyy-MM-dd_ from `endedOrderStopDate` where the backend states one. Its `detail` is the same words whether the chart holds the drug only as an ended order or a question proposed it, so a chip reading "interacts with active order Nevirapine" is, with this mark, about what giving the drug again would mean — not about two medications the patient takes now — and its tooltip says so. It is a mark of its own, apart from _Already prescribed_, because the backend keeps the two referents exclusive. `false`, and a backend that predates the key, render nothing: `false` is not a statement that the drug is current.

**Chips not about the drug asked about are drawn apart.** A chip whose `aboutAnotherOfHerMedications` is `true` (a finding about another of her own prescriptions, such as her lidocaine allergy beside a question about ibuprofen) or whose `aboutADrugOtherThanTheOneProposed` is `true` (a finding whose subject is not the drug the question proposes, such as a drug the question only lists) sits behind a closed line in the safety box, one click from its full detail. The line reads _2 findings about other medications this patient takes_ where every chip behind it is her own prescription, and _1 finding not about the drug asked about_ otherwise. Those chips do not keep the box open. Where they are the only chips in the box, the box is drawn neutral grey rather than red, since none of it is a warning about the drug asked about. Only `true` moves a chip; `false` is not a claim it is about the drug in question.

`orderStopDates` (`[{ citation, stopDate }]`) says when each cited prescription stopped being in force. The panel shows _Stopped yyyy-MM-dd_ beside the reference chip whose `index` is `citation`, next to the record's own `date` and never in its place: the two are different facts. `[]`, `null` and a missing key render nothing — an absent entry is never a claim that a cited order is current, because an order can be out of force with no end date anywhere.

Both dates are UTC calendar days, so either can be a day off the local date, and both tooltips say so. The panel shows them verbatim and never parses them into a `Date`, which would shift them again by the viewer's offset; a value that is not a `yyyy-MM-dd` day is withheld rather than trimmed, so nothing more exact than a day is shown.

### Fields that state the answer's limits

Four response fields, plus three per-reference fields, say what a bounded safety answer did **not** cover. The panel renders six of these seven, and the table says why the seventh is not drawn; the backend publishes more that this app does not draw — see _Not rendered_ below. The backend README is authoritative for what each does and does not assert.

| Field                               | Rendered as                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unstatedFindingSeverities`         | The rating for that finding, beside the sentence whose finding the answer left unrated — as a **caveat**, since the backend documents cells where this key over-reports. The rating is not on the key and cannot be joined to a chip by `(type, drug)`, so the panel narrows to the candidates sharing it and requires the answer's own sentence to single one out. It reads three independent kinds of evidence — `chartOrderBridges` (typed, and carrying both the substance and the chart's order display), the partner substance alone, and the module's whole sentence — and any disagreement between them refuses rather than being resolved by precedence. Findings sharing one `(type, drug)` are a candidate **set**: they are badged together or not at all, because a bare item beside a badged one reads as "no rating exists" rather than "we declined" |
| `misattributedOrderCitations`       | Those citations struck through and non-navigating, marked _Not the order named_ — bad **evidence** for a sound finding, never an unsupported claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `unstatedSignificanceQualifiers`    | _Clinical significance unknown_ beside each citation whose finding's record says so where the answer does not, after any rating badge, once per finding — the finding's own **caveat** the answer left out, never a correction of its rating. It arrives on the final `done` or `grounded`, never the early `done`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `unsupportedEndedOrderClaims`       | One amber line under the answer, _No record says the Nevirapine order has ended — the answer states it without one._ It names drugs and not sentences, so it sits under the answer rather than beside one. A statement in the answer that nothing in the records supports, never a finding that the order is in force.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `references[].attachedFor`          | A chip tagged _source of [46]_, naming the cited findings the record backs — the prose carries no `[N]` marker for such a citation, so this is the only place it appears. An index naming no `safety_finding` among the citations is dropped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `references[].source`               | The dataset, verbatim, as the citation label's hover text (_Source: DDInter 2.0 (via openmrs-ddi-knowledge-base)_) — keyed on the value and never on `group`, since a `reference`-group entry may carry no attribution and the module's own computed finding carries none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `references[].withheldInteractions` | Not drawn. The partners a drug-reference record leaves out are mostly drugs this patient is not on, and the backend's safety check reads every one of them regardless, so a count read as an incomplete check that was not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**A chip the answer already cites is drawn on one line.** Its drug, partner and rating, tagged with the marker the answer cites it at (_See [46] in the answer_, every such marker where there are several), with its full detail behind _Show details_. On a live _"Is aspirin safe for her?"_ answer the full chip repeated the answer's paragraph beside it. It qualifies only where the answer's own markers cite that finding's record (a `safety_finding` whose `resourceUuid` is the chip's `type:drug`), its own record is cited — where the chip carries `findingCitation` (the record number of its own finding) the answer must cite that number, and the chip is tagged with it alone; a chip from a backend that sends no `findingCitation` falls back to its key, which several findings of one type about one drug share, so such chips fold only where the answer cites at least as many distinct findings of the key as there are chips carrying it, each then tagged with every marker of the key, and the checks clear it. The two that name no finding — `misattributedOrderCitations` and `interactionClaimPairs` — must report nothing, or every chip is drawn in full. The ones that name findings — `unfaithfullyRenderedCitations`, `unfoundedFindingSeverities` and `cautionLedOverWithholding` — keep in full only the chips whose finding they name, since the full chip is the backstop for an answer that softened or misstated that finding. `unstatedFindingSeverities` keeps none open: the one-line chip states the rating the answer left out. A `null` measurement from any of them, or an answer still streaming, draws every chip in full. A chip whose finding the module states in its own sentence after the answer — named in `findingsStatedByTheModule`, the sentence citing no marker — is drawn on one line tagged _Stated above_, whatever those checks say, since they judge the model's prose and not the module's. A chip the answer does not cite that relates the drug asked about to another drug the question names — no order of hers among its partners — is drawn on one line tagged _Not in the answer_, its detail behind _Show details_; it does not count towards collapsing the box, which says each finding is cited. A finding against one of her own orders that the answer leaves out is still drawn in full. A cited finding that `unfaithfullyRenderedCitations` alone names — the answer reproduced its record and then said something different inside the same sentence — is drawn on one line tagged _Reworded in the answer, compare_, the record's own words behind _Show details_; it keeps the box open, so the tag is seen. A finding another check also names is drawn in full. The one exception is an answer the module wrote itself (`answeredByTheModule: true`, backend ADR Decision 140): it states each finding briefly from the chip, so those checks of a model's prose have nothing to judge and state `null`, and its cited chips fold on the citation conditions alone, their tag's hover saying the answer states the finding briefly. It is not a claim that the answer states the chip's words: that aspirin answer dropped the chip's last sentence, which is why the one-line chip still opens. Where **every** chip in the safety box qualifies, the box itself collapses to _Safety checks: 1 finding, cited in the answer_ with _Show safety checks_; one chip that does not keeps the whole box open, because that is the finding a clinician must not have to go looking for. `src/utils/compact-chips.ts` holds the rule. A folded chip naming no partner, a finding relating two drugs the question names, reads by its detail's lead (_Fluconazole interacts with Nevirapine, also named in the question (Moderate)_) rather than the bare drug.

**A question whether she has ever taken a drug draws every chip apart.** Where the response carries `asksWhetherSheHasTakenADrug: true` (backend ADR Decision 156) — *"Has she ever taken Metoclopramide?"* — the chips beside the answer are about that drug's place in her chart, such as *Metoclopramide interacts with active order Lidocaine — Major* for a drug she is on, and not a reading of the question. So every one is drawn in the neutral box, collapsed behind _1 finding about this patient's medications_ with _Show details_, rather than among the findings about the drug asked. Any other value draws them as above.

Two readings the panel deliberately does not offer. An empty `misattributedOrderCitations` renders **nothing** — the check reads only answers reproducing the module's own phrasing, so `[]` is not a certificate that the other citations are sound. And a `null` measurement renders nothing rather than a completeness claim.

**A known cost of the severity join, and it is a blank rather than a wrong rating.** The rating a citation gets is reconstructed from the model's prose, and the module refuses wherever the reading is ambiguous. Three rules decide that, between them covering the whole answer: they ask whether a drug of the same finding-group is named _past the set's own last citation_, _before its first_, or _between two of them_ with no citation willing to claim it — a subject left over, which is the signature of a list written so that each marker precedes the name it belongs to. All three are deliberately blunt about wording: two word lists were tried across them and each was defeated by the same subject phrased slightly differently, because the distinction they were reaching for is grammatical and nothing here parses. So an answer closing with _"Prednisone would be the safer choice."_ renders no ratings even though its citations were unambiguous. Together they cost 18 of the 98 ratings this module would otherwise render across the 46 captured live answers: three answers lose theirs because the closing text names one of their own finding-group's drugs for an unrelated reason, and two more because an earlier sentence names a family member the citations do not account for. That leaves 80, and every one of the 80 has been read against the sentence it was drawn from and checked against the payload's own warnings. A fourth rule joins them, from the payload rather than the prose: where the answer states a rating in words, the backend's own rule says no citation on its unstated list can be that finding, so a resolution giving it that rating is deleted. The count read 82 for part of a day, because that rule was first written to remove such findings from the candidate list instead — which recovered two correct ratings on one live answer and was then found to manufacture a swapped pair on another, since a shorter candidate list changes which drug names count as telling two findings apart. It deletes a resolution now and narrows nothing, so those two are blanks again and are not among the 80. That price is paid deliberately. The shape these rules catch resolved 35,010 generated answers of which 35,010 carried a wrong rating — the class has no correct resolutions at all — and a clinician reading a Major finding badged Moderate has been actively misled, where a missing badge sends them to the chart. `src/utils/safety-disclosure.ts` carries the measurements beside the rule.

**Three known gaps remain, all recorded in the code beside the rule they evade.** The first is an over-warning: where the answer misspells the order display it means — live captures on one day wrote `Solu-Medrol 12mg/5ml`, `125mag/5ml` and `125mcg/5ml` — the marker's own subject is invisible and a sibling named in the same sentence is elected in its place, so a Moderate finding can render Major. It is left open deliberately: closing it needs a near-match on drug names, and `Prednisone` and `Prednisolone` are different drugs one letter apart, so that trade buys one over-warning at the price of a class of wrong ratings between real neighbours. `src/utils/safety-disclosure.test.ts` asserts the shape as it behaves, so the assertion changes on the day someone closes it.

The second is a blind spot rather than a wrong reading: the rule that catches a list written so each marker precedes its drug works by reading what follows the last citation, so **an answer that ends on its last citation gives it nothing to read**, and the other checks are all silent there by construction. The same answer with one more name after that marker is refused, so the verdict turns on whether the module can see the tail rather than on how clear the prose is. It is left open because the two readings of such an answer genuinely disagree — the full stop argues one way, the next line the other — so there is no correct pairing to build a rule against, and a rule built on the wrong one would render wrong ratings instead of blanks.

The third is a cost rather than a wrong reading, and it is the one most likely to be noticed in use: **an answer that states one finding's rating in words withholds the ratings of the others.** Stating a rating removes that citation from the backend's list, which leaves the drug named in the prose with no citation of the remaining measurement to claim it — so it reads as a subject left over and the whole set is withheld. That is the shape a clinician is most likely to produce a question for, since a model naming one severity and not the rest is exactly what this field exists to report. No captured live answer resolves through it. The fix adds resolutions rather than removing them, which is the direction that has twice turned out to manufacture a wrong rating on this file, so it is deferred to a change that can be measured on its own.

**Not rendered.** The backend publishes more than the seven above. Naming them here is a deliberate gap, not a claim that the contract stops at what this panel draws.

- `conditionRuleCoverage` and `doseCeilingCoverage` — drawn for one release as a grey _Not checked against this patient’s age or recorded conditions._ note beside a drug-safety answer, and removed.
- `interactionPairs`, `conditionRuleCoverage` and `activeOrderClaims` — drawn until this release under a _What the safety checks covered_ heading, and removed with it. On a live clarithromycin answer listing four of the patient's own active orders as interactions, its `interactionPairs: { found: 0 }` line — _related no drug pairs_ — read as "no interactions with her medications", because the backend's screen skips the source's unrated pairs before relating any. The panel still carries all three on each message, and draws `conditionRuleCoverage` only in the note described next. That includes `interactionPairs.belowFloor`, which was briefly drawn as an amber _Not raised as a warning: … the drug reference rates these below the warning threshold_ line and removed: every such pair is a DDInter row rated `Unknown` with no mechanism text, so the line gave a clinician nothing to act on, and its wording read as a low rating the source never gave.
- `unresolvedDrugClass` — the drug **class** a question named that the module resolved to no substance (`"NSAID"`, `"oral contraceptive"`), or `null`. The backend asks a client to say that reference _entries_ are indexed by individual substance name so the class matched none of them, and to ask for a specific drug by name.
- `unfaithfullyRenderedCitations` — citations whose rendering _in the answer_ the module found unfaithful to the record they point at. A partial, with `unfoundedFindingSeverities`, `cautionLedOverWithholding` and `interactionClaimPairs`: the panel **reads** all four, only to decide whether a chip may be drawn on one line (above), and displays none of them.
- `safetyWarnings[].chartOrderBridges` — `{ substance, orderDisplay }`, saying _this chip's `Ibuprofen` is your `Advil 400mg` order_. This one is a partial: the panel **reads** it, as one of the three ORDER-FREE kinds of evidence the severity join weighs — they corroborate or contradict and none outranks another, which is why a disagreement refuses rather than being settled by precedence — but does not **display** it. The backend asks for it beside the chip, and until that is done a clinician reading a chip list next to the answer still has to work out whether `Advil` and `Ibuprofen` are one prescription or two.

Under `chartsearchai.grounding.async=true` the SSE `done` event is emitted before validation runs, so `safetyWarnings` and every measurement taken _after_ the answer — `interactionPairs`, `misattributedOrderCitations`, `unstatedFindingSeverities` — arrive on the trailing `grounded` event instead. That is why the stream's `onGrounded` callback hands over the whole payload rather than the references alone. Two exceptions not to gate on that event: `conditionRuleCoverage` is read off the dataset load before the model is called and so is already final on `done` (as is `orderStopDates`, a projection over the answer's own citations that owes the grounding pass nothing), and on an answer-cache hit no early `done` is emitted at all.

The required privilege is **AI Query Patient Data**.

## Deploying to an O3 Instance (without publishing to npm)

These steps work for the **OpenMRS SDK**, **O3 Standalone**, and **Docker** deployments.

### 1. Clone and build

```sh
git clone https://github.com/openmrs/openmrs-esm-chartsearchai.git
cd openmrs-esm-chartsearchai
yarn install
yarn build
```

### 2. Locate your frontend directory

Find the `frontend/` folder that contains `importmap.json`:

- **OpenMRS SDK**: `~/openmrs/<server-name>/frontend/`
- **O3 Standalone**: `<standalone-directory>/appdata/frontend/`
- **Docker**: the frontend files are inside the `frontend` container (see below)

Confirm by checking that `importmap.json` exists inside the directory.

For **Docker**, find the frontend directory inside the container:

```sh
# Find the frontend container name
docker ps --format '{{.Names}}' | grep frontend

# The frontend files are typically at /usr/share/nginx/html/
# Verify by checking for importmap.json
docker exec <frontend-container> ls /usr/share/nginx/html/importmap.json
```

### 3. Copy the built files

**SDK / Standalone:**

```sh
mkdir -p <frontend-directory>/openmrs-esm-chartsearchai-app
cp dist/* <frontend-directory>/openmrs-esm-chartsearchai-app/
```

**Docker:**

```sh
# Create the directory inside the container
docker exec <frontend-container> mkdir -p /usr/share/nginx/html/openmrs-esm-chartsearchai-app

# Copy the built files into the container
docker cp dist/. <frontend-container>:/usr/share/nginx/html/openmrs-esm-chartsearchai-app/
```

### 4. Add the module to the import map

Edit `importmap.json` and add this entry inside the `"imports"` object:

```json
"@openmrs/esm-chartsearchai-app": "./openmrs-esm-chartsearchai-app/openmrs-esm-chartsearchai-app.js"
```

For **Docker**, you can edit the file in-place:

```sh
docker exec <frontend-container> sh -c "cat /usr/share/nginx/html/importmap.json | \
  sed 's/}}/,\"@openmrs\/esm-chartsearchai-app\":\"\.\/openmrs-esm-chartsearchai-app\/openmrs-esm-chartsearchai-app.js\"}}/' \
  > /tmp/importmap.json && mv /tmp/importmap.json /usr/share/nginx/html/importmap.json"
```

Or copy the file out, edit locally, and copy it back:

```sh
docker cp <frontend-container>:/usr/share/nginx/html/importmap.json .
# Edit importmap.json with your editor
docker cp importmap.json <frontend-container>:/usr/share/nginx/html/importmap.json
```

### 5. Register the module's routes

Edit `routes.registry.json` and add this entry to the top-level JSON object.

For **Docker**, copy the file out, edit, and copy back:

```sh
docker cp <frontend-container>:/usr/share/nginx/html/routes.registry.json .
# Edit routes.registry.json with your editor
docker cp routes.registry.json <frontend-container>:/usr/share/nginx/html/routes.registry.json
```

Add this entry:

```json
"@openmrs/esm-chartsearchai-app": {
  "$schema": "https://json.openmrs.org/routes.schema.json",
  "backendDependencies": {
    "webservices.rest": ">=2.44.0",
    "chartsearchai": ">=1.0.0-SNAPSHOT"
  },
  "extensions": [
    {
      "name": "ai-search-button",
      "component": "aiSearchButton",
      "slot": "patient-banner-tags-slot",
      "privilege": "AI Query Patient Data",
      "order": 100
    }
  ],
  "version": "1.0.0"
}
```

### 6. Ensure your user has the required privilege

The logged-in user's role must include the **"AI Query Patient Data"** privilege. You can assign this via the OpenMRS admin UI under **Administration > Manage Roles**.

### 7. Hard-refresh the browser

Press **Cmd+Shift+R** (Mac) or **Ctrl+Shift+R** (Windows/Linux) to bypass the cache. Navigate to a patient chart and the AI search button should appear in the patient banner.

### Updating after code changes

After making changes, rebuild and copy:

**SDK / Standalone:**

```sh
yarn build
cp dist/* <frontend-directory>/openmrs-esm-chartsearchai-app/
```

**Docker:**

```sh
yarn build
docker cp dist/. <frontend-container>:/usr/share/nginx/html/openmrs-esm-chartsearchai-app/
```

Then hard-refresh the browser. No server restart is needed.

## Running tests

```sh
yarn test
```

## Building for production

```sh
yarn build
```

## License

[MPL-2.0](https://opensource.org/licenses/MPL-2.0)

## Staged chat transport

`chatPatientChartStream` in `src/api/chartsearchai.ts` provides the client transport
for the staged `/chat/stream` contract. It delivers the initial answer, subsequent
validation and evidence updates, optional In-Depth events, and the final turn result.
Requests carry the patient, new question, optional conversation identifier and
provider selection; Hub requests require a product profile.

The conversation panel uses this transport. `useStreaming: false` suppresses
incremental display while retaining the selected provider/profile, conversation
identity, history, cancellation and review status. Any supplied enabled reasoning
is then offered only after the complete answer arrives. The transport still uses
`/chat/stream`; this display preference does not yet suppress backend token generation.
A provider that emits no token, reasoning, structured-block, review or In-Depth
events still delivers its supported complete answer. No alternate provider or
model is selected to obtain a missing feature.

Stop retains displayed answer or enabled reasoning, drops temporary previews and
marks unfinished checks and In-Depth as interrupted. Once the direct answer settles,
a new question may preempt trailing In-Depth. Completed responses do not pull a
reader away from earlier transcript content. Feedback uses the numeric audit id
internally and sends the existing backend `questionId` field.

This source requires the corresponding backend conversation endpoints and provider
contracts. Local component checks do not establish combined runtime acceptance.

## Conversation history client

`fetchChatHistory` reads the current user's active conversation for a patient.
An empty history has a null session identifier; reading it does not create a
conversation. `startNewChat` requests a fresh conversation, optionally for an
explicit provider. Both calls support cancellation and pass failures to the caller.

The session store carries per-patient conversation identifiers and browser-session
provider/profile selections. Logout or a user change clears them together with the
messages and reasoning-display preference; refreshing the same user's session
preserves them. These values remain in memory, not browser storage.

The panel hydrates this history and offers New chat even before the first question.
An expired or failed turn remains visible with its recorded error, while interrupted
review or In-Depth is not restored as permanently pending work.
