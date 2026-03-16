# CivicFlow

**AI-powered voice and vision agent for navigating websites through natural conversation.**

Built for the Google AI Hackathon using Gemini Live for voice and Gemini 2.5 Flash for screenshot-based action planning.

## What It Does

CivicFlow lets a user speak naturally while an agent:

1. Listens to the request through Gemini Live
2. Opens a website in a remote Playwright browser
3. Looks at screenshots of that browser
4. Decides the next UI action without using site APIs or DOM automation logic
5. Reports progress back through voice plus a visible browser panel in the UI

The current frontend shows the remote browser **visually through streamed screenshots**, not through a native desktop browser window. That is the current deployment model and the one prepared for Cloud Run.

## Current Architecture

The repo currently contains **four services**:

- `frontend` - React + Vite UI with voice orb, browser screenshot panel, and activity log
- `agent` - Node.js / TypeScript service for Gemini Live voice, vision loop orchestration, HTTP APIs, and `/voice/ws`
- `browser_worker` - FastAPI + Playwright service that executes browser actions and returns screenshots
- `backend` - FastAPI orchestration API for notice intake and guided form sessions

### Runtime Shape

```text
Frontend (React)
  -> WebSocket -> Agent (/voice/ws)
  -> HTTP      -> Agent (/session/:id/step)
  -> HTTP      -> Browser Worker (/command)

Agent (Node.js)
  -> Gemini Live API
  -> Gemini 2.5 Flash
  -> Browser Worker (/command)

Backend (FastAPI)
  -> Browser Worker (/session/command)
  -> Gemini service for notice parsing and planning
```

### Important Note

For the current voice demo path, the frontend is primarily wired to the `agent` and `browser_worker` services. The `backend` service is still part of the repo and deployable, but it is not the primary path used by the current voice-first UI.

## How The Agent Works

### Voice Loop

- Browser microphone audio is streamed to Gemini Live over WebSocket
- Gemini Live produces streaming audio + transcription back to the frontend
- Gemini Live can call the `navigate_to_website` tool
- The agent then starts the screenshot-based navigation loop

### Vision Loop

For each step, the agent:

1. Requests a screenshot from `browser_worker`
2. Sends the screenshot and task context to Gemini 2.5 Flash
3. Receives a structured action such as:
   - `click_by_text`
   - `type_into_label`
   - `scroll_down`
   - `wait`
   - `request_user_input`
   - `finish`
4. Executes the action through Playwright
5. Broadcasts the updated screenshot and status back to the frontend

The current browser worker does **not** implement `press_enter` or `press_escape`. The current action schema is the one defined in:

- [agent/src/types.ts](/c:/Users/pavan/civic_flow/agent/src/types.ts)
- [browser_worker/app/main.py](/c:/Users/pavan/civic_flow/browser_worker/app/main.py)

## Cloud Run Deployment Model

The current codebase is prepared to deploy as **four separate Cloud Run services**:

1. `civicflow-frontend`
2. `civicflow-agent`
3. `civicflow-browser-worker`
4. `civicflow-backend`

### Visibility Model

On Cloud Run, users do **not** see a native Chrome window from the server. Instead:

- Playwright runs headless inside `browser_worker`
- Screenshots are returned after actions
- The frontend displays those screenshots as the visible browser panel

This matches the current Docker and Cloud Run direction.

### Current Scaling Constraint

The repo still uses in-memory state in important places:

- `agent` keeps active loop/session state in memory
- `browser_worker` keeps browser sessions/global page state in memory
- `backend` uses in-memory session storage

Because of that, initial Cloud Run deployment should be conservative:

- keep `browser_worker` at `maxScale=1`
- keep `backend` at `maxScale=1`
- keep `agent` sticky and conservative as well

## Local Development

### Prerequisites

- Node.js 20+
- Python 3.13+ recommended for the Python services
- Docker Desktop for the containerized flow

## Local Run With Docker

This is the easiest way to run the current stack.

From the repo root:

```bash
docker compose up --build
```

Then open:

- Frontend: `http://localhost:5173`
- Agent health: `http://localhost:8000/health`
- Browser worker health: `http://localhost:8001/health`
- Backend health: `http://localhost:8002/health`

### Docker Mode Notes

- The Docker setup currently forces the `agent` into **API key mode** for easier local execution
- The browser worker runs with `CIVICFLOW_BROWSER_HEADLESS=true`
- The visible browser experience comes from screenshots rendered in the frontend

## Local Run Without Docker

### 1. Install dependencies

```bash
# Python deps
pip install -r backend/requirements.txt
pip install -r browser_worker/requirements.txt

# Node deps
cd agent && npm install
cd ../frontend && npm install
cd ..
```

### 2. Start services

Terminal 1:

```bash
cd browser_worker
python -m uvicorn app.main:app --host 0.0.0.0 --port 8001
```

Terminal 2:

```bash
cd agent
npm run dev
```

Terminal 3:

```bash
cd frontend
npm run dev
```

Optional Terminal 4:

```bash
cd backend
python -m uvicorn app.main:app --host 0.0.0.0 --port 8002
```

## Environment Variables

### Local Docker / API key mode

```bash
USE_VERTEX=false
GOOGLE_API_KEY=your-key
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-09-2025
GEMINI_VISION_MODEL=gemini-2.5-flash
VOICE_NAME=Puck
```

### Cloud Run / Vertex mode

```bash
USE_VERTEX=true
GCP_PROJECT=your-project-id
GCP_LOCATION=us-central1
GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
GEMINI_VISION_MODEL=gemini-2.5-flash
VOICE_NAME=Puck
```

### Frontend service URLs

The frontend now uses environment-driven endpoints rather than hardcoded localhost URLs:

```bash
VITE_AGENT_BASE_URL=http://localhost:8000
VITE_AGENT_WS_URL=ws://localhost:8000/voice/ws
VITE_BROWSER_WORKER_BASE_URL=http://localhost:8001
```

## Main Endpoints

### Agent

- `GET /health`
- `POST /session/:sessionId/step`
- `WS /voice/ws`

### Browser Worker

- `GET /health`
- `POST /command`
- `POST /session/command`

### Backend

- `GET /health`
- `POST /intake/notice`
- `GET /session/{session_id}`
- `POST /session/{session_id}/start`
- `POST /session/{session_id}/step`
- `POST /session/{session_id}/provide-input`
- `POST /session/{session_id}/control-mode`
- `GET /session/{session_id}/status`

## Project Structure

```text
civic_flow/
  frontend/         React UI
  agent/            Node.js agent orchestrator
  browser_worker/   FastAPI + Playwright browser executor
  backend/          FastAPI intake/navigation API
  compose.yaml      Local multi-service Docker setup
  .env              Local configuration
```

## Current Limitations

- Browser visibility is screenshot-based, not live desktop streaming
- The backend and browser worker still rely on in-memory state
- The current frontend mostly exercises the `agent` + `browser_worker` path
- Cloud Run deployment should start with conservative scaling before shared state is externalized

## Status

Current repo state:

- Local Docker build path is in place
- Frontend URLs are environment-driven
- Browser worker runs cleanly in headless container mode
- Agent voice session works in API key mode locally
- The repo is ready for Cloud Run service YAML generation next

---

Built for hackathon work in March 2026.
