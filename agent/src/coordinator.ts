/**
 * Agent Coordinator
 * Orchestrates voice and vision agents
 */

import { EventEmitter } from 'events';
import { VoiceAgent } from './voice-agent.js';
import { VisionAgent } from './vision-agent.js';
import type { AgentConfig, Session, VoiceCommand, NavigationAction, AgentStatus } from './types.js';

export class AgentCoordinator extends EventEmitter {
  private voiceAgent: VoiceAgent;
  private visionAgent: VisionAgent;
  private sessions: Map<string, Session> = new Map();
  private browserWorkerUrl: string;

  constructor(config: AgentConfig) {
    super();
    this.browserWorkerUrl = config.browserWorkerUrl;

    // Initialize agents
    this.voiceAgent = new VoiceAgent(config);
    this.visionAgent = new VisionAgent(config);

    // Connect voice agent events
    this.voiceAgent.on('connected', (data) => {
      console.log(`[Coordinator] Voice connected: ${data.sessionId}`);
      this.emit('voice:connected', data);
    });

    this.voiceAgent.on('command', async (data) => {
      console.log(`[Coordinator] Voice command:`, data.command.intent);
      await this.handleVoiceCommand(data.sessionId, data.command);
    });

    this.voiceAgent.on('transcript', (data) => {
      this.emit('voice:transcript', data);
    });

    this.voiceAgent.on('audio', (data) => {
      this.emit('voice:audio', data);
    });

    this.voiceAgent.on('status', (data) => {
      this.broadcastStatus(data.sessionId);
    });

    // Connect vision agent events
    this.visionAgent.on('stuck', async (data) => {
      console.log(`[Coordinator] Vision agent stuck: ${data.reason}`);
      await this.voiceAgent.announce(
        data.sessionId,
        `I'm having trouble. ${data.reason}. Would you like to take control?`
      );
      this.updateSessionStatus(data.sessionId, 'stuck');
    });

    this.visionAgent.on('completed', async (data) => {
      console.log(`[Coordinator] Vision agent completed task`);
      await this.voiceAgent.announce(data.sessionId, 'Task completed successfully!');
      this.updateSessionStatus(data.sessionId, 'completed');
    });

    this.visionAgent.on('error', async (data) => {
      console.log(`[Coordinator] Vision agent error: ${data.error}`);
      await this.voiceAgent.announce(
        data.sessionId,
        `I encountered an error: ${data.error}. Please try again.`
      );
      this.updateSessionStatus(data.sessionId, 'error');
    });

    console.log('[Coordinator] Initialized with voice and vision agents');
  }

  /**
   * Handle voice commands
   */
  private async handleVoiceCommand(sessionId: string, command: VoiceCommand): Promise<void> {
    const session = this.sessions.get(sessionId) || this.voiceAgent.getSession(sessionId);
    if (!session) {
      console.warn(`[Coordinator] No session found for ${sessionId}`);
      return;
    }

    switch (command.intent) {
      case 'navigate':
        if (command.targetUrl) {
          await this.voiceAgent.announce(sessionId, `Opening ${command.targetUrl} now...`);
          await this.navigateToUrl(sessionId, command.targetUrl);
          session.currentUrl = command.targetUrl;
          session.mode = 'vision';
          this.updateSessionStatus(sessionId, 'navigating');
        }
        break;

      case 'add_item':
        if (command.items && command.items.length > 0) {
          session.itemsList = [...(session.itemsList || []), ...command.items];
          const itemsText = command.items.join(', ');
          await this.voiceAgent.announce(
            sessionId,
            `Got it! I'll add ${itemsText} to your list.`
          );
          this.emit('items:updated', { sessionId, items: session.itemsList });
        }
        break;

      case 'checkout':
        await this.voiceAgent.announce(sessionId, 'Starting checkout process...');
        session.currentTask = 'Complete checkout';
        this.updateSessionStatus(sessionId, 'navigating');
        break;

      case 'manual_control':
        session.mode = 'manual';
        this.updateSessionStatus(sessionId, 'manual_control');
        await this.voiceAgent.announce(
          sessionId,
          'Switching to manual control. Let me know when you want me to take over again.'
        );
        break;

      case 'help':
        await this.voiceAgent.announce(
          sessionId,
          'I can help you shop for groceries, file taxes, renew benefits, or fill government forms. Just tell me what you need!'
        );
        break;

      default:
        // Unknown intent - let the voice agent handle it naturally
        break;
    }

    this.sessions.set(sessionId, session);
  }

