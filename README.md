# Walkie Talkie Full Stack

Pacchetto completo con:
- `client/walkie-talkie-pro.html` frontend realtime
- `server/server.js` backend Node.js + Express + WebSocket
- `server/package.json` dipendenze server

## Funzioni incluse
- Stanze private con PIN
- Ruoli: guest, moderator, admin, host
- Push-to-talk multiutente
- Signaling WebRTC tramite backend tuo
- Mute e kick lato moderatore
- Stato stanza bloccata
- Canali condivisi
- Health endpoint `/health`

## Avvio locale
### Server
```bash
cd server
npm install
npm start
```
Server su `http://localhost:3000`, WebSocket su `ws://localhost:3000/ws`

### Client
Apri `client/walkie-talkie-pro.html` da un server statico locale o da hosting HTTPS.

## Deploy suggerito
- Frontend: Netlify o Vercel
- Backend: Railway, Render, Fly.io o VPS
- TURN/STUN: aggiungi coturn per reti difficili
- Reverse proxy: opzionale Nginx

## Note importanti
- Il frontend punta di default a `localhost:3000`. Per il deploy cambia `WS_URL` nel file HTML.
- Per WebRTC serio in produzione conviene aggiungere TURN, auth con token, rate limiting e validazione severa lato server.
