# CivicFlow Agent Orchestrator

**Node.js/TypeScript agent with Google GenAI SDK**

## What It Does

This is the brain of CivicFlow - it coordinates:
- **Voice Agent** (Gemini Live API) - Real-time conversation
- **Vision Agent** (Gemini 2.5 Flash) - Screenshot analysis
- **Command Routing** - Maps voice commands to actions

## Architecture

```
┌─────────────────────────────────────────┐
│         Voice Agent                     │
│  • Listens to user                      │
│  • Routes commands                      │
│  • Announces status                     │
└────────────┬────────────────────────────┘
             │
             ↓
┌────────────────────────────────────────┐
│       Coordinator                      │
│  • Voice ↔ Vision handoff              │
│  • Session management                  │
│  • Error recovery                      │
└────────────┬───────────────────────────┘
             │
             ↓
┌────────────────────────────────────────┐
│         Vision Agent                   │
│  • Analyzes screenshots                │
│  • Plans actions                       │
│  • Detects when stuck                  │
└────────────────────────────────────────┘
```

## Setup

### 1. Get Gemini API Key

Go to https://aistudio.google.com/app/apikey and create an API key.

### 2. Configure .env

Copy the root `.env` and add your API key:

```bash
GOOGLE_API_KEY=AIzaSy...your-key-here
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run

```bash
# Development mode (hot reload)
npm run dev

# Production mode
npm run build
npm start
```

## API Endpoints

### HTTP API (port 8000)

- `GET /health` - Health check
- `POST /intake/notice` - Extract notice from image
- `POST /session/:id/start` - Start navigation
- `POST /session/:id/step` - Execute navigation step
- `GET /session/:id/status` - Get session status

### WebSocket API (ws://localhost:8000/voice/ws)

- `type: start_session` - Start voice session
- `type: audio` - Send audio chunk
- `type: ping` - Keep-alive

**Receive:**
- `type: status` - Agent status update
- `type: transcript` - Voice transcript
- `type: audio` - Voice response audio

## Voice Commands

The agent understands:

- **"I want to buy groceries"** → Opens Instacart
- **"I need to file taxes"** → Opens IRS
- **"Renew my benefits"** → Opens Benefits.gov
- **"Add milk, bread, and eggs"** → Adds items to list
- **"Checkout"** → Starts checkout process
- **"Take control"** → Switches to manual mode

## Example Flow

```
1. User: "I want to buy groceries"
   → Voice Agent: "Opening Instacart now..."
   → Vision Agent: Navigates to instacart.com

2. Voice Agent: "What items would you like?"
   User: "Milk, bread, and eggs"
   → Voice Agent: "Got it! Adding those to your list"

3. Vision Agent: Searches for each item, adds to cart
   → Voice Agent: "I've added all 3 items. Ready to checkout?"

4. User: "Yes"
   → Vision Agent: Clicks checkout
   → Voice Agent: "I see a payment page. Please take over"

5. User takes manual control, enters payment

6. User: "Return to agent"
   → Vision Agent: Completes order
   → Voice Agent: "Order completed! ✅"
```

## Technology

- **@google/genai** - Official Google Generative AI SDK
- **Express** - HTTP server
- **ws** - WebSocket server
- **TypeScript** - Type safety

## Why This Design?

1. **API Key Mode** - Simpler than Vertex AI, works everywhere
2. **Node.js** - Better WebSocket support than Python
3. **Event-Driven** - Clean separation of voice/vision agents
4. **Real-Time** - Gemini Live API for instant voice responses
5. **Multimodal** - Voice IN/OUT + Vision IN = True Agent

## Next Steps

See the main README for full setup instructions including:
- Browser Worker (Playwright + noVNC)
- Frontend (React + Voice UI)
