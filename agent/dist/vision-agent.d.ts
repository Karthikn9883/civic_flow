/**
 * Vision Agent - Gemini 2.5 Flash
 * Handles screenshot analysis and navigation planning with session memory
 */
import type { AgentConfig, NavigationAction } from './types.js';
export declare class VisionAgent {
    private client;
    private config;
    private sessionHistory;
    constructor(config: AgentConfig);
    clearHistory(sessionId: string): void;
    private addToHistory;
    /**
     * Analyze screenshot and plan next action
     */
    planAction(sessionId: string, screenshotBase64: string, currentUrl: string, currentTask: string): Promise<NavigationAction>;
    /**
     * Get planner prompt with action history for context
     */
    private getPlannerPrompt;
    /**
     * Extract information from notice image
     */
    extractNotice(imageBase64: string, mimeType: string): Promise<any>;
}
//# sourceMappingURL=vision-agent.d.ts.map