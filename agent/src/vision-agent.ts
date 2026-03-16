/**
 * Vision Agent - Gemini 2.5 Flash
 * Observation-first: describes what it sees on screen before deciding each action.
 */

import { GoogleGenAI } from '@google/genai';
import type { GoogleGenAIOptions } from '@google/genai';
import type { AgentConfig, NavigationAction } from './types.js';

interface HistoryEntry {
  step: number;
  action: string;
  targetText?: string;
  inputValue?: string;
  reason: string;
  observation?: string;
  url: string;
  success?: boolean;
}

export class VisionAgent {
  private client: GoogleGenAI;
  private config: AgentConfig;
  private sessionHistory = new Map<string, HistoryEntry[]>();
  private sessionPlans   = new Map<string, string[]>();

  constructor(config: AgentConfig) {
    this.config = config;
    if (config.useVertex) {
      if (!config.gcpProject) throw new Error('VisionAgent requires gcpProject when useVertex=true');
      this.client = new GoogleGenAI({
        vertexai: true,
        project: config.gcpProject,
        location: config.gcpLocation || 'us-central1',
      } as GoogleGenAIOptions);
      console.log('[VisionAgent] Initialized in Vertex AI mode');
    } else {
      if (!config.googleApiKey) throw new Error('VisionAgent requires googleApiKey when useVertex=false');
      this.client = new GoogleGenAI({
        vertexai: false,
        apiKey: config.googleApiKey,
      } as GoogleGenAIOptions);
      console.log('[VisionAgent] Initialized in API key mode');
    }
  }

  clearHistory(sessionId: string): void {
    this.sessionHistory.delete(sessionId);
    this.sessionPlans.delete(sessionId);
  }

  markLastActionResult(sessionId: string, success: boolean): void {
    const history = this.sessionHistory.get(sessionId);
    if (history?.length) history[history.length - 1].success = success;
  }

  private addToHistory(sessionId: string, entry: HistoryEntry): void {
    const history = this.sessionHistory.get(sessionId) ?? [];
    history.push(entry);
    if (history.length > 20) history.shift();
    this.sessionHistory.set(sessionId, history);
  }

