# Target State — Full Org Integration (Prod Vision)

Today the workbench is upload-and-process: a user hands it one file, it comes back with one result. The prod vision is different — the org's own codebase, docs, and systems live inside the sovereign perimeter permanently, kept in sync, and any employee just talks to the workbench like a colleague who already knows everything. Every single step, from a question typed in chat to a line of code changed in the repo, is logged.

```mermaid
flowchart LR
  subgraph ORG[Organization's Sovereign Perimeter — Zero Internet Egress]
    direction TB

    subgraph SOURCES[Their Existing Systems]
      direction TB
      Git[(Internal Git / Code Repos)]
      Docs[(Document Stores<br/>SharePoint / Confluence / File Shares)]
      Wiki[(Internal Wikis / Knowledge Bases)]
      IdP[(Identity Provider<br/>LDAP / SSO)]
    end

    subgraph INGEST[Continuous Ingestion Pipeline]
      direction LR
      Sync[Repo + Doc Sync Workers]
      Parse[OCR / Layout / Code Parsers]
      EmbedW[Embedding Workers]
      Sync --> Parse --> EmbedW
    end

    Git --> Sync
    Docs --> Sync
    Wiki --> Sync

    subgraph STORE[Unified Knowledge Layer]
      direction TB
      PG[(PostgreSQL<br/>Metadata, RBAC, Audit)]
      Obj[(Object Store<br/>Files + Code Snapshots)]
      Vec[(Vector Index<br/>Org-wide Retrieval)]
    end

    EmbedW --> PG
    EmbedW --> Obj
    EmbedW --> Vec

    IdP --> Auth[Auth + RBAC Layer]

    User([Any Employee]) --> Chat[Conversational Workbench<br/>one entry point for everything]
    Chat --> Auth
    Auth --> Orchestrator

    subgraph AGENT[Agent Orchestrator]
      direction TB
      Orchestrator{Model Router}
      Retrieve[Knowledge Retrieval Tool]
      CodeTool[Codebase Tool<br/>read / edit / propose changes]
      GenTool[General Reasoning Tool]
      Orchestrator --> Retrieve
      Orchestrator --> CodeTool
      Orchestrator --> GenTool
    end

    Retrieve --> Vec
    Retrieve --> Obj
    CodeTool --> Git

    subgraph GATE[Human Approval Gate]
      Reviewer{{Reviewer / Maintainer}}
    end

    CodeTool --> Reviewer

    subgraph EXEC[Isolated Execution]
      direction TB
      Sandbox[Sandbox Runner]
      Clone[Ephemeral Repo Clone]
      Sandbox --> Clone
    end

    Reviewer -->|approved| Sandbox
    Clone -->|diff / test results| Orchestrator

    subgraph MODELS[Fully Local Model Layer]
      direction TB
      LLM[Local LLMs]
      VisionM[Local Vision Models]
      EmbedM[Local Embedding Models]
    end

    Orchestrator --> LLM
    Orchestrator --> VisionM
    EmbedW --> EmbedM

    subgraph AUDIT[Immutable Audit Trail]
      direction TB
      Log[(Append-only Audit Log)]
      Dash[Compliance / Ops Dashboard]
      Log --> Dash
    end

    Chat -.-> Log
    Auth -.-> Log
    Orchestrator -.-> Log
    Retrieve -.-> Log
    CodeTool -.-> Log
    Reviewer -.-> Log
    Sandbox -.-> Log
    Sync -.-> Log
  end

  classDef ext fill:#FFE2E2,stroke:#C53030,color:#6E1515;
  classDef store fill:#FFF0C2,stroke:#BA7A00,color:#563800;
  classDef safe fill:#E0F7E9,stroke:#198754,color:#114D30;
  classDef gate fill:#F3E8FF,stroke:#6B21A8,color:#3B0764;
  classDef app fill:#DDF4FF,stroke:#1677B8,color:#0B3A58;

  class Git,Docs,Wiki,IdP ext;
  class PG,Obj,Vec,Log store;
  class Sandbox,Clone,LLM,VisionM,EmbedM safe;
  class Reviewer gate;
  class Chat,Orchestrator,Retrieve,CodeTool,GenTool,Auth,Sync,Parse,EmbedW,Dash app;
```

### What's different from the current diagram

- **No more "upload a file, get a result."** The repo, the docs, the wikis are already inside the perimeter and stay in sync on their own — the user just asks.
- **One chat entry point** instead of separate upload/task flows — the workbench figures out whether it needs to search docs, read code, or both.
- **The codebase itself is a tool**, not a one-off attachment — the agent can read it, propose changes, and only a human reviewer decides if those changes actually touch the real repo.
- **Nothing leaves anything to chance** — every hop (chat → auth → router → tool → reviewer → sandbox) writes to the same append-only audit log, feeding a dashboard someone can actually check later.
- Still zero internet egress, still local models only — this scales up what's inside the wall, not what's allowed to leave it.
