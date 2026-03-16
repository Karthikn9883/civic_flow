/**
 * Voice Agent - Gemini Live API
 * Handles real-time voice interaction with users
 */
import { EventEmitter } from 'events';
import type { AgentConfig, Session } from './types.js';
export declare class VoiceAgent extends EventEmitter {
    private client;
    private config;
    private sessions;
    constructor(config: AgentConfig);
    /**
     * Start voice session for a user
     */
    startSession(sessionId: string): Promise<void>;
    /**
     * Handle messages from Gemini Live API
     */
    private handleLiveMessage;
    /**
     * Parse voice command into structured intent
     */
    private parseVoiceCommand;
    /**
     * Extract items from text (simple NLP)
     */
    private extractItems;
    /**
     * Send text to voice agent (for status announcements)
     */
    announce(sessionId: string, message: string): Promise<void>;
    /**
     * Send audio to voice agent
     */
    sendAudio(sessionId: string, audioData: string): Promise<void>;
    /**
     * Update session status
     */
    private updateSessionStatus;
    /**
     * Get session
     */
    getSession(sessionId: string): Session | undefined;
    /**
     * Stop session
     */
    stopSession(sessionId: string): Promise<void>;
    /**
     * System prompt for voice agent
     */
    private getSystemPrompt;
}
//# sourceMappingURL=voice-agent.d.ts.map