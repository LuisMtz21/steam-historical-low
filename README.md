# Steam Historical Low Notifier

Monitor de la lista pública de deseados de Steam México. Envía alertas por Telegram únicamente cuando el precio actual de un juego iguala o rompe su mínimo histórico de Steam México.

## Tipos de alerta

- **MÍNIMO HISTÓRICO:** el precio actual iguala el menor precio histórico conocido.
- **NUEVO MÍNIMO HISTÓRICO:** el precio actual queda por debajo del mínimo anterior registrado.

No se envían alertas por descuentos que sigan por encima del mínimo histórico. El porcentaje de descuento no determina la alerta: lo determinante es el precio frente al mínimo histórico.

Las comparaciones se hacen exclusivamente en MXN. No se convierten precios de otras monedas.

## Fuentes

- Steam AppDetails con región México (`cc=mx`) para precio actual, precio normal y descuento.
- Steam Index API, endpoint `/v1/apps/{appId}/prices/history?currency=MXN`, para el mínimo histórico en pesos mexicanos.

Steam Index documenta el historial de cambios de precio por moneda, el mínimo registrado y un límite gratuito de 1,440 solicitudes diarias y 60 por minuto. El Worker consulta los juegos en lotes para respetar el límite de solicitudes de Steam Index y el límite de subsolicitudes de Cloudflare.

## Panel

El panel permite:

- Consultar la última revisión y el estado de las conexiones.
- Ejecutar una revisión manual.
- Consultar el historial de alertas de mínimos históricos.
- Ver precio actual, mínimo histórico, descuento y fecha de notificación.

## Cómo evita las alertas repetidas

El Worker guarda por juego el mínimo histórico conocido y si el precio actual está en ese mínimo:

- No repite la misma alerta en cada revisión mientras el juego siga al mismo precio mínimo.
- Puede volver a avisar si el juego sale del mínimo y posteriormente lo alcanza otra vez.
- Notifica un nuevo récord cuando el precio baja por debajo del mínimo que ya tenía registrado.
- Si una aplicación no tiene historial disponible, vuelve a comprobarlo después de 24 horas.

El historial de notificaciones se guarda por separado del estado de precios y conserva hasta 500 alertas.

## Primera sincronización

Después de reiniciar el estado, el Worker consulta el mínimo histórico de todos los juegos que tienen precio en Steam México. La consulta se divide en lotes de 50 para respetar los límites de Cloudflare y Steam Index. Con una lista de unos 200 juegos, la primera revisión puede tardar aproximadamente cuatro minutos. Las revisiones posteriores normalmente consultan solo juegos cuyo precio toca o rompe el mínimo guardado.

## Horarios

Revisiones automáticas todos los días:

- 8:00 a. m.
- 12:05 p. m.

Zona horaria: `America/Monterrey`.

## Configuración de Cloudflare

En Workers & Pages → `steam-historical-low` → Settings → Variables and Secrets, configura estos secretos:

- `STEAM_INDEX_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

### Crear la clave de Steam Index

1. Abre [Steam Index API keys](https://steamidx.com/settings/api).
2. Inicia sesión con Steam y crea una clave para este monitor.
3. Copia la clave y guárdala como secreto `STEAM_INDEX_API_KEY` en Cloudflare.

No publiques ni guardes la clave en GitHub. La clave se utiliza únicamente desde el Worker para consultar mínimos históricos.

## KV

El Worker utiliza el namespace existente mediante el binding `KV`.

Claves de estado:

- `wishlist-state-v1`: mínimo histórico conocido por juego y estado de alerta.
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
- Historial: Steam Index API.
- Estado y notificaciones: Cloudflare KV.
- Automatización: Cloudflare Workers Cron.
- Notificaciones: Telegram.

El proyecto no está afiliado a Valve, Steam ni Steam Index.
