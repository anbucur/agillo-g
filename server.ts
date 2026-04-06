import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import path from "path";
import axios from "axios";
import cookieSession from "cookie-session";
import cookie from "cookie";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { Session, ClientMessage, ServerMessage, Participant, Issue } from "./src/types.js";
import { createLLMProvider } from "./src/lib/llm/index.js";

const clients: Record<string, Set<WebSocket>> = {};

// Initialize Redis client
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let redis: Redis | null = null;
let useInMemorySessions = true;

// Initialize LLM Provider
let llmProvider: ReturnType<typeof createLLMProvider>;
try {
  llmProvider = createLLMProvider();
} catch (err) {
  console.error("Failed to initialize LLM provider:", err);
  console.error("AI features will be disabled. Please set LLM_PROVIDER and appropriate API key in .env");
}

// Initialize Redis
try {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        // Only reconnect when the error contains "READONLY"
        return true;
      }
      return false;
    }
  });

  redis.on('connect', () => {
    console.log('Connected to Redis');
    useInMemorySessions = false;
  });

  redis.on('error', (err) => {
    console.error('Redis connection error, falling back to in-memory sessions:', err.message);
    useInMemorySessions = true;
  });

  // Test Redis connection
  redis.ping().then(() => {
    console.log('Redis ping successful');
  }).catch((err) => {
    console.error('Redis ping failed, using in-memory sessions:', err.message);
    useInMemorySessions = true;
    redis = null;
  });

} catch (err) {
  console.error('Failed to initialize Redis, using in-memory sessions:', err);
  redis = null;
}

// Fallback in-memory sessions
const inMemorySessions: Record<string, Session> = {};

// Session helper functions
async function getSession(sessionId: string): Promise<Session | null> {
  if (redis && !useInMemorySessions) {
    try {
      const data = await redis.get(`session:${sessionId}`);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      console.error('Redis get error:', err);
      return inMemorySessions[sessionId] || null;
    }
  }
  return inMemorySessions[sessionId] || null;
}

