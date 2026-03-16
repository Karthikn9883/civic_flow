/**
 * CivicFlow Agent Server
 * - Live API:   Vertex AI  (gemini-live-2.5-flash-preview, us-central1)
 * - Vision API: Vertex AI  (gemini-2.5-flash screenshot analysis)
 * - WebSocket:  Real-time audio streaming to/from browser
 */

import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import type { GoogleGenAIOptions, LiveConnectConfig, LiveServerMessage, Blob as GenAIBlob } from '@google/genai';
import { VisionAgent } from './vision-agent.js';
import type { AgentConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });

const PORT               = Number(process.env.AGENT_PORT || 8000);
const GOOGLE_API_KEY     = process.env.GOOGLE_API_KEY;
const GCP_PROJECT        = process.env.GCP_PROJECT;
const GCP_LOCATION       = process.env.GCP_LOCATION || 'us-central1';
const BROWSER_WORKER_URL = process.env.BROWSER_WORKER_URL || 'http://localhost:8001';
const USE_VERTEX         = process.env.USE_VERTEX === 'true';

if (USE_VERTEX && !GCP_PROJECT) {
  console.error('ERROR: GCP_PROJECT is required in .env when USE_VERTEX=true');
  process.exit(1);
}

if (!USE_VERTEX && !GOOGLE_API_KEY) {
  console.error('ERROR: GOOGLE_API_KEY is required in .env when USE_VERTEX=false');
  process.exit(1);
}

// ── Gemini client ──────────────────────────────────────────────────────────────
const liveAi = USE_VERTEX
  ? new GoogleGenAI({
      vertexai: true,
      project: GCP_PROJECT,
      location: GCP_LOCATION,
    } as GoogleGenAIOptions)
  : new GoogleGenAI({
      vertexai: false,
      apiKey: GOOGLE_API_KEY,
    } as GoogleGenAIOptions);

const LIVE_MODEL   = process.env.GEMINI_LIVE_MODEL || (USE_VERTEX ? 'gemini-live-2.5-flash-native-audio' : 'gemini-2.5-flash-native-audio-preview-09-2025');
const VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
const VOICE_NAME   = process.env.VOICE_NAME || 'Puck';

// ── Live session config (matches official Google notebook) ───────────────────

const liveConfig: LiveConnectConfig = {
  responseModalities: [Modality.AUDIO],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  speechConfig: {
    voiceConfig: {
      prebuiltVoiceConfig: { voiceName: VOICE_NAME },
    },
  },
  tools: [
    {
      functionDeclarations: [
        {
          name: 'navigate_to_website',
          description: 'Open one or more websites in the browser and complete tasks for the user. Supports multi-step plans across multiple sites.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              steps: {
                type: Type.ARRAY,
                description: 'Ordered list of navigation steps. Each step is one website + task.',
                items: {
                  type: Type.OBJECT,
                  properties: {
                    url:  { type: Type.STRING, description: 'Full URL, e.g. https://www.amazon.com' },
                    task: { type: Type.STRING, description: 'What to accomplish on this site' },
                  },
                  required: ['url', 'task'],
                },
              },
            },
            required: ['steps'],
          },
        },
      ],
    },
  ],
  systemInstruction: `You are CivicFlow, a powerful AI agent that navigates ANY website and completes real tasks for the user.

CRITICAL: You MUST call navigate_to_website for ANY web request. You take real action — never say you can only guide.

The steps array lets you plan multi-site workflows in one call:
- "order tomatoes from Costco on Instacart" → steps: [{url: "https://www.instacart.com", task: "find Costco store and add tomatoes to cart"}]
- "file taxes then check my Medicare" → steps: [{url: "https://www.irs.gov", task: "help file taxes"}, {url: "https://www.medicare.gov", task: "check Medicare status"}]
- "go to amazon and order milk" → steps: [{url: "https://www.amazon.com", task: "search for milk and add to cart"}]

Rules:
1. ALWAYS call navigate_to_website — never refuse or say you can only guide
2. After calling, say "On it — opening that now"
3. Keep responses SHORT
4. For multi-step requests, list all steps in one call`,
};

// ── Vision agent (screenshot navigation) ────────────────────────────────────

