# Steam Historical Low Notifier

Monitor de la lista pública de deseados de Steam México. Envía alertas por Telegram cuando el precio actual iguala o rompe el mínimo histórico disponible en la fuente configurada.

## Tipos de alerta

- **MÍNIMO HISTÓRICO REGISTRADO:** el precio actual iguala el menor precio disponible en el historial consultado.
- **NUEVO MÍNIMO REGISTRADO:** el precio actual queda por debajo del mínimo anterior guardado.

No se envían alertas por descuentos que sigan por encima del mínimo histórico registrado. El porcentaje de descuento no determina la alerta: lo determinante es el precio frente al mínimo disponible.

Las comparaciones se hacen exclusivamente en MXN. No se convierten precios de otras monedas.

## Fuente y cobertura histórica

- Steam AppDetails con región México (`cc=mx`) para precio actual, precio normal y descuento.
- Steam Index API, endpoint `/v1/apps/{appId}/prices/history?currency=MXN`, para consultar el mínimo registrado en pesos mexicanos.

**Limitación importante:** Steam Index indica que su historial de precios se registra desde septiembre de 2026. Por tanto, su mínimo es el menor registrado por esa fuente desde que comenzó a recopilar datos; no garantiza el mínimo de toda la vida del juego ni ofertas anteriores a septiembre de 2026.

SteamDB tiene un historial más amplio, pero su FAQ indica que no ofrece API y prohíbe la extracción automatizada de sus páginas. El Worker no realiza scraping de SteamDB.

Steam Index documenta un límite gratuito de 1,440 solicitudes diarias y 60 por minuto. El Worker consulta en lotes de 50 y espera entre lotes para respetar esos límites y los de Cloudflare.

## Panel

El panel permite:

- Consultar la última revisión y el estado de las conexiones.
- Ejecutar una revisión manual.
- Consultar el historial de alertas.
- Ver precio actual, mínimo registrado, descuento y fecha de notificación.

## Cómo evita las alertas repetidas

El Worker guarda por juego el mínimo registrado conocido y si el precio actual está en ese mínimo:

- No repite la misma alerta en cada revisión mientras el juego siga al mismo precio mínimo.
- Puede volver a avisar si el juego sale del mínimo y posteriormente lo alcanza otra vez.
- Notifica un nuevo récord cuando el precio baja por debajo del mínimo que ya tenía registrado.
- Si una aplicación no tiene historial disponible, vuelve a comprobarlo después de 24 horas.

El historial de notificaciones se guarda por separado del estado de precios y conserva hasta 500 alertas.

## Primera sincronización

Después de reiniciar el estado, el Worker consulta el mínimo disponible de todos los juegos que tienen precio en Steam México. La consulta se divide en lotes de 50. Con una lista de unos 200 juegos, la primera revisión puede tardar aproximadamente cuatro minutos. Las revisiones posteriores normalmente consultan solo juegos cuyo precio toca o rompe el mínimo guardado.

## Horarios

Revisiones automáticas todos los días:

- 8:00 a. m.
- 12:05 p. m.

Zona horaria: `America/Monterrey`.

## Configuración de Cloudflare

En Workers & Pages → `steam-historical-low` → Settings → Variables and Secrets, configura estos secretos:

- `STEAM_INDEX_API_KEY` — necesario para activar las alertas históricas.
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

### Crear la clave de Steam Index

1. Abre [Steam Index API keys](https://steamidx.com/settings/api).
2. Inicia sesión con Steam y crea una clave.
3. Guárdala como secreto `STEAM_INDEX_API_KEY` en Cloudflare.

No publiques ni guardes la clave en GitHub. Si no está configurada, el Worker omite la revisión histórica y no envía alertas incorrectas.

## KV

El Worker utiliza el namespace existente mediante el binding `KV`.

Claves de estado:

- `wishlist-state-v1`: mínimo registrado conocido por juego y estado de alerta.
- `notification-history-v1`: historial de alertas.
- `last-run-v1` y `last-result-v1`: datos de la última revisión.
- `telegram-test-sent`: evita repetir el mensaje inicial de configuración.

## Despliegue automático

Workers Builds está conectado al repositorio `LuisMtz21/steam-historical-low`, rama `main`, con comando:

    npx wrangler deploy

Los archivos del panel están en `public/`.

## Datos del proyecto

- País: México (`MX`).
- Tienda: Steam.
- Moneda de comparación: MXN.
- Historial: Steam Index API (desde septiembre de 2026).
- Estado y notificaciones: Cloudflare KV.
- Automatización: Cloudflare Workers Cron.
- Notificaciones: Telegram.

El proyecto no está afiliado a Valve, Steam, SteamDB ni Steam Index.
