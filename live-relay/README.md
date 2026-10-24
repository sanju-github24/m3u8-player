# live-relay

The live proxy (`/api/live-proxy`) moved onto the Delhi VPS, so it can keep state
between requests. See the comment at the top of `server.mjs` for why.

Deploy (from the Mac):

```bash
rsync -a --exclude node_modules -e "ssh -i ~/.ssh/vps_deploy" live-relay/ root@138.252.100.28:/opt/live-relay/
ssh -i ~/.ssh/vps_deploy root@138.252.100.28 'cd /opt/live-relay && npm install --omit=dev --no-audit --no-fund \
  && cp live-relay.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now live-relay \
  && systemctl restart live-relay'
```

Served at https://live.1anchormovies.buzz through the anchor-delhi tunnel. `/health`
shows the pool per host and whether the home tunnel is up.

Star Sports Digital (`livetv.hotstar.com`) and the Bigg Boss channels
(`live09p.hotstar.com`) take no free proxy at all, only a home line. They play
while the home tunnel is up:

```bash
node ~/anchor-ingest/scripts/home-proxy.js            # on the Mac
ssh -N -R 8899:127.0.0.1:8899 -i ~/.ssh/vps_deploy root@138.252.100.28
```