const agentConfig: AgentConfig = {
  googleApiKey: GOOGLE_API_KEY,
  useVertex: USE_VERTEX,
  gcpProject: GCP_PROJECT,
  gcpLocation: GCP_LOCATION,
  visionModel: VISION_MODEL,
  liveModel: LIVE_MODEL,
  voiceName: VOICE_NAME,
  enableGoogleSearch: true,
  browserWorkerUrl: BROWSER_WORKER_URL,
};

const visionAgent = new VisionAgent(agentConfig);

// ── WebSocket clients ────────────────────────────────────────────────────────

const clients = new Set<WebSocket>();

function broadcast(payload: object) {
  const data = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

// ── Vision navigation loop ───────────────────────────────────────────────────

const MAX_STEPS = 25;
const MIN_STEP_INTERVAL_MS = 2000;

// Loop lock — only one vision loop runs at a time; cancel by bumping this id
let activeLoopId: string | null = null;

function parseRetryDelay(error: unknown): number {
  try {
    const msg = error instanceof Error ? error.message : String(error);
    const parsed = JSON.parse(msg);
    const retryDelay = parsed?.error?.details?.find((d: any) => d['@type']?.includes('RetryInfo'))?.retryDelay;
    if (retryDelay) {
      const seconds = parseInt(retryDelay.replace('s', ''), 10);
      return isNaN(seconds) ? 60000 : (seconds + 2) * 1000;
    }
  } catch { /* ignore parse errors */ }
  return 60000; // default 60s
}

async function runVisionLoop(startUrl: string, task: string): Promise<void> {
  // Cancel any running loop and claim ownership
  const myLoopId = uuidv4();
  activeLoopId = myLoopId;
  // Each loop gets its own session ID so history never bleeds across loops
  const sessionId = myLoopId;

  console.log(`[Vision] Starting auto-loop [${myLoopId.slice(0, 6)}] for task: ${task}`);
  broadcast({ type: 'visionStatus', status: 'running', task });

  for (let step = 0; step < MAX_STEPS; step++) {
    // Stop if a newer loop has taken over
    if (activeLoopId !== myLoopId) {
      console.log(`[Vision] Loop [${myLoopId.slice(0, 6)}] superseded — stopping`);
      return;
    }

    const stepStart = Date.now();

    // Take screenshot
    let bwData: { screenshot?: string; url?: string };
    try {
      const r = await fetch(`${BROWSER_WORKER_URL}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'screenshot' }),
      });
      bwData = await r.json() as { screenshot?: string; url?: string };
    } catch (e) {
      console.error('[Vision] Screenshot failed:', e);
      break;
    }

    if (!bwData.screenshot) break;

    // Broadcast live screenshot to frontend
    broadcast({ type: 'screenshot', screenshot: bwData.screenshot, url: bwData.url || startUrl });

    // Ask vision agent what to do (with retry on 429)
    let action;
    let retries = 0;
    while (retries < 3) {
      try {
        action = await visionAgent.planAction(sessionId, bwData.screenshot, bwData.url || startUrl, task);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
          const waitMs = parseRetryDelay(e);
          console.warn(`[Vision] Rate limited — waiting ${waitMs / 1000}s before retry`);
          broadcast({ type: 'visionStatus', status: 'rate_limited', waitSeconds: Math.ceil(waitMs / 1000) });
          await new Promise(r => setTimeout(r, waitMs));
          retries++;
        } else {
          throw e;
        }
      }
    }

    if (!action) {
      broadcast({ type: 'visionStatus', status: 'stopped', reason: 'Too many rate limit retries' });
      return;
    }

    // Check again after the async planAction — a new loop may have started while waiting
    if (activeLoopId !== myLoopId) {
      console.log(`[Vision] Loop [${myLoopId.slice(0, 6)}] superseded after planning — discarding`);
      return;
    }

    console.log(`[Vision] Step ${step + 1}: ${action.action} — ${action.reason}`);
    broadcast({ type: 'visionStep', step: step + 1, action: action.action, reason: action.reason });

    if (action.action === 'finish') {
      console.log('[Vision] Task complete');
      broadcast({ type: 'visionStatus', status: 'complete', reason: action.reason });
      if (liveSession) {
        liveSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `The vision agent completed the task: "${task}". Briefly tell the user it's done.` }] }],
          turnComplete: true,
        });
      }
      return;
    }

    if (action.action === 'request_user_input') {
      console.log('[Vision] Needs user input:', action.reason);
      broadcast({ type: 'visionStatus', status: 'needs_input', reason: action.reason });
      if (liveSession) {
        liveSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `The vision agent needs help: ${action.reason}. Ask the user for this.` }] }],
          turnComplete: true,
        });
      }
      return;
    }

    // Execute the action
    try {
      await fetch(`${BROWSER_WORKER_URL}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: action.action,
          params: { text: action.targetText, value: action.inputValue },
        }),
      });
    } catch (e) {
      console.error('[Vision] Action execution failed:', e);
    }

    // Enforce minimum interval between steps to stay within rate limits
    const elapsed = Date.now() - stepStart;
    if (elapsed < MIN_STEP_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, MIN_STEP_INTERVAL_MS - elapsed));
    }

    // Check again after the wait in case a new loop started while we slept
    if (activeLoopId !== myLoopId) return;
  }

  broadcast({ type: 'visionStatus', status: 'stopped', reason: 'Max steps reached' });
}

// ── Gemini Live session (one shared session) ─────────────────────────────────

async function createLiveSession() {
  console.log(`[Live] Connecting to ${LIVE_MODEL}…`);

  const session = await liveAi.live.connect({
    model: LIVE_MODEL,
    config: liveConfig,
    callbacks: {
      onopen: () => {
        console.log('[Live] Session opened ✓');
      },

      onmessage: (message: LiveServerMessage) => {
        const msgStr = JSON.stringify(message);

        // Log non-audio messages (audio chunks are too large to print)
        if (!msgStr.includes('"data"')) {
          console.log('[Live] Message:', msgStr.slice(0, 400));
        }

        // User speech transcription
        const inputText = message.serverContent?.inputTranscription?.text;
        if (inputText) {
          console.log('[Live] User said:', inputText);
          broadcast({ type: 'userTranscript', data: inputText });
        }

        // Agent speech transcription
        const outputText = message.serverContent?.outputTranscription?.text;
        if (outputText) {
          console.log('[Live] Agent said:', outputText);
          broadcast({ type: 'textStream', data: outputText });
        }

        // Audio PCM chunks → forward to browser for playback (24 kHz)
        const parts = message.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            console.log('[Live] Audio chunk ✓ mimeType:', part.inlineData.mimeType, 'bytes:', part.inlineData.data.length);
            broadcast({ type: 'audioStream', data: part.inlineData.data });
          }
        }

        // Function call from voice agent → execute browser navigation
        if (message.toolCall?.functionCalls?.length) {
          for (const call of message.toolCall.functionCalls) {
            if (call.name === 'navigate_to_website') {
              const { steps } = call.args as { steps: Array<{ url: string; task: string }> };
              if (!steps?.length) continue;

              console.log(`[Live] navigate_to_website called with ${steps.length} step(s):`, steps.map(s => s.url));
              broadcast({ type: 'agentNavigated', url: steps[0].url, task: steps[0].task });

              // Respond immediately so Gemini speaks ("On it — opening that now")
              session.sendToolResponse({
                functionResponses: [{ id: call.id!, name: call.name, response: { success: true, steps: steps.length } }],
              });

              // Execute steps sequentially (fire-and-forget)
              (async () => {
                for (const step of steps) {
                  // Stop if superseded by a newer request mid-sequence
                  const myLoopSnapshot = activeLoopId;
                  try {
                    console.log(`[Live] Navigating to ${step.url}`);
                    broadcast({ type: 'agentNavigated', url: step.url, task: step.task });
                    const navRes = await fetch(`${BROWSER_WORKER_URL}/command`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ command: 'navigate', params: { url: step.url } }),
                    });
                    const navData = await navRes.json() as { screenshot?: string; url?: string };
                    if (navData.screenshot) {
                      broadcast({ type: 'screenshot', screenshot: navData.screenshot, url: navData.url || step.url });
                    }
                    await runVisionLoop(step.url, step.task);
                    // If the loop was superseded inside runVisionLoop, stop the sequence too
                    if (activeLoopId !== myLoopSnapshot && steps.indexOf(step) < steps.length - 1) {
                      console.log('[Live] Sequence cancelled by newer request');
                      break;
                    }
                  } catch (e) {
                    console.error(`[Live] Step failed for ${step.url}:`, e);
                  }
                }
              })();
            }
          }
        }
      },

      onerror: (e: { message?: string }) => {
        console.error('[Live] Error:', e.message);
        broadcast({ type: 'error', data: e.message });
      },

      onclose: (e: { reason?: string }) => {
        const reason = e.reason ?? '';
        console.warn('[Live] Session closed:', reason);

        // Don't reconnect on permanent errors (bad API key, API not enabled, quota)
        const permanent = [
          'API has not been used',
          'disabled',
          'PERMISSION_DENIED',
          'API_KEY_INVALID',
          'billing',
          'is not found for API version',
          'was not found',
          'not supported for bidi',
          'INVALID_ARGUMENT',
        ];
        if (permanent.some(p => reason.includes(p))) {
          console.error('[Live] Permanent error — fix the issue before restarting:\n ', reason);
          broadcast({ type: 'error', data: `Agent error: ${reason.slice(0, 120)}` });
          return;
        }

        // Transient close — reconnect with backoff
        const delay = Math.min(reconnectDelay, 30000);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        console.log(`[Live] Reconnecting in ${delay / 1000}s…`);
        setTimeout(() => {
          createLiveSession()
            .then(s => { liveSession = s; reconnectDelay = 3000; })
            .catch(console.error);
        }, delay);
      },
    },
  });

  // Session is confirmed open — send a greeting to verify the audio pipeline works
  try {
    session.sendClientContent({
      turns: [{ role: 'user', parts: [{ text: 'Hello! Please briefly introduce yourself.' }] }],
      turnComplete: true,
    });
    console.log('[Live] Greeting sent — waiting for audio response…');
  } catch (e) {
    console.warn('[Live] Greeting failed:', e);
  }

  return session;
}

let liveSession: Awaited<ReturnType<typeof createLiveSession>>;
let reconnectDelay = 3000;

// ── HTTP API ──────────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', model: LIVE_MODEL });
});

// Vision navigation step
app.post('/session/:sessionId/step', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const bwRes = await fetch(`${BROWSER_WORKER_URL}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'screenshot' }),
    });
    const bwData = await bwRes.json() as { screenshot?: string; url?: string };

    if (!bwData.screenshot) {
      return res.status(400).json({ error: 'No browser screenshot available' });
    }

    const action = await visionAgent.planAction(
      sessionId,
      bwData.screenshot,
      bwData.url || '',
      'Complete the current task on screen',
    );

    if (action.action !== 'finish' && action.action !== 'request_user_input') {
      await fetch(`${BROWSER_WORKER_URL}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: action.action,
          params: { text: action.targetText, value: action.inputValue },
        }),
      });
    }

    const afterRes = await fetch(`${BROWSER_WORKER_URL}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'screenshot' }),
    });
    const afterData = await afterRes.json() as { screenshot?: string; url?: string };

    res.json({
      action: action.action,
      reason: action.reason,
      screenshot: afterData.screenshot,
      url: afterData.url,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[API] Step error:', message);
    res.status(500).json({ error: message });
  }
});

