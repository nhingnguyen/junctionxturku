// Addresses of the optional AI assistant (agent/), see README. Change them when the agent runs elsewhere.
// This file is served to the browser, so it must hold addresses only, never keys.
window.PASILA_CONFIG = {
  agentApi: 'http://localhost:4000', // agent backend (Express)
  agentUi: 'http://localhost:3000',  // agent chat UI (Next.js), shown in the Assistant panel
};
