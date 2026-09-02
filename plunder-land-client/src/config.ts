// Single source for the game server address. Defaults to production; override
// for local work with ?server=http://localhost:8000 so the checked-in default
// never has to be edited to run the game locally.
const DEFAULT_SERVER = 'https://socket.plunderland.io:8000'

export const SERVER_URL: string =
  new URLSearchParams(window.location.search).get('server') ?? DEFAULT_SERVER
