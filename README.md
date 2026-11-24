# Steam Historical Low Notifier

Monitor de la lista pública de deseados de Steam México. Envía alertas por Telegram únicamente cuando el precio actual de un juego iguala o rompe su mínimo histórico de Steam México.

## Tipos de alerta

- **MÍNIMO HISTÓRICO:** el precio actual iguala el menor precio histórico conocido para Steam México.
- **NUEVO MÍNIMO HISTÓRICO:** el precio actual queda por debajo del mínimo anterior registrado.

No se envían alertas por descuentos que sigan por encima del mínimo histórico. El porcentaje de descuento no determina la alerta: lo determinante es el precio frente al mínimo histórico.

Las comparaciones se hacen en MXN y no convierten precios de otras monedas. Si no existe un mínimo histórico verificable en MXN, el juego no genera alertas.

## Fuentes

- Steam AppDetails con región México (`cc=mx`) para precio actual, precio normal y descuento.
- Steam Index API, endpoint `/v1/apps/{appId}/prices/history?currency=MXN`, para el mínimo histórico en pesos mexicanos.
- IsThereAnyDeal para identificar juegos y como respaldo de precios actuales.

IsThereAnyDeal está devolviendo mínimos históricos de Steam en otras monedas para esta wishlist; esos datos no se convierten ni se usan como mínimo mexicano. Steam Index entrega el precio histórico en la moneda solicitada, en unidades menores (centavos), y expone el mínimo registrado. Su API documenta un límite gratuito de 1,440 solicitudes diarias y 60 por minuto.

## Panel

El panel del Worker permite:

- Consultar la última revisión y el estado de las conexiones.
- Ejecutar una revisión manual.
- Consultar el historial de alertas de mínimos históricos.
- Ver precio actual, mínimo histórico, descuento y fecha de notificación.

## Cómo evita las alertas repetidas

El Worker guarda por juego el mínimo histórico conocido y si el precio actual está en ese mínimo. Así:

- No repite la misma alerta en cada revisión mientras el juego siga al mismo precio mínimo.
- Puede volver a avisar si el juego sale del mínimo y posteriormente lo alcanza otra vez.
- Notifica un nuevo récord cuando el precio baja por debajo del mínimo que ya tenía registrado.
- Guarda cuándo se consultó el historial para no repetir solicitudes de juegos sin datos.

El historial de notificaciones se guarda por separado del estado de precios y conserva hasta 500 alertas.

## Horarios

Revisiones automáticas todos los días:

- 8:00 a. m.
- 12:05 p. m.

Zona horaria: `America/Monterrey`.

## Configuración de Cloudflare

En Workers & Pages → `steam-historical-low` → Settings → Variables and Secrets, configura estos secretos:

- `ITAD_API_KEY`
- `STEAM_INDEX_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

### Crear la clave de Steam Index

1. Abre [Steam Index API keys](https://steamidx.com/settings/api).
2. Inicia sesión con Steam y crea una clave para este monitor.
3. Copia la clave una sola vez y guárdala como secreto `STEAM_INDEX_API_KEY` en Cloudflare.

No publiques ni guardes la clave en GitHub. La clave se usa únicamente desde el Worker para consultar los mínimos históricos.

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

## Primera revisión después de reiniciar el historial

La primera revisión consulta el historial regional de los juegos que están en oferta. Si un juego ya está al mínimo, puede generar una alerta inicial. Después se guarda la línea base para detectar nuevos mínimos y evitar duplicados.

## Datos del proyecto

- País: México (`MX`).
- Tienda: Steam.
- Moneda de comparación: MXN.
- Estado y notificaciones: Cloudflare KV.
- Automatización: Cloudflare Workers Cron.
- Notificaciones: Telegram.

El proyecto no está afiliado a Steam, Steam Index ni a IsThereAnyDeal.
