# CivicFlow

**AI Paperwork Copilot for Older Adults**

CivicFlow helps older adults and caregivers complete high-stakes government forms by:
1. **Scanning** mailed notices via webcam
2. **Extracting** deadlines and requirements using Gemini 2.5 Flash AI
3. **Navigating** government portals automatically through intelligent screenshot-based actions
4. **Guiding** users step-by-step through complex paperwork workflows

## How It Works

1. User holds a government notice (benefits renewal, housing recertification, etc.) in front of their laptop webcam
2. Gemini AI analyzes the image and extracts: document type, deadline, reference numbers, and required information
3. CivicFlow opens the relevant government portal and uses AI vision to navigate the forms
4. The system fills out forms automatically, shows progress to the user, and completes the submission

## Technical Architecture

### Components
- **Frontend** (React + Vite) - Webcam capture, notice display, progress tracking
- **Backend API** (FastAPI) - Orchestrates AI and browser automation
- **Browser Worker** (Playwright) - Executes safe navigation actions
- **Demo Portal** (FastAPI + Jinja2) - Simulated government benefits portal

### AI Technology
- **Gemini 2.5 Flash** (Google Vertex AI) for vision and planning
- **Screenshot-based navigation** - AI sees the page and decides next action
- **Safe action schema** - Only predefined actions allowed (click, type, scroll, wait)
- **Robust error handling** - Intelligently waits when information is missing

### Cloud Infrastructure
- **Google Cloud Platform**
- **Firestore** - Session storage
- **Cloud Storage** - Notice images and screenshots
- **Vertex AI** - Gemini API access

## Setup & Run

### Prerequisites
- Python 3.13+
- Node.js 18+
- GCP account with Vertex AI enabled (for production mode)

### Quick Start

1. **Install dependencies:**
```bash
# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install Python packages
pip install -r backend/requirements.txt -r browser_worker/requirements.txt -r demo_portal/requirements.txt

# Install Playwright browser
playwright install chromium

# Install frontend dependencies
cd frontend && npm install && cd ..
```

2. **Configure GCP (for production mode):**
```bash
# Add your GCP credentials file to project root
cp path/to/your/gcp-credentials.json ./gcp-credentials.json

# Ensure Live API uses a Live-capable model + supported region
# .env defaults:
# CIVICFLOW_GEMINI_LIVE_MODEL=gemini-live-2.5-flash-native-audio
# CIVICFLOW_GEMINI_LIVE_LOCATION=us-east4
```

3. **Run the application:**

**Terminal 1 - Backend services:**
```bash
source .venv/bin/activate
cd backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Terminal 2 - Browser worker:**
```bash
source .venv/bin/activate
cd browser_worker
# Optional for local manual takeover:
# export CIVICFLOW_BROWSER_HEADLESS=false
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

**Terminal 3 - Demo portal:**
```bash
source .venv/bin/activate
cd demo_portal
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8002
```

**Terminal 4 - Frontend:**
```bash
cd frontend
npm run dev
```

4. **Open the app:**
```
http://localhost:5173
```

### Testing the Flow

1. Upload any image with text (or use webcam to capture a notice)
2. Click "Start Guided Help" to begin automated navigation
3. If a sensitive field appears, the app pauses and asks for user input
4. Use "Take Manual Control" when you want to fill parts yourself, then return to assistant mode

## Project Structure

```
civic_flow/
├── backend/              # FastAPI orchestrator
│   ├── app/
│   │   ├── services/     # Gemini AI, Firestore, Storage
│   │   ├── routers/      # API endpoints
│   │   └── models/       # Pydantic schemas
│   └── requirements.txt
├── browser_worker/       # Playwright automation
│   └── app/main.py       # Browser control logic
├── demo_portal/          # Simulated government site
│   └── app/
│       ├── templates/    # HTML forms
│       └── main.py
├── frontend/             # React user interface
│   └── src/
│       ├── components/   # UI components
│       └── lib/          # API client
└── .env                  # Configuration
```

## API Endpoints

- `POST /intake/notice` - Upload and analyze notice image
- `POST /session/{id}/start` - Begin automated navigation
- `POST /session/{id}/step` - Execute next navigation step
- `POST /session/{id}/provide-input` - Submit user-provided field value and resume
- `POST /session/{id}/control-mode` - Switch between assistant and manual control
- `GET /session/{id}/status` - Get current progress
- `GET /health` - Health check

## Current Status

✅ **Fully functional end-to-end demo**
- Real Gemini 2.5 Flash AI integration (no mocks)
- Webcam notice capture working
- **Intelligent agent** - Adapts to any government website, not just demo portal
- Automated portal navigation with context-aware decisions
- **Real-time conversational voice AI** - Uses Gemini Live API with native audio
  - Always-on microphone streaming (hands-free)
  - AI listens and responds in natural conversation
  - Proactively asks for missing information
  - Guides users through each step with encouragement
- **Anti-doom-scrolling logic** - Prevents getting stuck on information pages
- Intelligent error handling (waits when info is missing)
- Real website support - Extracts portal URLs from notices
- Successfully completes government form workflows

## Future Enhancements

- Enhanced accessibility features (WCAG AAA compliance, adjustable font sizes)
- Multi-language support (Spanish, Chinese, Vietnamese)
- Mobile app version for on-the-go scanning
- Cloud Run production deployment with auto-scaling

## Built With

- **AI**: Google Gemini 2.5 Flash (Vertex AI)
- **Backend**: FastAPI, Python 3.13
- **Frontend**: React, TypeScript, Vite
- **Automation**: Playwright
- **Cloud**: Google Cloud Platform (Firestore, Cloud Storage, Vertex AI)
- **Infrastructure**: Docker-ready for Cloud Run deployment

---

**Built for hackathon - March 2026**
