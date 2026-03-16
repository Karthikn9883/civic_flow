/**
 * Vision Agent - Gemini 2.5 Flash
 * Handles screenshot analysis and navigation planning with session memory
 */
import { GoogleGenAI } from '@google/genai';
export class VisionAgent {
    client;
    config;
    // Per-session action history so the model knows what was already tried
    sessionHistory = new Map();
    constructor(config) {
        this.config = config;
        if (config.useVertex) {
            if (!config.gcpProject) {
                throw new Error('VisionAgent requires gcpProject when useVertex=true');
            }
            this.client = new GoogleGenAI({
                vertexai: true,
                project: config.gcpProject,
                location: config.gcpLocation || 'us-central1',
            });
            console.log('[VisionAgent] Initialized in Vertex AI mode');
        }
        else {
            if (!config.googleApiKey) {
                throw new Error('VisionAgent requires googleApiKey when useVertex=false');
            }
            this.client = new GoogleGenAI({
                vertexai: false,
                apiKey: config.googleApiKey,
            });
            console.log('[VisionAgent] Initialized in API key mode');
        }
    }
    clearHistory(sessionId) {
        this.sessionHistory.delete(sessionId);
    }
    addToHistory(sessionId, entry) {
        const history = this.sessionHistory.get(sessionId) ?? [];
        history.push(entry);
        // Keep last 15 steps to avoid huge prompts
        if (history.length > 15)
            history.shift();
        this.sessionHistory.set(sessionId, history);
    }
    /**
     * Analyze screenshot and plan next action
     */
    async planAction(sessionId, screenshotBase64, currentUrl, currentTask) {
        console.log(`[VisionAgent] Planning action for ${sessionId} at ${currentUrl}`);
        const history = this.sessionHistory.get(sessionId) ?? [];
        const prompt = this.getPlannerPrompt(currentTask, currentUrl, history);
        try {
            const result = await this.client.models.generateContent({
                model: this.config.visionModel,
                contents: [{
                        role: 'user',
                        parts: [
                            { inlineData: { data: screenshotBase64, mimeType: 'image/png' } },
                            { text: prompt },
                        ],
                    }],
            });
            const responseText = result.text ?? '';
            console.log(`[VisionAgent] Raw response:`, responseText.substring(0, 200));
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                throw new Error('No JSON found in response');
            const action = JSON.parse(jsonMatch[0]);
            console.log(`[VisionAgent] Planned action:`, action.action, '-', action.reason);
            // Record in history
            this.addToHistory(sessionId, {
                step: history.length + 1,
                action: action.action,
                targetText: action.targetText,
                inputValue: action.inputValue,
                reason: action.reason,
                url: currentUrl,
            });
            return action;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[VisionAgent] Planning failed:`, message);
            // Record the failure in history so we don't repeat it
            this.addToHistory(sessionId, {
                step: history.length + 1,
                action: 'wait',
                reason: `API error: ${message.slice(0, 80)}`,
                url: currentUrl,
            });
            // Re-throw so the caller can handle rate limits / retries
            throw error;
        }
    }
    /**
     * Get planner prompt with action history for context
     */
    getPlannerPrompt(currentTask, currentUrl, history) {
        const historySection = history.length > 0
            ? `\nACTIONS ALREADY TAKEN (do NOT repeat these):\n${history.map(h => `  Step ${h.step}: ${h.action}${h.targetText ? ` on "${h.targetText}"` : ''}${h.inputValue ? ` with "${h.inputValue}"` : ''} — ${h.reason}`).join('\n')}\n`
            : '';
        return `You are an intelligent web navigation agent helping complete tasks online.

Current task: ${currentTask}
Current URL: ${currentUrl}
${historySection}
Analyze the screenshot and decide the NEXT SINGLE ACTION to take.

Available actions:
- click_by_text: Click a button, link, or element by its visible text
- type_into_label: Type text into an input field identified by its label or placeholder
- scroll_down: Scroll down to see more content
- wait: Pause (use when page is loading or after an action needs to settle)
- request_user_input: Ask the user for help (payment info, login credentials, stuck after 3+ retries)
- finish: Task is visibly complete (confirmation page, success message, item added to cart)

CRITICAL RULES:
1. NEVER repeat an action that already appears in "ACTIONS ALREADY TAKEN"
2. If you typed into a field and it didn't work, try a different approach (e.g., click the field first, then type)
3. After typing in a search bar, the next step should be pressing Enter — use click_by_text on the search/submit button or scroll to see results
4. If stuck after 3+ attempts at the same element, use request_user_input
5. SCROLL to find content before giving up
6. finish ONLY when you see a clear success confirmation

Return ONLY a JSON object with these exact keys (camelCase):
- action: one of the allowed actions
- targetText: the visible text to click/type into (required for click_by_text, type_into_label)
- inputValue: the text to enter (required for type_into_label)
- reason: brief explanation of why you chose this action

Example:
{
  "action": "click_by_text",
  "targetText": "Add to Cart",
  "reason": "Item found in search results, adding to cart"
}`;
    }
    /**
     * Extract information from notice image
     */
    async extractNotice(imageBase64, mimeType) {
        console.log(`[VisionAgent] Extracting notice information`);
        const prompt = `You are an expert assistant helping older adults understand government and official mailed notices.

Analyze this notice image carefully and extract the following information:

1. **service_name**: The type of notice (e.g., "Benefits Renewal Notice", "Tax Notice", "Housing Assistance")
2. **deadline**: The exact deadline date if visible (format: YYYY-MM-DD). If not visible, return empty string.
3. **reference_number**: Any reference number, case number, or notice ID visible on the document
4. **summary**: A clear, simple explanation (2-3 sentences) of what this notice is asking the person to do
5. **required_items**: A list of information or documents the person will likely need
6. **portal_url**: The website URL if visible on the notice. If no URL is visible, return empty string.

Return ONLY a JSON object with these exact keys. No markdown, no extra text.

Example:
{
  "service_name": "Benefits Renewal Notice",
  "deadline": "2026-04-15",
  "reference_number": "RN-20481",
  "summary": "Your benefits need to be renewed before the deadline. You must verify your identity and address.",
  "required_items": ["Date of birth", "Street address", "ZIP code"],
  "portal_url": "https://www.benefits.gov/renew"
}`;
        try {
            const result = await this.client.models.generateContent({
                model: this.config.visionModel,
                contents: [{
                        role: 'user',
                        parts: [
                            { inlineData: { data: imageBase64, mimeType } },
                            { text: prompt },
                        ],
                    }],
            });
            const responseText = result.text ?? '';
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch)
                throw new Error('No JSON found in response');
            const noticeData = JSON.parse(jsonMatch[0]);
            console.log(`[VisionAgent] Extracted notice:`, noticeData.service_name);
            return noticeData;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[VisionAgent] Notice extraction failed:`, message);
            throw error;
        }
    }
}
//# sourceMappingURL=vision-agent.js.map