// ── WebSocket server ──────────────────────────────────────────────────────────

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/voice/ws' });

wss.on('connection', (ws: WebSocket) => {
  const id = uuidv4().slice(0, 8);
  console.log(`[WS] Client connected: ${id}`);
  clients.add(ws);

  ws.send(JSON.stringify({ type: 'session_started' }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'realtimeInput' && msg.audioData) {
        // PCM16 audio from mic (16 kHz) → forward to Gemini Live
        if (!liveSession) return;
        const blob: GenAIBlob = { data: msg.audioData, mimeType: 'audio/pcm;rate=16000' };
        liveSession.sendRealtimeInput({ media: blob });

      } else if (msg.type === 'contentUpdateText' && msg.text) {
        // Text message from browser → forward to Gemini Live
        if (!liveSession) return;
        liveSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: msg.text }] }],
          turnComplete: true,
        });

      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (err) {
      console.error('[WS] Message error:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected: ${id}`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error for ${id}:`, err.message);
    clients.delete(ws);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  liveSession = await createLiveSession();

  httpServer.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  CivicFlow Agent Server');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  HTTP API:   http://localhost:${PORT}`);
    console.log(`  WebSocket:  ws://localhost:${PORT}/voice/ws`);
    if (USE_VERTEX) {
      console.log(`  Mode:       Vertex AI (project: ${GCP_PROJECT}, location: ${GCP_LOCATION})`);
    } else {
      console.log('  Mode:       Gemini API (API key)');
    }
    console.log(`  Live Model: ${LIVE_MODEL}`);
    console.log(`  Vision:     ${VISION_MODEL}`);
    console.log(`  Voice:      ${VOICE_NAME}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