  /**
   * Robustly extract the first complete JSON object from a string.
   * Handles models that wrap JSON in markdown or add surrounding text.
   */
  private extractJson(text: string): string | null {
    // Try direct parse first
    const trimmed = text.trim();
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {}

    // Find the first { and walk forward tracking brace depth
    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {}
        }
      }
    }
    return null;
  }

  /**
   * Phase 1 — observe the page and generate a flexible task plan.
   * Called once at the start of each vision loop.
   */
  async planTask(
    sessionId: string,
    screenshotBase64: string,
    currentUrl: string,
    task: string,
  ): Promise<void> {
    const prompt = `You are a web automation planner. Look carefully at this screenshot.

TASK: ${task}
URL: ${currentUrl}

FIRST — observe the page:
• What website/app is this? What store or section are you in?
• What key elements are visible? (search bar, category navigation, product grid, buttons, forms, etc.)
• What is the current state? (homepage, product page, search results, cart, etc.)

THEN — create a realistic 3–8 step plan to complete the task based on what you actually see.
The plan should name the specific paths visible on screen (e.g., "use the search bar" or "click the Produce category").
Where multiple paths exist, note the fastest one.

Respond with ONLY a JSON array of step strings — no markdown, no extra text.
["step 1 based on what I see", "step 2", ...]`;

    try {
      const result = await this.client.models.generateContent({
        model: this.config.visionModel,
        contents: [{ role: 'user', parts: [
          { inlineData: { data: screenshotBase64, mimeType: 'image/png' } },
          { text: prompt },
        ]}],
      });
      const responseText = result.text ?? '';
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const plan: string[] = JSON.parse(jsonMatch[0]);
        this.sessionPlans.set(sessionId, plan);
        console.log(`[VisionAgent] Plan for "${task}":\n${plan.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[VisionAgent] Planning skipped (will proceed reactively): ${msg.slice(0, 120)}`);
    }
  }

  /**
   * Phase 2 — observe the screen, then decide the next single action.
   */
  async planAction(
    sessionId: string,
    screenshotBase64: string,
    currentUrl: string,
    currentTask: string,
  ): Promise<NavigationAction> {
    console.log(`[VisionAgent] Planning action for session ${sessionId.slice(0, 6)} at ${currentUrl}`);

    const history = this.sessionHistory.get(sessionId) ?? [];
    const plan    = this.sessionPlans.get(sessionId) ?? [];
    const prompt  = this.buildPrompt(currentTask, currentUrl, history, plan);

    try {
      const result = await this.client.models.generateContent({
        model: this.config.visionModel,
        contents: [{ role: 'user', parts: [
          { inlineData: { data: screenshotBase64, mimeType: 'image/png' } },
          { text: prompt },
        ]}],
      });

      let responseText = result.text ?? '';
      console.log(`[VisionAgent] Raw response:`, responseText.substring(0, 300));

      let jsonStr = this.extractJson(responseText);
      if (!jsonStr) {
        // Retry with a stricter prompt
        console.warn('[VisionAgent] No JSON found — retrying with strict prompt');
        const retry = await this.client.models.generateContent({
          model: this.config.visionModel,
          contents: [{ role: 'user', parts: [
            { inlineData: { data: screenshotBase64, mimeType: 'image/png' } },
            { text: prompt + '\n\nCRITICAL: Your response MUST be a single JSON object starting with { and ending with }. No other text.' },
          ]}],
        });
        responseText = retry.text ?? '';
        jsonStr = this.extractJson(responseText);
      }

      if (!jsonStr) throw new Error('No valid JSON in response after retry');

      const parsed = JSON.parse(jsonStr);
      const action: NavigationAction = {
        action: parsed.action,
        targetText: parsed.targetText,
        inputValue: parsed.inputValue,
        reason: parsed.reason,
        observation: parsed.observation,
      };

      if (action.observation) {
        console.log(`[VisionAgent] Saw: ${action.observation}`);
      }
      console.log(`[VisionAgent] → ${action.action}${action.targetText ? ` "${action.targetText}"` : ''} — ${action.reason}`);

      this.addToHistory(sessionId, {
        step: history.length + 1,
        action: action.action,
        targetText: action.targetText,
        inputValue: action.inputValue,
        reason: action.reason,
        observation: action.observation,
        url: currentUrl,
      });

      return action;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[VisionAgent] planAction failed:`, message);
      this.addToHistory(sessionId, {
        step: history.length + 1,
        action: 'wait',
        reason: `API error: ${message.slice(0, 80)}`,
        url: currentUrl,
      });
      throw error;
    }
  }

  private buildPrompt(task: string, url: string, history: HistoryEntry[], plan: string[]): string {
    const planSection = plan.length > 0
      ? `\n━━━ TASK PLAN (your roadmap) ━━━\n${plan.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`
      : '';

    const failedCount = history.filter(h => h.success === false).length;
    const historySection = history.length > 0
      ? `\n━━━ ACTIONS TAKEN SO FAR ━━━\n${history.map(h =>
          `  Step ${h.step} [${h.success === false ? '✗ FAILED' : '✓ ok'}]: ${h.action}${h.targetText ? ` "${h.targetText}"` : ''}${h.inputValue ? ` → "${h.inputValue}"` : ''} — ${h.reason}${h.observation ? `\n    Saw: ${h.observation}` : ''}`
        ).join('\n')}\n`
      : '';

    return `You are an autonomous browser agent. You receive a real browser screenshot and must carefully look at it before deciding what to do next.

TASK: ${task}
CURRENT URL: ${url}
${planSection}${historySection}
━━━ YOUR PROCESS (follow in order) ━━━

STEP 1 — OBSERVE THE SCREEN
Look at the screenshot and note exactly what you see:
• What page is this? (e.g., "Instacart homepage", "Costco store on Instacart", "search results page", "product detail page")
• What interactive elements are visible? Be specific:
  - Is there a search bar? What does the placeholder say?
  - What buttons are visible? List their labels.
  - Are there category sections or navigation tabs? What are they called?
  - Are there product cards? What items are shown?
  - Is the page still loading?
• Has any part of the task already been completed?

STEP 2 — REASON ABOUT THE BEST PATH
Given what you see and the task, think:
• What is the fastest path to complete the task from this exact screen state?
• If there's a search bar → searching is usually fastest for finding items
• If there are category sections (like "Produce", "Vegetables") → those are valid navigation paths
• If you're already on a results page → look for the target item and its Add button
• If you see a loading indicator → wait, don't click anything yet
• If you tried something and it failed → look for a different element or approach

SEARCH BAR RULES (critical — read before any search action):
① To search for something new, use type_into_label with targetText matching the PLACEHOLDER of the search bar (e.g., "Search", "Ask or search anything"), NOT the current value inside it
② The fill action CLEARS existing text automatically — you do not need to delete "tomatoes" before typing "eggs"
③ When a search dropdown/suggestions list appears: ALWAYS use press_enter to submit — NEVER click a suggestion by text. The search input intercepts all clicks and they will fail.
④ After press_enter: wait one step for results before acting

QUANTITY / ADD TO CART RULES (critical):
① When task says "add 1": click Add on exactly ONE product (cheapest/first match), confirm cart count +1, then finish. Do NOT add a second product.
② When task says "add 2 units of same product": click Add once (qty=1), wait for +/- controls to appear, click "+" once (qty=2), then finish.
③ When you see multiple products on results page: choose ONE and add only that one. Seeing 3 tomato products does not mean you add all 3.
④ After adding, check the cart count or cart icon to confirm the right quantity was added before finishing.

STEP 3 — CHOOSE ONE ACTION
Pick the single next action that moves the task forward most directly.
${failedCount >= 3 ? `\n⚠️  ${failedCount} actions have failed already. Look at the page fresh and try a completely different approach.\n` : ''}
━━━ MODAL / POPUP HANDLING (critical) ━━━
If you see a modal, dialog, or overlay blocking the main content:
① FIRST action: press_escape — this dismisses most popups instantly
② If press_escape fails (modal still there next step): look for a close button labeled "✕", "X", "Close", "No thanks", "Skip"
③ NEVER click buttons INSIDE a modal that require credentials or trigger sign-up/verification flows
④ If a sign-up/login modal appears and you can't close it: request_user_input explaining the modal

━━━ RECOVERY RULES ━━━
• [✗ FAILED] action → that exact text/element didn't work, look for alternative text or element
• Same URL for 4+ steps with no visible progress → scroll_up to check for missed elements
• Can't find the button/field you expect → scroll_down to reveal more content
• Spinner, skeleton content, or "Loading..." visible → wait
• Genuinely stuck after 5+ failed attempts → request_user_input

━━━ AVAILABLE ACTIONS ━━━
• click_by_text    — click a button, link, or element using its exact visible text label
• type_into_label  — type text into an input (use "Search" for any search bar, or the field's label)
• press_enter      — press Enter (use immediately after typing into a search bar)
• press_escape     — dismiss modals, popups, or overlays (ALWAYS try this first when a popup blocks content)
• scroll_down      — scroll down to reveal more content below
• scroll_up        — scroll back up to see content above
• wait             — pause for loading/animation (use when page is not fully loaded)
• request_user_input — ask the user for information or intervention (last resort)
• finish           — task is fully done (only when you see confirmed success state)

━━━ RESPOND WITH ONLY A SINGLE JSON OBJECT ━━━
Required fields: observation, action, reason
Optional: targetText (for click_by_text and type_into_label), inputValue (for type_into_label)

{
  "observation": "I see [page description]. Visible elements: [list key buttons/inputs/sections you see]",
  "action": "action_name",
  "targetText": "exact visible text of element to interact with",
  "inputValue": "text to type (only for type_into_label)",
  "reason": "why this specific action is the right next step"
}

EXAMPLES for an Instacart/Costco scenario:

On the Costco store homepage — searching for first item:
{"observation":"Costco store on Instacart. Search bar at top with placeholder 'Ask or search anything'. Category tabs visible: Produce, Bakery, Dairy, Meat. No tomatoes visible yet.","action":"type_into_label","targetText":"Search","inputValue":"tomatoes","reason":"Typing tomatoes into the search bar — fill will clear any existing text automatically"}

Search bar shows current term 'tomatoes', need to search for 'eggs' instead:
{"observation":"Currently on tomatoes search results page. The search bar at top shows 'tomatoes' as its current value. Placeholder was 'Ask or search anything'. I need to search for eggs instead.","action":"type_into_label","targetText":"Search","inputValue":"eggs","reason":"Filling the search bar with 'eggs' — fill() clears 'tomatoes' automatically. Using 'Search' as targetText, not 'tomatoes' (which is the current value, not the label)."}

After typing — dropdown suggestions visible:
{"observation":"Search bar shows 'eggs' typed. Dropdown list of suggestions visible: 'eggs', 'hard boiled eggs', 'eggs made great'. The search input is still focused and captures pointer events.","action":"press_enter","reason":"Pressing Enter to submit the search — clicking dropdown suggestions fails because the search input intercepts pointer events"}

On search results page — adding 1 item:
{"observation":"Search results for tomatoes. Roma Tomatoes $2.49/lb (Add button), Tomatoes on the Vine $3.99 (Add button), Cherry Tomatoes $4.99 (Add button). Cart shows 0 items.","action":"click_by_text","targetText":"Add","reason":"Clicking Add on the FIRST product (Roma Tomatoes, cheapest). Adding exactly 1 unit only — not all three products."}

After adding 1, cart count increased — finish:
{"observation":"Cart icon now shows 1 item. Roma Tomatoes was successfully added. No more items need to be added per the task.","action":"finish","reason":"Task complete — exactly 1 tomato product added to cart as requested"}

Adding 2 units of same product — step 1:
{"observation":"Search results for eggs. Kirkland Eggs 60ct $14.99 visible with Add button. Cart shows 0.","action":"click_by_text","targetText":"Add","reason":"Clicking Add once to add first unit (qty will become 1)"}

Adding 2 units — step 2 (quantity control appeared):
{"observation":"Kirkland Eggs now shows quantity control: '-' '1' '+'. Cart shows 1. Need qty=2.","action":"click_by_text","targetText":"+","reason":"Clicking + to increment from 1 to 2 units of the same product"}

Page still loading:
{"observation":"Skeleton grey boxes where products should be, spinner visible. URL changed to search results.","action":"wait","reason":"Waiting for search results to fully render"}

Modal/popup blocking content:
{"observation":"A '$0 delivery fee on your first 3 orders' modal is covering the main page content.","action":"press_escape","reason":"Modal blocking the page — pressing Escape to dismiss before continuing"}`;
  }

  /**
   * Extract information from a mailed notice image.
   */
  async extractNotice(imageBase64: string, mimeType: string): Promise<any> {
    const prompt = `You are an expert assistant helping older adults understand government and official mailed notices.

Analyze this notice image and extract:
1. service_name — type of notice (e.g. "Benefits Renewal Notice")
2. deadline — exact date if visible (YYYY-MM-DD), else ""
3. reference_number — case/notice/reference ID
4. summary — 2-3 sentence plain-English explanation of what action is needed
5. required_items — list of documents/info the person needs
6. portal_url — website URL if printed on notice, else ""

Return ONLY a JSON object, no markdown.

{"service_name":"...","deadline":"...","reference_number":"...","summary":"...","required_items":[...],"portal_url":"..."}`;

    try {
      const result = await this.client.models.generateContent({
        model: this.config.visionModel,
        contents: [{ role: 'user', parts: [
          { inlineData: { data: imageBase64, mimeType } },
          { text: prompt },
        ]}],
      });
      const responseText = result.text ?? '';
      const jsonStr = this.extractJson(responseText);
      if (!jsonStr) throw new Error('No JSON in response');
      const noticeData = JSON.parse(jsonStr);
      console.log(`[VisionAgent] Extracted notice: ${noticeData.service_name}`);
      return noticeData;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[VisionAgent] Notice extraction failed:`, message);
      throw error;
    }
  }
}
