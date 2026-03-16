/**
 * CivicFlow Agent Types
 * Shared types for voice and vision agents
 */

export interface AgentConfig {
  googleApiKey?: string;
  useVertex?: boolean;
  gcpProject?: string;
  gcpLocation?: string;
  visionModel: string;
  liveModel: string;
  voiceName: string;
  enableGoogleSearch: boolean;
  browserWorkerUrl: string;
}

export interface Session {
  sessionId: string;
  mode: 'voice' | 'vision' | 'manual';
  currentUrl?: string;
  currentTask?: string;
  conversationHistory: Message[];
  itemsList?: string[];
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionStatus =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'navigating'
  | 'waiting_for_user'
  | 'manual_control'
  | 'stuck'
  | 'completed'
  | 'error';

export interface Message {
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: Date;
}

export interface VoiceCommand {
  intent: 'navigate' | 'add_item' | 'checkout' | 'help' | 'manual_control' | 'unknown';
  targetUrl?: string;
  items?: string[];
  parameters?: Record<string, unknown>;
}

export interface NavigationAction {
  action: 'click_by_text' | 'type_into_label' | 'press_enter' | 'press_escape' | 'scroll_down' | 'scroll_up' | 'wait' | 'finish' | 'request_user_input';
  targetText?: string;
  inputValue?: string;
  reason: string;
  observation?: string; // what the model saw on screen before deciding
}

export interface AgentStatus {
  sessionId: string;
  status: SessionStatus;
  message: string;
  currentUrl?: string;
  currentTask?: string;
  error?: string;
}

export interface VoiceStreamMessage {
  type: 'audio' | 'text' | 'status' | 'error';
  data: string;
}

export interface BrowserCommand {
  command: 'screenshot' | 'navigate' | 'click' | 'type' | 'scroll';
  params?: Record<string, unknown>;
}

export interface BrowserResponse {
  success: boolean;
  screenshot?: string; // base64
  url?: string;
  error?: string;
}
