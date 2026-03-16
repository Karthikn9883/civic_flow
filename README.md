# CivicFlow

CivicFlow is an AI paperwork copilot for older adults and caregivers.

It takes a mailed notice image from a laptop webcam, extracts the deadline + required steps, then guides a controlled benefits-style portal using screenshot-based UI navigation actions.

## Implemented MVP (local development phase)

- Webcam capture and image upload fallback in a React frontend.
- `POST /intake/notice` in FastAPI for notice intake.
- Notice extraction service with `mock` mode (default) and `vertex` integration points.
- Session state persistence with checklist and action logs.
- Controlled demo portal with full renewal flow:
  - Start
  - Identity verification
  - Address confirmation
  - Review
  - Confirmation
- Playwright browser worker with safe command schema:
  - `start_session`
  - `goto`
  - `screenshot`
  - `click_by_text`
  - `type_into_label`
  - `select_dropdown`
  - `scroll_down`
  - `wait`
  - `close_session`
- Screenshot -> planner -> action execution loop through:
  - `POST /session/{id}/start`
  - `POST /session/{id}/step`
  - `GET /session/{id}/status`

## Repo structure

```text
backend/         FastAPI orchestrator
browser_worker/  FastAPI Playwright worker
demo_portal/     Controlled benefits-style portal
frontend/        React + Vite dashboard
```

## Architecture diagram

```mermaid
flowchart LR
    U[User on Laptop<br/>Web App + Webcam + Mic] --> FE[Frontend<br/>React + Vite]

    FE -->|Capture notice image| API[FastAPI Orchestrator]
    FE -->|User intent / optional voice text| API

    API -->|Store notice/sessions (local MVP)| STORE[Local JSON Store]
    API -->|Analyze notice image| GEM[Gemini Service Layer<br/>mock or Vertex]
    GEM -->|Notice type, deadline, summary, required fields| API

    API -->|Start browser session| BW[Browser Worker<br/>Playwright]
    BW --> PORTAL[Controlled Demo Portal]

    BW -->|Screenshot + state| API
    API -->|UI reasoning request| GEM
    GEM -->|Structured action JSON| API
    API -->|Validated action| BW

    API -->|Progress updates| FE
```

## Environment setup

1. Create and activate a virtual environment (required for Python commands):

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2. Install Python dependencies:

```bash
pip install -r backend/requirements.txt -r browser_worker/requirements.txt -r demo_portal/requirements.txt
```

3. Install Playwright Chromium:

```bash
playwright install chromium
```

4. Install frontend dependencies:

```bash
cd frontend
npm install
cd ..
```

5. Configure env vars (optional now, required for Vertex mode later):

```bash
cp .env.example .env
```

## Run locally

Use two terminals (recommended).

Terminal 1: backend stack (demo portal + browser worker + API orchestrator)

```bash
./scripts/run-backend-dev.sh
```

Terminal 2: frontend

```bash
cd frontend
npm run dev -- --host 0.0.0.0 --port 5173
```

Open `http://localhost:5173`.

Alternative manual mode (4 terminals) is still available if you want to run each backend service separately for debugging.

## API endpoints

- `POST /intake/notice`
- `GET /session/{id}`
- `POST /session/{id}/start`
- `POST /session/{id}/step`
- `GET /session/{id}/status`
- `GET /health`

## Gemini integration notes

`CIVICFLOW_GEMINI_MODE=mock` is the default and was used for local validation.

`CIVICFLOW_GEMINI_MODE=vertex` path is scaffolded in `backend/app/services/gemini_service.py` and can be completed with your Cloud/Vertex setup.

## Validation run completed

Completed local smoke test successfully:

- Intake worked.
- Session started.
- Planner loop navigated the portal.
- Submission reached confirmation in 8 steps.
