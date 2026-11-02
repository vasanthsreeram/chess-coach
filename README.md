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

The `prep/chesscom-import` branch prepares completed-game imports using the
Chess.com Published-Data API; it is not deployed on the public site. Before
activating it, clarify the interaction between Chess.com's API guidance and
its AI restrictions. It searches the three newest archive months for up to
two players; older games can be pasted as PGN. Bare links may require a player
username because the API has no documented game-by-id lookup.

The app caches public game records in D1 and partitions saved analysis by a
secret stored in each browser. The same browser can reuse its analysis; other
browsers run the engine again. Shared analysis across users would require a
trusted server-side engine rather than accepting anonymous client evaluations.
Clearing the browser's site data removes its cache key. Only completed games
should be analysed.

For deployment, apply the SQL migrations and add a `DB` D1 binding to your own
Cloudflare configuration (for example `bindings.d1({ name: 'your-database',
id: 'your-database-id' })`). Never accept arbitrary browser evaluations into a
cache shared by unrelated users.

## Licence

[MIT](LICENSE) for original app code. See [third-party notices](THIRD_PARTY_NOTICES.md)
for the separate licences and corresponding source information for bundled
components, including the GPL-licensed engine.
