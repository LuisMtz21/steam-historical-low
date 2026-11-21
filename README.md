# Steam Historical Low Notifier

Cloudflare Worker que revisa la lista pública de deseados de Steam México cada 6 horas y envía alertas por Telegram cuando un juego iguala o establece un nuevo mínimo histórico en Steam México.

## Qué hace

- Lee la wishlist pública de Steam.
- Convierte los Steam AppID a identificadores de IsThereAnyDeal.
- Consulta precio actual y mínimo histórico exclusivamente de la tienda Steam y el país México.
- Envía dos tipos de aviso:
  - **IGUALÓ SU MÍNIMO HISTÓRICO:** el precio actual alcanza un mínimo ya registrado.
  - **NUEVO MÍNIMO HISTÓRICO:** el mínimo histórico bajó respecto a la revisión anterior y el precio actual está en ese mínimo.
- Guarda el estado en Cloudflare KV para no repetir avisos cada seis horas mientras el mismo descuento siga activo.

## Requisitos

- Cloudflare Workers con Cron Triggers y KV.
- Clave de API de IsThereAnyDeal y autorización para este uso.
- Bot de Telegram y Chat ID.
- Wishlist de Steam pública.

## Configuración en Cloudflare

### 1. Variables secretas

En Workers & Pages → steam-historical-low → Settings → Variables and Secrets, agrega como **Secrets**:

- `ITAD_API_KEY`: tu clave de IsThereAnyDeal.
- `TELEGRAM_BOT_TOKEN`: token del bot de Telegram.
- `TELEGRAM_CHAT_ID`: chat ID donde recibirás los avisos.

No guardes estos valores en GitHub.

### 2. KV

El archivo `wrangler.jsonc` ya contiene el binding `KV` y el ID del namespace proporcionado para este proyecto.

### 3. Workers Builds

Configuración esperada:

- Repositorio: `LuisMtz21/steam-historical-low`
- Rama de producción: `main`
- Directorio raíz: `/`
- Comando de compilación: vacío
- Comando de despliegue: `npx wrangler deploy`

### 4. Cron

El Worker incluye `0 */6 * * *`: se ejecuta a las 00:00, 06:00, 12:00 y 18:00 UTC. Cloudflare interpreta los Cron Triggers en UTC.

## Primera ejecución

La primera revisión crea una línea base en KV y no manda avisos por descuentos que ya estaban activos antes de instalar el monitor. Después notificará cuando un juego entre en su mínimo histórico o cuando ese mínimo se reduzca.

Para probar, puedes ejecutar una vez el Worker desde la opción **Triggers → Cron Triggers → Trigger** en el panel de Cloudflare. La ejecución programada usará los mismos secretos y binding KV.

La URL pública del Worker responde únicamente con información básica de estado; no expone un endpoint para ejecutar revisiones manuales.

## Notas

- El país consultado es `MX` y la tienda es Steam (shop ID 61 de IsThereAnyDeal).
- La comparación se realiza usando la moneda devuelta por la API; si las monedas no coinciden, el juego se omite para evitar comparaciones incorrectas.
- No se envían alertas repetidas mientras el precio permanezca en el mismo mínimo.
- IsThereAnyDeal puede no tener identificado algún AppID; esos juegos se omiten.
- Las revisiones se hacen cada seis horas; no son alertas instantáneas.
- Este proyecto no está afiliado a Steam ni a IsThereAnyDeal. Consulta y respeta las condiciones de uso de sus servicios.
