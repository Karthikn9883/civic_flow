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

const PORT               = Number(process.env.PORT || process.env.AGENT_PORT || 8000);
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

const LIVE_MODEL   = process.env.GEMINI_LIVE_MODEL || 'gemini-live-2.5-flash-native-audio';
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
          description: 'Open websites and complete tasks. Accepts either {url, task} or {steps:[{url, task}, ...]}.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              url: {
                type: Type.STRING,
                description: 'Single-step URL, e.g. https://www.instacart.com',
              },
              task: {
                type: Type.STRING,
                description: 'Single-step task for the URL',
              },
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
            required: [],
          },
        },
      ],
    },
  ],
  systemInstruction: `You are CivicFlow, a conversational web navigation assistant. You complete real tasks on live websites using the browser tool, and you maintain awareness of the user’s overall goal throughout the conversation.

OPERATING RULES

1. Tool usage
- For any task that requires navigating, searching, clicking, or filling on a website, call navigate_to_website.
- Do not describe what the user should do — do it yourself.

2. BATCH multi-item requests into ONE tool call
- If the user wants multiple things (e.g., “add tomatoes and eggs”), describe the FULL workflow for ALL items in a single task string.
- Do NOT call the tool once per item. One call handles everything.
- Example multi-item task: “type ‘tomatoes’ in the search bar, press Enter, add exactly 1 unit of the cheapest option, then type ‘eggs’ in the search bar, press Enter, add exactly 2 units of the same egg product, stop before checkout”

3. Task-writing rules — write for a visual agent that executes literally
- State the current page context (e.g., “on the Costco store page on Instacart”)
- For search: always say “type X into the search bar and press Enter” — never “click the suggestion”
- For quantities: always say “add exactly N units”. If N=1: click Add once. If N=2: click Add once, then click ‘+’ once to increment to 2.
- For cart adds: “click Add on exactly ONE product (the cheapest/most relevant) — do NOT add multiple different products”
- Include the stopping point explicitly (e.g., “stop before checkout”)
- Never write vague tasks like “handle this” or “help with checkout”

4. Safe stopping boundaries
- Stop before payment, irreversible submission, or legal commitment unless user explicitly authorized.
- Never invent personal, payment, or identity details.

5. Ambiguity handling
- Low-risk choices (which brand): pick cheapest/most common.
- High-risk choices (price, identity, timing): stop and ask the user.

6. Truthfulness
- Never say a task succeeded before receiving [Vision result: completed — ...].
- Relay the exact result from [Vision result:] to the user.

7. Conversational flow — CRITICAL
- You have full conversation memory. Use it.
- Keep a mental list of what the user wants done and what has been completed.
- After each [Vision result: completed]: tell the user in 1 sentence what was done.
- After ALL requested items are completed: summarize what was accomplished, then ask “What would you like to do next?” and stay IDLE.
- If the user says “also add X”: you already know the current store/page — include it in the task context, do not re-navigate unnecessarily.
- Do NOT call navigate_to_website again after completing a task unless the user gives a new instruction.
- Be warm and clear. Speak simply — you’re helping older adults.

8. Response style
- After calling the tool: say ONLY “On it.” Nothing more.
- After [Vision result: completed]: 1 sentence summary + ask what’s next.
- After [Vision result: needs_input]: explain the blocker and ask the user.
- After [Vision result: stopped]: explain briefly, ask if they want to retry.

TOOL ARGUMENT FORMAT

{“url”:”https://example.com”,”task”:”<complete precise workflow>”}

SHOPPING TASK EXAMPLES

Add 1 item from current page:
{“url”:”https://www.instacart.com”,”task”:”on the current Costco page, type ‘tomatoes’ into the search bar and press Enter, wait for results, click Add on exactly ONE product (cheapest fresh option), confirm cart count increased, stop — do not go to checkout”}

Add multiple items in one shot:
{“url”:”https://www.instacart.com”,”task”:”on the current Costco page: step 1 — type ‘tomatoes’ in search bar, press Enter, add exactly 1 unit of the cheapest option (click Add once, stop adding tomatoes as soon as cart shows 1); step 2 — type ‘eggs’ in the same search bar, press Enter, add exactly 2 units of the same egg product (click Add once to get qty 1, then click + once to get qty 2); stop before checkout”}

Add 2 units of one product:
{“url”:”https://www.instacart.com”,”task”:”search for eggs, press Enter, find a standard egg product, click Add (this adds 1 unit), wait for the quantity control to appear, click + once to increment to 2 units total, stop”}`,
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

const MAX_STEPS = 40;
const MIN_STEP_INTERVAL_MS = 2500;

// Loop lock — only one vision loop runs at a time; cancel by bumping this id
let activeLoopId: string | null = null;
let lastMalformedRetryMs = 0;

