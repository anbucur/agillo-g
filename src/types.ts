export type VotingMode = 'FIBONACCI' | 'TSHIRT' | 'REFINEMENT';
export type RefinementPhase = 'BRAINSTORM' | 'GROUPING' | 'VOTING' | 'PRIORITIZATION' | 'ANALYSIS' | 'COMPLEXITY_RANKING' | 'QUICK_WINS';

export interface StickerGroup {
  id: string;
  title: string;
  votes: Record<string, number>;
}

export interface Participant {
  id: string;
  name: string;
  isFacilitator: boolean;
  vote?: string;
  lastActive: number;
  isAnonymous?: boolean;
}

export interface Issue {
  id: string;
  key?: string;
  summary: string;
  description?: string;
  estimate?: string;
  status: 'PENDING' | 'VOTING' | 'COMPLETED';
}

export interface Sticker {
  id: string;
  participantId: string;
  text: string;
  categories?: string[];
  votes?: Record<string, number>;
  groupId?: string;
}

export interface ActionItem {
  id: string;
  title: string;
  description: string;
  jiraIssueKey?: string;
  linkedStickerIds?: string[];
  linkedGroupIds?: string[];
}

export interface AnalysisResult {
  summary: string;
  good: string[];
  bad: string[];
  blockers: string[];
  ideas: string[];
  actionItems: ActionItem[];
  confluenceUrl?: string;
}

export interface FinalAnalysisResult {
  summary: string;
  rankedItems: {
    actionItemId: string;
    justification: string;
  }[];
}

export interface Session {
  id: string;
  name: string;
  mode: VotingMode;
  currentIssueId?: string;
  isRevealed: boolean;
  participants: Record<string, Participant>;
  issues: Issue[];
  timerStart?: number;
  timerDuration?: number;
  stickers?: Record<string, Sticker>;
  stickerGroups?: Record<string, StickerGroup>;
  categories?: string[];
  analysis?: AnalysisResult;
  refinementPhase?: RefinementPhase;
  impactRanking?: string[];
  groupRanking?: string[];
  complexityRanking?: string[];
  finalAnalysis?: FinalAnalysisResult;
}

export interface JiraBoard {
  id: string;
  name: string;
  type: string;
}

export interface JiraSprint {
  id: string;
  name: string;
  state: string;
}

export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  description?: string;
  estimate?: string;
}

export type ServerMessage = 
  | { type: 'SESSION_UPDATE'; session: Session }
  | { type: 'PARTICIPANT_JOINED'; participant: Participant }
  | { type: 'PARTICIPANT_LEFT'; participantId: string }
  | { type: 'VOTE_CAST'; participantId: string; vote: string }
  | { type: 'VOTES_REVEALED' }
  | { type: 'VOTES_RESET' }
  | { type: 'ISSUE_SELECTED'; issueId: string }
  | { type: 'ISSUE_ADDED'; issue: Issue }
  | { type: 'JIRA_CONNECTED'; cloudId: string; siteName: string }
  | { type: 'ERROR'; message: string };

export type ClientMessage =
  | { type: 'JOIN_SESSION'; sessionId: string; participant: Participant }
  | { type: 'CAST_VOTE'; sessionId: string; participantId: string; vote: string }
  | { type: 'REVEAL_VOTES'; sessionId: string }
  | { type: 'RESET_VOTES'; sessionId: string }
  | { type: 'SELECT_ISSUE'; sessionId: string; issueId: string }
  | { type: 'ADD_ISSUE'; sessionId: string; issue: Issue }
  | { type: 'COMPLETE_ISSUE'; sessionId: string; issueId: string; estimate: string }
  | { type: 'CHANGE_MODE'; sessionId: string; mode: VotingMode }
  | { type: 'SYNC_JIRA_ESTIMATE'; sessionId: string; issueId: string; estimate: string }
  | { type: 'START_TIMER'; sessionId: string; duration: number }
  | { type: 'STOP_TIMER'; sessionId: string }
  | { type: 'ADD_STICKER'; sessionId: string; sticker: Sticker }
  | { type: 'UPDATE_STICKER'; sessionId: string; stickerId: string; text: string }
  | { type: 'REMOVE_STICKER'; sessionId: string; stickerId: string }
  | { type: 'CATEGORIZE_STICKERS'; sessionId: string }
  | { type: 'SAVE_CATEGORIES'; sessionId: string; categories: string[]; stickerUpdates: { id: string, categories: string[] }[] }
  | { type: 'ANALYZE_SESSION'; sessionId: string }
  | { type: 'SAVE_ANALYSIS'; sessionId: string; analysis: AnalysisResult }
  | { type: 'CREATE_JIRA_TASK'; sessionId: string; actionItemId: string; projectId: string }
  | { type: 'EXPORT_TO_CONFLUENCE'; sessionId: string; spaceKey: string }
  | { type: 'SET_REFINEMENT_PHASE'; sessionId: string; phase: RefinementPhase }
  | { type: 'SET_GROUPS'; sessionId: string; groups: Record<string, StickerGroup>; stickerUpdates: Record<string, string> }
  | { type: 'VOTE_STICKER'; sessionId: string; stickerId: string; participantId: string; delta: number }
  | { type: 'VOTE_GROUP'; sessionId: string; groupId: string; participantId: string; delta: number }
  | { type: 'UPDATE_IMPACT_RANKING'; sessionId: string; ranking: string[] }
  | { type: 'UPDATE_GROUP_RANKING'; sessionId: string; ranking: string[] }
  | { type: 'UPDATE_COMPLEXITY_RANKING'; sessionId: string; ranking: string[] }
  | { type: 'SAVE_FINAL_ANALYSIS'; sessionId: string; analysis: FinalAnalysisResult }
  | { type: 'GENERATE_DEMO_DATA'; sessionId: string }
  | { type: 'TOGGLE_ANONYMOUS'; sessionId: string; participantId: string; isAnonymous: boolean };