  /**
   * Navigate to URL via browser worker
   */
  private async navigateToUrl(sessionId: string, url: string): Promise<void> {
    try {
      const response = await fetch(`${this.browserWorkerUrl}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'navigate',
          params: { url },
        }),
      });

      if (!response.ok) {
        throw new Error(`Browser worker returned ${response.status}`);
      }

      console.log(`[Coordinator] Navigated to ${url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Coordinator] Navigation failed:`, message);
      throw error;
    }
  }

  /**
   * Execute navigation step
   */
  async executeNavigationStep(sessionId: string): Promise<NavigationAction> {
    const session = this.sessions.get(sessionId) || this.voiceAgent.getSession(sessionId);
    if (!session) {
      throw new Error(`No session found for ${sessionId}`);
    }

    // Get screenshot from browser worker
    const screenshotResponse = await fetch(`${this.browserWorkerUrl}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'screenshot',
      }),
    });

    if (!screenshotResponse.ok) {
      throw new Error(`Failed to get screenshot: ${screenshotResponse.status}`);
    }

    const { screenshot, url } = await screenshotResponse.json() as { screenshot: string; url: string };

    // Plan action using vision agent
    const action = await this.visionAgent.planAction(
      sessionId,
      screenshot,
      url,
      session.currentTask || 'Complete the task'
    );

    // Execute action via browser worker
    if (action.action !== 'wait' && action.action !== 'finish') {
      await fetch(`${this.browserWorkerUrl}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: action.action,
          params: {
            text: action.targetText,
            value: action.inputValue,
          },
        }),
      });
    }

    return action;
  }

  /**
   * Update session status and broadcast
   */
  private updateSessionStatus(sessionId: string, status: Session['status']): void {
    const session = this.sessions.get(sessionId) || this.voiceAgent.getSession(sessionId);
    if (session) {
      session.status = status;
      session.updatedAt = new Date();
      this.sessions.set(sessionId, session);
      this.broadcastStatus(sessionId);
    }
  }

  /**
   * Broadcast status to all listeners
   */
  private broadcastStatus(sessionId: string): void {
    const session = this.sessions.get(sessionId) || this.voiceAgent.getSession(sessionId);
    if (!session) return;

    const status: AgentStatus = {
      sessionId,
      status: session.status,
      message: this.getStatusMessage(session.status),
      currentUrl: session.currentUrl,
      currentTask: session.currentTask,
    };

    this.emit('status', status);
  }

  /**
   * Get human-readable status message
   */
  private getStatusMessage(status: Session['status']): string {
    switch (status) {
      case 'idle':
        return 'Waiting for command';
      case 'listening':
        return 'Listening...';
      case 'thinking':
        return 'Thinking...';
      case 'navigating':
        return 'Navigating website';
      case 'waiting_for_user':
        return 'Waiting for your input';
      case 'manual_control':
        return 'You have control';
      case 'stuck':
        return 'Need help - please take over';
      case 'completed':
        return 'Task completed!';
      case 'error':
        return 'Error occurred';
      default:
        return 'Unknown status';
    }
  }

  /**
   * Start voice session
   */
  async startVoiceSession(sessionId: string): Promise<void> {
    await this.voiceAgent.startSession(sessionId);
    this.sessions.set(sessionId, this.voiceAgent.getSession(sessionId)!);
  }

  /**
   * Stop voice session
   */
  async stopVoiceSession(sessionId: string): Promise<void> {
    await this.voiceAgent.stopSession(sessionId);
    this.sessions.delete(sessionId);
  }

  /**
   * Send audio to voice agent
   */
  async sendAudio(sessionId: string, audioData: string): Promise<void> {
    await this.voiceAgent.sendAudio(sessionId, audioData);
  }

  /**
   * Get session
   */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId) || this.voiceAgent.getSession(sessionId);
  }

  /**
   * Extract notice using vision agent
   */
  async extractNotice(imageBase64: string, mimeType: string): Promise<any> {
    return await this.visionAgent.extractNotice(imageBase64, mimeType);
  }
}
