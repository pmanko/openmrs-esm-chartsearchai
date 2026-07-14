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

The module receives staged SSE updates from the backend: the short answer arrives as one chunk, optional answer validation updates the same message, and in-depth analysis arrives as a later whole chunk. Numbered citations (e.g. `[1]`, `[2]`) link back to the relevant section of the patient chart (Results, Orders, Allergies, etc.).

When the selected med-agent-hub profile emits deterministic safety advisories, the panel shows non-blocking **safety-check** chips below the answer and renders knowledge-base citations as distinct, non-navigating reference chips.

## Backend

This frontend requires the [Chart Search AI backend module](https://github.com/openmrs/openmrs-module-chartsearchai). The Java module authorizes the patient request, persists the conversation, and relays one staged request to med-agent-hub. The hub owns profile composition, context sources, temporal and safety checks, answer review, citation grounding, and In-Depth generation.

The frontend renders those lifecycle and evidence states. It does not choose provider endpoints, compose model stages, or maintain a model catalog.

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

| Property | Type | Default | Description |
|---|---|---|---|
| `aiSearchPlaceholder` | `string` | `"Ask AI about this patient..."` | Placeholder text for the search input |
| `maxQuestionLength` | `number` | `1000` | Maximum characters allowed in a question |
| `showModelPicker` | `boolean` | `true` | Show available med-agent-hub product profiles |

## API endpoints used

All endpoints are served by the backend module under `/ws/rest/v1/chartsearchai/`:

| Method | Path | Description |
|---|---|---|
| POST | `/chat` | Synchronous chat turn (returns the complete answer) |
| POST | `/chat/stream` | SSE staged chat turn (answer/validation/in-depth phase events; multi-turn via `session`) |
| GET | `/chat` | Hydrate a patient's active session + prior messages |
| POST | `/chat/new` | Close the active session and open a fresh one |
| GET | `/models` | Relay med-agent-hub product-profile metadata |

Request body: `{ "patient": "<uuid>", "question": "<text>", "session": "<uuid, optional>", "profile": "<required hub product profile>" }`

Response (`POST /chat`, and the final `done` event of `POST /chat/stream`):
```json
{
  "answer": "The patient is currently on metformin [1] and lisinopril [2]...",
  "disclaimer": "AI-generated summary. Verify with the full chart.",
  "references": [
    { "index": 1, "resourceType": "order", "resourceUuid": "5946f880-b197-400b-9caa-a3c661d71165", "date": "2025-12-01" },
    { "index": 2, "resourceType": "order", "resourceUuid": "a8f5f167-4ee2-4d2a-94f9-3f3f86d2e9b6", "date": "2025-11-15" }
  ],
  "safetyWarnings": [],
  "session": "session-uuid",
  "messageId": "assistant-message-uuid"
}
```

`references[].resourceUuid` is the cited record's UUID (used to locate and highlight the chart row). `safetyWarnings` (each `{ type, drug, detail }`) is always present and empty unless the backend's optional drug-reference feature is enabled; the panel renders any entries as chips below the answer.

Product profiles emit this staged sequence:
`answer_done` (direct answer complete) → optional `answer_validation` (self-check result) →
`indepth_pending` → `indepth_done` or `indepth_error` → `done`. The hub does not token-stream the
answer or in-depth text; each content phase is delivered whole. See the
[backend README's streaming chat docs](https://github.com/openmrs/openmrs-module-chartsearchai#streaming-chat-sse) for the full event reference.

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
