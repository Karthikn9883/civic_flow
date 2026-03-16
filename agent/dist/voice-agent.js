/**
 * Voice Agent - Gemini Live API
 * Handles real-time voice interaction with users
 */
import { GoogleGenAI, Modality } from '@google/genai';
import { EventEmitter } from 'events';
export class VoiceAgent extends EventEmitter {
    client;
    config;
    sessions = new Map();
    constructor(config) {
        super();
        this.config = config;
        if (config.useVertex) {
            if (!config.gcpProject) {
                throw new Error('VoiceAgent requires gcpProject when useVertex=true');
            }
            this.client = new GoogleGenAI({
                vertexai: true,
                project: config.gcpProject,
                location: config.gcpLocation || 'us-central1',
            });
            console.log('[VoiceAgent] Initialized in Vertex AI mode');
        }
        else {
            if (!config.googleApiKey) {
                throw new Error('VoiceAgent requires googleApiKey when useVertex=false');
            }
            this.client = new GoogleGenAI({
                vertexai: false,
                apiKey: config.googleApiKey,
            });
            console.log('[VoiceAgent] Initialized in API key mode');
        }
    }
    /**
     * Start voice session for a user
     */
    async startSession(sessionId) {
        console.log(`[VoiceAgent] Starting session ${sessionId}`);
        const session = {
            sessionId,
            mode: 'voice',
            conversationHistory: [],
            status: 'listening',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        this.sessions.set(sessionId, session);
        const liveConfig = {
            responseModalities: [Modality.AUDIO],
            outputAudioTranscription: {},
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: this.config.voiceName,
                    },
                },
            },
            tools: this.config.enableGoogleSearch ? [{ googleSearch: {} }] : undefined,
            systemInstruction: this.getSystemPrompt(),
        };
        try {
            const liveSession = await this.client.live.connect({
                model: this.config.liveModel,
                config: liveConfig,
                callbacks: {
                    onopen: () => {
                        console.log(`[VoiceAgent] Live session connected for ${sessionId}`);
                        this.emit('connected', { sessionId });
                        this.updateSessionStatus(sessionId, 'listening');
                    },
                    onmessage: (message) => {
                        this.handleLiveMessage(sessionId, message);
                    },
                    onerror: (event) => {
                        console.error(`[VoiceAgent] Error for ${sessionId}:`, event.message);
                        this.emit('error', { sessionId, error: event.message });
                        this.updateSessionStatus(sessionId, 'error');
                    },
                    onclose: (event) => {
                        console.log(`[VoiceAgent] Session closed for ${sessionId}: ${event.reason}`);
                        this.emit('closed', { sessionId, reason: event.reason });
                    },
                },
            });
            // Store session reference for cleanup
            session.liveSession = liveSession;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[VoiceAgent] Failed to connect for ${sessionId}:`, message);
            this.emit('error', { sessionId, error: message });
            throw error;
        }
    }
    /**
     * Handle messages from Gemini Live API
     */
    handleLiveMessage(sessionId, message) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        // Handle transcript (user speech or AI response)
        const transcript = message.serverContent?.outputTranscription?.text;
        if (transcript) {
            console.log(`[VoiceAgent] ${sessionId} transcript:`, transcript);
            session.conversationHistory.push({
                role: 'agent',
                content: transcript,
                timestamp: new Date(),
            });
            // Parse for commands
            const command = this.parseVoiceCommand(transcript);
            if (command.intent !== 'unknown') {
                this.emit('command', { sessionId, command });
            }
            this.emit('transcript', { sessionId, text: transcript });
        }
        // Handle audio response
        const parts = message.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
            if (part.inlineData?.data) {
                // Forward audio to client
                this.emit('audio', { sessionId, audioData: part.inlineData.data });
            }
        }
        session.updatedAt = new Date();
    }
    /**
     * Parse voice command into structured intent
     */
    parseVoiceCommand(text) {
        const lower = text.toLowerCase();
        // Navigate intents
        if (lower.includes('groceries') || lower.includes('instacart')) {
            return {
                intent: 'navigate',
                targetUrl: 'https://www.instacart.com',
            };
        }
        if (lower.includes('taxes') || lower.includes('irs') || lower.includes('file taxes')) {
            return {
                intent: 'navigate',
                targetUrl: 'https://www.irs.gov/e-file-providers-partners',
            };
        }
        if (lower.includes('benefits') || lower.includes('renew')) {
            return {
                intent: 'navigate',
                targetUrl: 'https://www.benefits.gov',
            };
        }
        // Item collection
        if (lower.includes('add') || lower.includes('need')) {
            const items = this.extractItems(text);
            if (items.length > 0) {
                return { intent: 'add_item', items };
            }
        }
        // Checkout
        if (lower.includes('checkout') || lower.includes('purchase') || lower.includes('buy')) {
            return { intent: 'checkout' };
        }
        // Manual control
        if (lower.includes('take control') || lower.includes('manual')) {
            return { intent: 'manual_control' };
        }
        // Help
        if (lower.includes('help') || lower.includes('what can you do')) {
            return { intent: 'help' };
        }
        return { intent: 'unknown' };
    }
    /**
     * Extract items from text (simple NLP)
     */
    extractItems(text) {
        // Common grocery items
        const items = ['milk', 'bread', 'eggs', 'bananas', 'apples', 'chicken', 'rice', 'pasta'];
        const found = [];
        for (const item of items) {
            if (text.toLowerCase().includes(item)) {
                found.push(item);
            }
        }
        return found;
    }
    /**
     * Send text to voice agent (for status announcements)
     */
    async announce(sessionId, message) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.liveSession) {
            console.warn(`[VoiceAgent] Cannot announce - no active session for ${sessionId}`);
            return;
        }
        const liveSession = session.liveSession;
        try {
            await liveSession.sendClientContent({
                turns: [{ role: 'user', parts: [{ text: message }] }],
                turnComplete: true,
            });
            console.log(`[VoiceAgent] Announced to ${sessionId}: ${message}`);
        }
        catch (error) {
            console.error(`[VoiceAgent] Failed to announce:`, error);
        }
    }
    /**
     * Send audio to voice agent
     */
    async sendAudio(sessionId, audioData) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.liveSession)
            return;
        const liveSession = session.liveSession;
        try {
            await liveSession.sendRealtimeInput({
                media: {
                    data: audioData,
                    mimeType: 'audio/pcm;rate=16000',
                },
            });
        }
        catch (error) {
            console.error(`[VoiceAgent] Failed to send audio:`, error);
        }
    }
    /**
     * Update session status
     */
    updateSessionStatus(sessionId, status) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.status = status;
            session.updatedAt = new Date();
            this.emit('status', { sessionId, status });
        }
    }
    /**
     * Get session
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    /**
     * Stop session
     */
    async stopSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return;
        const liveSession = session.liveSession;
        if (liveSession && typeof liveSession.close === 'function') {
            try {
                await liveSession.close();
            }
            catch (error) {
                console.error(`[VoiceAgent] Error closing session:`, error);
            }
        }
        this.sessions.delete(sessionId);
        console.log(`[VoiceAgent] Stopped session ${sessionId}`);
    }
    /**
     * System prompt for voice agent
     */
    getSystemPrompt() {
        return `You are a helpful AI assistant for CivicFlow, an app that helps older adults complete forms and tasks online.

Your role:
- Listen to user requests and help them navigate websites
- Ask clarifying questions when needed
- Announce what you're doing (e.g., "Opening the grocery website now")
- Tell the user when you need help or are stuck
- Speak clearly and simply (6th grade reading level)
- Be patient and encouraging

Common tasks:
- Grocery shopping (Instacart)
- Filing taxes (IRS)
- Renewing benefits (Benefits.gov)
- Filling government forms

When the user asks for something, confirm what you heard and then help them do it.
If you encounter a problem, tell the user clearly what's wrong and ask how they'd like to proceed.`;
    }
}
//# sourceMappingURL=voice-agent.js.map