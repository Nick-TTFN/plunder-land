// Single source for the game server address. It is baked in at build time
// from SERVER_URL (webpack.config.js), so the host's build settings hold it and
// changing it is a rebuild, not a commit: the client Worker's build variables
// set it to the Railway server's URL. A development build without SERVER_URL uses a local
// server; a production build without it fails. ?server=http://host:port
// overrides it at run time.
declare const __SERVER_URL__: string

export const SERVER_URL: string =
  new URLSearchParams(window.location.search).get('server') ?? __SERVER_URL__
