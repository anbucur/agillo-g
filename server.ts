import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import path from "path";
import axios from "axios";
import cookieSession from "cookie-session";
import cookie from "cookie";
import { v4 as uuidv4 } from "uuid";
import { Session, ClientMessage, ServerMessage, Participant, Issue } from "./src/types";

const sessions: Record<string, Session> = {};
const clients: Record<string, Set<WebSocket>> = {};

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

  app.post("/api/sessions", (req, res) => {
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
    sessions[id] = session;
    res.status(201).json(session);
  });

  app.get("/api/sessions/:id", (req, res) => {
    const session = sessions[req.params.id];
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
        const session = sessions[sessionId];

        if (!session && type !== 'JOIN_SESSION') {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Session not found' }));
          return;
        }

        switch (type) {
          case 'JOIN_SESSION': {
            const { participant } = message;
            currentSessionId = sessionId;
            currentParticipantId = participant.id;

            if (!sessions[sessionId]) {
              sessions[sessionId] = {
                id: sessionId,
                name: "New Session",
                mode: 'FIBONACCI',
                isRevealed: false,
                participants: {},
                issues: [],
              };
            }
            
            sessions[sessionId].participants[participant.id] = participant;
            
            if (!clients[sessionId]) clients[sessionId] = new Set();
            clients[sessionId].add(ws);

            broadcast(sessionId, { type: 'SESSION_UPDATE', session: sessions[sessionId] });
            break;
          }

          case 'CAST_VOTE': {
            const { participantId, vote } = message;
            if (session.participants[participantId]) {
              session.participants[participantId].vote = vote;
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'TOGGLE_ANONYMOUS': {
            const { participantId, isAnonymous } = message;
            if (session.participants[participantId]) {
              session.participants[participantId].isAnonymous = isAnonymous;
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'REVEAL_VOTES': {
            session.isRevealed = true;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'RESET_VOTES': {
            session.isRevealed = false;
            Object.values(session.participants).forEach(p => p.vote = undefined);
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'SELECT_ISSUE': {
            session.currentIssueId = message.issueId;
            session.isRevealed = false;
            Object.values(session.participants).forEach(p => p.vote = undefined);
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'ADD_ISSUE': {
            session.issues.push(message.issue);
            if (!session.currentIssueId) session.currentIssueId = message.issue.id;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'COMPLETE_ISSUE': {
            const issue = session.issues.find(i => i.id === message.issueId);
            if (issue) {
              issue.status = 'COMPLETED';
              issue.estimate = message.estimate;
              session.isRevealed = false;
              Object.values(session.participants).forEach(p => p.vote = undefined);
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
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
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'START_TIMER': {
            session.timerStart = Date.now();
            session.timerDuration = message.duration;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'STOP_TIMER': {
            session.timerStart = undefined;
            session.timerDuration = undefined;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'ADD_STICKER': {
            if (!session.stickers) session.stickers = {};
            session.stickers[message.sticker.id] = message.sticker;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'UPDATE_STICKER': {
            if (session.stickers && session.stickers[message.stickerId]) {
              session.stickers[message.stickerId].text = message.text;
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'REMOVE_STICKER': {
            if (session.stickers && session.stickers[message.stickerId]) {
              delete session.stickers[message.stickerId];
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'CATEGORIZE_STICKERS': {
            // No-op on server, handled by client
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
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'ANALYZE_SESSION': {
            // No-op on server, handled by client
            break;
          }

          case 'SAVE_ANALYSIS': {
            session.analysis = message.analysis;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
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
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
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
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            } catch (err) {
              console.error("Confluence Export Error:", err);
              ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to export to Confluence' }));
            }
            break;
          }

          case 'SET_REFINEMENT_PHASE': {
            session.refinementPhase = message.phase;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'SET_GROUPS': {
            session.stickerGroups = message.groups;
            Object.entries(message.stickerUpdates).forEach(([stickerId, groupId]) => {
              if (session.stickers && session.stickers[stickerId]) {
                session.stickers[stickerId].groupId = groupId;
              }
            });
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'VOTE_GROUP': {
            if (session.stickerGroups && session.stickerGroups[message.groupId]) {
              const group = session.stickerGroups[message.groupId];
              if (!group.votes) group.votes = {};
              const current = group.votes[message.participantId] || 0;
              group.votes[message.participantId] = Math.max(0, current + message.delta);
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'UPDATE_GROUP_RANKING': {
            session.groupRanking = message.ranking;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'VOTE_STICKER': {
            if (session.stickers && session.stickers[message.stickerId]) {
              const sticker = session.stickers[message.stickerId];
              if (!sticker.votes) sticker.votes = {};
              const current = sticker.votes[message.participantId] || 0;
              sticker.votes[message.participantId] = Math.max(0, current + message.delta);
              broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            }
            break;
          }

          case 'UPDATE_IMPACT_RANKING': {
            session.impactRanking = message.ranking;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'UPDATE_COMPLEXITY_RANKING': {
            session.complexityRanking = message.ranking;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
            break;
          }

          case 'SAVE_FINAL_ANALYSIS': {
            session.finalAnalysis = message.analysis;
            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
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

            broadcast(sessionId, { type: 'SESSION_UPDATE', session });
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
                broadcast(sessionId, { type: 'SESSION_UPDATE', session });
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

    ws.on("close", () => {
      if (currentSessionId && currentParticipantId) {
        const session = sessions[currentSessionId];
        if (session) {
          delete session.participants[currentParticipantId];
          clients[currentSessionId]?.delete(ws);
          broadcast(currentSessionId, { type: 'SESSION_UPDATE', session });
        }
      }
    });
  });

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
