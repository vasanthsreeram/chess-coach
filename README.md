# Chess

A small chess app with timed games, a browser-based Stockfish opponent, game
history, invite-link games with another player, and move-by-move analysis. Original application code is MIT licensed.
The bundled Stockfish engine is separately GPL-3.0 licensed; see
[third-party notices](THIRD_PARTY_NOTICES.md).

This independent project is not affiliated with, endorsed by, or sponsored by
Chess.com. Chess.com is a trademark of its respective owner.

## Development

Requires Node.js and npm. Install dependencies with `npm ci`, run `npm run dev`
for local development, and use `npm run build`, `npm test`, and
`npm run test:e2e` to build and check the app. The local development server
provides a feedback endpoint for the interface; production feedback runs as a
Cloudflare Worker and needs a Workers AI binding.

The deployment configuration is an example for the original installation.
Install the deployment dependencies with `cd deploy && npm install`, then set
your own Cloudflare Worker name, domain, and bindings before deploying.
Hosting and AI use may incur costs to the operator even if access is free to
players.

Invite-link games are casual and do not require accounts. The invitation link
allows someone to join the available seat or watch once both seats are taken;
share it only with people you want in the game. The server stores a room's
moves, clocks and hashed seat tokens temporarily; finished rooms expire after
one hour. Players' game history and seat tokens are stored in their browsers.
Cloudflare uses connection information for request handling and rate limits.

## Chess.com imports

The D1 schema for a future import cache is provided in `migrations/`. Imports
and shared analysis caching are not enabled in this release; cached analysis
must be protected from untrusted clients before it is shared.

## Licence

[MIT](LICENSE) for original app code. See [third-party notices](THIRD_PARTY_NOTICES.md)
for the separate licences and corresponding source information for bundled
components, including the GPL-licensed engine.
