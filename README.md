# Braintrust

An AI-powered thought capture and processing system that integrates with Slack to collect, classify, and deliver digests of ideas and insights.

## Overview

Braintrust is a sophisticated system designed to capture thoughts, ideas, and insights from team communications (primarily Slack), automatically classify them, and deliver curated digests. It helps teams preserve institutional knowledge and ensures important ideas don't get lost in chat history.

## Features

- 🤖 **Slack Integration**: Captures messages and reactions from Slack channels
- 🏷️ **AI Classification**: Automatically categorizes thoughts using LLM models
- 📊 **Smart Digests**: Delivers curated digests based on configurable schedules
- 📈 **Analytics**: Tracks thought patterns and team insights
- 🔔 **Interactive Notifications**: Allows users to interact with digests via Slack buttons
- ⏰ **Scheduled Processing**: Configurable schedules for digest delivery

## Architecture

Braintrust follows a modular architecture with clear separation of concerns:

- **thought-capture/**: Core application module (TypeScript/Cloudflare Workers)
  - Slack event handlers for capturing messages
  - Classification service using AI models
  - Digest generation and delivery
  - Queue consumers for async processing

- **docs/**: Comprehensive documentation
  - Architecture Decision Records (ADRs)
  - Product Requirements Documents (PRDs)
  - Security threat models
  - Runbooks and specifications

- **prompts/**: AI prompts for various agents
  - Reviewer, architect, critic, and executor prompts

- **scripts/**: Utility scripts for documentation generation

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Cloudflare Workers (edge computing)
- **Database**: SQLite with migrations (via D1)
- **Queue**: Cloudflare Queues for async processing
- **Testing**: Vitest
- **CI/CD**: GitHub Actions
- **Integrations**: Slack API

## Project Structure

```
braintrust/
├── thought-capture/          # Main application
│   ├── src/                 # Source code
│   │   ├── index.ts         # Worker entry point
│   │   ├── slack-*.ts       # Slack handlers
│   │   ├── *-service.ts     # Business logic
│   │   └── *-repository.ts  # Data access
│   ├── test/                # Test suite
│   └── migrations/          # Database migrations
├── docs/                    # Documentation
│   ├── adr/                 # Architecture decisions
│   ├── spec/                # Specifications
│   └── prd/                 # Product requirements
├── prompts/                 # AI agent prompts
└── scripts/                 # Utility scripts
```

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm or npm
- Cloudflare account (for deployment)
- Slack workspace with admin access

### Installation

```bash
# Clone the repository
git clone https://github.com/snaveevans/braintrust.git
cd braintrust/thought-capture

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env
# Edit .env with your Slack tokens and configuration

# Run locally
pnpm dev
```

### Configuration

1. **Slack App Setup**: Create a Slack app with the following scopes:
   - `channels:history`
   - `chat:write`
   - `reactions:read`
   - `users:read`

2. **Cloudflare Setup**: 
   - Create D1 database
   - Configure Cloudflare Queues
   - Set up Wrangler configuration

3. **Environment Variables**:
   ```
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_SIGNING_SECRET=your-signing-secret
   DATABASE_URL=your-d1-database-url
   ```

## Usage

### Capturing Thoughts

Once installed in your Slack workspace, Braintrust automatically:
1. Monitors configured channels for messages
2. Processes reactions and threads
3. Classifies content using AI
4. Stores in database for later retrieval

### Managing Digests

Users can interact with digests through Slack:
- Schedule regular digests (daily, weekly)
- Request on-demand digests
- Provide feedback on classifications
- Mark items as resolved or important

### Development

```bash
# Run tests
pnpm test

# Run specific test
pnpm test src/path/to/test.ts

# Deploy to staging
pnpm run deploy:staging

# Deploy to production
pnpm run deploy:production
```

## Documentation

- [Architecture Decision Records](docs/adr/)
- [Agent Conventions](docs/AGENT-CONVENTIONS.md)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [Security Threat Models](docs/security/)

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit changes: `git commit -am 'Add new feature'`
4. Push to branch: `git push origin feature/my-feature`
5. Open a Pull Request

## License

[License](LICENSE)

## Acknowledgments

Built with ❤️ using Cloudflare Workers, TypeScript, and AI models.
