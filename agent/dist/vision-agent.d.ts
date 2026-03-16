/**
 * Vision Agent - Gemini 2.5 Flash
 * Observation-first: describes what it sees on screen before deciding each action.
 */
import type { AgentConfig, NavigationAction } from './types.js';
export declare class VisionAgent {
    private client;
    private config;
    private sessionHistory;
    private sessionPlans;
    constructor(config: AgentConfig);
    clearHistory(sessionId: string): void;
    markLastActionResult(sessionId: string, success: boolean): void;
    private addToHistory;
    /**
     * Robustly extract the first complete JSON object from a string.
     * Handles models that wrap JSON in markdown or add surrounding text.
     */
    private extractJson;
    /**
     * Phase 1 — observe the page and generate a flexible task plan.
     * Called once at the start of each vision loop.
     */
    planTask(sessionId: string, screenshotBase64: string, currentUrl: string, task: string): Promise<void>;
    /**
     * Phase 2 — observe the screen, then decide the next single action.
     */
    planAction(sessionId: string, screenshotBase64: string, currentUrl: string, currentTask: string): Promise<NavigationAction>;
    private buildPrompt;
    /**
     * Extract information from a mailed notice image.
     */
    extractNotice(imageBase64: string, mimeType: string): Promise<any>;
}
//# sourceMappingURL=vision-agent.d.ts.map