/**
 * Agent Coordinator
 * Orchestrates voice and vision agents
 */
import { EventEmitter } from 'events';
import type { AgentConfig, Session, NavigationAction } from './types.js';
export declare class AgentCoordinator extends EventEmitter {
    private voiceAgent;
    private visionAgent;
    private sessions;
    private browserWorkerUrl;
    constructor(config: AgentConfig);
    /**
     * Handle voice commands
     */
    private handleVoiceCommand;
    /**
     * Navigate to URL via browser worker
     */
    private navigateToUrl;
    /**
     * Execute navigation step
     */
    executeNavigationStep(sessionId: string): Promise<NavigationAction>;
    /**
     * Update session status and broadcast
     */
    private updateSessionStatus;
    /**
     * Broadcast status to all listeners
     */
    private broadcastStatus;
    /**
     * Get human-readable status message
     */
    private getStatusMessage;
    /**
     * Start voice session
     */
    startVoiceSession(sessionId: string): Promise<void>;
    /**
     * Stop voice session
     */
    stopVoiceSession(sessionId: string): Promise<void>;
    /**
     * Send audio to voice agent
     */
    sendAudio(sessionId: string, audioData: string): Promise<void>;
    /**
     * Get session
     */
    getSession(sessionId: string): Session | undefined;
    /**
     * Extract notice using vision agent
     */
    extractNotice(imageBase64: string, mimeType: string): Promise<any>;
}
//# sourceMappingURL=coordinator.d.ts.map