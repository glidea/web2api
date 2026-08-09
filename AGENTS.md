# Web2API Repository

- Use English for source code, comments, identifiers, UI text, and README files.
- Use Chinese for product, technical, task, and acceptance documents under `docs/`.
- Keep the architecture simple: Node.js daemon, MV3 extension, and shared typed protocols.
- Follow TDD. Define E2E acceptance first, then implement module behavior with failing unit tests.
- Run `pnpm test`, `pnpm typecheck`, and the relevant Playwright suite before committing.
- Real ChatGPT smoke tests must use a dedicated profile or an explicitly authorized test bridge. Never copy browser credentials.
- Real Gemini smoke tests must use system Google Chrome with the dedicated `~/.web2api/gemini-profile`. Never copy browser credentials.