interface LoopResult {
  outcome: 'completed' | 'needs_input' | 'stopped' | 'superseded';
  reason: string;
  url: string;
}

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

async function runVisionLoop(startUrl: string, task: string): Promise<LoopResult> {
  // Cancel any running loop and claim ownership
  const myLoopId = uuidv4();
  activeLoopId = myLoopId;
  const sessionId = myLoopId;

  console.log(`[Vision] Starting auto-loop [${myLoopId.slice(0, 6)}] for task: ${task}`);
  broadcast({ type: 'visionStatus', status: 'running', task });

  let currentUrl = startUrl;

  try {
    // ── Phase 1: plan the task from the initial screenshot ─────────────────
    try {
      const initRes = await fetch(`${BROWSER_WORKER_URL}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'screenshot' }),
      });
      const initData = await initRes.json() as { screenshot?: string; url?: string };
      if (initData.screenshot) {
        if (initData.url) currentUrl = initData.url;
        broadcast({ type: 'screenshot', screenshot: initData.screenshot, url: currentUrl });
        await visionAgent.planTask(sessionId, initData.screenshot, currentUrl, task);
      }
    } catch (e) {
      console.warn('[Vision] Pre-loop planning failed (continuing without plan):', e);
    }

    // Check if superseded while planning
    if (activeLoopId !== myLoopId) {
      console.log(`[Vision] Loop [${myLoopId.slice(0, 6)}] superseded during planning`);
      return { outcome: 'superseded', reason: 'A newer task took over', url: currentUrl };
    }

    // ── Phase 2: execute actions toward the plan ───────────────────────────
    for (let step = 0; step < MAX_STEPS; step++) {
      if (activeLoopId !== myLoopId) {
        console.log(`[Vision] Loop [${myLoopId.slice(0, 6)}] superseded — stopping`);
        return { outcome: 'superseded', reason: 'A newer task took over', url: currentUrl };
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
      if (bwData.url) currentUrl = bwData.url;

      broadcast({ type: 'screenshot', screenshot: bwData.screenshot, url: currentUrl });

      // Ask vision agent what to do (with retry on any error)
      let action;
      let retries = 0;
      while (retries < 3) {
        try {
          action = await visionAgent.planAction(sessionId, bwData.screenshot, currentUrl, task);
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
            const waitMs = parseRetryDelay(e);
            console.warn(`[Vision] Rate limited — waiting ${waitMs / 1000}s before retry`);
            broadcast({ type: 'visionStatus', status: 'rate_limited', waitSeconds: Math.ceil(waitMs / 1000) });
            await new Promise(r => setTimeout(r, waitMs));
          } else {
            const backoffMs = (retries + 1) * 5000;
            console.warn(`[Vision] API error (retry ${retries + 1}/3 in ${backoffMs / 1000}s): ${msg.slice(0, 120)}`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
          retries++;
        }
      }

      if (!action) {
        broadcast({ type: 'visionStatus', status: 'stopped', reason: 'Too many retries' });
        return { outcome: 'stopped', reason: 'Too many API retries', url: currentUrl };
      }

      if (activeLoopId !== myLoopId) {
        return { outcome: 'superseded', reason: 'A newer task took over', url: currentUrl };
      }

      console.log(`[Vision] Step ${step + 1}: ${action.action} — ${action.reason}`);
      broadcast({ type: 'visionStep', step: step + 1, action: action.action, reason: action.reason, observation: action.observation });

      if (action.action === 'finish') {
        console.log('[Vision] Task complete');
        broadcast({ type: 'visionStatus', status: 'complete', reason: action.reason });
        return { outcome: 'completed', reason: action.reason, url: currentUrl };
      }

      if (action.action === 'request_user_input') {
        console.log('[Vision] Needs user input:', action.reason);
        broadcast({ type: 'visionStatus', status: 'needs_input', reason: action.reason });
        return { outcome: 'needs_input', reason: action.reason, url: currentUrl };
      }

      // Execute the action
      try {
        const execRes = await fetch(`${BROWSER_WORKER_URL}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: action.action,
            params: { text: action.targetText, value: action.inputValue },
          }),
        });
        const execData = await execRes.json() as { success?: boolean; error?: string; screenshot?: string; url?: string };
        visionAgent.markLastActionResult(sessionId, execData.success !== false);
        if (!execData.success) {
          console.warn(`[Vision] Action ${action.action} failed: ${execData.error}`);
        }
        if (execData.screenshot) {
          if (execData.url) currentUrl = execData.url;
          broadcast({ type: 'screenshot', screenshot: execData.screenshot, url: currentUrl });
        }
      } catch (e) {
        console.error('[Vision] Action execution failed:', e);
        visionAgent.markLastActionResult(sessionId, false);
      }

      const elapsed = Date.now() - stepStart;
      if (elapsed < MIN_STEP_INTERVAL_MS) {
        await new Promise(r => setTimeout(r, MIN_STEP_INTERVAL_MS - elapsed));
      }

      if (activeLoopId !== myLoopId) {
        return { outcome: 'superseded', reason: 'A newer task took over', url: currentUrl };
      }
    }

    broadcast({ type: 'visionStatus', status: 'stopped', reason: 'Max steps reached' });
    return { outcome: 'stopped', reason: 'Maximum steps reached without completing the task', url: currentUrl };

  } finally {
    visionAgent.clearHistory(sessionId);
  }
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

        const turnReason = message.serverContent?.turnCompleteReason;
        if (turnReason === 'MALFORMED_FUNCTION_CALL') {
          console.warn('[Live] Model produced malformed function call; asking it to retry with valid args');
          const now = Date.now();
          if (now - lastMalformedRetryMs > 2500) {
            lastMalformedRetryMs = now;
            session.sendClientContent({
              turns: [{
                role: 'user',
                parts: [{
                  text: 'Retry now with a valid navigate_to_website function call. Use either {"url":"https://...","task":"..."} or {"steps":[{"url":"https://...","task":"..."}]}.',
                }],
              }],
              turnComplete: true,
            });
          }
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
              const args = (call.args ?? {}) as {
                steps?: Array<{ url?: string; task?: string }>;
                url?: string;
                task?: string;
              };

              const steps = (Array.isArray(args.steps) ? args.steps : [])
                .map((s) => ({ url: (s.url ?? '').trim(), task: (s.task ?? '').trim() }))
                .filter((s) => s.url && s.task);

              if (!steps.length && args.url?.trim() && args.task?.trim()) {
                steps.push({ url: args.url.trim(), task: args.task.trim() });
              }

              if (!steps.length) {
                console.warn('[Live] navigate_to_website called without valid args:', call.args);
                session.sendToolResponse({
                  functionResponses: [
                    {
                      id: call.id!,
                      name: call.name,
                      response: {
                        success: false,
                        error: 'Missing required args. Provide either {url, task} or {steps:[{url, task}]}.',
                      },
                    },
                  ],
                });
                continue;
              }

              console.log(`[Live] navigate_to_website called with ${steps.length} step(s):`, steps.map(s => s.url));
              broadcast({ type: 'agentNavigated', url: steps[0].url, task: steps[0].task });

              // Respond immediately so Gemini speaks ("On it — opening that now")
              session.sendToolResponse({
                functionResponses: [{ id: call.id!, name: call.name, response: { success: true, steps: steps.length } }],
              });

              // Execute steps sequentially (fire-and-forget)
              (async () => {
                for (const step of steps) {
                  const myLoopSnapshot = activeLoopId;
                  try {
                    // Get current browser state
                    let currentUrl = step.url;
                    try {
                      const stateRes = await fetch(`${BROWSER_WORKER_URL}/command`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ command: 'screenshot' }),
                      });
                      const stateData = await stateRes.json() as { screenshot?: string; url?: string };
                      if (stateData.url) currentUrl = stateData.url;
                    } catch {}

                    // Smart navigation: skip if already on the same domain
                    const currentHost = (() => { try { return new URL(currentUrl).hostname; } catch { return ''; } })();
                    const targetHost = (() => { try { return new URL(step.url).hostname; } catch { return ''; } })();
                    const needsNav = !currentHost || currentHost !== targetHost;

                    if (needsNav) {
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
                      currentUrl = navData.url || step.url;
                    } else {
                      console.log(`[Live] Already on ${currentHost} — skipping navigation, starting vision from ${currentUrl}`);
                      broadcast({ type: 'agentNavigated', url: currentUrl, task: step.task });
                    }

                    const result = await runVisionLoop(currentUrl, step.task);

                    // Feed actual result back to Live so it can accurately tell the user
                    if (result.outcome !== 'superseded' && liveSession) {
                      let feedbackMsg: string;
                      if (result.outcome === 'completed') {
                        feedbackMsg = `[Vision result: completed — ${result.reason}]`;
                      } else if (result.outcome === 'needs_input') {
                        feedbackMsg = `[Vision result: needs_input — ${result.reason}]`;
                      } else {
                        feedbackMsg = `[Vision result: stopped — ${result.reason}]`;
                      }
                      try {
                        liveSession.sendClientContent({
                          turns: [{ role: 'user', parts: [{ text: feedbackMsg }] }],
                          turnComplete: true,
                        });
                      } catch (e) {
                        console.warn('[Live] Could not send vision result:', e);
                      }
                    }

                    if (result.outcome === 'superseded' || (activeLoopId !== myLoopSnapshot && steps.indexOf(step) < steps.length - 1)) {
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
