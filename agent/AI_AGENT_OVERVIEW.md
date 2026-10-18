# Helsinki Real Estate AI Agent Overview

## What does the AI Agent do?

The AI Agent helps people researching a property to buy or rent in Helsinki. It combines information from several sources into one conversation.

The user can enter a normal question or address. The Agent can:

- Find official building and address information.
- Identify the property parcel and nearby buildings.
- Search for municipal decisions related to the property.
- Find news about fires, water damage, structural damage, crime, or other incidents.
- Summarize risks such as radon and water-supply disruptions.
- Explain the results in plain language and include source links when available.

The Agent supports initial property research. It does not replace a professional building inspection, legal advice, or an official purchasing decision.

## How it works

1. The user sends a question through the chat interface.
2. The backend sends the question and recent conversation history to the AI model.
3. The AI selects the tools needed to answer the question.
4. MCP servers connect to official sources or normalized local datasets.
5. The Agent compares the results, removes unrelated information, and checks the evidence.
6. The final answer is simplified and filtered before it is shown to the user.

## Main capabilities

### 1. Ryhti / SYKE — building information

- `ryhti_list_collections`: lists the available Ryhti datasets.
- `ryhti_get_queryables`: shows which fields can be used in a search.
- `ryhti_get_features`: searches addresses, buildings, or permits.
- `ryhti_get_feature`: retrieves one specific Ryhti record.
- `ryhti_get_buildings_by_permanent_identifiers`: retrieves multiple buildings by permanent building ID, including official completion dates when available.

### 2. MML — locations and property parcels

- `mml_geocode_place`: converts a place or landmark name into coordinates.
- `mml_find_nearby_buildings`: finds buildings near a location.
- `mml_get_parcels_by_property_identifier`: retrieves parcel information using a Finnish property identifier.
- `mml_get_parcel_by_feature_id`: retrieves one parcel using its MML feature ID.

### 3. Helsinki Decisions — municipal decisions

- `helsinki_search_decisions`: searches official City of Helsinki decisions.
- `helsinki_search_parcel_decisions`: searches by address or parcel and classifies how closely each result matches the property.
- `helsinki_get_decision_context`: reads the important parts of a decision for verification.
- `helsinki_lookup_local_parcel`: converts an apartment or listing address into the official parcel-level address.

### 4. Articles — news and incidents

- `search_property_incident_articles`: searches Finnish and English news related to a property address.
- `get_property_article_context`: opens an article from an allowed source and checks whether it actually refers to the correct address and incident.

Search results are treated as candidates only. The Agent should not claim that an incident occurred until the article content has been verified.

### 5. Risk — property risk profile

- `risk_get_property_profile`: returns the normalized risk profile for a property.
- `risk_check_live_water_disruptions`: checks current HSY water-disruption areas affecting the property.

## Core Agent components

- `runAgent`: manages the conversation, selects and calls tools, limits the number of steps, and prevents repeated tool-call loops.
- `McpHub`: connects the backend to the MCP servers and returns tool results to the AI.
- `buildSystemPrompt`: tells the AI how to search, verify evidence, and answer customers.
- `findEvidenceClaimIssues`: detects claims that do not have enough supporting evidence.
- `sanitizePublicReply`: removes secrets, internal paths, and unnecessary technical details before returning the answer.

## Technology stack

- **Frontend:** Next.js, React, and TypeScript.
- **Backend API:** Node.js, Express, and TypeScript.
- **AI/LLM:** Ollama with a model selected through environment configuration.
- **Tool integration:** Model Context Protocol (MCP).
- **Validation:** Zod.
- **Data sources:** Ryhti/SYKE, MML, Helsinki Decisions API, HSY, Brave Search or GDELT, and local JSON datasets.
- **Deployment:** Docker and Docker Compose.
- **Testing:** Node Test Runner with TSX.

## Answer quality and data protection

- Limits question length, Agent steps, and tool calls.
- Does not expose API keys, internal paths, or debug data.
- Does not treat “no result found” as proof that an incident never happened.
- Separates exact-building evidence from same-street or neighborhood information.
- Requires source links when mentioning news articles or municipal decisions.
- Explains when information is a snapshot, an area-level statistic, or insufficient for a building-specific conclusion.

## What the user receives

The final response prioritizes information that is easy to understand:

- A short property summary.
- Important findings and warning signs.
- The confidence level of the available information.
- Source links that the user can check.
- Suggested items for the buyer or tenant to verify next.