async function setSession(sessionId: string, session: Session): Promise<void> {
  if (redis && !useInMemorySessions) {
    try {
      await redis.set(`session:${sessionId}`, JSON.stringify(session));
      // Set expiration to 24 hours
      await redis.expire(`session:${sessionId}`, 24 * 60 * 60);
    } catch (err) {
      console.error('Redis set error:', err);
      inMemorySessions[sessionId] = session;
    }
  } else {
    inMemorySessions[sessionId] = session;
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  if (redis && !useInMemorySessions) {
    try {
      await redis.del(`session:${sessionId}`);
    } catch (err) {
      console.error('Redis delete error:', err);
      delete inMemorySessions[sessionId];
    }
  } else {
    delete inMemorySessions[sessionId];
  }
}

async function getAllSessions(): Promise<Record<string, Session>> {
  if (redis && !useInMemorySessions) {
    try {
      const keys = await redis.keys('session:*');
      const sessions: Record<string, Session> = {};
      for (const key of keys) {
        const sessionId = key.replace('session:', '');
        const data = await redis.get(key);
        if (data) {
          sessions[sessionId] = JSON.parse(data);
        }
      }
      return sessions;
    } catch (err) {
      console.error('Redis getAll error:', err);
      return inMemorySessions;
    }
  }
  return inMemorySessions;
}

// Helper to parse Jira ADF (Atlassian Document Format) or plain text
function parseJiraDescription(description: any): string {
  if (!description) return "";
  if (typeof description === "string") return description;
  
  // Basic ADF parsing: extract text from content nodes
  try {
    if (description.type === "doc" && Array.isArray(description.content)) {
      return description.content
        .map((node: any) => {
          if (node.type === "paragraph" && Array.isArray(node.content)) {
            return node.content.map((c: any) => c.text || "").join("");
          }
          if (node.type === "text") return node.text || "";
          return "";
        })
        .join("\n")
        .trim();
    }
  } catch (e) {
    console.error("ADF Parsing Error:", e);
  }
  return "";
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = 3000;

  const sessionMiddleware = cookieSession({
    name: 'agillo-session',
    keys: ['agillo-secret-key'],
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'none',
    secure: true,
  });

  app.use(express.json());
  app.use(sessionMiddleware);

  // Jira OAuth Config
  const JIRA_CLIENT_ID = process.env.JIRA_CLIENT_ID;
  const JIRA_CLIENT_SECRET = process.env.JIRA_CLIENT_SECRET;
  const REDIRECT_URI = `${process.env.APP_URL}/api/auth/jira/callback`;

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Jira OAuth Routes
  app.get("/api/auth/jira/url", (req, res) => {
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: JIRA_CLIENT_ID!,
      scope: 'read:jira-work read:jira-user write:jira-work manage:jira-configuration read:board-scope:jira-software read:project:jira read:issue:jira write:issue:jira write:confluence-content read:confluence-space.summary write:confluence-page',
      redirect_uri: REDIRECT_URI,
      state: 'agillo-state',
      response_type: 'code',
      prompt: 'consent'
    });
    res.json({ url: `https://auth.atlassian.com/authorize?${params.toString()}` });
  });

  app.get("/api/auth/jira/callback", async (req, res) => {
    const { code } = req.query;
    try {
      const response = await axios.post('https://auth.atlassian.com/oauth/token', {
        grant_type: 'authorization_code',
        client_id: JIRA_CLIENT_ID,
        client_secret: JIRA_CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI
      });

      const { access_token, refresh_token } = response.data;
      req.session!.jira_token = access_token;
      
      // Get cloud ID
      const resourcesResponse = await axios.get('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      
      const cloudId = resourcesResponse.data[0]?.id;
      req.session!.jira_cloud_id = cloudId;

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'JIRA_AUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      console.error("Jira OAuth Error:", err);
      res.status(500).send("Authentication failed");
    }
  });

  // Jira API Proxy
  app.get("/api/jira/projects", async (req, res) => {
    const token = req.session?.jira_token;
    const cloudId = req.session?.jira_cloud_id;
    if (!token || !cloudId) return res.status(401).json({ error: "Not authenticated with Jira" });

    try {
      const response = await axios.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      res.json(response.data);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  app.get("/api/confluence/spaces", async (req, res) => {
    const token = req.session?.jira_token;
    const cloudId = req.session?.jira_cloud_id;
    if (!token || !cloudId) return res.status(401).json({ error: "Not authenticated with Confluence" });

    try {
      const response = await axios.get(`https://api.atlassian.com/ex/confluence/${cloudId}/rest/api/space`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      res.json(response.data.results);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch spaces" });
    }
  });

  app.get("/api/jira/boards", async (req, res) => {
    const token = req.session?.jira_token;
    const cloudId = req.session?.jira_cloud_id;
    if (!token || !cloudId) return res.status(401).json({ error: "Not authenticated with Jira" });

    try {
      const response = await axios.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0/board`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      res.json(response.data.values);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch boards" });
    }
  });

  app.get("/api/jira/boards/:boardId/issues", async (req, res) => {
    const token = req.session?.jira_token;
    const cloudId = req.session?.jira_cloud_id;
    if (!token || !cloudId) return res.status(401).json({ error: "Not authenticated with Jira" });

    try {
      const response = await axios.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0/board/${req.params.boardId}/issue`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      res.json(response.data.issues.map((issue: any) => ({
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        description: parseJiraDescription(issue.fields.description)
      })));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch issues" });
    }
  });

  app.get("/api/jira/boards/:boardId/sprints", async (req, res) => {
    const token = req.session?.jira_token;
    const cloudId = req.session?.jira_cloud_id;
    if (!token || !cloudId) return res.status(401).json({ error: "Not authenticated with Jira" });

    try {
      const response = await axios.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0/board/${req.params.boardId}/sprint`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      res.json(response.data.values);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch sprints" });
    }
  });

  app.get("/api/jira/sprints/:sprintId/issues", async (req, res) => {
    const token = req.session?.jira_token;
    const cloudId = req.session?.jira_cloud_id;
    if (!token || !cloudId) return res.status(401).json({ error: "Not authenticated with Jira" });

    try {
      const response = await axios.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0/sprint/${req.params.sprintId}/issue`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      res.json(response.data.issues.map((issue: any) => ({
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        description: parseJiraDescription(issue.fields.description)
      })));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch sprint issues" });
    }
  });

  app.get("/api/jira/boards/:boardId/backlog", async (req, res) => {
    const token = req.session?.jira_token;
    const cloudId = req.session?.jira_cloud_id;
    if (!token || !cloudId) return res.status(401).json({ error: "Not authenticated with Jira" });

    try {
      const response = await axios.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0/board/${req.params.boardId}/backlog`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      res.json(response.data.issues.map((issue: any) => ({
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        description: parseJiraDescription(issue.fields.description)
      })));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch backlog issues" });
    }
  });

  app.post("/api/sessions", async (req, res) => {
    const { id, name, mode } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: "Missing session ID or name" });
    }
    const session: Session = {
      id,
      name,
      mode: mode || 'FIBONACCI',
      isRevealed: false,
      participants: {},
      issues: [],
    };
    await setSession(id, session);
    res.status(201).json(session);
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const session = await getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json(session);
  });

  // WebSocket Logic
  wss.on("connection", (ws, req: any) => {
    let currentSessionId: string | null = null;
    let currentParticipantId: string | null = null;

    // Manually run session middleware logic to get session data
    // This is a simplified version of what cookie-session does
    const cookies = cookie.parse(req.headers.cookie || "");
    const sessionCookie = cookies['agillo-session'];
    let wsSession: any = {};
    
    if (sessionCookie) {
      try {
        // In a real app, we'd verify the signature here.
        // For this demo, we'll just decode the base64.
        const decoded = Buffer.from(sessionCookie, 'base64').toString();
        wsSession = JSON.parse(decoded);
      } catch (e) {
        console.error("WS Session Parse Error:", e);
      }
    }

    ws.on("message", async (data) => {
      try {
        const message: ClientMessage = JSON.parse(data.toString());
        const { type, sessionId } = message;
        const session = await getSession(sessionId);

        if (!session && type !== 'JOIN_SESSION') {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Session not found' }));
          return;
        }

        switch (type) {
          case 'JOIN_SESSION': {
            const { participant } = message;
            currentSessionId = sessionId;
            currentParticipantId = participant.id;

            let session = await getSession(sessionId);
            if (!session) {
              session = {
                id: sessionId,
                name: "New Session",
                mode: 'FIBONACCI',
                isRevealed: false,
                participants: {},
                issues: [],
              };
            }

            session.participants[participant.id] = participant;
            await setSession(sessionId, session);

            if (!clients[sessionId]) clients[sessionId] = new Set();
            clients[sessionId].add(ws);

            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'CAST_VOTE': {
            const { participantId, vote } = message;
            if (session.participants[participantId]) {
              session.participants[participantId].vote = vote;
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'TOGGLE_ANONYMOUS': {
            const { participantId, isAnonymous } = message;
            if (session.participants[participantId]) {
              session.participants[participantId].isAnonymous = isAnonymous;
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'REVEAL_VOTES': {
            session.isRevealed = true;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'RESET_VOTES': {
            session.isRevealed = false;
            Object.values(session.participants).forEach(p => p.vote = undefined);
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'SELECT_ISSUE': {
            session.currentIssueId = message.issueId;
            session.isRevealed = false;
            Object.values(session.participants).forEach(p => p.vote = undefined);
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'ADD_ISSUE': {
            session.issues.push(message.issue);
            if (!session.currentIssueId) session.currentIssueId = message.issue.id;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'COMPLETE_ISSUE': {
            const issue = session.issues.find(i => i.id === message.issueId);
            if (issue) {
              issue.status = 'COMPLETED';
              issue.estimate = message.estimate;
              session.isRevealed = false;
              Object.values(session.participants).forEach(p => p.vote = undefined);
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'CHANGE_MODE': {
            session.mode = message.mode;
            session.isRevealed = false;
            Object.values(session.participants).forEach(p => p.vote = undefined);
            if (message.mode === 'REFINEMENT' && !session.stickers) {
              session.stickers = {};
              session.categories = [];
            }
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'START_TIMER': {
            session.timerStart = Date.now();
            session.timerDuration = message.duration;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'STOP_TIMER': {
            session.timerStart = undefined;
            session.timerDuration = undefined;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'ADD_STICKER': {
            if (!session.stickers) session.stickers = {};
            session.stickers[message.sticker.id] = message.sticker;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'UPDATE_STICKER': {
            if (session.stickers && session.stickers[message.stickerId]) {
              session.stickers[message.stickerId].text = message.text;
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'REMOVE_STICKER': {
            if (session.stickers && session.stickers[message.stickerId]) {
              delete session.stickers[message.stickerId];
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'CATEGORIZE_STICKERS': {
            if (!llmProvider) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'LLM provider not configured' }));
              break;
            }
            if (!session.stickers || Object.keys(session.stickers).length === 0) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'No stickers to categorize' }));
              break;
            }

            try {
              const stickersList = Object.values(session.stickers).map(s => ({ id: s.id, text: s.text }));

              const response = await llmProvider.generateStructured<{
                title: string;
                stickerIds: string[];
              }[]>(`Group the following feedback items into logical themes.
              Return a JSON array of groups, where each group has a "title" and an array of "stickerIds".
              Stickers: ${JSON.stringify(stickersList)}`, {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    stickerIds: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['title', 'stickerIds']
                }
              });

              const newGroups: Record<string, any> = {};
              const stickerUpdates: Record<string, string> = {};

              response.forEach((g) => {
                const groupId = `group-${uuidv4()}`;
                newGroups[groupId] = {
                  id: groupId,
                  title: g.title,
                  votes: {}
                };
                g.stickerIds.forEach((sid) => {
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

              session.stickerGroups = newGroups;
              Object.entries(stickerUpdates).forEach(([stickerId, groupId]) => {
                if (session.stickers && session.stickers[stickerId]) {
                  session.stickers[stickerId].groupId = groupId;
                }
              });
              session.refinementPhase = 'GROUPING';
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            } catch (err) {
              console.error("CATEGORIZE_STICKERS error:", err);
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to categorize stickers' }));
            }
            break;
          }

          case 'SAVE_CATEGORIES': {
            if (!session.stickers) break;
            session.categories = message.categories;
            message.stickerUpdates.forEach(update => {
              if (session.stickers![update.id]) {
                session.stickers![update.id].categories = update.categories;
              }
            });
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'ANALYZE_SESSION': {
            if (!llmProvider) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'LLM provider not configured' }));
              break;
            }
            if (!session.stickerGroups || Object.keys(session.stickerGroups).length === 0) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'No groups to analyze' }));
              break;
            }

            try {
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

              const response = await llmProvider.generateStructured<{
                summary: string;
                good: string[];
                bad: string[];
                blockers: string[];
                ideas: string[];
                actionItems: Array<{
                  title: string;
                  description: string;
                  linkedGroupIds: string[];
                }>;
              }>(`Analyze the following prioritized groups of feedback from a retrospective or refinement session.
              Identify the good things, the bad things, the blockers, and the ideas.
              Create a brief summary of the session.
              Propose actionable items based on the feedback groups, focusing on the highest priority ones.
              IMPORTANT: For each action item, provide an array of "linkedGroupIds" corresponding to the IDs of the groups that inspired it.
              Return a JSON object.
              Groups: ${JSON.stringify(groupsList)}`, {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                  good: { type: 'array', items: { type: 'string' } },
                  bad: { type: 'array', items: { type: 'string' } },
                  blockers: { type: 'array', items: { type: 'string' } },
                  ideas: { type: 'array', items: { type: 'string' } },
                  actionItems: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        description: { type: 'string' },
                        linkedGroupIds: { type: 'array', items: { type: 'string' } }
                      },
                      required: ['title', 'description', 'linkedGroupIds']
                    }
                  }
                },
                required: ['summary', 'good', 'bad', 'blockers', 'ideas', 'actionItems']
              });

              const actionItemsWithIds = (response.actionItems || []).map((item) => ({
                id: uuidv4(),
                title: item.title,
                description: item.description,
                linkedGroupIds: item.linkedGroupIds || []
              }));

              session.analysis = {
                summary: response.summary || "",
                good: response.good || [],
                bad: response.bad || [],
                blockers: response.blockers || [],
                ideas: response.ideas || [],
                actionItems: actionItemsWithIds
              };

              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            } catch (err) {
              console.error("ANALYZE_SESSION error:", err);
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to analyze session' }));
            }
            break;
          }

          case 'QUICK_WIN_ANALYSIS': {
            if (!llmProvider) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'LLM provider not configured' }));
              break;
            }
            if (!session.analysis || !session.groupRanking || !session.complexityRanking) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Missing required data for quick win analysis' }));
              break;
            }

            try {
              // Calculate quick wins (server-side version of calculateQuickWins)
              const totalGroups = session.groupRanking.length;

              const quickWins = session.analysis.actionItems.map(action => {
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

                return {
                  id: action.id,
                  title: action.title,
                  description: action.description,
                  valueScore,
                  complexityScore,
                  quickWinIndex,
                  groupVotes,
                  groupTitles
                };
              }).sort((a, b) => {
                if (b.groupVotes !== a.groupVotes) {
                  return b.groupVotes - a.groupVotes; // Sort by group votes first
                }
                return b.quickWinIndex - a.quickWinIndex; // Then by quick win index
              });

              if (quickWins.length === 0) {
                ws.send(JSON.stringify({ type: 'ERROR', message: 'No action items to analyze' }));
                break;
              }

              const response = await llmProvider.generateStructured<{
                summary: string;
                rankedItems: Array<{
                  actionItemId: string;
                  justification: string;
                }>;
              }>(`Based on the following prioritized action items (sorted primarily by the votes of their parent groups, then by Quick Win Index: high value, low complexity), generate a final execution plan and summary for the team.
              The action items are derived from grouped feedback. Pay special attention to the "groupVotes" and "groupTitles" fields, as action items from highly voted groups are listed first and should be addressed first.

              Action Items:
              ${JSON.stringify(quickWins.map(qw => ({
                id: qw.id,
                title: qw.title,
                description: qw.description,
                valueScore: qw.valueScore,
                complexityScore: qw.complexityScore,
                quickWinIndex: qw.quickWinIndex,
                groupVotes: qw.groupVotes,
                groupTitles: qw.groupTitles
              })))}

              Return a JSON object with:
              - summary: A brief encouraging summary of the plan, explicitly mentioning the top themes/groups that the team prioritized based on votes.
              - rankedItems: An array of objects containing the actionItemId and a brief justification for its priority (mentioning its group's votes or value vs complexity).`, {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                  rankedItems: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        actionItemId: { type: 'string' },
                        justification: { type: 'string' }
                      },
                      required: ['actionItemId', 'justification']
                    }
                  }
                },
                required: ['summary', 'rankedItems']
              });

              session.finalAnalysis = response;
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            } catch (err) {
              console.error("QUICK_WIN_ANALYSIS error:", err);
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to perform quick win analysis' }));
            }
            break;
          }

          case 'SAVE_ANALYSIS': {
            session.analysis = message.analysis;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'CREATE_JIRA_TASK': {
            const token = wsSession?.jira_token;
            const cloudId = wsSession?.jira_cloud_id;
            
            if (!token || !cloudId) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Not authenticated with Jira' }));
              break;
            }

            const actionItem = session.analysis?.actionItems.find(a => a.id === message.actionItemId);
            if (!actionItem) break;

            try {
              const response = await axios.post(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`, {
                fields: {
                  project: { id: message.projectId },
                  summary: actionItem.title,
                  description: {
                    type: "doc",
                    version: 1,
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: actionItem.description }]
                      }
                    ]
                  },
                  issuetype: { name: "Task" }
                }
              }, {
                headers: { Authorization: `Bearer ${token}` }
              });

              actionItem.jiraIssueKey = response.data.key;
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            } catch (err) {
              console.error("Jira Task Creation Error:", err);
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to create Jira task' }));
            }
            break;
          }

          case 'EXPORT_TO_CONFLUENCE': {
            const token = wsSession?.jira_token;
            const cloudId = wsSession?.jira_cloud_id;
            
            if (!token || !cloudId) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Not authenticated with Confluence' }));
              break;
            }

            const analysis = session.analysis;
            if (!analysis) break;

            try {
              let htmlContent = `<h1>Retrospective Summary: ${session.name}</h1>`;
              htmlContent += `<p>${analysis.summary}</p>`;
              
              htmlContent += `<h2>The Good</h2><ul>`;
              analysis.good.forEach(g => htmlContent += `<li>${g}</li>`);
              htmlContent += `</ul>`;

              htmlContent += `<h2>The Bad</h2><ul>`;
              analysis.bad.forEach(b => htmlContent += `<li>${b}</li>`);
              htmlContent += `</ul>`;

              htmlContent += `<h2>Blockers</h2><ul>`;
              analysis.blockers.forEach(b => htmlContent += `<li>${b}</li>`);
              htmlContent += `</ul>`;

              htmlContent += `<h2>Ideas</h2><ul>`;
              analysis.ideas.forEach(i => htmlContent += `<li>${i}</li>`);
              htmlContent += `</ul>`;

              htmlContent += `<h2>Action Items</h2><ul>`;
              analysis.actionItems.forEach(a => {
                htmlContent += `<li><strong>${a.title}</strong>: ${a.description} ${a.jiraIssueKey ? `(Jira: ${a.jiraIssueKey})` : ''}</li>`;
              });
              htmlContent += `</ul>`;

              const response = await axios.post(`https://api.atlassian.com/ex/confluence/${cloudId}/rest/api/content`, {
                type: "page",
                title: `Retrospective: ${session.name} - ${new Date().toLocaleDateString()}`,
                space: { key: message.spaceKey },
                body: {
                  storage: {
                    value: htmlContent,
                    representation: "storage"
                  }
                }
              }, {
                headers: { Authorization: `Bearer ${token}` }
              });

              const confluenceUrl = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki${response.data._links.webui}`;
              session.analysis.confluenceUrl = confluenceUrl;
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            } catch (err) {
              console.error("Confluence Export Error:", err);
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to export to Confluence' }));
            }
            break;
          }

          case 'SET_REFINEMENT_PHASE': {
            session.refinementPhase = message.phase;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'SET_GROUPS': {
            session.stickerGroups = message.groups;
            Object.entries(message.stickerUpdates).forEach(([stickerId, groupId]) => {
              if (session.stickers && session.stickers[stickerId]) {
                session.stickers[stickerId].groupId = groupId;
              }
            });
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'VOTE_GROUP': {
            if (session.stickerGroups && session.stickerGroups[message.groupId]) {
              const group = session.stickerGroups[message.groupId];
              if (!group.votes) group.votes = {};
              const current = group.votes[message.participantId] || 0;
              group.votes[message.participantId] = Math.max(0, current + message.delta);
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'UPDATE_GROUP_RANKING': {
            session.groupRanking = message.ranking;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'VOTE_STICKER': {
            if (session.stickers && session.stickers[message.stickerId]) {
              const sticker = session.stickers[message.stickerId];
              if (!sticker.votes) sticker.votes = {};
              const current = sticker.votes[message.participantId] || 0;
              sticker.votes[message.participantId] = Math.max(0, current + message.delta);
              await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'UPDATE_IMPACT_RANKING': {
            session.impactRanking = message.ranking;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'UPDATE_COMPLEXITY_RANKING': {
            session.complexityRanking = message.ranking;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'SAVE_FINAL_ANALYSIS': {
            session.finalAnalysis = message.analysis;
            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'GENERATE_DEMO_DATA': {
            const demoUsers = [
              { id: 'demo-1', name: 'Alice (Demo)', isFacilitator: false, lastActive: Date.now() },
              { id: 'demo-2', name: 'Bob (Demo)', isFacilitator: false, lastActive: Date.now() },
              { id: 'demo-3', name: 'Charlie (Demo)', isFacilitator: false, lastActive: Date.now() },
              { id: 'demo-4', name: 'Diana (Demo)', isFacilitator: false, lastActive: Date.now() }
            ];
            
            demoUsers.forEach(u => {
              session.participants[u.id] = u;
            });

            if (session.mode === 'REFINEMENT') {
              const demoStickers = [
                "We need more automated tests",
                "The new CI/CD pipeline is super fast!",
                "Too many context switches this sprint",
                "Great collaboration on the API design",
                "Let's try pair programming more often",
                "Documentation is getting out of date",
                "The daily standups are taking too long",
                "Loved the new UI components",
                "We should refactor the auth service",
                "Need clearer requirements before starting work"
              ];

              if (!session.stickers) session.stickers = {};
              if (!session.stickerGroups) session.stickerGroups = {};

              const demoGroups = [
                { id: 'group-demo-1', title: 'Testing & Quality', stickerIndices: [0, 8] },
                { id: 'group-demo-2', title: 'Process & Meetings', stickerIndices: [2, 6, 9] },
                { id: 'group-demo-3', title: 'Collaboration & Teamwork', stickerIndices: [3, 4] },
                { id: 'group-demo-4', title: 'Infrastructure & Tools', stickerIndices: [1, 5, 7] }
              ];

              demoStickers.forEach((text, i) => {
                const stickerId = `sticker-demo-${i}`;
                const participantId = demoUsers[i % demoUsers.length].id;
                const group = demoGroups.find(g => g.stickerIndices.includes(i));
                session.stickers![stickerId] = {
                  id: stickerId,
                  participantId,
                  text,
                  groupId: group?.id,
                  votes: {}
                };
              });

              demoGroups.forEach(g => {
                session.stickerGroups![g.id] = {
                  id: g.id,
                  title: g.title,
                  votes: {}
                };
              });

              // Random votes on groups (up to 3 per user)
              demoUsers.forEach(u => {
                let votesLeft = 3;
                while (votesLeft > 0) {
                  const randomGroup = demoGroups[Math.floor(Math.random() * demoGroups.length)];
                  const group = session.stickerGroups![randomGroup.id];
                  if (!group.votes) group.votes = {};
                  group.votes[u.id] = (group.votes[u.id] || 0) + 1;
                  votesLeft--;
                }
              });
            } else {
              // FIBONACCI or TSHIRT
              const demoIssues = [
                { id: 'issue-demo-1', summary: 'Implement login page', status: 'PENDING' as const },
                { id: 'issue-demo-2', summary: 'Setup database schema', status: 'PENDING' as const },
                { id: 'issue-demo-3', summary: 'Create API endpoints', status: 'PENDING' as const },
                { id: 'issue-demo-4', summary: 'Write unit tests', status: 'PENDING' as const }
              ];
              
              // Only add if there are no issues
              if (session.issues.length === 0) {
                session.issues = demoIssues;
                session.currentIssueId = demoIssues[0].id;
              }

              if (session.currentIssueId) {
                const scale = session.mode === 'FIBONACCI' 
                  ? ['1', '2', '3', '5', '8', '13'] 
                  : ['S', 'M', 'L', 'XL'];
                
                demoUsers.forEach(u => {
                  const randomVote = scale[Math.floor(Math.random() * scale.length)];
                  session.participants[u.id].vote = randomVote;
                });
              }
            }

            await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'SYNC_JIRA_ESTIMATE': {
            const token = wsSession?.jira_token;
            const cloudId = wsSession?.jira_cloud_id;
            
            if (!token || !cloudId) {
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Not authenticated with Jira' }));
              break;
            }

            const issue = session.issues.find(i => i.id === message.issueId);
            if (issue && issue.key) {
              try {
                // 1. Find the story points field ID dynamically
                const fieldsResponse = await axios.get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/field`, {
                  headers: { Authorization: `Bearer ${token}` }
                });
                
                const fields = fieldsResponse.data;
                // Look for fields that are likely to be story points
                const storyPointField = fields.find((f: any) => 
                  f.name.toLowerCase().includes('story point') || 
                  f.name.toLowerCase().includes('estimate')
                );

                const fieldId = storyPointField?.id || "customfield_10016"; // Fallback

                // 2. Update story points in Jira
                await axios.put(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issue.key}`, {
                  fields: {
                    [fieldId]: parseFloat(message.estimate) || 0
                  }
                }, {
                  headers: { Authorization: `Bearer ${token}` }
                });
                
                // Update local issue state to reflect sync
                issue.estimate = message.estimate;
                await broadcastAndSave(sessionId, session, { type: 'SESSION_UPDATE', session });
              } catch (err) {
                console.error("Jira Sync Error:", err);
                ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to sync with Jira' }));
              }
            }
            break;
          }
        }
      } catch (err) {
        console.error("WS Error:", err);
      }
    });

    ws.on("close", async () => {
      if (currentSessionId && currentParticipantId) {
        const session = await getSession(currentSessionId);
        if (session) {
          delete session.participants[currentParticipantId];
          await setSession(currentSessionId, session);
          clients[currentSessionId]?.delete(ws);
          broadcast(currentSessionId, { type: 'SESSION_UPDATE', session });
        }
      }
    });
  });

  async function broadcastAndSave(sessionId: string, session: Session, message: ServerMessage) {
    await setSession(sessionId, session);
    const sessionClients = clients[sessionId];
    if (sessionClients) {
      const payload = JSON.stringify(message);
      sessionClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    }
  }

  function broadcast(sessionId: string, message: ServerMessage) {
    const sessionClients = clients[sessionId];
    if (sessionClients) {
      const payload = JSON.stringify(message);
      sessionClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    }
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
