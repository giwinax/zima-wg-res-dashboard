# zima-dash

Realtime-дашборд ZimaBlade: CPU / RAM / температура / сеть (eth0) + статус клиентов WireGuard (wg-easy).

## Деплой

Скопировать папку на ZimaBlade (например, через `Files` в ZimaOS, SCP, или смонтированную шару) и поднять:

```bash
cd zima-dash
docker compose up -d --build
```

Порт **8090**, `network_mode: host` — открывать `http://192.168.8.128:8090`.

## Настройка

Всё через `docker-compose.yml` / `environment`:

- `WG_EASY_PASSWORD` — значение по умолчанию `changeme` — обязательно поменять на реальный пароль контейнера WireGuard Easy.
- `NET_IFACE` — если интерфейс не `eth0`, поменять.
- `WG_EASY_URL` — если wg-easy не на той же машине, указать адрес/порт.

## Как работает

- `pid: host` + смонтированные `/proc`, `/sys` (ro) — чтобы CPU/RAM/температура читались с хоста, а не из namespace контейнера.
- `network_mode: host` — чтобы `eth0` и его счётчики трафика были видны напрямую.
- Бэкенд (FastAPI) логинится в wg-easy API (`/api/session`), держит cookie-сессию, раз в запрос забирает `/api/wireguard/client`, кэш сессии переживает рестарты запроса (не контейнера).
- Фронт — чистый HTML/CSS/JS, без CDN, поллинг раз в 2 сек.

## Безопасность

Дашборд сам без авторизации (LAN-only расчёт). Если нужно — повесить перед ним Cloudflared/Caddy с basic-auth, благо на ZimaOS уже стоит Cloudflared.
