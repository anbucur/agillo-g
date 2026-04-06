import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { QRCodeSVG } from 'qrcode.react';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Users, 
  Plus, 
  Play, 
  RotateCcw, 
  Eye, 
  CheckCircle2, 
  Copy, 
  Share2, 
  Clock,
  ArrowRight,
  ChevronRight,
  Settings,
  LogOut,
  Trophy,
  AlertCircle,
  Database,
  RefreshCw,
  ExternalLink,
  Search,
  X
} from 'lucide-react';
import { SiJira } from 'react-icons/si';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { Session, Participant, Issue, VotingMode, ServerMessage, ClientMessage, JiraBoard, JiraIssue, JiraSprint, RefinementPhase, StickerGroup } from './types';

const FIBONACCI_SCALE = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];
const TSHIRT_SCALE = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'];

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('s');
  });
  const [participant, setParticipant] = useState<Participant | null>(() => {
    const saved = localStorage.getItem('agillo_participant');
    return saved ? JSON.parse(saved) : null;
  });
  const [session, setSession] = useState<Session | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [nickname, setNickname] = useState('');
  const [isJiraModalOpen, setIsJiraModalOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('agillo_theme');
    return (saved as 'light' | 'dark') || 'light';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('agillo_theme', theme);
  }, [theme]);

  // WebSocket connection management
  useEffect(() => {
    if (sessionId && participant) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}`);
      
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: 'JOIN_SESSION',
          sessionId,
          participant
        }));
      };

      socket.onmessage = (event) => {
        const message: ServerMessage = JSON.parse(event.data);
        if (message.type === 'SESSION_UPDATE') {
          setSession(message.session);
        } else if (message.type === 'ERROR') {
          setError(message.message);
        }
      };

      socket.onclose = () => {
        console.log('WS Disconnected');
        setWs(null);
      };

      setWs(socket);
      return () => socket.close();
    }
  }, [sessionId, participant]);

  const createSession = async (name: string, mode: VotingMode) => {
    const id = uuidv4().slice(0, 8);
    const newParticipant: Participant = {
      id: uuidv4(),
      name: nickname || 'Facilitator',
      isFacilitator: true,
      lastActive: Date.now()
    };
    
    localStorage.setItem('agillo_participant', JSON.stringify(newParticipant));
    setParticipant(newParticipant);
    
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name, mode })
      });
      if (res.ok) {
        window.history.pushState({}, '', `?s=${id}`);
        setSessionId(id);
      }
    } catch (err) {
      setError('Failed to create session');
    }
  };

  const joinSession = (name: string) => {
    const newParticipant: Participant = {
      id: uuidv4(),
      name,
      isFacilitator: false,
      lastActive: Date.now()
    };
    localStorage.setItem('agillo_participant', JSON.stringify(newParticipant));
    setParticipant(newParticipant);
  };

  const sendMessage = useCallback((msg: ClientMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, [ws]);

  if (!sessionId) {
    return <Landing onCreate={createSession} nickname={nickname} setNickname={setNickname} theme={theme} />;
  }

  if (!participant) {
    return <JoinRoom onJoin={joinSession} theme={theme} />;
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center font-sans">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-line border-t-transparent rounded-full animate-spin" />
          <p className="text-ink font-medium italic">Connecting to session...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-ink font-sans selection:bg-ink selection:text-bg">
      <Header 
        session={session} 
        participant={participant} 
        onLeave={() => {
          window.history.pushState({}, '', '/');
          setSessionId(null);
          setParticipant(null);
        }}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        onChangeMode={(mode) => sendMessage({ type: 'CHANGE_MODE', sessionId: session.id, mode })}
        onGenerateDemoData={() => sendMessage({ type: 'GENERATE_DEMO_DATA', sessionId: session.id })}
      />
      
      <main className="max-w-[1600px] mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left: Session Info & Issues */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          <IssueList 
            session={session} 
            isFacilitator={participant.isFacilitator}
            onAddIssue={(summary) => sendMessage({ 
              type: 'ADD_ISSUE', 
              sessionId: session.id, 
              issue: { id: uuidv4(), summary, status: 'PENDING' } 
            })}
            onSelectIssue={(issueId) => sendMessage({ type: 'SELECT_ISSUE', sessionId: session.id, issueId })}
            onOpenJira={() => setIsJiraModalOpen(true)}
          />
          <ShareCard sessionId={session.id} theme={theme} />
        </div>

        {/* Center: Main Area */}
        <div className="lg:col-span-6 flex flex-col gap-8">
          {session.mode === 'REFINEMENT' ? (
            <RefinementBoard 
              session={session} 
              participant={participant} 
              sendMessage={sendMessage} 
            />
          ) : (
            <PokerTable 
              session={session} 
              participant={participant}
              onVote={(vote) => sendMessage({ type: 'CAST_VOTE', sessionId: session.id, participantId: participant.id, vote })}
              onReveal={() => sendMessage({ type: 'REVEAL_VOTES', sessionId: session.id })}
              onReset={() => sendMessage({ type: 'RESET_VOTES', sessionId: session.id })}
              onComplete={(estimate) => sendMessage({ 
                type: 'COMPLETE_ISSUE', 
                sessionId: session.id, 
                issueId: session.currentIssueId!, 
                estimate 
              })}
              onSyncJira={(estimate) => sendMessage({
                type: 'SYNC_JIRA_ESTIMATE',
                sessionId: session.id,
                issueId: session.currentIssueId!,
                estimate
              })}
              onToggleAnonymous={(isAnonymous) => sendMessage({
                type: 'TOGGLE_ANONYMOUS',
                sessionId: session.id,
                participantId: participant.id,
                isAnonymous
              })}
            />
          )}
        </div>

        {/* Right: Participants */}
        <div className="lg:col-span-3">
          <ParticipantList session={session} />
        </div>
      </main>

      <AnimatePresence>
        {isJiraModalOpen && (
          <JiraModal 
            onClose={() => setIsJiraModalOpen(false)}
            onImport={(issues) => {
              issues.forEach(issue => {
                sendMessage({
                  type: 'ADD_ISSUE',
                  sessionId: session.id,
                  issue: {
                    id: uuidv4(),
                    key: issue.key,
                    summary: issue.summary,
                    description: issue.description,
                    status: 'PENDING'
                  }
                });
              });
              setIsJiraModalOpen(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Components ---

function JiraModal({ onClose, onImport }: { onClose: () => void, onImport: (issues: JiraIssue[]) => void }) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [boards, setBoards] = useState<JiraBoard[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null);
  const [sprints, setSprints] = useState<any[]>([]);
  const [selectedSprint, setSelectedSprint] = useState<string | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedIssueId, setExpandedIssueId] = useState<string | null>(null);

  const connectJira = async () => {
    setIsConnecting(true);
    try {
      const res = await fetch('/api/auth/jira/url');
      const { url } = await res.json();
      const authWindow = window.open(url, 'jira_auth', 'width=600,height=700');
      
      const handleMessage = (event: MessageEvent) => {
        if (event.data?.type === 'JIRA_AUTH_SUCCESS') {
          setIsConnected(true);
          fetchBoards();
          window.removeEventListener('message', handleMessage);
        }
      };
      window.addEventListener('message', handleMessage);
    } catch (err) {
      console.error(err);
    } finally {
      setIsConnecting(false);
    }
  };

  const fetchBoards = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/jira/boards');
      if (res.ok) {
        const data = await res.json();
        setBoards(data);
      } else {
        setIsConnected(false);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchSprints = async (boardId: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/jira/boards/${boardId}/sprints`);
      if (res.ok) {
        const data = await res.json();
        setSprints(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchIssues = async (boardId: string, sprintId?: string | null) => {
    setIsLoading(true);
    try {
      let url = `/api/jira/boards/${boardId}/issues`;
      if (sprintId === 'backlog') {
        url = `/api/jira/boards/${boardId}/backlog`;
      } else if (sprintId) {
        url = `/api/jira/sprints/${sprintId}/issues`;
      }
      const res = await fetch(url);
      const data = await res.json();
      setIssues(data);
      setSelectedIssueIds(new Set());
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchBoards();
  }, []);

  const filteredIssues = issues.filter(issue => 
    issue.key.toLowerCase().includes(searchQuery.toLowerCase()) ||
    issue.summary.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const toggleIssueSelection = (id: string) => {
    const next = new Set(selectedIssueIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIssueIds(next);
  };

  const toggleAllSelection = () => {
    if (selectedIssueIds.size === filteredIssues.length) {
      setSelectedIssueIds(new Set());
    } else {
      setSelectedIssueIds(new Set(filteredIssues.map(i => i.id)));
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-ink/80 backdrop-blur-sm"
    >
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="bg-surface border-2 border-line w-full max-w-4xl h-[800px] flex flex-col shadow-[16px_16px_0px_0px_rgba(20,20,20,1)] dark:shadow-[16px_16px_0px_0px_rgba(0,0,0,0.5)]"
      >
        <div className="p-6 border-b-2 border-line flex items-center justify-between bg-muted">
          <div className="flex items-center gap-3">
            <SiJira size={24} color="#0052CC" />
            <h2 className="text-xl font-black italic text-ink">Jira Integration</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-ink hover:text-bg transition-all border-2 border-line text-ink">
            <Plus className="w-4 h-4 rotate-45" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col p-6">
          {!isConnected && boards.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-6">
              <div className="w-20 h-20 bg-muted border-2 border-line flex items-center justify-center">
                <div className="opacity-20">
                  <SiJira size={40} />
                </div>
              </div>
              <div>
                <h3 className="text-lg font-bold uppercase mb-2 text-ink">Connect your Jira account</h3>
                <p className="text-sm opacity-50 max-w-xs mx-auto text-ink">Import issues directly from your Jira boards and sync estimates back with one click.</p>
              </div>
              <button 
                onClick={connectJira}
                disabled={isConnecting}
                className="bg-ink text-bg px-8 py-4 font-bold uppercase tracking-widest hover:opacity-90 transition-all flex items-center gap-2"
              >
                {isConnecting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
                Connect Jira
              </button>
            </div>
          ) : (
            <div className="flex-1 flex flex-col gap-6 overflow-hidden">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-black uppercase tracking-widest opacity-50 text-ink">Board</label>
                  <select 
                    className="w-full bg-muted border-2 border-line p-3 font-mono text-sm focus:outline-none text-ink"
                    onChange={(e) => {
                      const bid = e.target.value;
                      setSelectedBoard(bid);
                      setSelectedSprint(null);
                      setSprints([]);
                      setIssues([]);
                      fetchSprints(bid);
                      fetchIssues(bid);
                    }}
                    value={selectedBoard || ''}
                  >
                    <option value="" disabled>Choose board...</option>
                    {boards.map(board => (
                      <option key={board.id} value={board.id}>{board.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-black uppercase tracking-widest opacity-50 text-ink">Sprint / Filter</label>
                  <select 
                    disabled={!selectedBoard}
                    className="w-full bg-muted border-2 border-line p-3 font-mono text-sm focus:outline-none disabled:opacity-50 text-ink"
                    onChange={(e) => {
                      const sid = e.target.value;
                      setSelectedSprint(sid);
                      fetchIssues(selectedBoard!, sid);
                    }}
                    value={selectedSprint || ''}
                  >
                    <option value="">All Board Issues</option>
                    <option value="backlog">Backlog</option>
                    {sprints.map(sprint => (
                      <option key={sprint.id} value={sprint.id}>{sprint.name} ({sprint.state})</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-black uppercase tracking-widest opacity-50 text-ink">Search</label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-30 text-ink" />
                    <input 
                      type="text" 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Key or summary..."
                      className="w-full bg-muted border-2 border-line p-3 pl-10 font-mono text-sm focus:outline-none text-ink"
                    />
                  </div>
                </div>
              </div>

              <div className="flex-1 border-2 border-line overflow-y-auto bg-muted">
                <div className="sticky top-0 bg-surface border-b border-line p-4 flex items-center justify-between z-10">
                  <div className="flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      checked={selectedIssueIds.size > 0 && selectedIssueIds.size === filteredIssues.length}
                      onChange={toggleAllSelection}
                      className="w-4 h-4 accent-ink"
                    />
                    <span className="text-[10px] font-black uppercase tracking-widest text-ink">Select All</span>
                  </div>
                  <span className="text-[10px] font-mono opacity-50 text-ink">{selectedIssueIds.size} selected</span>
                </div>

                {isLoading ? (
                  <div className="h-full flex items-center justify-center flex-col gap-4">
                    <RefreshCw className="w-8 h-8 animate-spin opacity-20 text-ink" />
                    <p className="text-[10px] font-mono uppercase opacity-40 text-ink">Loading issues...</p>
                  </div>
                ) : filteredIssues.length === 0 ? (
                  <div className="h-full flex items-center justify-center italic opacity-40 text-sm text-ink">
                    {selectedBoard ? 'No issues found' : 'Select a board to start'}
                  </div>
                ) : (
                  <div className="divide-y divide-line">
                    {filteredIssues.map(issue => (
                      <div 
                        key={issue.id} 
                        className={cn(
                          "p-4 flex items-start gap-4 transition-colors",
                          selectedIssueIds.has(issue.id) ? "bg-surface" : "hover:bg-surface/50"
                        )}
                      >
                        <input 
                          type="checkbox" 
                          checked={selectedIssueIds.has(issue.id)}
                          onChange={() => toggleIssueSelection(issue.id)}
                          className="mt-1 w-4 h-4 accent-ink cursor-pointer"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono bg-ink text-bg px-1.5 py-0.5">{issue.key}</span>
                              <p className="text-sm font-bold truncate text-ink">{issue.summary}</p>
                            </div>
                            {issue.description && (
                              <button 
                                onClick={() => setExpandedIssueId(expandedIssueId === issue.id ? null : issue.id)}
                                className="text-[10px] font-black uppercase tracking-widest opacity-50 hover:opacity-100 transition-opacity text-ink"
                              >
                                {expandedIssueId === issue.id ? 'Hide' : 'Details'}
                              </button>
                            )}
                          </div>
                          {issue.description && (
                            <div className={cn(
                              "text-[11px] font-mono overflow-hidden transition-all duration-200",
                              expandedIssueId === issue.id ? "max-h-96 mt-2 opacity-100" : "max-h-0 opacity-0"
                            )}>
                              <div className="p-3 bg-muted border-l-4 border-line whitespace-pre-wrap text-ink">
                                {issue.description}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-4">
                <button 
                  onClick={onClose}
                  className="flex-1 bg-surface border-2 border-line p-4 font-bold uppercase tracking-widest hover:bg-muted transition-all text-ink"
                >
                  Cancel
                </button>
                <button 
                  disabled={selectedIssueIds.size === 0}
                  onClick={() => {
                    const selected = issues.filter(i => selectedIssueIds.has(i.id));
                    onImport(selected);
                  }}
                  className="flex-[2] bg-ink text-bg p-4 font-bold uppercase tracking-widest hover:opacity-90 transition-all disabled:opacity-50"
                >
                  Import {selectedIssueIds.size} {selectedIssueIds.size === 1 ? 'Issue' : 'Issues'}
                </button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

function Landing({ onCreate, nickname, setNickname, theme }: { onCreate: (name: string, mode: VotingMode) => void, nickname: string, setNickname: (s: string) => void, theme: 'light' | 'dark' }) {
  const [sessionName, setSessionName] = useState('');
  const [mode, setMode] = useState<VotingMode>('FIBONACCI');

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center p-6 font-sans overflow-hidden">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="mb-12 text-center">
          <h1 className="text-8xl font-black tracking-tighter mb-2 italic text-ink">agillo</h1>
          <p className="text-sm uppercase tracking-widest opacity-50 font-mono text-ink">Estimation Intelligence Layer</p>
        </div>

        <div className="bg-surface border-2 border-line p-8 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] dark:shadow-[8px_8px_0px_0px_rgba(0,0,0,0.5)]">
          <div className="space-y-6">
            <div>
              <label className="block text-[11px] uppercase tracking-wider font-bold mb-2 opacity-50 text-ink">Your Nickname</label>
              <input 
                type="text" 
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="e.g. Alex"
                className="w-full bg-muted border-2 border-line p-3 focus:outline-none focus:bg-surface transition-colors font-mono text-ink"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider font-bold mb-2 opacity-50 text-ink">Session Name</label>
              <input 
                type="text" 
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="e.g. Sprint 42 Planning"
                className="w-full bg-muted border-2 border-line p-3 focus:outline-none focus:bg-surface transition-colors font-mono text-ink"
              />
            </div>
            <div>
              <label className="block text-[11px] uppercase tracking-wider font-bold mb-2 opacity-50 text-ink">Session Mode</label>
              <div className="grid grid-cols-3 gap-2">
                <button 
                  onClick={() => setMode('FIBONACCI')}
                  className={cn(
                    "p-3 border-2 border-line font-bold text-xs transition-all",
                    mode === 'FIBONACCI' ? "bg-ink text-bg" : "bg-surface text-ink hover:bg-muted"
                  )}
                >
                  Fibonacci
                </button>
                <button 
                  onClick={() => setMode('TSHIRT')}
                  className={cn(
                    "p-3 border-2 border-line font-bold text-xs transition-all",
                    mode === 'TSHIRT' ? "bg-ink text-bg" : "bg-surface text-ink hover:bg-muted"
                  )}
                >
                  T-Shirt
                </button>
                <button 
                  onClick={() => setMode('REFINEMENT')}
                  className={cn(
                    "p-3 border-2 border-line font-bold text-xs transition-all",
                    mode === 'REFINEMENT' ? "bg-ink text-bg" : "bg-surface text-ink hover:bg-muted"
                  )}
                >
                  Refinement
                </button>
              </div>
            </div>
            <button 
              disabled={!sessionName}
              onClick={() => onCreate(sessionName, mode)}
              className="w-full bg-ink text-bg p-4 font-bold uppercase tracking-widest flex items-center justify-center gap-2 hover:opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Start Session <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function JoinRoom({ onJoin, theme }: { onJoin: (name: string) => void, theme: 'light' | 'dark' }) {
  const [name, setName] = useState('');
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-sm bg-surface border-2 border-line p-8 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] dark:shadow-[8px_8px_0px_0px_rgba(0,0,0,0.5)]">
        <h2 className="text-2xl font-black italic mb-6 text-ink">Join Session</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold mb-2 opacity-50 text-ink">Your Nickname</label>
            <input 
              type="text" 
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sarah"
              className="w-full bg-muted border-2 border-line p-3 focus:outline-none focus:bg-surface transition-colors font-mono text-ink"
            />
          </div>
          <button 
            disabled={!name}
            onClick={() => onJoin(name)}
            className="w-full bg-ink text-bg p-4 font-bold uppercase tracking-widest hover:opacity-90 transition-colors disabled:opacity-50"
          >
            Enter Room
          </button>
        </div>
      </div>
    </div>
  );
}

function Header({ session, participant, onLeave, theme, onToggleTheme, onChangeMode, onGenerateDemoData }: { 
  session: Session, 
  participant: Participant, 
  onLeave: () => void,
  theme: 'light' | 'dark',
  onToggleTheme: () => void,
  onChangeMode: (mode: VotingMode) => void,
  onGenerateDemoData: () => void
}) {
  return (
    <header className="border-b border-line bg-surface px-6 py-4 flex items-center justify-between sticky top-0 z-50">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-black italic tracking-tighter text-ink">agillo</h1>
        <div className="h-6 w-[1px] bg-line opacity-20" />
        <div>
          <h2 className="text-sm font-bold uppercase tracking-tight text-ink">{session.name}</h2>
          {participant.isFacilitator ? (
            <select 
              value={session.mode}
              onChange={(e) => onChangeMode(e.target.value as VotingMode)}
              className="text-[10px] font-mono uppercase text-ink bg-transparent border-none outline-none cursor-pointer hover:underline"
            >
              <option value="FIBONACCI">FIBONACCI Mode</option>
              <option value="TSHIRT">TSHIRT Mode</option>
              <option value="REFINEMENT">REFINEMENT Mode</option>
            </select>
          ) : (
            <p className="text-[10px] font-mono opacity-50 uppercase text-ink">{session.mode} Mode</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4">
        {participant.isFacilitator && (
          <button 
            onClick={onGenerateDemoData}
            className="text-[10px] font-bold uppercase tracking-widest bg-accent text-white px-3 py-1 hover:opacity-90 transition-all"
          >
            Demo Data
          </button>
        )}
        <div className="text-right hidden sm:block">
          <p className="text-[11px] font-bold uppercase text-ink">{participant.name}</p>
          <p className="text-[10px] font-mono opacity-50 uppercase text-ink">{participant.isFacilitator ? 'Facilitator' : 'Estimator'}</p>
        </div>
        <button 
          onClick={onToggleTheme}
          className="p-2 border-2 border-line hover:bg-ink hover:text-bg transition-all text-ink"
          title="Toggle Theme"
        >
          {theme === 'light' ? <Clock className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <button 
          onClick={onLeave}
          className="p-2 border-2 border-line hover:bg-ink hover:text-bg transition-all text-ink"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}

function IssueList({ session, isFacilitator, onAddIssue, onSelectIssue, onOpenJira }: { 
  session: Session, 
  isFacilitator: boolean, 
  onAddIssue: (s: string) => void,
  onSelectIssue: (id: string) => void,
  onOpenJira: () => void
}) {
  const [newIssue, setNewIssue] = useState('');

  return (
    <div className="bg-surface border-2 border-line flex flex-col h-[600px] shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] dark:shadow-[8px_8px_0px_0px_rgba(0,0,0,0.5)]">
      <div className="p-4 border-b-2 border-line bg-muted flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-ink" />
          <h3 className="text-[11px] font-black uppercase tracking-widest text-ink">Backlog</h3>
        </div>
        <div className="flex items-center gap-2">
          {isFacilitator && (
            <button 
              onClick={onOpenJira}
              title="Import from Jira"
              className="p-1.5 border-2 border-line bg-surface hover:bg-ink hover:text-bg transition-all flex items-center gap-2 text-[9px] font-black uppercase tracking-widest group text-ink"
            >
              <SiJira size={14} color="#0052CC" />
              Jira
            </button>
          )}
          <span className="text-[10px] font-mono bg-ink text-bg px-2 py-0.5">{session.issues.length}</span>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto divide-y-2 divide-line/10">
        {session.issues.length === 0 ? (
          <div className="p-12 text-center opacity-40 flex flex-col items-center gap-4">
            <Database className="w-8 h-8 opacity-20 text-ink" />
            <p className="text-xs font-mono uppercase tracking-widest text-ink">Empty Backlog</p>
          </div>
        ) : (
          session.issues.map(issue => (
            <button
              key={issue.id}
              onClick={() => onSelectIssue(issue.id)}
              className={cn(
                "w-full p-4 text-left transition-all relative group",
                session.currentIssueId === issue.id 
                  ? "bg-ink text-bg" 
                  : "hover:bg-muted text-ink"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {issue.key && (
                      <span className={cn(
                        "text-[9px] font-mono px-1.5 py-0.5 border",
                        session.currentIssueId === issue.id ? "border-bg/30 text-bg/70" : "border-line/20 text-ink/50"
                      )}>
                        {issue.key}
                      </span>
                    )}
                    {issue.status === 'COMPLETED' && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                  </div>
                  <p className="text-sm font-bold leading-tight truncate group-hover:whitespace-normal group-hover:line-clamp-2 transition-all">
                    {issue.summary}
                  </p>
                </div>
                {issue.estimate && (
                  <div className={cn(
                    "text-lg font-black italic",
                    session.currentIssueId === issue.id ? "text-bg" : "text-ink"
                  )}>
                    {issue.estimate}
                  </div>
                )}
              </div>
            </button>
          ))
        )}
      </div>

      {isFacilitator && (
        <div className="p-4 border-t-2 border-line bg-muted">
          <div className="flex gap-2">
            <input 
              type="text" 
              value={newIssue}
              onChange={(e) => setNewIssue(e.target.value)}
              placeholder="Add issue title..."
              className="flex-1 bg-surface border-2 border-line p-3 text-xs focus:outline-none font-mono text-ink"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newIssue.trim()) {
                  onAddIssue(newIssue.trim());
                  setNewIssue('');
                }
              }}
            />
            <button 
              onClick={() => {
                if (newIssue.trim()) {
                  onAddIssue(newIssue.trim());
                  setNewIssue('');
                }
              }}
              className="p-3 bg-ink text-bg border-2 border-line hover:opacity-90 transition-all"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PokerTable({ session, participant, onVote, onReveal, onReset, onComplete, onSyncJira, onToggleAnonymous }: { 
  session: Session, 
  participant: Participant,
  onVote: (v: string) => void,
  onReveal: () => void,
  onReset: () => void,
  onComplete: (e: string) => void,
  onSyncJira: (e: string) => void,
  onToggleAnonymous: (isAnonymous: boolean) => void
}) {
  const currentIssue = session.issues.find(i => i.id === session.currentIssueId);
  const scale = session.mode === 'FIBONACCI' ? FIBONACCI_SCALE : TSHIRT_SCALE;
  
  const participants = Object.values(session.participants);
  const votes = participants.map(p => p.vote).filter(Boolean);
  const allVoted = votes.length === participants.length;
  const currentParticipantVote = session.participants[participant.id]?.vote;

  const consensus = useMemo(() => {
    if (!session.isRevealed || votes.length === 0) return null;
    const counts: Record<string, number> = {};
    votes.forEach(v => counts[v!] = (counts[v!] || 0) + 1);
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0][0];
  }, [session.isRevealed, votes]);

  return (
    <div className="flex flex-col gap-8">
      {/* Current Issue Display */}
      <div className="bg-surface border-2 border-line p-8 shadow-[12px_12px_0px_0px_rgba(20,20,20,1)] dark:shadow-[12px_12px_0px_0px_rgba(0,0,0,0.5)]">
        {currentIssue ? (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-black bg-ink text-bg px-2 py-1 uppercase tracking-[0.2em]">Current Issue</span>
                {currentIssue.key && (
                  <span className="text-[10px] font-mono bg-accent text-white px-2 py-1 uppercase tracking-widest flex items-center gap-1.5 font-bold">
                    <SiJira size={12} /> {currentIssue.key}
                  </span>
                )}
              </div>
              {participant.isFacilitator && currentIssue.status === 'COMPLETED' && currentIssue.key && (
                <button 
                  onClick={() => onSyncJira(currentIssue.estimate || '0')}
                  className="px-4 py-2 bg-accent text-white hover:bg-blue-600 transition-all flex items-center gap-2 text-[10px] font-black uppercase tracking-widest shadow-[4px_4px_0px_0px_rgba(0,82,204,0.3)]"
                >
                  <SiJira size={16} /> Sync to Jira
                </button>
              )}
            </div>
            <div className="space-y-2">
              <h2 className="text-5xl font-black italic tracking-tighter leading-none text-ink">{currentIssue.summary}</h2>
              {currentIssue.description && (
                <div className="p-4 bg-muted border-l-4 border-line mt-4">
                  <p className="text-sm opacity-60 font-mono line-clamp-4 whitespace-pre-wrap text-ink">{currentIssue.description}</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="py-20 text-center flex flex-col items-center gap-6">
            <div className="w-20 h-20 bg-muted border-2 border-line flex items-center justify-center">
              <Play className="w-10 h-10 opacity-20 text-ink" />
            </div>
            <div>
              <h3 className="text-xl font-black uppercase tracking-widest mb-2 text-ink">Ready to Estimate</h3>
              <p className="text-sm opacity-40 italic max-w-xs mx-auto text-ink">Select an issue from the backlog to start the voting session.</p>
            </div>
          </div>
        )}
      </div>

      {/* Voting Area */}
      {currentIssue && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-12">
            {/* Participants Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-6">
              {participants.map(p => (
                <div key={p.id} className="flex flex-col items-center gap-3">
                  <div className={cn(
                    "w-20 h-28 border-2 flex items-center justify-center transition-all duration-300 relative",
                    p.vote 
                      ? "border-line bg-surface shadow-[6px_6px_0px_0px_rgba(20,20,20,1)] dark:shadow-[6px_6px_0px_0px_rgba(0,0,0,0.5)]" 
                      : "border-dashed border-line/20",
                    session.isRevealed && p.vote && "scale-110"
                  )}>
                    {p.vote ? (
                      session.isRevealed ? (
                        p.isAnonymous ? (
                          <span className="text-3xl font-black italic text-ink opacity-50">?</span>
                        ) : (
                          <span className="text-3xl font-black italic text-ink">{p.vote}</span>
                        )
                      ) : (
                        <div className="w-full h-full bg-ink flex items-center justify-center">
                          <CheckCircle2 className="w-6 h-6 text-bg" />
                        </div>
                      )
                    ) : null}
                    {p.id === participant.id && (
                      <div className="absolute -top-2 -right-2 bg-ink text-bg text-[9px] font-black uppercase px-2 py-0.5">You</div>
                    )}
                  </div>
                  <span className="text-[11px] font-black uppercase tracking-widest truncate w-full text-center text-ink">{p.name}</span>
                </div>
              ))}
            </div>

            {/* Voting Controls */}
            {!session.isRevealed ? (
              <div className="space-y-10">
                <div className="flex flex-wrap justify-center gap-4">
                  {scale.map(val => (
                    <button
                      key={val}
                      onClick={() => onVote(val)}
                      className={cn(
                        "w-14 h-20 border-2 font-black italic text-2xl transition-all",
                        currentParticipantVote === val
                          ? "bg-ink text-bg border-line -translate-y-2 shadow-[6px_6px_0px_0px_rgba(0,0,0,0.2)]"
                          : "bg-surface border-line text-ink hover:-translate-y-1 hover:shadow-[6px_6px_0px_0px_rgba(20,20,20,1)]"
                      )}
                    >
                      {val}
                    </button>
                  ))}
                </div>
                
                <div className="flex justify-center mt-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={!!participant.isAnonymous}
                      onChange={(e) => onToggleAnonymous(e.target.checked)}
                      className="w-4 h-4 accent-ink"
                    />
                    <span className="text-sm font-mono text-ink">Vote anonymously</span>
                  </label>
                </div>

                {participant.isFacilitator && (
                  <div className="flex justify-center">
                    <button
                      onClick={onReveal}
                      disabled={votes.length === 0}
                      className="bg-ink text-bg px-12 py-4 font-black uppercase tracking-[0.2em] hover:opacity-90 transition-all disabled:opacity-50 shadow-[8px_8px_0px_0px_rgba(0,0,0,0.2)]"
                    >
                      Reveal Votes
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-12">
                <div className="flex flex-wrap justify-center gap-8">
                  <VoteDistribution session={session} />
                </div>

                {participant.isFacilitator && (
                  <div className="flex flex-col gap-6 w-full max-w-md">
                    <div className="grid grid-cols-2 gap-4">
                      <button
                        onClick={onReset}
                        className="bg-surface border-2 border-line p-4 font-black uppercase tracking-widest hover:bg-muted transition-all flex items-center justify-center gap-2 text-ink"
                      >
                        <RotateCcw className="w-4 h-4" /> Revote
                      </button>
                      {consensus && (
                        <button
                          onClick={() => onComplete(consensus)}
                          className="bg-ink text-bg p-4 font-black uppercase tracking-widest hover:opacity-90 transition-all flex items-center justify-center gap-2"
                        >
                          <CheckCircle2 className="w-4 h-4" /> Finalize: {consensus}
                        </button>
                      )}
                    </div>
                    {!consensus && (
                      <div className="space-y-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-center opacity-50 text-ink">Manual Finalize</p>
                        <div className="flex flex-wrap justify-center gap-2">
                          {scale.filter(v => v !== '?' && v !== '☕').map(v => (
                            <button
                              key={v}
                              onClick={() => onComplete(v)}
                              className="px-4 py-2 border-2 border-line font-black italic hover:bg-ink hover:text-bg transition-all text-ink"
                            >
                              {v}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Stats Sidebar */}
          <div className="space-y-6">
            <div className="bg-muted border-2 border-line p-6 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] dark:shadow-[8px_8px_0px_0px_rgba(0,0,0,0.5)]">
              <h3 className="text-[10px] font-black uppercase tracking-widest mb-6 opacity-50 text-ink">Session Stats</h3>
              <div className="space-y-6">
                <div className="flex justify-between items-end">
                  <span className="text-[10px] font-mono uppercase text-ink">Participation</span>
                  <span className="text-2xl font-black italic text-ink">{votes.length}/{participants.length}</span>
                </div>
                <div className="w-full h-3 bg-surface border-2 border-line">
                  <div 
                    className="h-full bg-ink transition-all duration-500" 
                    style={{ width: `${(votes.length / participants.length) * 100}%` }}
                  />
                </div>
                {session.isRevealed && consensus && (
                  <div className="pt-4 border-t border-line/10">
                    <p className="text-[10px] font-mono uppercase mb-1 opacity-50 text-ink">Consensus</p>
                    <p className="text-3xl font-black italic text-ink">{consensus}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RefinementBoard({ session, participant, sendMessage }: {
  session: Session,
  participant: Participant,
  sendMessage: (msg: ClientMessage) => void
}) {
  const [newSticker, setNewSticker] = useState('');
  const [timerInput, setTimerInput] = useState('3');

  const stickers = Object.values(session.stickers || {});
  const isTimerRunning = session.timerStart && session.timerDuration;
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  const [isCategorizing, setIsCategorizing] = useState(false);
  
  const [isAtlassianConnected, setIsAtlassianConnected] = useState(false);
  const [projects, setProjects] = useState<any[]>([]);
  const [spaces, setSpaces] = useState<any[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [selectedSpace, setSelectedSpace] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState(false);

  const phase = session.refinementPhase || 'BRAINSTORM';
  const MAX_VOTES = 3;
  const myVotesUsed = Object.values(session.stickerGroups || {}).reduce((acc, g) => acc + (g.votes?.[participant.id] || 0), 0);

  const nextPhase = () => {
    const phases: RefinementPhase[] = ['BRAINSTORM', 'GROUPING', 'VOTING', 'PRIORITIZATION', 'ANALYSIS', 'COMPLEXITY_RANKING', 'QUICK_WINS'];
    const idx = phases.indexOf(phase);
    if (idx < phases.length - 1) {
      const next = phases[idx + 1];
      if (next === 'PRIORITIZATION') {
        const sorted = Object.values(session.stickerGroups || {})
          .sort((a, b) => {
            const aVotes = Object.values(a.votes || {}).reduce((sum, v) => sum + v, 0);
            const bVotes = Object.values(b.votes || {}).reduce((sum, v) => sum + v, 0);
            return bVotes - aVotes;
          })
          .map(g => g.id);
        sendMessage({ type: 'UPDATE_GROUP_RANKING', sessionId: session.id, ranking: sorted });
      }
      if (next === 'COMPLEXITY_RANKING') {
        const sorted = (session.analysis?.actionItems || []).map(a => a.id);
        sendMessage({ type: 'UPDATE_COMPLEXITY_RANKING', sessionId: session.id, ranking: sorted });
      }
      sendMessage({ type: 'SET_REFINEMENT_PHASE', sessionId: session.id, phase: next });
    }
  };

  const prevPhase = () => {
    const phases: RefinementPhase[] = ['BRAINSTORM', 'GROUPING', 'VOTING', 'PRIORITIZATION', 'ANALYSIS', 'COMPLEXITY_RANKING', 'QUICK_WINS'];
    const idx = phases.indexOf(phase);
    if (idx > 0) {
      sendMessage({ type: 'SET_REFINEMENT_PHASE', sessionId: session.id, phase: phases[idx - 1] });
    }
  };

  const handleVoteGroup = (groupId: string, delta: number) => {
    if (delta > 0 && myVotesUsed >= MAX_VOTES) return;
    sendMessage({ type: 'VOTE_GROUP', sessionId: session.id, groupId, participantId: participant.id, delta });
  };

  const moveGroupPriority = (index: number, direction: -1 | 1) => {
    if (!session.groupRanking) return;
    const newRanking = [...session.groupRanking];
    if (index + direction < 0 || index + direction >= newRanking.length) return;
    const temp = newRanking[index];
    newRanking[index] = newRanking[index + direction];
    newRanking[index + direction] = temp;
    sendMessage({ type: 'UPDATE_GROUP_RANKING', sessionId: session.id, ranking: newRanking });
  };

  const moveComplexity = (index: number, direction: -1 | 1) => {
    if (!session.complexityRanking) return;
    const newRanking = [...session.complexityRanking];
    if (index + direction < 0 || index + direction >= newRanking.length) return;
    const temp = newRanking[index];
    newRanking[index] = newRanking[index + direction];
    newRanking[index + direction] = temp;
    sendMessage({ type: 'UPDATE_COMPLEXITY_RANKING', sessionId: session.id, ranking: newRanking });
  };

  const calculateQuickWins = () => {
    if (!session.analysis || !session.groupRanking || !session.complexityRanking) return [];
    
    const totalGroups = session.groupRanking.length;
    
    return session.analysis.actionItems.map(action => {
      const complexityScore = session.complexityRanking!.indexOf(action.id); 
      
      let valueScore = 0;
      let groupVotes = 0;
      let groupTitles: string[] = [];

      if (action.linkedGroupIds && action.linkedGroupIds.length > 0) {
        valueScore = action.linkedGroupIds.reduce((sum, gid) => {
          const g = session.stickerGroups![gid];
          if (!g) return sum;
          const votes = Object.values(g.votes || {}).reduce((a, b) => a + b, 0);
          groupVotes += votes;
          groupTitles.push(g.title);
          const priorityRank = session.groupRanking!.indexOf(gid);
          const priorityScore = priorityRank >= 0 ? (totalGroups - priorityRank) : 0;
          return sum + (votes * 2) + priorityScore;
        }, 0) / action.linkedGroupIds.length;
      }

      const quickWinIndex = valueScore / (complexityScore + 1);

      return { ...action, quickWinIndex, valueScore, complexityScore, groupVotes, groupTitles };
    }).sort((a, b) => {
      if (b.groupVotes !== a.groupVotes) {
        return b.groupVotes - a.groupVotes; // Sort by group votes first
      }
      return b.quickWinIndex - a.quickWinIndex; // Then by quick win index (value vs complexity)
    });
  };

  useEffect(() => {
    const checkConnection = async () => {
      try {
        const [projRes, spaceRes] = await Promise.all([
          fetch('/api/jira/projects'),
          fetch('/api/confluence/spaces')
        ]);
        if (projRes.ok && spaceRes.ok) {
          setIsAtlassianConnected(true);
          const projData = await projRes.json();
          const spaceData = await spaceRes.json();
          setProjects(projData);
          setSpaces(spaceData);
          if (projData.length > 0) setSelectedProject(projData[0].id);
          if (spaceData.length > 0) setSelectedSpace(spaceData[0].key);
        }
      } catch (err) {
        console.error("Not connected to Atlassian");
      }
    };
    checkConnection();
  }, []);

  const connectAtlassian = async () => {
    setIsConnecting(true);
    try {
      const res = await fetch('/api/auth/jira/url');
      const { url } = await res.json();
      const authWindow = window.open(url, 'jira_auth', 'width=600,height=800');
      
      const handleMessage = async (event: MessageEvent) => {
        if (event.data?.type === 'JIRA_AUTH_SUCCESS') {
          setIsAtlassianConnected(true);
          const [projRes, spaceRes] = await Promise.all([
            fetch('/api/jira/projects'),
            fetch('/api/confluence/spaces')
          ]);
          if (projRes.ok && spaceRes.ok) {
            const projData = await projRes.json();
            const spaceData = await spaceRes.json();
            setProjects(projData);
            setSpaces(spaceData);
            if (projData.length > 0) setSelectedProject(projData[0].id);
            if (spaceData.length > 0) setSelectedSpace(spaceData[0].key);
          }
          window.removeEventListener('message', handleMessage);
        }
      };
      window.addEventListener('message', handleMessage);
    } catch (err) {
      console.error(err);
    } finally {
      setIsConnecting(false);
    }
  };

  useEffect(() => {
    if (isTimerRunning) {
      const elapsed = Date.now() - session.timerStart!;
      const remaining = Math.max(0, session.timerDuration! - elapsed);
      setTimeLeft(remaining);

      if (remaining === 0) {
        if (participant.isFacilitator && (!session.analysis) && !isCategorizing) {
          performAnalysis();
        }
        return;
      }

      const interval = setInterval(() => {
        const currentElapsed = Date.now() - session.timerStart!;
        const currentRemaining = Math.max(0, session.timerDuration! - currentElapsed);
        setTimeLeft(currentRemaining);
        if (currentRemaining === 0) {
          clearInterval(interval);
          if (participant.isFacilitator && (!session.analysis) && !isCategorizing) {
            performAnalysis();
          }
        }
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setTimeLeft(null);
      setIsCategorizing(false);
    }
  }, [isTimerRunning, session.timerStart, session.timerDuration, participant.isFacilitator, session.categories, session.id, sendMessage, isCategorizing]);

  const handleAddSticker = () => {
    if (newSticker.trim()) {
      sendMessage({
        type: 'ADD_STICKER',
        sessionId: session.id,
        sticker: {
          id: uuidv4(),
          participantId: participant.id,
          text: newSticker.trim()
        }
      });
      setNewSticker('');
    }
  };

  const performGrouping = async () => {
    if (!session.stickers || Object.keys(session.stickers).length === 0) return;
    setIsCategorizing(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const stickersList = Object.values(session.stickers).map(s => ({ id: s.id, text: s.text }));
      
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `Group the following feedback items into logical themes.
        Return a JSON array of groups, where each group has a "title" and an array of "stickerIds".
        Stickers: ${JSON.stringify(stickersList)}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                stickerIds: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ["title", "stickerIds"]
            }
          }
        }
      });

      const result = JSON.parse(response.text || "[]");
      const newGroups: Record<string, StickerGroup> = {};
      const stickerUpdates: Record<string, string> = {};

      result.forEach((g: any) => {
        const groupId = `group-${uuidv4()}`;
        newGroups[groupId] = {
          id: groupId,
          title: g.title,
          votes: {}
        };
        g.stickerIds.forEach((sid: string) => {
          stickerUpdates[sid] = groupId;
        });
      });

      // Handle any stickers that weren't grouped
      const ungroupedStickers = Object.keys(session.stickers).filter(sid => !stickerUpdates[sid]);
      if (ungroupedStickers.length > 0) {
        const ungroupedId = `group-ungrouped`;
        newGroups[ungroupedId] = {
          id: ungroupedId,
          title: "Other / Ungrouped",
          votes: {}
        };
        ungroupedStickers.forEach(sid => {
          stickerUpdates[sid] = ungroupedId;
        });
      }

      sendMessage({ type: 'SET_GROUPS', sessionId: session.id, groups: newGroups, stickerUpdates });
      sendMessage({ type: 'SET_REFINEMENT_PHASE', sessionId: session.id, phase: 'GROUPING' });
    } catch (err) {
      console.error("Grouping error:", err);
    } finally {
      setIsCategorizing(false);
    }
  };

  const performAnalysis = async () => {
    if (!session.stickerGroups || Object.keys(session.stickerGroups).length === 0) return;
    setIsCategorizing(true);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const groupsList = Object.values(session.stickerGroups).map(g => {
        const totalVotes = Object.values(g.votes || {}).reduce((a, b) => a + b, 0);
        const priorityRank = session.groupRanking?.indexOf(g.id) ?? -1;
        const groupStickers = Object.values(session.stickers || {}).filter(s => s.groupId === g.id).map(s => s.text);
        return { 
          id: g.id, 
          title: g.title,
          stickers: groupStickers,
          votes: totalVotes, 
          priorityRank: priorityRank >= 0 ? priorityRank + 1 : 999 
        };
      });
      
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `Analyze the following prioritized groups of feedback from a retrospective or refinement session. 
        Identify the good things, the bad things, the blockers, and the ideas. 
        Create a brief summary of the session. 
        Propose actionable items based on the feedback groups, focusing on the highest priority ones. 
        IMPORTANT: For each action item, provide an array of "linkedGroupIds" corresponding to the IDs of the groups that inspired it.
        Return a JSON object.
        Groups: ${JSON.stringify(groupsList)}`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              good: { type: Type.ARRAY, items: { type: Type.STRING } },
              bad: { type: Type.ARRAY, items: { type: Type.STRING } },
              blockers: { type: Type.ARRAY, items: { type: Type.STRING } },
              ideas: { type: Type.ARRAY, items: { type: Type.STRING } },
              actionItems: { 
                type: Type.ARRAY,
                items: { 
                  type: Type.OBJECT,
                  properties: {
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    linkedGroupIds: { type: Type.ARRAY, items: { type: Type.STRING } }
                  },
                  required: ["title", "description", "linkedGroupIds"]
                }
              }
            },
            required: ["summary", "good", "bad", "blockers", "ideas", "actionItems"]
          }
        }
      });

      const result = JSON.parse(response.text || "{}");
      
      const actionItemsWithIds = (result.actionItems || []).map((item: any) => ({
        id: uuidv4(),
        title: item.title,
        description: item.description,
        linkedGroupIds: item.linkedGroupIds || []
      }));

      const analysis = {
        summary: result.summary || "",
        good: result.good || [],
        bad: result.bad || [],
        blockers: result.blockers || [],
        ideas: result.ideas || [],
        actionItems: actionItemsWithIds
      };
      
      sendMessage({ type: 'SAVE_ANALYSIS', sessionId: session.id, analysis });
    } catch (err) {
      console.error("Analysis error:", err);
    } finally {
      setIsCategorizing(false);
    }
  };

  const handleStartTimer = () => {
    const duration = parseInt(timerInput) * 60 * 1000;
    if (!isNaN(duration) && duration > 0) {
      sendMessage({ type: 'START_TIMER', sessionId: session.id, duration });
    }
  };

  const handleAnalyze = () => {
    performAnalysis();
  };

  const performFinalAnalysis = async () => {
    const quickWins = calculateQuickWins();
    if (quickWins.length === 0) return;
    
    setIsCategorizing(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      const response = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: `Based on the following prioritized action items (sorted primarily by the votes of their parent groups, then by Quick Win Index: high value, low complexity), generate a final execution plan and summary for the team.
        The action items are derived from grouped feedback. Pay special attention to the "groupVotes" and "groupTitles" fields, as action items from highly voted groups are listed first and should be addressed first.
        
        Action Items:
        ${JSON.stringify(quickWins.map(qw => ({ id: qw.id, title: qw.title, description: qw.description, valueScore: qw.valueScore, complexityScore: qw.complexityScore, quickWinIndex: qw.quickWinIndex, groupVotes: qw.groupVotes, groupTitles: qw.groupTitles })))}
        
        Return a JSON object with:
        - summary: A brief encouraging summary of the plan, explicitly mentioning the top themes/groups that the team prioritized based on votes.
        - rankedItems: An array of objects containing the actionItemId and a brief justification for its priority (mentioning its group's votes or value vs complexity).`,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              rankedItems: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    actionItemId: { type: Type.STRING },
                    justification: { type: Type.STRING }
                  },
                  required: ["actionItemId", "justification"]
                }
              }
            },
            required: ["summary", "rankedItems"]
          }
        }
      });

      const result = JSON.parse(response.text || "{}");
      sendMessage({ type: 'SAVE_FINAL_ANALYSIS', sessionId: session.id, analysis: result });
    } catch (error) {
      console.error("Final analysis failed:", error);
    } finally {
      setIsCategorizing(false);
    }
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Group stickers by category combinations
  const groupedStickers = useMemo(() => {
    const groups: Record<string, typeof stickers> = {};
    
    stickers.forEach(s => {
      let key = 'Uncategorized';
      if (s.categories && s.categories.length > 0) {
        key = [...s.categories].sort().join(' + ');
      }
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(s);
    });
    return groups;
  }, [stickers]);

  return (
    <div className="flex flex-col gap-8">
      <div className="bg-surface border-2 border-line p-8 shadow-[12px_12px_0px_0px_rgba(20,20,20,1)] dark:shadow-[12px_12px_0px_0px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-black italic text-ink">Refinement Board</h2>
            <p className="text-[10px] font-mono uppercase tracking-widest opacity-50 text-ink">
              Phase: {phase.replace('_', ' ')}
            </p>
          </div>
          
          <div className="flex items-center gap-4">
            {participant.isFacilitator && (
              <div className="flex items-center gap-2 mr-4">
                <button 
                  onClick={prevPhase}
                  disabled={phase === 'BRAINSTORM'}
                  className="bg-muted text-ink border-2 border-line px-3 py-1 font-bold uppercase tracking-widest hover:bg-line hover:text-bg transition-all text-xs disabled:opacity-50"
                >
                  &larr; Prev
                </button>
                <button 
                  onClick={nextPhase}
                  disabled={phase === 'QUICK_WINS'}
                  className="bg-ink text-bg px-3 py-1 font-bold uppercase tracking-widest hover:opacity-90 transition-all text-xs disabled:opacity-50"
                >
                  Next &rarr;
                </button>
              </div>
            )}

            {phase === 'BRAINSTORM' && isTimerRunning && timeLeft !== null ? (
              <div className="text-3xl font-mono font-black text-ink">
                {formatTime(timeLeft)}
              </div>
            ) : phase === 'BRAINSTORM' && participant.isFacilitator ? (
              <div className="flex items-center gap-2">
                <input 
                  type="number" 
                  value={timerInput}
                  onChange={(e) => setTimerInput(e.target.value)}
                  className="w-16 bg-muted border-2 border-line p-2 font-mono text-center text-ink focus:outline-none"
                  min="1"
                  max="60"
                />
                <span className="text-[10px] font-black uppercase tracking-widest text-ink">min</span>
                <button 
                  onClick={handleStartTimer}
                  className="bg-ink text-bg px-4 py-2 font-bold uppercase tracking-widest hover:opacity-90 transition-all text-xs"
                >
                  Start Timer
                </button>
              </div>
            ) : null}
            
            {phase === 'GROUPING' && participant.isFacilitator && (
              <button 
                onClick={performGrouping}
                disabled={stickers.length === 0 || isCategorizing}
                className="bg-accent text-white px-4 py-2 font-bold uppercase tracking-widest hover:opacity-90 transition-all text-xs disabled:opacity-50"
              >
                {isCategorizing ? 'Grouping...' : 'Group (AI)'}
              </button>
            )}
            
            {phase === 'ANALYSIS' && participant.isFacilitator && (
              <button 
                onClick={handleAnalyze}
                disabled={!session.stickerGroups || Object.keys(session.stickerGroups).length === 0 || isCategorizing}
                className="bg-accent text-white px-4 py-2 font-bold uppercase tracking-widest hover:opacity-90 transition-all text-xs disabled:opacity-50"
              >
                {isCategorizing ? 'Analyzing...' : 'Analyze (AI)'}
              </button>
            )}
          </div>
        </div>

        {phase === 'BRAINSTORM' && (
          <>
            <div className="flex gap-2 mb-8">
              <input 
                type="text" 
                value={newSticker}
                onChange={(e) => setNewSticker(e.target.value)}
                placeholder="Write a thought, question, or feedback..."
                className="flex-1 bg-muted border-2 border-line p-4 font-mono text-ink focus:outline-none focus:bg-surface transition-colors"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddSticker();
                }}
              />
              <button 
                onClick={handleAddSticker}
                disabled={!newSticker.trim()}
                className="bg-ink text-bg px-8 py-4 font-black uppercase tracking-widest hover:opacity-90 transition-all disabled:opacity-50"
              >
                Add
              </button>
            </div>
            <div className="flex flex-wrap gap-4">
              <AnimatePresence>
                {stickers.map(sticker => (
                  <motion.div 
                    key={sticker.id}
                    layout
                    initial={{ opacity: 0, scale: 0.8, rotate: Math.random() * 10 - 5 }}
                    animate={{ opacity: 1, scale: 1, rotate: Math.random() * 10 - 5 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="bg-[#FEF08A] dark:bg-[#854D0E] border-2 border-line p-4 w-48 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] dark:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] flex flex-col justify-between"
                  >
                    <p className="text-sm font-mono text-ink mb-4 break-words">{sticker.text}</p>
                    <div className="flex justify-between items-center">
                      <p className="text-[9px] font-bold uppercase opacity-50 text-ink">
                        {session.participants[sticker.participantId]?.name || 'Unknown'}
                      </p>
                      {participant.id === sticker.participantId && (
                        <button 
                          onClick={() => sendMessage({ type: 'REMOVE_STICKER', sessionId: session.id, stickerId: sticker.id })}
                          className="opacity-50 hover:opacity-100 text-ink"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {stickers.length === 0 && (
                <div className="w-full py-12 flex flex-col items-center justify-center opacity-30">
                  <p className="text-sm font-black uppercase tracking-widest text-ink">No stickers yet</p>
                  <p className="text-[10px] font-mono uppercase text-ink">Add some thoughts above</p>
                </div>
              )}
            </div>
          </>
        )}

        {phase === 'GROUPING' && (
          <div className="space-y-8">
            <p className="text-sm font-mono text-ink mb-4">Cards are grouped by similarity. Facilitator can run AI grouping.</p>
            <div className="flex flex-wrap gap-8">
              {Object.values(session.stickerGroups || {}).map(group => {
                const groupStickers = stickers.filter(s => s.groupId === group.id);
                return (
                  <div key={group.id} className="bg-muted border-2 border-line p-4 w-80 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] dark:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)]">
                    <h3 className="font-black text-lg text-ink mb-4 border-b-2 border-line pb-2">{group.title}</h3>
                    <div className="flex flex-col gap-2">
                      {groupStickers.map(sticker => (
                        <div key={sticker.id} className="bg-surface border border-line p-2 text-sm font-mono text-ink">
                          {sticker.text}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {phase === 'VOTING' && (
          <>
            <div className="mb-4 flex justify-between items-center bg-muted border-2 border-line p-4">
              <span className="font-bold text-ink uppercase tracking-widest text-sm">Your Votes (On Groups)</span>
              <span className="font-mono text-ink bg-surface px-3 py-1 border-2 border-line">
                {MAX_VOTES - myVotesUsed} / {MAX_VOTES} remaining
              </span>
            </div>
            <div className="flex flex-wrap gap-8">
              {Object.values(session.stickerGroups || {}).map(group => {
                const totalVotes = Object.values(group.votes || {}).reduce((a, b) => a + b, 0);
                const myVotes = group.votes?.[participant.id] || 0;
                const groupStickers = stickers.filter(s => s.groupId === group.id);
                return (
                  <motion.div 
                    key={group.id}
                    layout
                    className="bg-[#FEF08A] dark:bg-[#854D0E] border-2 border-line p-4 w-80 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] dark:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] flex flex-col justify-between relative"
                  >
                    <div>
                      <h3 className="font-black text-lg text-ink mb-4">{group.title}</h3>
                      <div className="flex flex-col gap-2 mb-8 opacity-80">
                        {groupStickers.map(sticker => (
                          <div key={sticker.id} className="text-xs font-mono text-ink border-l-2 border-ink pl-2">
                            {sticker.text}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex justify-between items-center border-t-2 border-line/20 pt-2">
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => handleVoteGroup(group.id, -1)}
                          disabled={myVotes === 0}
                          className="w-6 h-6 flex items-center justify-center bg-surface border-2 border-line text-ink disabled:opacity-50"
                        >-</button>
                        <span className="font-mono text-xs font-bold w-4 text-center">{myVotes}</span>
                        <button 
                          onClick={() => handleVoteGroup(group.id, 1)}
                          disabled={myVotesUsed >= MAX_VOTES}
                          className="w-6 h-6 flex items-center justify-center bg-surface border-2 border-line text-ink disabled:opacity-50"
                        >+</button>
                      </div>
                      <div className="text-xs font-black bg-ink text-bg px-2 py-1">
                        {totalVotes} Total
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </>
        )}

        {phase === 'PRIORITIZATION' && (
          <div className="space-y-4">
            <p className="text-sm font-mono text-ink mb-4">Rank the groups by priority. Top is most important.</p>
            {session.groupRanking?.map((groupId, index) => {
              const group = session.stickerGroups?.[groupId];
              if (!group) return null;
              const totalVotes = Object.values(group.votes || {}).reduce((a, b) => a + b, 0);
              return (
                <div key={groupId} className="flex items-center gap-4 bg-muted border-2 border-line p-4">
                  <div className="flex flex-col gap-1">
                    <button onClick={() => moveGroupPriority(index, -1)} disabled={index === 0} className="p-1 hover:bg-line disabled:opacity-30 text-ink">
                      ▲
                    </button>
                    <button onClick={() => moveGroupPriority(index, 1)} disabled={index === session.groupRanking!.length - 1} className="p-1 hover:bg-line disabled:opacity-30 text-ink">
                      ▼
                    </button>
                  </div>
                  <div className="font-black text-xl text-ink w-8 text-center">{index + 1}</div>
                  <div className="flex-1">
                    <p className="font-bold text-lg text-ink">{group.title}</p>
                    <p className="font-mono text-xs text-ink opacity-70 mt-1">
                      {stickers.filter(s => s.groupId === group.id).length} cards
                    </p>
                  </div>
                  <div className="text-xs font-black bg-ink text-bg px-2 py-1 whitespace-nowrap">
                    {totalVotes} Votes
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(phase === 'ANALYSIS' || phase === 'COMPLEXITY_RANKING' || phase === 'QUICK_WINS') && session.analysis && (
        <div className="bg-surface border-2 border-line p-8 shadow-[12px_12px_0px_0px_rgba(20,20,20,1)] dark:shadow-[12px_12px_0px_0px_rgba(0,0,0,0.5)]">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-black italic text-ink">AI Analysis & Action Items</h2>
            </div>
            
            {participant.isFacilitator && (
              <div className="flex items-center gap-4">
                {!isAtlassianConnected ? (
                  <button 
                    onClick={connectAtlassian}
                    disabled={isConnecting}
                    className="bg-[#0052CC] text-white px-4 py-2 font-bold uppercase tracking-widest hover:opacity-90 transition-all text-xs flex items-center gap-2 disabled:opacity-50"
                  >
                    <SiJira size={16} />
                    Connect Atlassian
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <select 
                      value={selectedSpace}
                      onChange={(e) => setSelectedSpace(e.target.value)}
                      className="bg-muted border-2 border-line p-2 text-xs font-mono text-ink focus:outline-none max-w-[150px]"
                    >
                      {spaces.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                    </select>
                    <button 
                      onClick={() => sendMessage({ type: 'EXPORT_TO_CONFLUENCE', sessionId: session.id, spaceKey: selectedSpace })}
                      className="bg-ink text-bg px-4 py-2 font-bold uppercase tracking-widest hover:opacity-90 transition-all text-xs"
                    >
                      Export to Confluence
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {session.analysis.confluenceUrl && (
            <div className="mb-8 p-4 bg-green-100 dark:bg-green-900 border-2 border-green-500 text-green-800 dark:text-green-100 font-mono text-sm flex justify-between items-center">
              <span>Successfully exported to Confluence!</span>
              <a href={session.analysis.confluenceUrl} target="_blank" rel="noopener noreferrer" className="underline font-bold">View Page</a>
            </div>
          )}

          {phase === 'ANALYSIS' && (
            <div className="space-y-8">
              <div>
                <h3 className="text-sm font-black uppercase tracking-widest mb-2 text-ink border-b-2 border-line pb-2">Summary</h3>
                <p className="text-sm font-mono text-ink leading-relaxed">{session.analysis.summary}</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest mb-2 text-green-600 border-b-2 border-green-600 pb-2">The Good</h3>
                  <ul className="list-disc list-inside space-y-2">
                    {session.analysis.good.map((item, i) => (
                      <li key={i} className="text-sm font-mono text-ink">{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest mb-2 text-red-600 border-b-2 border-red-600 pb-2">The Bad</h3>
                  <ul className="list-disc list-inside space-y-2">
                    {session.analysis.bad.map((item, i) => (
                      <li key={i} className="text-sm font-mono text-ink">{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest mb-2 text-orange-600 border-b-2 border-orange-600 pb-2">Blockers</h3>
                  <ul className="list-disc list-inside space-y-2">
                    {session.analysis.blockers.map((item, i) => (
                      <li key={i} className="text-sm font-mono text-ink">{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase tracking-widest mb-2 text-blue-600 border-b-2 border-blue-600 pb-2">Ideas</h3>
                  <ul className="list-disc list-inside space-y-2">
                    {session.analysis.ideas.map((item, i) => (
                      <li key={i} className="text-sm font-mono text-ink">{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {phase === 'COMPLEXITY_RANKING' && (
            <div className="space-y-4">
              <p className="text-sm font-mono text-ink mb-4">Rank the action items by complexity. Top is most complex.</p>
              {session.complexityRanking?.map((actionId, index) => {
                const action = session.analysis!.actionItems.find(a => a.id === actionId);
                if (!action) return null;
                return (
                  <div key={actionId} className="flex items-center gap-4 bg-muted border-2 border-line p-4">
                    <div className="flex flex-col gap-1">
                      <button onClick={() => moveComplexity(index, -1)} disabled={index === 0} className="p-1 hover:bg-line disabled:opacity-30 text-ink">
                        ▲
                      </button>
                      <button onClick={() => moveComplexity(index, 1)} disabled={index === session.complexityRanking!.length - 1} className="p-1 hover:bg-line disabled:opacity-30 text-ink">
                        ▼
                      </button>
                    </div>
                    <div className="font-black text-xl text-ink w-8 text-center">{index + 1}</div>
                    <div className="flex-1">
                      <h4 className="font-bold text-ink">{action.title}</h4>
                      <p className="font-mono text-xs text-ink opacity-70">{action.description}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {phase === 'QUICK_WINS' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-4 border-b-2 border-line pb-2">
                <h3 className="text-sm font-black uppercase tracking-widest text-ink">Prioritized Action Items (By Group Votes & Complexity)</h3>
                <div className="flex items-center gap-4">
                  {participant.isFacilitator && !session.finalAnalysis && (
                    <button 
                      onClick={performFinalAnalysis}
                      disabled={isCategorizing}
                      className="bg-accent text-white px-3 py-1 font-bold uppercase tracking-widest hover:opacity-90 transition-all text-[10px] disabled:opacity-50"
                    >
                      {isCategorizing ? 'Analyzing...' : 'Generate Final Plan (AI)'}
                    </button>
                  )}
                  {isAtlassianConnected && participant.isFacilitator && (
                    <select 
                      value={selectedProject}
                      onChange={(e) => setSelectedProject(e.target.value)}
                      className="bg-muted border-2 border-line p-1 text-xs font-mono text-ink focus:outline-none max-w-[150px]"
                    >
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                </div>
              </div>

              {session.finalAnalysis && (
                <div className="bg-accent/10 border-2 border-accent p-6 mb-8">
                  <h3 className="text-lg font-black uppercase tracking-widest text-accent mb-2">Executive Summary</h3>
                  <p className="font-mono text-sm text-ink mb-6">{session.finalAnalysis.summary}</p>
                  <h4 className="text-sm font-bold uppercase tracking-widest text-ink mb-4">Recommended Execution Order</h4>
                  <div className="space-y-4">
                    {session.finalAnalysis.rankedItems.map((rankedItem, index) => {
                      const actionItem = session.analysis!.actionItems.find(a => a.id === rankedItem.actionItemId);
                      if (!actionItem) return null;
                      return (
                        <div key={rankedItem.actionItemId} className="bg-surface border-2 border-line p-4">
                          <div className="flex items-start gap-4">
                            <div className="font-black text-xl text-accent w-8 text-center">#{index + 1}</div>
                            <div className="flex-1">
                              <h5 className="font-bold text-ink">{actionItem.title}</h5>
                              <p className="text-xs font-mono text-ink opacity-70 mt-1">{actionItem.description}</p>
                              <div className="mt-3 p-3 bg-muted border-l-4 border-accent">
                                <p className="text-xs font-mono text-ink italic">"{rankedItem.justification}"</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {!session.finalAnalysis && (
                <div className="space-y-4">
                  {calculateQuickWins().map((item, index) => (
                    <div key={item.id} className="bg-muted border-2 border-line p-4 flex justify-between items-start gap-4">
                      <div className="font-black text-2xl text-accent w-8 text-center">#{index + 1}</div>
                      <div className="flex-1">
                        <h4 className="font-bold text-ink">{item.title}</h4>
                        <p className="text-xs font-mono text-ink opacity-70 mt-1">{item.description}</p>
                        <div className="flex flex-wrap gap-2 mt-2">
                          <span className="text-[10px] font-mono bg-surface px-2 py-1 border border-line text-ink">
                            Value Score: {item.valueScore.toFixed(1)}
                          </span>
                          <span className="text-[10px] font-mono bg-surface px-2 py-1 border border-line text-ink">
                            Complexity Score: {item.complexityScore.toFixed(1)}
                          </span>
                          {item.groupTitles.length > 0 && (
                            <span className="text-[10px] font-mono bg-accent/20 px-2 py-1 border border-accent text-accent">
                              Groups: {item.groupTitles.join(', ')} ({item.groupVotes} votes)
                            </span>
                          )}
                        </div>
                      </div>
                      {item.jiraIssueKey ? (
                        <span className="bg-[#0052CC] text-white px-2 py-1 text-[10px] font-bold uppercase tracking-widest">
                          {item.jiraIssueKey}
                        </span>
                      ) : (
                        isAtlassianConnected && participant.isFacilitator && (
                          <button 
                            onClick={() => sendMessage({ type: 'CREATE_JIRA_TASK', sessionId: session.id, actionItemId: item.id, projectId: selectedProject })}
                            className="bg-ink text-bg px-3 py-1 font-bold uppercase tracking-widest hover:opacity-90 transition-all text-[10px] whitespace-nowrap"
                          >
                            Create Jira Task
                          </button>
                        )
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VoteDistribution({ session }: { session: Session }) {
  const votes = Object.values(session.participants).map(p => p.vote).filter(Boolean);
  const counts: Record<string, number> = {};
  votes.forEach(v => counts[v!] = (counts[v!] || 0) + 1);
  
  const max = Math.max(...Object.values(counts));

  return (
    <div className="space-y-3">
      {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([val, count]) => (
        <div key={val} className="flex items-center gap-4">
          <div className="w-8 font-black italic text-sm text-ink">{val}</div>
          <div className="flex-1 h-4 bg-muted border border-line relative overflow-hidden">
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${(count / max) * 100}%` }}
              className="absolute inset-0 bg-ink"
            />
          </div>
          <div className="w-8 font-mono text-[10px] text-right text-ink">{count}</div>
        </div>
      ))}
    </div>
  );
}

function ParticipantList({ session }: { session: Session }) {
  const participants = Object.values(session.participants);
  
  return (
    <div className="bg-surface border-2 border-line flex flex-col shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] dark:shadow-[8px_8px_0px_0px_rgba(0,0,0,0.5)]">
      <div className="p-4 border-b-2 border-line bg-muted flex items-center justify-between">
        <h3 className="text-[11px] font-black uppercase tracking-widest text-ink">Participants</h3>
        <span className="text-[10px] font-mono bg-ink text-bg px-1.5 py-0.5">{participants.length}</span>
      </div>
      <div className="divide-y divide-line">
        {participants.map(p => (
          <div key={p.id} className="p-4 flex items-center justify-between group">
            <div className="flex items-center gap-3">
              <div className={cn(
                "w-2 h-2 rounded-full",
                p.vote ? "bg-ink" : "bg-transparent border border-line animate-pulse"
              )} />
              <div>
                <p className="text-sm font-bold uppercase text-ink">{p.name}</p>
                {p.isFacilitator && <p className="text-[9px] font-mono opacity-40 uppercase text-ink">Facilitator</p>}
              </div>
            </div>
            <div className="flex items-center gap-2 text-ink">
              {session.isRevealed ? (
                <span className="text-lg font-black italic">
                  {p.vote ? (p.isAnonymous ? '?' : p.vote) : '-'}
                </span>
              ) : (
                p.vote && <CheckCircle2 className="w-4 h-4" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShareCard({ sessionId, theme }: { sessionId: string, theme: 'light' | 'dark' }) {
  const url = `${window.location.origin}?s=${sessionId}`;
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-surface border-2 border-line p-6 space-y-4 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] dark:shadow-[8px_8px_0px_0px_rgba(0,0,0,0.5)]">
      <h3 className="text-[11px] font-black uppercase tracking-widest text-ink">Invite Team</h3>
      <div className="bg-muted p-4 border border-line flex justify-center">
        <QRCodeSVG 
          value={url} 
          size={120} 
          bgColor={theme === 'dark' ? '#1E293B' : '#F5F5F5'} 
          fgColor={theme === 'dark' ? '#F8FAFC' : '#141414'} 
        />
      </div>
      <div className="flex gap-2">
        <input 
          readOnly 
          value={url} 
          className="flex-1 bg-muted border border-line p-2 text-[10px] font-mono focus:outline-none text-ink"
        />
        <button 
          onClick={copy}
          className="p-2 border border-line hover:bg-ink hover:text-bg transition-all text-ink"
        >
          {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
